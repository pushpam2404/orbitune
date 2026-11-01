// src/main.js
import * as THREE from 'three';
import { animate as motionAnimate } from 'motion';
import { GALAXY_PRESETS } from './config/presets.js';
import { buildUniverseGraph } from './etl/graphNormalizer.js';
import { getAuthStatus, fetchUniverse, enrichArtists } from './api/backendClient.js';
import { loadArtistMeta, saveArtistMeta } from './api/artistMetaCache.js';
import {
  loadStoredHistorySummary,
  saveStoredHistorySummary,
  loadStoredUniverseSnapshot,
  saveStoredUniverseSnapshot,
  clearStoredHistory,
  migrateLegacyLocalStorage,
  parseImportedFiles,
  exportUniverseSnapshotJson,
  exportListeningHistoryCsv
} from './api/historyStorage.js';
import { createUniverseScene, webglAvailable } from './renderer/universeScene.js';
import { CelestialFactory, nodeMatchesLens } from './renderer/celestialFactory.js';
import { GalaxyLayoutEngine } from './physics/galaxyLayout.js';
import { CameraFlightController } from './renderer/cameraController.js';
import { LabelProjector } from './renderer/labelProjector.js';
import { Hud, yearRange } from './ui/hud.js';
import { DetailPanel } from './ui/detailPanel.js';

const AppState = {
  isDemo: true,
  rawDataset: null,
  historySummary: null,
  spotifyApiOnly: false,
  activeLens: 'all',
  nodeScaleMultiplier: 1.0,
  layers: { genres: true, artists: true, tracks: true, historySongs: true, edges: true, labels: true },
  nodes: [],
  edges: [],
  nodeMap: new Map(),
  pulseParticles: [],
  hoveredNode: null,
  selectedNode: null
};

const ENRICH_BATCH = 40;
// Auto-refine every time this many artists get new genres (and once more when the
// lookups finish), after this long without interaction.
const AUTO_REFINE_EVERY = 200;
const AUTO_REFINE_IDLE_MS = 4000;
const MORPH_SECONDS = 2.4;
const TRAIL_FADE_MS = 2500;
const MAX_TRAILS = 400;
const plural = (n, one, many = `${one}s`) => `${Number(n || 0).toLocaleString()} ${n === 1 ? one : many}`;

async function initApp() {
  if (!webglAvailable()) {
    document.getElementById('webgl-fallback').hidden = false;
    return;
  }
  const { scene, camera, renderer, controls } = createUniverseScene(document.getElementById('webgl-canvas-container'));

  const viewShift = { x: 0, y: 0, tx: 0, ty: 0 };
  let sheetCover = () => 88;
  // Below this width the side panel becomes a bottom sheet. Keep in sync with the
  // `@media (max-width: 900px)` block in src/style.css.
  const SHEET_QUERY = window.matchMedia('(max-width: 900px)');
  function updateViewOffset(snap = false) {
    const narrow = SHEET_QUERY.matches;
    viewShift.tx = narrow ? 0 : (340 + 16) / 2;
    const barBottom = narrow ? document.getElementById('top-bar').getBoundingClientRect().bottom : 0;
    viewShift.ty = narrow ? (sheetCover() - barBottom) / 2 : 0;
    if (snap === true) { viewShift.x = viewShift.tx; viewShift.y = viewShift.ty; }
    applyViewOffset();
  }
  function applyViewOffset() {
    camera.setViewOffset(window.innerWidth, window.innerHeight, viewShift.x, viewShift.y, window.innerWidth, window.innerHeight);
  }
  function easeViewOffset() {
    if (Math.abs(viewShift.tx - viewShift.x) + Math.abs(viewShift.ty - viewShift.y) < 0.5) return;
    viewShift.x += (viewShift.tx - viewShift.x) * 0.15;
    viewShift.y += (viewShift.ty - viewShift.y) * 0.15;
    applyViewOffset();
  }
  updateViewOffset(true);
  window.addEventListener('resize', () => updateViewOffset(true));

  const factory = new CelestialFactory(scene);
  const layout = new GalaxyLayoutEngine();
  const cameraController = new CameraFlightController(camera, controls);
  const labelProjector = new LabelProjector(document.getElementById('hud-labels-container'));
  let edgeGroup = null;
  let suns = [];
  let authStatus = { loggedIn: false };

  // ---------- Selection ----------

  const LAYER_OF = { genre: 'genres', artist: 'artists', track: 'tracks' };

  function selectNode(node) {
    if (!node) return;
    if (!AppState.layers[LAYER_OF[node.type]]) hud.setLayer(LAYER_OF[node.type], true);
    AppState.selectedNode = node;
    cameraController.flyToNode(node);
    detailPanel.render(node);
    hud.showDetails();
    writeUrl();
  }

  function clearSelection() {
    AppState.selectedNode = null;
    hud.showClusters();
    if (hud.isPhone()) hud.setSheet(false);
    writeUrl();
  }

  // The selection and lens live in the URL, so Back steps through what you looked at
  // and any view can be shared as a link.
  let restoringUrl = false;
  function writeUrl({ replace = false } = {}) {
    if (restoringUrl) return;
    const params = new URLSearchParams();
    if (AppState.selectedNode) params.set('node', AppState.selectedNode.id);
    // Time-lapse years are a playback, not a place to link to.
    if (AppState.activeLens !== 'all' && !AppState.activeLens.startsWith('year_')) params.set('lens', AppState.activeLens);
    const next = params.toString() ? `?${params}` : '';
    if (next !== window.location.search) window.history[replace ? 'replaceState' : 'pushState'](null, '', next || window.location.pathname);
  }
  function applyUrl() {
    const params = new URLSearchParams(window.location.search);
    restoringUrl = true;
    try {
      const lens = params.get('lens') || 'all';
      const knownLens = lens === 'all' || document.querySelector(`#lens-bar .lens-pill[data-lens="${CSS.escape(lens)}"]`);
      if (knownLens && lens !== AppState.activeLens) hud.setLens(lens);
      const node = AppState.nodeMap.get(params.get('node'));
      if (node && node !== AppState.selectedNode) selectNode(node);
      else if (!node && AppState.selectedNode) {
        clearSelection();
        cameraController.resetOverview();
      }
    } finally {
      restoringUrl = false;
    }
    writeUrl({ replace: true }); // drop unknown ids from a shared or stale link
  }
  window.addEventListener('popstate', applyUrl);

  const detailPanel = new DetailPanel(document.getElementById('detail-content'), {
    resolve: (id) => AppState.nodeMap.get(id),
    onSelect: selectNode,
    onFly: (node) => cameraController.flyToNode(node),
    isDemo: () => AppState.isDemo,
    likedSongsConnected: () => !authStatus.missingScopes?.includes('user-library-read'),
    getActiveLens: () => AppState.activeLens,
    onSetLens: (lens) => hud.setLens(lens)
  });

  const hud = new Hud(AppState, {
    onSelectNode: selectNode,
    onBack: () => {
      clearSelection();
      cameraController.resetOverview();
    },
    onResetCamera: () => {
      clearSelection();
      cameraController.resetOverview();
    },
    onZoomStep: (factor) => {
      cameraController.zoomBy(factor);
    },
    onLayersChange: applyLayerVisibility,
    onToggleHistorySongs: async (includeHistory) => {
      AppState.layers.historySongs = includeHistory;
      AppState.spotifyApiOnly = !includeHistory;
      hud.syncHistoryToggleUI();
      hud.updateHistoryButtonBadge();

      const hasSpotifyItemsInCurrent = AppState.nodes.some(n => n.fromSpotifyApi);
      if (authStatus.loggedIn) {
        await loadLive({
          historySummary: includeHistory ? AppState.historySummary : null,
          useLocalHistory: includeHistory,
          spotifyApiOnly: !includeHistory,
          skipInitialEnrich: true
        });
        return;
      }

      if (hasSpotifyItemsInCurrent) {
        applyLayerVisibility();
        return;
      }

      if (!includeHistory) {
        loadDemo();
        hud.setNotice('History songs hidden. Connect Spotify to map your live Spotify library, or re-enable History songs in View.', {
          label: 'Restore history songs',
          run: () => hud.cb.onToggleHistorySongs(true)
        });
      } else if (AppState.historySummary || authStatus.localHistory?.available) {
        await loadLive({ historySummary: AppState.historySummary, useLocalHistory: true, skipInitialEnrich: true });
      }
    },
    onRemoveHistory: async () => {
      AppState.historySummary = null;
      AppState.spotifyApiOnly = true;
      AppState.layers.historySongs = false;
      await clearStoredHistory();
      hud.syncHistoryToggleUI();
      hud.updateHistoryButtonBadge();
      if (authStatus.loggedIn) {
        await loadLive({ historySummary: null, useLocalHistory: false, spotifyApiOnly: true });
      } else {
        loadDemo();
        hud.setNotice('Removed streaming history. Connect Spotify to map your live library.');
      }
    },
    onLensChange: () => {
      writeUrl();
      factory.focusKey = null;
      if (AppState.selectedNode) detailPanel.render(AppState.selectedNode);
    },
    onSheetChange: () => updateViewOffset(),
    onReplayYear: (year) => {
      if (!year) return updateUniverseCaption(AppState.rawDataset);
      const played = AppState.nodes.filter(n => n.type === 'artist' && (n.history?.byYear?.[year] || 0) > 0).length;
      hud.setCaption(year, `${plural(played, 'artist')} played this year`);
    },
    onOrbitSpeed: (speed) => {
      layout.orbitMultiplier = speed;
      controls.autoRotate = speed > 0;
      controls.autoRotateSpeed = 0.35 * speed;
    },
    onNodeScale: (scale) => {
      AppState.nodeScaleMultiplier = scale;
      layout.nodeScaleMultiplier = scale;
      AppState.nodes.forEach(n => n.meshGroup?.scale.setScalar(scale));
    },
    onClusterSpread: (spread) => {
      layout.clusterSpreadMultiplier = spread;
      layout.boundingRadius = layout.bounds[layout.mode] * spread;
      cameraController.setSceneRadius(layout.boundingRadius);
    },
    onImportFiles: async (fileList, progress) => {
      const parsed = await parseImportedFiles(fileList);
      if (parsed.kind === 'history') progress?.(`Found ${parsed.historySummary.validPlays.toLocaleString()} plays. Building your map…`);
      AppState.spotifyApiOnly = false;
      AppState.layers.historySongs = true;
      hud.syncHistoryToggleUI();

      if (parsed.kind === 'snapshot') {
        if (parsed.artistMeta) saveArtistMeta(parsed.artistMeta);
        if (parsed.historySummary) {
          AppState.historySummary = parsed.historySummary;
          await saveStoredHistorySummary(parsed.historySummary);
        }
        await saveStoredUniverseSnapshot(parsed.snapshot);
        AppState.isDemo = false;
        loadDataset(parsed.dataset);
        updateUniverseCaption(parsed.dataset);
        hud.setNotice(`Loaded universe snapshot (${parsed.fileNames[0]}).`);
        return;
      }

      AppState.historySummary = parsed.historySummary;
      await saveStoredHistorySummary(parsed.historySummary);
      await saveStoredUniverseSnapshot(null);
      await loadLive({ historySummary: parsed.historySummary });
    },
    onUseLocalHistory: async () => {
      AppState.historySummary = null;
      AppState.spotifyApiOnly = false;
      AppState.layers.historySongs = true;
      hud.syncHistoryToggleUI();
      await saveStoredHistorySummary(null);
      await saveStoredUniverseSnapshot(null);
      await loadLive({ useLocalHistory: true });
    },
    onExportJson: () => {
      exportUniverseSnapshotJson(AppState.rawDataset, loadArtistMeta(), AppState.historySummary);
    },
    onExportCsv: () => {
      exportListeningHistoryCsv(AppState.rawDataset);
    },
    onDisconnected: () => {
      if ((authStatus.localHistory?.available || AppState.historySummary) && !AppState.spotifyApiOnly) {
        loadLive({ historySummary: AppState.historySummary });
      } else {
        loadDemo();
      }
    }
  });
  sheetCover = () => hud.sheetCover();
  updateViewOffset(true);

  // ---------- Pointer & Touch: multi-touch safe tap, pinch-zoom & double-tap ----------

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(-9, -9);
  const activeTouches = new Set();
  let gestureHadMultiTouch = false;
  let downAt = null;
  let lastTap = { time: 0, x: 0, y: 0 };
  const setPointer = (e) => pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);

  renderer.domElement.addEventListener('pointermove', (e) => {
    if (activeTouches.size <= 1) setPointer(e);
  });
  renderer.domElement.addEventListener('pointerleave', () => pointer.set(-9, -9));
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') {
      activeTouches.add(e.pointerId);
      if (activeTouches.size > 1) gestureHadMultiTouch = true;
    }
    if (activeTouches.size <= 1) {
      downAt = { x: e.clientX, y: e.clientY, time: performance.now() };
    }
  });
  renderer.domElement.addEventListener('pointerup', (e) => {
    const touch = e.pointerType !== 'mouse';
    if (touch) activeTouches.delete(e.pointerId);

    // Never treat the end of a two-finger pinch-zoom or pan gesture as a node tap
    if (touch && (gestureHadMultiTouch || activeTouches.size > 0)) {
      if (activeTouches.size === 0) gestureHadMultiTouch = false;
      pointer.set(-9, -9);
      return;
    }

    const moved = downAt ? Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) : Infinity;
    const elapsed = downAt ? performance.now() - downAt.time : Infinity;
    if (moved <= (touch ? 14 : 5) && elapsed < 550) {
      setPointer(e);
      const node = pickNode(touch) || pickNearest(e.clientX, e.clientY, touch ? 34 : 12, touch);
      const now = performance.now();
      const isDoubleTap = touch && (now - lastTap.time < 320) && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 36;
      lastTap = { time: now, x: e.clientX, y: e.clientY };

      if (node) {
        selectNode(node);
        if (isDoubleTap) cameraController.zoomBy(0.65);
        if (touch) navigator.vibrate?.(8);
      } else if (isDoubleTap) {
        clearSelection();
        cameraController.resetOverview();
      } else if (AppState.selectedNode) {
        clearSelection();
      } else if (touch && hud.sheetOpen) {
        hud.setSheet(false);
      }
    }
    if (touch) pointer.set(-9, -9);
  });
  renderer.domElement.addEventListener('pointercancel', (e) => {
    activeTouches.delete(e.pointerId);
    if (activeTouches.size === 0) gestureHadMultiTouch = false;
    pointer.set(-9, -9);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && AppState.selectedNode && document.activeElement?.tagName !== 'INPUT') clearSelection();
  });

  /** Closest visible sun, artist, or song moon on screen within `radius` px. */
  function pickNearest(x, y, radius, isTouch = false) {
    let bestFocused = null, bestFocusedD = radius;
    let bestAny = null, bestAnyD = radius;
    const v = new THREE.Vector3();
    const hasLens = AppState.activeLens && AppState.activeLens !== 'all';
    for (const n of AppState.nodes) {
      if (!n.position || n.meshGroup?.visible === false) continue;
      if (n.type === 'artist' && !AppState.layers.artists) continue;
      if (n.type === 'track') {
        if (!AppState.layers.tracks) continue;
        if (!AppState.selectedNode && !hasLens && !isTouch) continue;
        if (hasLens && !nodeMatchesLens(n, AppState.activeLens)) continue;
      }
      v.copy(n.position).project(camera);
      if (v.z > 1) continue;
      const d = Math.hypot((v.x + 1) / 2 * window.innerWidth - x, (1 - v.y) / 2 * window.innerHeight - y);
      const isFocusedNode = (n.focusTarget ?? 1) >= 0.5;
      if (isFocusedNode && d < bestFocusedD) {
        bestFocusedD = d;
        bestFocused = n;
      }
      if (d < bestAnyD) {
        bestAnyD = d;
        bestAny = n;
      }
    }
    return bestFocused || bestAny;
  }

  function pickNode(isTouch = false, allowDimmedFallback = true) {
    raycaster.setFromCamera(pointer, camera);
    const interactiveMeshes = [];
    AppState.nodes.forEach(n => {
      if (n.sphereMesh && n.meshGroup?.visible) {
        interactiveMeshes.push(n.sphereMesh);
      }
    });
    if (factory.artistMesh && AppState.layers.artists) interactiveMeshes.push(factory.artistMesh);
    const zoomedIn = camera.position.length() < layout.boundingRadius * 0.95;
    const hasLens = AppState.activeLens && AppState.activeLens !== 'all';
    if (factory.trackMesh && AppState.layers.tracks && (AppState.selectedNode || hasLens || zoomedIn || isTouch)) {
      interactiveMeshes.push(factory.trackMesh);
    }

    const pickableTargets = interactiveMeshes.filter((m) => m.visible);
    const hits = raycaster.intersectObjects(pickableTargets, false);
    let fallbackDimmed = null;
    for (const hit of hits) {
      const node = factory.nodeFromHit(hit);
      if (!node || node.meshGroup?.visible === false) continue;
      if ((node.focusTarget ?? 1) >= 0.65) {
        return node;
      }
      if (allowDimmedFallback && !fallbackDimmed) fallbackDimmed = node;
    }
    return fallbackDimmed;
  }

  // ---------- Building a universe ----------

  function updateUniverseCaption(dataset) {
    const hm = dataset.historyMeta;
    const totalArtists = dataset.artists?.length || AppState.rawDataset?.artists?.length || hm?.artistCount || AppState.nodes.filter(n => n.type === 'artist').length;
    const totalTracks = dataset.tracks?.length || AppState.rawDataset?.tracks?.length || hm?.trackCount || AppState.nodes.filter(n => n.type === 'track').length;
    const totalClusters = dataset.genres?.length || AppState.rawDataset?.genres?.length || AppState.nodes.filter(n => n.type === 'genre').length;

    if (hm?.validPlays && !AppState.spotifyApiOnly && AppState.layers.historySongs !== false) {
      const span = yearRange(Object.keys(hm.years || {}).sort());
      hud.setCaption(
        dataset.name || 'Your Complete Music Universe',
        `${plural(totalArtists, 'artist')} & ${plural(totalTracks, 'song')} in ${plural(totalClusters, 'cluster')} · ${hm.validPlays.toLocaleString()} plays (${hm.totalHours?.toLocaleString() || '—'} hrs${span ? `, ${span}` : ''})`
      );
    } else {
      hud.setCaption(
        dataset.name || 'Your music universe',
        `${plural(totalArtists, 'artist')} & ${plural(totalTracks, 'song')} in ${plural(totalClusters, 'cluster')}`
      );
    }
  }

  /**
   * @param {object} rawDataset
   * @param {{ morph?: boolean }} opts  morph: keep the camera and let suns and planets
   *   glide from their old positions (used when the map refines in the background).
   */
  function loadDataset(rawDataset, { morph = false } = {}) {
    const previous = new Map();
    const previousCluster = new Map();
    if (morph) AppState.nodes.forEach(n => {
      if (n.type !== 'track' && n.position) previous.set(n.id, n.position.clone());
      if (n.type === 'artist') previousCluster.set(n.id, AppState.nodeMap.get(n.primarySunId)?.name);
    });
    AppState.rawDataset = rawDataset;
    AppState.nodes.forEach(n => { if (n.meshGroup?.isObject3D) scene.remove(n.meshGroup); });
    if (edgeGroup) scene.remove(edgeGroup);
    factory.solarMaterials = [];
    factory.disposeBatches();
    AppState.selectedNode = null;
    AppState.hoveredNode = null;

    const graph = buildUniverseGraph(rawDataset);
    AppState.nodes = graph.nodes;
    AppState.edges = graph.edges;
    AppState.nodeMap = graph.nodeMap;

    layout.initializeNodePositions(AppState.nodes);
    cameraController.setSceneRadius(layout.boundingRadius);
    if (morph) startMorph(previous, previousCluster);
    else {
      lastMoves = [];
      showTrails([]);
    }

    AppState.nodes.forEach(node => { if (node.type === 'genre') factory.buildGenreSun(node); });
    factory.buildArtistPlanets(AppState.nodes.filter(n => n.type === 'artist'));
    factory.buildTrackSatellites(AppState.nodes.filter(n => n.type === 'track'));
    const edgeData = factory.buildEdgeVisuals(AppState.edges);
    edgeGroup = edgeData.edgeLinesGroup;
    AppState.pulseParticles = edgeData.pulseParticles;
    if (AppState.nodeScaleMultiplier !== 1) AppState.nodes.forEach(n => n.meshGroup?.scale.setScalar(AppState.nodeScaleMultiplier));

    suns = AppState.nodes.filter(n => n.type === 'genre');
    labelProjector.syncLabels(AppState.nodes, selectNode);
    hud.renderLensBar(Boolean(!AppState.isDemo || rawDataset.historyMeta));
    hud.updateHistoryButtonBadge();
    applyLayerVisibility();
    hud.restoreSettings();
    if (!morph) cameraController.resetOverview();
  }

  function applyLayerVisibility() {
    const show = { genre: AppState.layers.genres, artist: AppState.layers.artists, track: AppState.layers.tracks };
    const includeHistoryItems = AppState.layers.historySongs !== false && !AppState.spotifyApiOnly;
    const hasSpotifyItems = AppState.nodes.some(n => n.fromSpotifyApi);

    AppState.nodes.forEach(n => {
      if (!n.meshGroup) return;
      let vis = Boolean(show[n.type]);
      if (vis && !includeHistoryItems && hasSpotifyItems && n.historyOnly) {
        vis = false;
      }
      n.meshGroup.visible = vis;
    });

    if (factory.trackMesh) factory.trackMesh.visible = AppState.layers.tracks;
    if (factory.trackDimMesh) factory.trackDimMesh.visible = AppState.layers.tracks && Boolean(AppState.selectedNode || (AppState.activeLens && AppState.activeLens !== 'all'));
    if (factory.artistMesh) factory.artistMesh.visible = factory.artistDecor.visible = AppState.layers.artists;
    if (factory.artistDimMesh) factory.artistDimMesh.visible = AppState.layers.artists && Boolean(AppState.selectedNode || (AppState.activeLens && AppState.activeLens !== 'all'));
    if (edgeGroup) edgeGroup.visible = AppState.layers.edges;
    factory.focusKey = null;
    hud.renderClusters(suns);
    if (AppState.rawDataset && !AppState.isDemo) updateUniverseCaption(AppState.rawDataset);
  }

  function loadDemo() {
    AppState.isDemo = true;
    loadDataset(GALAXY_PRESETS.cosmic_synth);
    hud.setCaption('A demo universe', 'Connect Spotify or import your listening history to map your own music.');
    hud.updateEnrichmentStatus({ waitingCount: 0, readyOnReloadCount: 0 });
    hud.setNotice(null);
  }

  async function loadLive({
    historySummary = AppState.historySummary,
    useLocalHistory = true,
    skipInitialEnrich = false,
    spotifyApiOnly = AppState.spotifyApiOnly,
    refine = false
  } = {}) {
    if (!refine) {
      // Say where the data is coming from; the old text always claimed Spotify.
      const fromSpotify = Boolean(authStatus.loggedIn) || spotifyApiOnly;
      const hasHistory = Boolean(historySummary) && !spotifyApiOnly;
      const body = fromSpotify
        ? `Merging your Spotify top charts, recent plays and Liked Songs${hasHistory ? ' with your listening history' : ''}, then grouping every artist by sound.`
        : 'Reading your listening history, then grouping every artist by sound.';
      hud.setLoading(true, 'Charting your universe', body);
    }
    try {
      const { dataset, artistMeta, diagnostics } = await fetchUniverse(loadArtistMeta(), {
        historySummary: spotifyApiOnly ? null : historySummary,
        useLocalHistory: spotifyApiOnly ? false : useLocalHistory,
        loggedIn: Boolean(authStatus.loggedIn),
        skipInitialEnrich,
        spotifyApiOnly
      });
      saveArtistMeta(artistMeta);
      console.info('[Orbitune] universe diagnostics:', diagnostics);
      console.info('[Orbitune] clustering:', JSON.stringify({ ...diagnostics.clusterStats, genreSource: diagnostics.genreSource, doubted: diagnostics.doubtedGenres }));
      if (!dataset) {
        loadDemo();
        hud.setNotice('Spotify has no listening data for this account yet.');
        return;
      }
      const morph = refine && !AppState.isDemo;
      AppState.isDemo = false;
      loadDataset(dataset, { morph });
      updateUniverseCaption(dataset);

      if (authStatus.loggedIn && authStatus.missingScopes?.includes('user-library-read')) {
        hud.setNotice('Your Liked Songs aren’t included yet.', { label: 'Reconnect Spotify', run: () => document.getElementById('spotify-btn').click() });
      } else if (!authStatus.loggedIn && dataset.historyMeta) {
        hud.setNotice('Mapped from your streaming history. Connect Spotify anytime to merge live top charts & Liked Songs.');
      } else if (spotifyApiOnly) {
        hud.setNotice('Showing only songs & artists from the Spotify API (history songs excluded).', {
          label: 'Include history songs',
          run: () => hud.cb.onToggleHistorySongs(true)
        });
      } else {
        hud.setNotice(null);
      }
      if (morph && lastMoves.length) hud.setNotice(describeMoves(lastMoves));

      if (diagnostics.pendingArtists?.length) {
        enrichInBackground(diagnostics.pendingArtists);
      } else {
        hud.updateEnrichmentStatus({ waitingCount: 0, readyOnReloadCount: 0 });
      }
    } catch (err) {
      console.error('Failed to load universe:', err);
      // A background refine that fails keeps the map you're looking at.
      if (refine && !AppState.isDemo) return;
      loadDemo();
      if (err.status === 401) {
        authStatus = { ...authStatus, loggedIn: false };
        hud.setAuthStatus(authStatus);
      }
      hud.setNotice(err.message, err.status === 401 || err.status === 429 ? null : { label: 'Try again', run: () => loadLive({ historySummary, useLocalHistory, spotifyApiOnly }) });
    } finally {
      hud.setLoading(false);
    }
  }

  // One spring drives every glide (Motion: a single interruptible animation, no
  // per-node tweens). Cluster ids change between maps, so a new sun starts from
  // where its artists were.
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let morphAnimation = null;
  let lastMoves = [];
  function startMorph(previous, previousCluster) {
    const v = new THREE.Vector3();
    AppState.nodes.forEach(n => {
      if (n.type === 'artist') n.morphFrom = previous.get(n.id) || null;
    });
    AppState.nodes.forEach(n => {
      if (n.type !== 'genre') return;
      if (previous.has(n.id)) { n.morphFrom = previous.get(n.id); return; }
      let count = 0;
      v.set(0, 0, 0);
      AppState.nodes.forEach(a => {
        if (a.type === 'artist' && a.genres?.[0] === n.id && a.morphFrom) { v.add(a.morphFrom); count++; }
      });
      n.morphFrom = count ? v.clone().divideScalar(count) : null;
    });
    // Artists that left their group get a trail and a mention in the notice. Clusters get
    // renamed between maps, so each old cluster's successor is the new cluster most of
    // its artists landed in; only artists that went somewhere else count as moved.
    const clusterName = (n) => AppState.nodeMap.get(n.primarySunId)?.name;
    const landed = new Map();
    AppState.nodes.forEach(n => {
      const from = n.type === 'artist' && previousCluster.get(n.id);
      if (!from) return;
      const counts = landed.get(from) || new Map();
      counts.set(clusterName(n), (counts.get(clusterName(n)) || 0) + 1);
      landed.set(from, counts);
    });
    const successor = new Map([...landed].map(([from, counts]) => [from, [...counts].sort((a, b) => b[1] - a[1])[0][0]]));
    lastMoves = AppState.nodes
      .filter(n => n.type === 'artist' && n.morphFrom && previousCluster.get(n.id) && successor.get(previousCluster.get(n.id)) !== clusterName(n))
      .sort((a, b) => (b.history?.plays || b.basePlays || 0) - (a.history?.plays || a.basePlays || 0));
    morphAnimation?.stop();
    if (reduceMotion.matches) { layout.morphT = 1; return; }
    showTrails(lastMoves.slice(0, MAX_TRAILS));
    layout.morphT = 0;
    morphAnimation = motionAnimate(0, 1, {
      type: 'spring', visualDuration: MORPH_SECONDS, bounce: 0,
      onUpdate: (t) => { layout.morphT = t; }
    });
  }

  const describeMoves = (moves) => {
    const top = moves[0];
    return `${plural(moves.length, 'artist')} moved to a new cluster, like ${top.name} → ${AppState.nodeMap.get(top.primarySunId)?.name}.`;
  };

  // One line per moving artist, from where it was to where it is now: bright at the
  // artist, dim at the old spot. Fades once the glide settles.
  let trails = null;
  function showTrails(movers) {
    if (trails) {
      scene.remove(trails);
      trails.geometry.dispose();
      trails.material.dispose();
      trails = null;
    }
    if (!movers.length) return;
    const positions = new Float32Array(movers.length * 6);
    const colors = new Float32Array(movers.length * 6);
    const color = new THREE.Color();
    movers.forEach((n, i) => {
      n.morphFrom.toArray(positions, i * 6);
      n.morphFrom.toArray(positions, i * 6 + 3);
      color.set(AppState.nodeMap.get(n.primarySunId)?.color || n.color);
      color.toArray(colors, i * 6 + 3);
      color.multiplyScalar(0.15).toArray(colors, i * 6);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    trails = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
    trails.userData = { movers, fadeStart: null };
    scene.add(trails);
  }

  function updateTrails(now) {
    if (!trails) return;
    const { movers } = trails.userData;
    const pos = trails.geometry.attributes.position;
    movers.forEach((n, i) => pos.setXYZ(i * 2 + 1, n.position.x, n.position.y, n.position.z));
    pos.needsUpdate = true;
    if (layout.morphT < 1) return;
    trails.userData.fadeStart ??= now;
    const left = 1 - (now - trails.userData.fadeStart) / TRAIL_FADE_MS;
    if (left <= 0) showTrails([]);
    else trails.material.opacity = 0.9 * left;
  }

  // The map refines itself as genres arrive, but only while you aren't exploring:
  // never mid-gesture, never with something selected.
  let lastInteraction = performance.now();
  ['pointerdown', 'wheel', 'keydown', 'touchstart'].forEach(type =>
    window.addEventListener(type, () => { lastInteraction = performance.now(); }, { passive: true }));
  const isIdle = () => !AppState.selectedNode && !hud.replayTimer && document.visibilityState === 'visible' &&
    performance.now() - lastInteraction > AUTO_REFINE_IDLE_MS;

  let enrichRun = 0;
  async function enrichInBackground(unenrichedArtists) {
    const run = ++enrichRun;
    let waitingToFetchCount = unenrichedArtists.length;
    let newlyResolvedForReloadCount = 0;

    const applyResolvedNow = async () => {
      enrichRun++;
      hud.updateEnrichmentStatus({ waitingCount: 0, readyOnReloadCount: 0 });
      await loadLive({ skipInitialEnrich: true, refine: true });
    };

    hud.updateEnrichmentStatus({
      waitingCount: waitingToFetchCount,
      readyOnReloadCount: newlyResolvedForReloadCount,
      onApply: applyResolvedNow
    });

    for (let i = 0; i < unenrichedArtists.length && run === enrichRun; i += ENRICH_BATCH) {
      const batch = unenrichedArtists.slice(i, i + ENRICH_BATCH);
      try {
        // Calls Wikidata/Last.fm/MusicBrainz ONLY (never Spotify)
        const { artistMeta } = await enrichArtists(batch);
        if (run !== enrichRun) return;

        const toSave = {};
        for (const item of batch) {
          const id = item.id || item;
          // An artist missing from the reply ran out of time (or Last.fm still owes a lookup):
          // leave it unsaved so the next load tries again instead of caching a blank.
          const meta = artistMeta?.[id];
          if (!meta) continue;
          toSave[id] = meta;
          const genres = meta.g || meta.genres;
          if (Array.isArray(genres) && genres.length > 0) {
            newlyResolvedForReloadCount++;
          }
        }
        saveArtistMeta(toSave);

        // Artists the server ran out of time for go to the back of the queue, as long as this
        // batch made progress (so a lookup that never succeeds cannot loop forever).
        const unresolved = batch.filter(item => !artistMeta?.[item.id || item]);
        if (unresolved.length && unresolved.length < batch.length) unenrichedArtists.push(...unresolved);

        waitingToFetchCount = Math.max(0, unenrichedArtists.length - (i + batch.length));
        const finished = waitingToFetchCount === 0;
        if (newlyResolvedForReloadCount > 0 && (finished || newlyResolvedForReloadCount >= AUTO_REFINE_EVERY) && isIdle()) {
          // The refined map starts its own lookup loop for whatever is still pending.
          applyResolvedNow();
          return;
        }
        hud.updateEnrichmentStatus({
          waitingCount: waitingToFetchCount,
          readyOnReloadCount: newlyResolvedForReloadCount,
          onApply: applyResolvedNow
        });
      } catch (err) {
        console.warn('Background genre lookup stopped:', err);
        break;
      }
    }
  }

  // ---------- Start ----------

  const authError = new URLSearchParams(window.location.search).get('auth_error');
  if (authError) window.history.replaceState({}, document.title, window.location.pathname);

  const [status, storedHistory, storedSnapshot] = await Promise.all([
    getAuthStatus(),
    loadStoredHistorySummary(),
    loadStoredUniverseSnapshot()
  ]);
  authStatus = status;
  AppState.historySummary = storedHistory;
  hud.setAuthStatus(authStatus);

  // ---------- Frame loop ----------

  let lastTime = performance.now();
  let frame = 0;

  function animate(now) {
    requestAnimationFrame(animate);
    const delta = Math.min(32, now - lastTime);
    lastTime = now;

    easeViewOffset();
    layout.step(AppState.nodes, delta);
    updateTrails(now);
    factory.updateArtistInstances(AppState.hoveredNode);
    factory.updateTrackInstances(AppState.hoveredNode);
    factory.updateEdgeGeometry(AppState.edges);
    factory.updatePulses(AppState.pulseParticles, layout.orbitMultiplier);
    factory.updateSolarShaders(now * 0.001);
    factory.updateFocus(AppState.selectedNode, AppState.nodes, AppState.edges, AppState.activeLens, AppState.hoveredNode);

    cameraController.update(AppState.selectedNode);

    if (frame++ % 3 === 0) {
      const hovered = pickNode(false);
      if (hovered !== AppState.hoveredNode) {
        AppState.hoveredNode = hovered;
        renderer.domElement.style.cursor = hovered ? 'pointer' : '';
      }
    }

    labelProjector.update(
      AppState.nodes,
      camera,
      AppState.selectedNode,
      AppState.nodeScaleMultiplier,
      AppState.layers.labels,
      AppState.activeLens,
      AppState.hoveredNode
    );
    renderer.render(scene, camera);
  }
  requestAnimationFrame(animate);

  if (storedSnapshot?.dataset && !authStatus.loggedIn && !authStatus.localHistory?.available) {
    AppState.isDemo = false;
    loadDataset(storedSnapshot.dataset);
    updateUniverseCaption(storedSnapshot.dataset);
  } else if ((authStatus.loggedIn && !authError) || authStatus.localHistory?.available || storedHistory) {
    await loadLive({ historySummary: storedHistory, useLocalHistory: true });
  } else {
    loadDemo();
    if (authError) hud.setNotice(`Spotify login didn’t complete: ${authError}`);
  }
  applyUrl();

  if (import.meta.env.DEV) window.__orbitune = { loadDataset, AppState };
}

window.addEventListener('DOMContentLoaded', () => {
  migrateLegacyLocalStorage();
  initApp().catch(err => console.error('Orbitune failed to start:', err));
});
