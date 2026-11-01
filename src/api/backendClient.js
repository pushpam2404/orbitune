// src/api/backendClient.js
/**
 * Thin client for the Orbitune backend (server/). Spotify tokens never reach the browser.
 * When browser-imported `historySummary` or cached Spotify signals are present, universe
 * merging & clustering runs directly in the browser so multi-megabyte history payloads
 * never hit serverless request/response limits (HTTP 413 on Vercel) and reloads read
 * from the 6-hour local Spotify signal cache (0 repeat Spotify API calls).
 */

export const SPOTIFY_LOGIN_URL = '/api/auth/login';

const SPOTIFY_SIGNAL_CACHE_KEY = 'orbitune_spotify_signals_v1';
const SPOTIFY_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — protects against Spotify 429 rate limits

const INITIAL_CLIENT_ENRICH_BATCH = 50;
const INITIAL_CLIENT_ENRICH_CONCURRENCY = 3; // Top 150 artists enriched in parallel (~2.5 KB/req) before first render
const MAX_POST_KNOWN_META = 8000;

export function getCachedSpotifySignals(forceRefresh = false) {
  if (forceRefresh) return null;
  try {
    const raw = localStorage.getItem(SPOTIFY_SIGNAL_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.timestamp > SPOTIFY_CACHE_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function setCachedSpotifySignals(data) {
  try {
    if (!data) {
      localStorage.removeItem(SPOTIFY_SIGNAL_CACHE_KEY);
      return;
    }
    localStorage.setItem(
      SPOTIFY_SIGNAL_CACHE_KEY,
      JSON.stringify({ timestamp: Date.now(), data })
    );
  } catch (e) {
    console.warn('Could not cache Spotify signals in localStorage:', e);
  }
}

export function clearCachedSpotifySignals() {
  try {
    localStorage.removeItem(SPOTIFY_SIGNAL_CACHE_KEY);
  } catch {
    // Ignore
  }
}

const VOCAB_KEY = 'orbitune_genre_vocab_v1';
const VOCAB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The genre catalogue (Wikidata + MusicBrainz, served by /api/genre-vocabulary), kept
 * in this browser for a week. Falls back to a stale copy, then to null (every tag is
 * then treated as a genre).
 */
async function loadGenreVocabulary() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(VOCAB_KEY) || 'null'); } catch { stored = null; }
  if (stored?.aliases && Date.now() - stored.fetchedAt < VOCAB_TTL_MS) return stored;
  try {
    const fresh = await requestJson('/api/genre-vocabulary');
    try { localStorage.setItem(VOCAB_KEY, JSON.stringify(fresh)); } catch { /* storage full: use it this once */ }
    return fresh;
  } catch {
    return stored?.aliases ? stored : null;
  }
}

async function requestJson(url, options) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/** Keeps knownMeta payload well under serverless body limits (< 60 KB). */
function compactKnownMetaForPost(knownMeta = {}) {
  const entries = Object.entries(knownMeta || {});
  if (entries.length <= MAX_POST_KNOWN_META) return knownMeta;
  entries.sort((a, b) => {
    const aHas = Array.isArray(a[1]?.g) && a[1].g.length ? 1 : 0;
    const bHas = Array.isArray(b[1]?.g) && b[1].g.length ? 1 : 0;
    if (bHas !== aHas) return bHas - aHas;
    return (Number(b[1]?.t) || 0) - (Number(a[1]?.t) || 0);
  });
  return Object.fromEntries(entries.slice(0, MAX_POST_KNOWN_META));
}

export async function getAuthStatus() {
  try {
    return await requestJson('/api/auth/status');
  } catch {
    // Backend not running (e.g. plain `vite` dev server); presets and client history still work.
    return { configured: false, loggedIn: false, backendUnavailable: true };
  }
}

export async function getHistoryStatus() {
  try {
    return await requestJson('/api/history/status');
  } catch {
    return { available: false };
  }
}

/** Looks up genres for up to 50 artists (Wikidata / MusicBrainz / Last.fm ONLY, never Spotify). */
export function enrichArtists(artists) {
  return requestJson('/api/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ artists, allowHistoryEnrich: true })
  });
}

/**
 * Builds the complete universe directly in the browser when `historySummary` is present
 * or when cached/live Spotify signals are used, fetching only lightweight `/api/enrich`
 * genre batches (~2 KB each) and caching Spotify OAuth signals for 6 hours.
 */
async function buildBrowserHistoryUniverse(
  knownMeta = {},
  {
    historySummary = null,
    loggedIn = false,
    skipInitialEnrich = false,
    spotifyApiOnly = false,
    forceSpotifyRefresh = false
  } = {}
) {
  // Clustering pulls in UMAP and Louvain, which the first screen does not need.
  const { mergeSignalsAndRank, assembleUniverseFromSignals } = await import('../etl/universeAssembler.js');
  const diagnostics = { warnings: [], clientBuilt: true };
  let liveSignals = {
    topArtistsByRange: [[], [], []],
    topTracksByRange: [[], [], []],
    recent: [],
    saved: [],
    connectedSpotify: false
  };

  if (loggedIn) {
    const cachedSignals = getCachedSpotifySignals(forceSpotifyRefresh);
    if (cachedSignals && cachedSignals.connectedSpotify) {
      liveSignals = cachedSignals;
      diagnostics.spotifySignalsCached = true;
    } else {
      try {
        const res = await requestJson('/api/universe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signalsOnly: true, useLocalHistory: false })
        });
        if (res?.liveSignals) {
          liveSignals = res.liveSignals;
          if (liveSignals.connectedSpotify) {
            setCachedSpotifySignals(liveSignals);
          }
        }
        if (res?.diagnostics?.warnings?.length) diagnostics.warnings.push(...res.diagnostics.warnings);
      } catch (err) {
        if (!historySummary?.validPlays) throw err;
        diagnostics.warnings.push(`Live Spotify fetch unavailable (${err.message}); showing your streaming history universe.`);
      }
    }
  }

  const mergedKnown = { ...knownMeta };
  const state = mergeSignalsAndRank({
    ...liveSignals,
    historySummary,
    spotifyApiOnly,
    knownMeta: mergedKnown
  });

  const newlyEnrichedMeta = {};
  const vocabularyPromise = loadGenreVocabulary();
  if (!skipInitialEnrich && state.unknown.length > 0) {
    const batches = [];
    for (let i = 0; i < INITIAL_CLIENT_ENRICH_CONCURRENCY; i++) {
      const slice = state.unknown.slice(i * INITIAL_CLIENT_ENRICH_BATCH, (i + 1) * INITIAL_CLIENT_ENRICH_BATCH);
      if (slice.length) batches.push(slice);
    }
    try {
      const results = await Promise.all(
        batches.map(batch => enrichArtists(batch).catch(() => ({ artistMeta: {}, warnings: [] })))
      );
      results.forEach((r, idx) => {
        const batch = batches[idx] || [];
        const map = r?.artistMeta || {};
        for (const a of batch) {
          // Artists missing from the reply were not finished (out of time); leave them pending
          // so a later pass retries them rather than remembering a blank.
          const entry = map[a.id];
          if (!entry) continue;
          newlyEnrichedMeta[a.id] = entry;
          mergedKnown[a.id] = entry;
        }
      });
    } catch {
      // Offline or rate-limited; continue with cached genres + co-listening clustering
    }
  }

  const assembled = assembleUniverseFromSignals(state, {
    knownMeta: mergedKnown,
    vocabulary: await vocabularyPromise,
    diagnostics
  });

  return {
    dataset: assembled.dataset,
    artistMeta: { ...newlyEnrichedMeta, ...assembled.artistMeta },
    diagnostics: assembled.diagnostics
  };
}

/**
 * Resolves to { dataset, artistMeta, diagnostics }; dataset is null when Spotify has no
 * data yet. knownMeta is what earlier loads learned (see artistMetaCache.js).
 * historySummary is optional browser-imported streaming history.
 */
export async function fetchUniverse(
  knownMeta = {},
  {
    historySummary = null,
    useLocalHistory = true,
    loggedIn = false,
    skipInitialEnrich = false,
    spotifyApiOnly = false,
    forceSpotifyRefresh = false
  } = {}
) {
  const hasCachedSpotify = loggedIn && Boolean(getCachedSpotifySignals(forceSpotifyRefresh));
  // The server path only adds something when the server has a local history folder
  // (local dev). Otherwise logged-in loads go through the browser path, which caches
  // Spotify data for 6 hours instead of calling Spotify on every reload.
  const serverHistory = loggedIn && useLocalHistory && !spotifyApiOnly && !hasCachedSpotify
    ? (await getHistoryStatus()).available
    : false;
  if (
    (historySummary?.isOrbituneHistorySummary && !spotifyApiOnly) ||
    (loggedIn && (spotifyApiOnly || !useLocalHistory || hasCachedSpotify || !serverHistory))
  ) {
    return buildBrowserHistoryUniverse(knownMeta, {
      historySummary: spotifyApiOnly ? null : historySummary,
      loggedIn,
      skipInitialEnrich,
      spotifyApiOnly,
      forceSpotifyRefresh
    });
  }

  return requestJson('/api/universe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      knownMeta: compactKnownMetaForPost(knownMeta),
      useLocalHistory: spotifyApiOnly ? false : useLocalHistory,
      spotifyApiOnly
    })
  });
}

export function logout() {
  clearCachedSpotifySignals();
  return requestJson('/api/auth/logout', { method: 'POST' });
}
