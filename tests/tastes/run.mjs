// Runs the full Orbitune pipeline on each generated listener: parse → genre lookups
// (Wikidata/MusicBrainz/Last.fm, cached in .cache/meta.json) → clustering → names.
// Usage: node tests/tastes/run.mjs [listener ...]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(path.join(here, '../../.env'));
const { parseStreamingEvents } = await import('../../src/etl/historyParser.js');
const { mergeSignalsAndRank, assembleUniverseFromSignals } = await import('../../src/etl/universeAssembler.js');
const { enrichArtists, toCacheEntry } = await import('../../server/enrich.js');
const { getGenreVocabulary } = await import('../../server/genreVocabulary.js');
const vocabulary = await getGenreVocabulary();
const truthFile = path.join(here, '.cache/truth.json');
const truth = fs.existsSync(truthFile) ? JSON.parse(fs.readFileSync(truthFile)) : {};

// Agreement with the chart each artist came from: purity and Adjusted Rand Index.
function score(listener, artists) {
  const t = truth[listener] || {};
  const rows = artists.filter(a => t[a.name] && a.genres[0]).map(a => [a.genres[0], t[a.name]]);
  if (rows.length < 2) return null;
  const choose2 = (x) => x * (x - 1) / 2;
  const cont = new Map(), byC = new Map(), byT = new Map();
  rows.forEach(([c, k]) => {
    cont.set(c + '|' + k, (cont.get(c + '|' + k) || 0) + 1);
    byC.set(c, (byC.get(c) || 0) + 1);
    byT.set(k, (byT.get(k) || 0) + 1);
  });
  const sumIJ = [...cont.values()].reduce((s, x) => s + choose2(x), 0);
  const sumA = [...byC.values()].reduce((s, x) => s + choose2(x), 0);
  const sumB = [...byT.values()].reduce((s, x) => s + choose2(x), 0);
  const expected = sumA * sumB / choose2(rows.length);
  const ari = (sumIJ - expected) / ((sumA + sumB) / 2 - expected || 1);
  const purity = [...byC.keys()].reduce((s, c) => s + Math.max(...[...cont].filter(([k]) => k.startsWith(c + '|')).map(([, v]) => v)), 0) / rows.length;
  return { ari: +ari.toFixed(3), purity: +purity.toFixed(3), scored: rows.length };
}

const CACHE = path.join(here, '.cache');
const metaFile = path.join(CACHE, 'meta.json');
const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile)) : {};
const wanted = process.argv.slice(2);
const files = fs.readdirSync(CACHE).filter(f => f.endsWith('.json') && !['meta.json', 'truth.json'].includes(f) && !f.startsWith('report-'))
  .filter(f => !wanted.length || wanted.includes(f.replace('.json', '')));

const assemble = (summary) => assembleUniverseFromSignals(mergeSignalsAndRank({ historySummary: summary, knownMeta: meta }), { knownMeta: meta, vocabulary });
const report = [];
for (const f of files) {
  const summary = parseStreamingEvents(JSON.parse(fs.readFileSync(path.join(CACHE, f))));
  const pending = assemble(summary).diagnostics.pendingArtists || [];
  for (let i = 0; i < pending.length; i += 40) {
    const r = await enrichArtists(pending.slice(i, i + 40), 15000);
    r.meta.forEach((m, id) => { if (r.done.has(id)) meta[id] = toCacheEntry(m); });
    fs.writeFileSync(metaFile, JSON.stringify(meta));
  }
  const t = Date.now();
  const d = assemble(summary).dataset;
  const ms = Date.now() - t;
  const size = new Map();
  d.artists.forEach(a => size.set(a.genres[0], (size.get(a.genres[0]) || 0) + 1));
  const unknown = d.genres.filter(g => g.family === 'unclassified').reduce((n, g) => n + (size.get(g.id) || 0), 0);
  const listener = f.replace('.json', '');
  const sc = score(listener, d.artists);
  console.log(`\n== ${listener}: ${d.artists.length} artists, ${d.genres.length} groups, ${unknown} genre-unknown, ${ms} ms, ARI ${sc?.ari} purity ${sc?.purity}`);
  d.genres.forEach(g => console.log(String(size.get(g.id) || 0).padStart(5), g.name.padEnd(32), '|', (g.topArtists || []).slice(0, 3).join(', ')));
  report.push({ listener, ...sc, artists: d.artists.length, unknown, groups: d.genres.map(g => ({ name: g.name, size: size.get(g.id) || 0, top: (g.topArtists || []).slice(0, 3) })) });
}
fs.writeFileSync(path.join(CACHE, `report-${process.env.REPORT || 'latest'}.json`), JSON.stringify(report, null, 1));
const mean = (k) => (report.reduce((s, r) => s + (r[k] || 0), 0) / report.length).toFixed(3);
console.log(`\nMEAN ARI ${mean('ari')}  purity ${mean('purity')}  genre-unknown ${report.reduce((s, r) => s + r.unknown, 0)}`);
