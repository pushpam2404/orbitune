# CLAUDE.md

This file provides comprehensive architectural and operational context to Claude Code and any AI coding agent working in this repository. Read this file before modifying code.

---

## 1. Project Overview

**Orbitune** is a Vite + Three.js interactive 3D music observatory that maps a user's Spotify listening history and live Spotify library into a 3D celestial universe:

* **Cluster Center Planet (`type: 'genre'`)**: A macro-genre or listening community discovered via Louvain community detection, rendered at the center of each cluster as a solid, non-glowing 3D planet (`SphereGeometry(node.baseRadius, 48, 48)` with `solarPlasmaShader.js`).
* **Artist Planet (`type: 'artist'`)**: An individual artist positioned via 3D UMAP similarity + spherical cloud layout + 3D collision clearance, rendered via `InstancedMesh` (`SphereGeometry(1, 32, 32)` with `planetShader.js`).
* **Song Moon (`type: 'track'`)**: An individual track orbiting its primary artist planet on an inclined orbit, rendered via `InstancedMesh` as a flat-faceted crystal (`IcosahedronGeometry(1, 0)` with `createMoonCrystalMaterial()` in `planetShader.js`).
* **Connection Lines & Focus Tubes**: `LineSegments` for overview connections (`artist_genre`, `artist_bridge`, `track_artist`, `track_collab`) plus weighted 3D `CylinderGeometry` tubes and orbital rings when focusing on a specific artist or song.

The frontend uses plain ES modules and vanilla JS/CSS (zero UI framework). A lightweight Express backend in `server/` (and `api/index.js` on Vercel) handles stateless Spotify OAuth, live signal fetching, and multi-source metadata enrichment (Wikidata, MusicBrainz, Last.fm).

---

## 2. Commands & Environment

```bash
npm install
npm run dev         # Express + Vite middleware (restarts on server/ changes)
npm run dev:client  # Frontend-only Vite server
npm run build       # Production Vite bundle -> dist/
npm start           # production (--production flag, works on Windows): Express serves dist/ + /api
```

* **Running Server Preservation**: If a local server is already running (e.g., on port `5180` or `5173`) and serving `dist/` or Vite middleware, **do not kill or restart the server** unless explicitly asked—run `npx vite build` (`./node_modules/.bin/vite build`) so the user can simply refresh without losing background enrichment progress.
* **Environment Variables (`.env`)**:
  * `SPOTIFY_CLIENT_ID` & `SPOTIFY_CLIENT_SECRET`: Spotify Developer App credentials.
  * `SESSION_SECRET`: Secret used to derive the AES-256-GCM key for the stateless `orbitune_session` cookie (falls back to `SPOTIFY_CLIENT_SECRET`).
  * `LASTFM_API_KEY`: Optional but recommended; enables Last.fm track/artist tag enrichment (`server/lastfm.js`).
  * `PORT`: Local server port (defaults to `5173`, often run on `5180`).
* **Spotify Loopback Rule**: Spotify rejects `http://localhost`; always use `http://127.0.0.1:<PORT>/api/auth/callback`.

---

## 3. Non-Negotiable Architectural & Visual Invariants

Any AI agent modifying Orbitune **must** preserve these invariants:

### 3.1 Browser-Side History Assembly (Vercel 4.5 MB Limit Defense)
* **Never** `POST` raw streaming history files or large `historySummary` payloads to `/api/universe`. Vercel serverless functions reject payloads over 4.5 MB with `HTTP 413 Payload Too Large`.
* When browser-imported history (`historySummary`) or cached Spotify signals are used, `src/api/backendClient.js` (`buildBrowserHistoryUniverse`) runs `mergeSignalsAndRank` and `assembleUniverseFromSignals` (`src/etl/universeAssembler.js`) **entirely in the browser**.
* When logged into Spotify, `/api/universe` is called with `{ signalsOnly: true, useLocalHistory: false }` so the server returns only lightweight Spotify OAuth signals.

### 3.2 Spotify Rate-Limit Defense (HTTP 429 Prevention)
* **Never** call the Spotify Web API inside background enrichment loops.
* Live Spotify OAuth signals (`topArtistsByRange`, `topTracksByRange`, `recent`, `saved`) are cached in `localStorage` under `orbitune_spotify_signals_v1` for **6 hours** (`SPOTIFY_CACHE_TTL_MS` in `src/api/backendClient.js`).
* Logged-in loads always take the browser path (`buildBrowserHistoryUniverse`), which reads/writes that cache. `fetchUniverse` only sends a logged-in load to the full server path when the server has a local history folder (`/api/history/status`, local dev), because the server path never fills the cache and would call Spotify on every reload.
* All artist genre/country enrichment goes exclusively through `POST /api/enrich` (`server/enrich.js` → Wikidata SPARQL, MusicBrainz, Last.fm) and is cached per artist in `localStorage` (`src/api/artistMetaCache.js`).
* **Zero Hardcoding**: Never add hardcoded artist-to-genre or artist-to-country lookup tables.

### 3.3 100% Opaque 3D Celestial Bodies & Non-Glowing Central Cluster Planets
* **No Translucent Soap Bubbles**: `createPlanetMaterial()`, `createMoonCrystalMaterial()` (`src/renderer/shaders/planetShader.js`), and `createSolarShaderMaterial()` (`src/renderer/shaders/solarPlasmaShader.js`) must all use `transparent: false`, `depthWrite: true`, and `depthTest: true`. Never toggle `depthWrite = false` on `artistMesh`, `trackMesh`, or `sphereMesh` during focus or lens modes.
* **Solid, Non-Glowing Central Cluster Planet**: Every cluster has a solid 3D planet at its center (`buildGenreSun` in `src/renderer/celestialFactory.js`). Do **not** attach additive glow sprites (corona), nebula clouds, vertex-wobble plasma halos, or post-processing bloom. There is no post-processing at all: the frame loop calls `renderer.render(scene, camera)` directly.

### 3.4 Crisp Black Border on Light-Colored Clusters
* Light-colored clusters (e.g., pastel pink, lime green, mint, sky blue, yellow, peach, lavender) blend together when nodes overlap unless separated by a dark outline.
* `solarPlasmaShader.js` and `planetShader.js` compute a screen-space silhouette outline using `radial = sqrt(max(0.0, 1.0 - ndotv * ndotv))` and `fwidth(radial)`, mixing the outer silhouette edge toward near-black (`vec3(0.012, 0.015, 0.025)`) with extra width/strength on higher-luminance cluster colors (`isLight`).
* UI indicators (`.cluster-swatch`, `.label-dot`, `.chip-dot` in `src/style.css`) also carry a `1.5px solid rgba(0, 0, 0, 0.88)` border with no blurry colored box-shadow on swatches.

### 3.5 Distinct Cluster Palette (OKLCH Golden-Angle)
* `src/config/genreTaxonomy.js` → `getDistinctClusterColor(index)` steps the hue by the `137.5°` golden angle in **OKLCH** (gamut-clamped by `oklchToHex`), so each new cluster lands in the widest unused hue gap.
* Clusters are sorted by size/plays descending in `server/clusterNaming.js` and `src/etl/graphNormalizer.js` before colors are assigned, so the largest clusters get the most distinct hues.

### 3.6 Strict Lens & Focus Culling (Zero Orphan Lines or Floating Labels)
* **In `CelestialFactory.updateFocus` (`src/renderer/celestialFactory.js`)**:
  * When a Time/Memory Lens (`activeLens !== 'all'`) is active (either in Galaxy Overview or inside a selected Cluster), **only** nodes that match the active lens (`lensMatch.has(n.id)`) or are the primary parent artist of a lens-matched track (`lensArtistHasMatchTrack.has(n.id)`) remain visible (`focusTarget >= 1.1`). All non-matching artists and tracks are strictly culled (`focusTarget = 0.0, lensScale = 0.0`).
  * **Never** use a fallback like `!clusterHasLensMatch` that lights up all nodes in a cluster when 0 nodes match the active lens—if 0 artists in a cluster match `Current rotation`, 0 artists should appear in 3D, matching `"No artists in this cluster match that memory filter."` in the side panel.
  * When an Artist or Song is selected (`activeNode.type === 'artist' | 'track'`), unrelated song moons are culled (`focusTarget = 0.0, lensScale = 0.0`), while unrelated background artist planets and cluster centers dim into quiet matte spheres (`focusTarget = DIM_PLANET_FOCUS`) and are discarded in the fragment shader if they pass directly in front of the camera lens (`camDist < 28.0 && centerDist < 0.38`).
  * **Hard Edge Invariant**: An edge is never drawn if either endpoint has `focusTarget < 0.65` or `lensScale <= 0.01`.
* **In `LabelProjector` (`src/renderer/labelProjector.js`)**:
  * Never show an HTML label for any artist or track with `focusTarget < 0.65` or `lensScale <= 0.01`.
  * When `hasLens` is true (including inside Cluster Focus Mode), never label a node unless `nodeMatchesLens(node, activeLens)` is `true`.
* **Synchronized Cluster Explorer (`src/ui/detailPanel.js`)**:
  * Clicking an inline memory/era filter pill inside the Cluster detail panel invokes `onSetLens(f.id)` so the 3D canvas, top lens bar, and side-panel list always stay in sync.
* **Data-driven lenses (`src/config/lenses.js`)**: the lens bar, cluster filters and artist song filters all come from `availableLenses(nodes)`: the four memory lenses plus one `era_YYYY` / `early_YYYY` lens per year present in the history (years up to 2022 share `era_2020_2022`). Never hardcode years; a lens that matches nothing is not shown.
* **Time-lapse (`Hud.toggleReplay`)**: "Replay years" steps through `year_YYYY` lenses (anything played that calendar year, `nodeMatchesLens`), so it reuses lens culling; the caption shows the year and artist count. `year_` lenses never go in the URL, and the map doesn't refine mid-replay.
* **Visible refining (`src/main.js` → `startMorph`, `showTrails`)**: when the map refines, each old cluster's successor is the new cluster most of its artists landed in; artists that went elsewhere get a fading trail (up to `MAX_TRAILS`) and the notice names how many moved.
* **URL state (`src/main.js` → `writeUrl` / `applyUrl`)**: the selected node and active lens live in `?node=&lens=`, so Back/Forward step through views and links reopen them. Unknown ids in a link are ignored and dropped from the URL.

### 3.7 3D Planet Collision Clearance
* `src/physics/galaxyLayout.js` runs `resolveClusterArtistOverlaps` per cluster and `resolveArtistCollisions(artists, 18)` globally so no two artist planets overlap and no artist clips into its central cluster planet (`coreRadius`).

### 3.8 Data-Driven Genres, Clustering & Naming
* **Dynamic Resolution & Cluster Scaling (`server/clustering.js`)**:
  * Louvain resolution dynamically scales with library volume ($1.3$ to $2.25$) so large libraries naturally resolve into authentic sub-communities (Hindie, Filmi, Punjabi & Bhangra, Desi Hip-Hop, Synthpop, Ambient) rather than collapsing into monolithic blobs.
  * Cluster count dynamically scales from 8 to 22 ($\approx 8 + \sqrt{\max(0, \text{artists} - 100)} \times 0.21$).
  * Raising the resolution was tested against the taste tests and lowers ARI (base 1.6: 0.672, 2.0: 0.633, 2.5: 0.565 vs 0.683), so keep it unless the tests say otherwise. Few clusters on sparse data (e.g. Spotify-only, 515 artists → 5) is Louvain finding few communities, not over-merging; the browser console line `[Orbitune] clustering:` shows `louvainGroups`, `genreGroups` (after dropping genre-less groups), `merges` (duplicate names) and `genreSource`.
* **No hardcoded genre knowledge.** There are no genre families, alias tables, mood/junk/broad-tag lists, demonym tables or occupation→genre maps. Don't add any. Every decision comes from public data or from the library itself:
  * **Which tags are genres** (`src/etl/genreSignals.js` → `selectGenreTags`): a tag is a genre if Wikidata or MusicBrainz lists it as one (catalogue from `server/genreVocabulary.js`, served CDN-cached at `GET /api/genre-vocabulary`, kept 7 days in `localStorage` as `orbitune_genre_vocab_v1`); it's a home country if it matches an Intl region name; it's a language scene ("tamil", "haryanvi") if it matches an Intl language name; any other tag counts only if it passes the coherence test (the artists carrying it sound alike well above the library's background). Coherent-only tags help grouping but can't name clusters (`nameable`). Each catalogue genre is displayed in the listener's own most-used spelling.
  * **How genres relate** (`server/clustering.js` → `buildTagVectors`): TF-IDF over genre + `@country` tags, expanded with tag relatedness learned from co-occurrence in the library (PPMI, `RELATED_WEIGHT`).
  * **Naming** (`server/clusterNaming.js`): BERTopic-style class-based TF-IDF over nameable tags, weighted by √listening, with a consensus floor (`MIN_SUPPORT` of the cluster's listening, at least 2 artists). Never `Artist & Co.`, moods, invented themes, or made-up audio features (there are none: the old hash-based `estimatedFeatures` were removed). If a group can't get an unused real-genre name it returns `duplicateOf` and the groups merge.
  * **Genre groups** (`clusterArtists`): a Louvain group exists only if `MIN_GENRE_SHARE` (25%) of its listening has real genres; otherwise its artists join the most similar genre group (co-listening, collaborations, tags) or **Genre Unknown**. Artists with no signal at all also go to Genre Unknown; never place them by guesswork.
* **Same-name artists (`server/enrich.js`)**: history-only artists whose Last.fm tags are missing or came from the shared artist page are looked up on MusicBrainz through one of their own songs (`searchMusicBrainzByTrack`). If Last.fm's artist page links a different MusicBrainz artist (`lastfmArtistMbid`), its tags are dropped. Tags resting only on the artist page are flagged `u`, and `doubtGenresAgainstContext` drops them when they fit none of the artists you play alongside it; the detail panel then says so (`doubtedTags`).
* **Taste tests (`tests/tastes/`)**: `generate.mjs` builds Spotify-format histories for 8 very different listeners from Last.fm's public charts, `truth.mjs` records which chart each artist came from, and `run.mjs` runs the full pipeline and reports group names plus purity / Adjusted Rand Index against that truth. Run `node tests/tastes/run.mjs` after any change to tags, similarity, clustering or naming. Fixtures and lookup cache live in the gitignored `tests/tastes/.cache/`. Current mean: ARI 0.683, purity 0.855 (the old hardcoded pipeline: 0.524 / 0.731).
* **Metadata Caching & POST Ceiling (`src/api/backendClient.js`, `server/enrich.js`, `src/api/artistMetaCache.js`)**:
  * `MAX_POST_KNOWN_META` is set to 8,000 so large libraries transmit full metadata to `/api/universe` without truncation loops.
  * `isFreshMeta` treats all cached entries with valid genres as permanently fresh.
  * `saveArtistMeta` automatically recovers from `localStorage` quota errors via oldest-entry pruning.

---

## 4. End-to-End Data & Rendering Flow

1. **Ingestion & Storage**:
   * **Spotify OAuth**: `/api/auth/login` → `/api/auth/callback` sets the encrypted `orbitune_session` cookie. `src/api/backendClient.js` fetches live signals (`signalsOnly: true`) and caches them in `localStorage` for 6 hours.
   * **Extended Streaming History**: Users import `Streaming_History_Audio_*.json` / `StreamingHistory_music_*.json`, `.json` snapshots, or Spotify's export `.zip` as-is via the **History** modal (`src/ui/hud.js`). Zips are read in the browser by `src/api/zipReader.js` (native `DecompressionStream`), because Windows doesn't auto-unzip downloads like Safari; dropped folders are walked with `webkitGetAsEntry`. `src/api/historyStorage.js` parses events via `parseStreamingEvents` (`src/etl/historyParser.js`) and persists `historySummary` in IndexedDB (`orbitune_history_db`).
   * **Local Folder Auto-Detection**: `server/historyLoader.js` also detects a local `Spotify Extended Streaming History/` directory when running locally.
2. **Universe Assembly & Clustering (`src/etl/universeAssembler.js` + `server/clustering.js`)**:
   * `mergeSignalsAndRank` merges Spotify top charts, recent plays, Liked Songs, and `historySummary`, deduplicating tracks by normalized primary artist + cleaned track title and extracting featured collaborators.
   * `assembleUniverseFromSignals` combines cached/enriched genre & country metadata, builds session co-listening pairs (`listenedTogether`), runs `clusterArtists` (TF-IDF + collaboration + co-listening similarity graph → seeded Louvain communities → seeded 3D UMAP embedding), and names clusters via `describeClusters` (`server/clusterNaming.js`).
3. **Graph Normalization & Layout (`src/etl/graphNormalizer.js` + `src/physics/galaxyLayout.js`)**:
   * `buildUniverseGraph` log-normalizes node radii (`TIER_BOUNDS`), assigns `getDistinctClusterColor` colors by cluster size, and builds edges (`artist_genre`, `artist_bridge`, `track_artist`, `track_collab`).
   * `GalaxyLayoutEngine.initializeNodePositions` seriates clusters by affinity on a Fibonacci sphere (`computeBalancedClusterAnchors`), blends artist UMAP offsets with spherical shells, runs 3D collision resolution, and assigns inclined lunar orbits to tracks.
4. **Frame Loop (`src/main.js` → `animate`)**:
   * `easeViewOffset()` centers the 3D viewport beside the desktop side panel or above the mobile bottom sheet.
   * `layout.step()` updates orbiting song moon positions.
   * `factory.updateArtistInstances()`, `updateTrackInstances()`, `updateEdgeGeometry()`, `updatePulses()`, `updateSolarShaders()`, and `updateFocus()` update GPU buffers and focus highlights.
   * `pickNode()` raycasts every 3rd frame for hover states and handles multi-touch-safe tap/double-tap selection (`pointerdown`/`pointerup` ignores pinch-to-zoom gestures).
   * `labelProjector.update()` projects and overlap-culls DOM labels, and `renderer.render()` draws the frame.
