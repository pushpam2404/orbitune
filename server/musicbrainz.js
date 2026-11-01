// server/musicbrainz.js
/**
 * MusicBrainz lookup by Spotify artist URL. Two requests regardless of artist count:
 *   1. batch URL lookup (/ws/2/url?resource=...&resource=...) → MusicBrainz artist ids
 *   2. one artist search (arid:a OR arid:b ...) → country, area and community tags
 * MusicBrainz allows ~1 request/second per client, hence the pause between the two.
 */

import { usefulTags } from './tagFilter.js';

const MB_BASE = 'https://musicbrainz.org/ws/2';
const USER_AGENT = 'Orbitune/1.0 ( https://orbitune-music.vercel.app )';
const TIMEOUT_MS = 30000;
// MusicBrainz accepts up to 100 URL resources per lookup.
const CHUNK_SIZE = 100;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const cache = new Map();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function mbGet(path, params, signal, attempt = 0) {
  const url = `${MB_BASE}${path}?${params}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal });
  // 503 is MusicBrainz's rate limiter; back off and retry.
  if (res.status === 503 && attempt < 2) {
    await sleep(1500 * (attempt + 1));
    return mbGet(path, params, signal, attempt + 1);
  }
  if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);
  return res.json();
}

async function queryMusicBrainz(spotifyIds, signal) {
  // 1. Spotify URL → MusicBrainz artist id.
  const urlParams = new URLSearchParams({ fmt: 'json', inc: 'artist-rels' });
  spotifyIds.forEach(id => urlParams.append('resource', `https://open.spotify.com/artist/${id}`));
  const urlRes = await mbGet('/url', urlParams, signal);
  const urls = urlRes.urls || (urlRes.resource ? [urlRes] : []);

  const mbidToSpotify = new Map();
  urls.forEach(u => {
    const spotifyId = u.resource.split('/artist/')[1];
    const artist = (u.relations || []).find(r => r.artist)?.artist;
    if (spotifyId && artist) mbidToSpotify.set(artist.id, spotifyId);
  });
  if (mbidToSpotify.size === 0) return new Map();

  await sleep(1100);

  // 2. Country, area and tags for all matched artists in one search.
  const query = [...mbidToSpotify.keys()].map(id => `arid:${id}`).join(' OR ');
  const search = await mbGet('/artist', new URLSearchParams({ query, fmt: 'json', limit: '100' }), signal);

  const out = new Map();
  (search.artists || []).forEach(a => {
    const spotifyId = mbidToSpotify.get(a.id);
    if (!spotifyId) return;
    let country = null;
    try {
      country = a.country ? regionNames.of(a.country) : null;
    } catch {
      country = null;
    }
    out.set(spotifyId, {
      mbid: a.id,
      country,
      area: a.area?.name || null,
      tags: usefulTags(a.tags, a.name)
    });
  });
  return out;
}

/**
 * Returns { metaById: Map<spotifyId, { mbid, country, area, tags }>, error?: string }. Never throws.
 */
export async function fetchMusicBrainzArtistMeta(spotifyIds) {
  const metaById = new Map();
  const now = Date.now();
  const missing = [];
  spotifyIds.forEach(id => {
    const hit = cache.get(id);
    if (hit && now - hit.fetchedAt < CACHE_TTL_MS) {
      if (hit.meta) metaById.set(id, hit.meta);
    } else {
      missing.push(id);
    }
  });
  if (missing.length === 0) return { metaById };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const found = new Map();
    for (let i = 0; i < missing.length; i += CHUNK_SIZE) {
      if (i > 0) await sleep(1100);
      const part = await queryMusicBrainz(missing.slice(i, i + CHUNK_SIZE), controller.signal);
      part.forEach((v, k) => found.set(k, v));
    }
    missing.forEach(id => {
      const meta = found.get(id) || null;
      cache.set(id, { meta, fetchedAt: now });
      if (meta) metaById.set(id, meta);
    });
    return { metaById };
  } catch (err) {
    return { metaById, error: err.name === 'AbortError' ? 'MusicBrainz timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

const squashName = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const quoteLucene = (s) => `"${String(s).replace(/["\\]/g, ' ').trim()}"`;

/**
 * For artists without a Spotify id (history imports): find them on MusicBrainz through
 * one of their own songs, which tells same-name artists apart. One recording search
 * per artist (~1/s), then one artist search for country and tags of all matches.
 * @param {Array<{id, name, track}>} artists  most important first
 * @returns {Promise<{ metaById: Map<id, { mbid, country, area, tags }>, looked: number, error?: string }>} never throws
 */
export async function searchMusicBrainzByTrack(artists, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const mbidFor = new Map(); // mbid → our id
  let looked = 0;
  // Artists whose song was actually searched; the rest ran out of time and should be retried.
  const searched = new Set();
  try {
    for (const a of artists) {
      if (!a.track || Date.now() + 2500 > deadline) break;
      if (looked > 0) await sleep(1100);
      looked++;
      searched.add(a.id);
      const query = `recording:${quoteLucene(a.track)} AND artist:${quoteLucene(a.name)}`;
      const res = await mbGet('/recording', new URLSearchParams({ query, fmt: 'json', limit: '5' }), AbortSignal.timeout(8000));
      const want = squashName(a.name);
      for (const rec of res.recordings || []) {
        const credit = (rec['artist-credit'] || []).find(c => squashName(c.artist?.name || c.name) === want);
        if (credit?.artist?.id) { mbidFor.set(credit.artist.id, a.id); break; }
      }
    }
    if (!mbidFor.size || Date.now() + 1500 > deadline) return { metaById: new Map(), looked, searched };
    await sleep(1100);
    const query = [...mbidFor.keys()].map(id => `arid:${id}`).join(' OR ');
    const search = await mbGet('/artist', new URLSearchParams({ query, fmt: 'json', limit: '100' }), AbortSignal.timeout(8000));
    const metaById = new Map();
    (search.artists || []).forEach(m => {
      const id = mbidFor.get(m.id);
      if (!id) return;
      let country = null;
      try { country = m.country ? regionNames.of(m.country) : null; } catch { country = null; }
      metaById.set(id, { mbid: m.id, country, area: m.area?.name || null, tags: usefulTags(m.tags, m.name, { max: 8 }) });
    });
    return { metaById, looked, searched };
  } catch (err) {
    return { metaById: new Map(), looked, searched, error: `MusicBrainz song search failed (${err.message})` };
  }
}
