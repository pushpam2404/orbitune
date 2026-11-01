// server/lastfm.js
/**
 * Last.fm community tags (artist.getTopTags): the best genre coverage for independent
 * and regional artists that Wikidata/MusicBrainz don't describe. One request per
 * artist, so lookups run under a time budget, most-listened artists first; the
 * browser keeps what was learned (see artistMetaCache.js) so later loads only ask
 * about the rest.
 *
 * Disambiguation: Last.fm merges same-name artists into one page ("King" mixes several
 * artists' tags), so we first ask for the tags of the artist's most-played *track* in
 * this library, which pins down the right one. Only if that track has no tags do we
 * fall back to the artist page.
 * Requires LASTFM_API_KEY; without it this is a no-op.
 */
import { usefulTags } from './tagFilter.js';

const API = 'https://ws.audioscrobbler.com/2.0/';
const CONCURRENCY = 8;
// ~20 requests/s during one load's burst (≤ ~26 s) averages under Last.fm's
// 5 requests/s over 5 minutes.
const MIN_INTERVAL_PER_WORKER_MS = 400;
const REQUEST_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Last.fm tag counts are relative weights (0–100); below this they're noise.
const MIN_TAG_WEIGHT = 8;

const cache = new Map();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let warnedInvalidKey = false;

export function isLastfmConfigured() {
  const k = (process.env.LASTFM_API_KEY || '').trim();
  // A valid Last.fm API key is a 32-character hexadecimal MD5 string
  return Boolean(k && k.length >= 24 && /^[0-9a-fA-F]+$/.test(k));
}

export function getLastfmConfigWarning() {
  const k = (process.env.LASTFM_API_KEY || '').trim();
  if (k && !isLastfmConfigured()) {
    return `LASTFM_API_KEY in .env ("${k}") is not a valid 32-character hex key (it looks like a username or placeholder). Get a free API key at https://www.last.fm/api/account/create.`;
  }
  return null;
}

// A track needs at least this many useful tags to be trusted over the artist page.
const MIN_TRACK_TAGS = 1;

/** "Song (feat. X) - Remastered 2011" → "Song" */
const cleanTrackName = (t) => t.replace(/\s*[([].*?[)\]]/g, '').replace(/\s+-\s+.*$/, '').trim();

async function lastfmTags(method, params, artistName) {
  const key = (process.env.LASTFM_API_KEY || '').trim();
  const query = new URLSearchParams({ method, api_key: key, format: 'json', autocorrect: '1', ...params });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API}?${query}`, { signal: controller.signal, headers: { 'User-Agent': 'Orbitune/1.0' } });
    const json = await res.json().catch(() => ({}));
    if (json.error === 29) throw Object.assign(new Error('rate limited'), { rateLimited: true });
    if (json.error === 10 || json.error === 4) {
      throw Object.assign(new Error(`Invalid Last.fm API key (${json.message || 'error 10'}). Please obtain a 32-character key at https://www.last.fm/api/account/create`), { invalidKey: true });
    }
    if (json.error) return [];
    const tags = (json.toptags?.tag || []).map(t => ({ name: t.name, count: Number(t.count) }));
    return usefulTags(tags, artistName, { max: 10, minCount: MIN_TAG_WEIGHT });
  } finally {
    clearTimeout(timer);
  }
}

/** Track tags first (unambiguous), artist page as the fallback. */
async function topTags({ name, track }) {
  if (track) {
    const trackTags = await lastfmTags('track.gettoptags', { artist: name, track: cleanTrackName(track) }, name);
    if (trackTags.length >= MIN_TRACK_TAGS) return { tags: trackTags, via: 'track' };
  }
  return { tags: await lastfmTags('artist.gettoptags', { artist: name }, name), via: 'artist' };
}

/**
 * @param {Array<{id, name, track?}>} artists  in priority order; track = their most-played song here
 * @param {number} budgetMs  stop starting new lookups after this long
 * @returns {{ tagsById: Map<id, string[]>, viaById: Map<id, 'track'|'artist'>, looked: number, viaTrack: number, skipped: number, error?: string }}
 */
export async function fetchLastfmTags(artists, budgetMs) {
  const tagsById = new Map();
  const viaById = new Map();
  const warning = getLastfmConfigWarning();
  if (warning && !warnedInvalidKey) {
    warnedInvalidKey = true;
    console.warn(`[lastfm] ${warning}`);
  }
  if (!isLastfmConfigured() || artists.length === 0) {
    return { tagsById, viaById, looked: 0, viaTrack: 0, skipped: artists.length, ...(warning ? { error: warning } : {}) };
  }

  const now = Date.now();
  const queue = [];
  artists.forEach(a => {
    const hit = cache.get(a.id);
    if (hit && now - hit.fetchedAt < CACHE_TTL_MS) {
      tagsById.set(a.id, hit.tags);
      viaById.set(a.id, hit.via);
    }
    else queue.push(a);
  });

  const deadline = now + budgetMs;
  let looked = 0;
  let viaTrack = 0;
  let rateLimited = false;
  let invalidKeyError = null;
  let next = 0;
  const worker = async () => {
    while (next < queue.length && Date.now() < deadline && !rateLimited && !invalidKeyError) {
      const a = queue[next++];
      const started = Date.now();
      try {
        const { tags, via } = await topTags(a);
        cache.set(a.id, { tags, via, fetchedAt: Date.now() });
        tagsById.set(a.id, tags);
        viaById.set(a.id, via);
        looked++;
        if (via === 'track') viaTrack++;
      } catch (err) {
        if (err.rateLimited) {
          rateLimited = true;
        } else if (err.invalidKey) {
          invalidKeyError = err.message;
          console.warn('[lastfm]', err.message);
        }
      }
      const wait = MIN_INTERVAL_PER_WORKER_MS - (Date.now() - started);
      if (wait > 0) await sleep(wait);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const skipped = queue.length - looked;
  const errorMsg = invalidKeyError || (rateLimited ? 'Last.fm rate limit reached' : undefined);
  return { tagsById, viaById, looked, viaTrack, skipped, ...(errorMsg ? { error: errorMsg } : {}) };
}

/**
 * MusicBrainz id of the artist a Last.fm artist page describes, or null when Last.fm
 * doesn't link one. Never throws.
 */
export async function lastfmArtistMbid(name) {
  const key = (process.env.LASTFM_API_KEY || '').trim();
  if (!isLastfmConfigured()) return null;
  const query = new URLSearchParams({ method: 'artist.getinfo', api_key: key, format: 'json', autocorrect: '1', artist: name });
  try {
    const res = await fetch(`${API}?${query}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { 'User-Agent': 'Orbitune/1.0' } });
    const json = await res.json().catch(() => ({}));
    return json.artist?.mbid || null;
  } catch {
    return null;
  }
}
