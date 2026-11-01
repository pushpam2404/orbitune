// server/genreVocabulary.js
/**
 * The music-genre catalogue, from public curated sources instead of hand-made lists:
 *   - Wikidata: every item that is an instance of "music genre" (or of a subclass of
 *     it), with its English label and aliases ("kpop" → "K-pop").
 *   - MusicBrainz: the editor-curated genre list.
 * Returned as { alias → canonical name } on squashed keys (see squashTag). Fetched at
 * most once a week per server instance; /api/genre-vocabulary is also CDN-cached.
 */
import { squashTag } from '../src/etl/genreSignals.js';

const USER_AGENT = 'Orbitune/1.0 ( https://orbitune-music.vercel.app )';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WIKIDATA_QUERY = `SELECT ?g ?label ?alias WHERE {
  ?g wdt:P31/wdt:P279* wd:Q188451 .
  ?g rdfs:label ?label . FILTER(LANG(?label) = "en")
  OPTIONAL { ?g skos:altLabel ?alias . FILTER(LANG(?alias) = "en") }
}`;

let cached = null;
let inFlight = null;

async function fetchWikidata() {
  const url = `https://query.wikidata.org/sparql?${new URLSearchParams({ query: WIKIDATA_QUERY })}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/csv' }, signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  const rows = (await res.text()).split('\n').slice(1);
  const pairs = [];
  for (const row of rows) {
    // CSV: g,label,alias (fields may be quoted)
    const cols = row.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map(c => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')) || [];
    const [, label, alias] = cols;
    if (!label) continue;
    pairs.push([label, label]);
    if (alias) pairs.push([alias, label]);
  }
  return pairs;
}

async function fetchMusicBrainz() {
  const res = await fetch('https://musicbrainz.org/ws/2/genre/all?fmt=txt', { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);
  return (await res.text()).split('\n').map(s => s.trim()).filter(Boolean).map(g => [g, g]);
}

/** @returns {Promise<{ aliases: Record<string, string>, sources: string[], fetchedAt: number } | null>} never throws */
export async function getGenreVocabulary() {
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const [wd, mb] = await Promise.allSettled([fetchWikidata(), fetchMusicBrainz()]);
    const aliases = {};
    const sources = [];
    // MusicBrainz names first so its spelling wins as the canonical form.
    if (mb.status === 'fulfilled') {
      sources.push('musicbrainz');
      mb.value.forEach(([a, c]) => { aliases[squashTag(a)] ??= c.toLowerCase(); });
    }
    if (wd.status === 'fulfilled') {
      sources.push('wikidata');
      wd.value.forEach(([a, c]) => {
        const canonical = aliases[squashTag(c)] || c.toLowerCase().replace(/ music$/, '');
        aliases[squashTag(a)] ??= canonical;
      });
    }
    delete aliases[''];
    const result = sources.length ? { aliases, sources, fetchedAt: Date.now() } : null;
    if (result) cached = result;
    return result;
  })().finally(() => { inFlight = null; });
  return inFlight;
}
