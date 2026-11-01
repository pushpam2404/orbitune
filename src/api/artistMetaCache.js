// src/api/artistMetaCache.js
/**
 * Remembers artist genres/countries the backend has already looked up, so each load
 * only asks Wikidata/MusicBrainz/Last.fm about artists it hasn't seen. This is the
 * app's only persistent cache; it lives in this browser, so no database is needed.
 * Entry shape: { g: string[] genres, c: string[] countries, t: lookup time (ms) }.
 */

const STORAGE_KEY = 'orbitune_artist_meta_v1';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// "Nothing found" is only remembered for a week: tags get added to Wikidata, MusicBrainz and Last.fm over time.
const EMPTY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function loadArtistMeta() {
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const now = Date.now();
    Object.keys(all).forEach(id => {
      const age = now - (all[id]?.t || 0);
      if (age > MAX_AGE_MS || (!all[id]?.g?.length && age > EMPTY_MAX_AGE_MS)) delete all[id];
    });
    return all;
  } catch {
    return {};
  }
}

export function saveArtistMeta(newEntries) {
  if (!newEntries || !Object.keys(newEntries).length) return;
  try {
    const all = loadArtistMeta();
    for (const [id, val] of Object.entries(newEntries)) {
      if (val && typeof val === 'object') {
        all[id] = {
          g: Array.isArray(val.g) ? val.g : [],
          c: Array.isArray(val.c) ? val.c : [],
          t: Number(val.t) || Date.now(),
          ...(val.l ? { l: Number(val.l) } : {}),
          ...(val.u ? { u: 1 } : {})
        };
      }
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch (quotaErr) {
      console.warn('[artistMetaCache] localStorage quota hit, pruning oldest empty entries:', quotaErr.message);
      const sortedKeys = Object.keys(all).sort((a, b) => {
        const aHas = all[a].g?.length ? 1 : 0;
        const bHas = all[b].g?.length ? 1 : 0;
        if (aHas !== bHas) return aHas - bHas;
        return (all[a].t || 0) - (all[b].t || 0);
      });
      const dropCount = Math.ceil(sortedKeys.length * 0.25);
      for (let i = 0; i < dropCount; i++) delete all[sortedKeys[i]];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    }
  } catch (err) {
    console.warn('[artistMetaCache] save failed:', err);
  }
}
