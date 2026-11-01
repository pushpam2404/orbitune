// src/etl/historyParser.js
/**
 * Shared Spotify Streaming History parser & temporal memory analyzer.
 * Works identically in Node (server/) and the browser (src/).
 *
 * Includes ALL artists and tracks present in the user's records (no artists dropped).
 * Full streams (>= 30s) drive primary play counts, while brief plays (< 30s) are also
 * retained so every artist and song in the records is represented in the universe.
 */

const MIN_MS_FULL_STREAM = 30000; // 30s standard threshold for a full play
const SESSION_GAP_MS = 45 * 60 * 1000; // 45 minutes session window
const SESSION_WINDOW = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Normalizes track titles so "505 - Remastered 2011", "505 (Live)" and "505" merge cleanly. */
export function cleanTrackTitle(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function normalizeArtistKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Deterministic synthetic ID for history items not present in live OAuth top charts. */
export function makeHistoryId(prefix, key) {
  let h1 = 2166136261;
  let h2 = 16777619;
  const s = String(key);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2166136261);
  }
  const slug = s.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20);
  return `hist_${prefix}_${slug}_${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36).slice(0, 4)}`;
}

/** Extracts featured artist names from track titles like "Song (feat. Artist B & Artist C)". */
export function extractFeaturedArtists(trackName, primaryArtist) {
  if (!trackName) return [];
  const matches = [];
  const regex = /[([](?:feat\.?|ft\.?|featuring|with)\s+([^)\]]+)[)\]]/gi;
  let m;
  while ((m = regex.exec(trackName)) !== null) {
    const raw = m[1].split(/\s*(?:,|&|\band\b|\bx\b|\/)\s*/i);
    for (const part of raw) {
      const cleaned = part.trim();
      if (cleaned && cleaned.length > 1 && normalizeArtistKey(cleaned) !== normalizeArtistKey(primaryArtist)) {
        matches.push(cleaned);
      }
    }
  }
  return [...new Set(matches)];
}

/** Converts a UTC timestamp into "Early YYYY" (Jan-Apr), "Mid YYYY" (May-Aug), or "Late YYYY" (Sep-Dec). */
export function eraLabelFromTs(ts) {
  const d = new Date(ts);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const part = month < 4 ? 'Early' : (month < 8 ? 'Mid' : 'Late');
  return `${part} ${year}`;
}

export function formatMonthYear(tsOrIso) {
  if (!tsOrIso) return '';
  const d = new Date(tsOrIso);
  if (!Number.isFinite(d.getTime())) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function formatRelativeDays(days) {
  if (!Number.isFinite(days) || days < 0) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30.4);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = (days / 365.25).toFixed(1).replace(/\.0$/, '');
  return `${years} year${years === '1' ? '' : 's'} ago`;
}

/**
 * Classifies an artist or track's listening history into intuitive human categories:
 *  - 'past_fav': heavily played in past eras/years, minimal recent plays
 *  - 'dormant': loved track/artist untouched for 120+ days ("haven't heard in a while")
 *  - 'early_era': discovered & primarily heard back in an earlier year (2020-2025)
 *  - 'all_time_staple': consistent across 3+ years and still active
 *  - 'current_rotation': actively played in the last 60 days
 *  - 'casual': lighter history footprint
 */
export function computeTemporalProfile(entry, refTs, kind = 'track') {
  const fullPlays = entry.plays || 0;
  const totalOccurrences = entry.rawCount || fullPlays || 1;
  const plays = fullPlays > 0 ? fullPlays : 1;
  const totalMs = entry.totalMs || 0;
  const firstTs = entry.firstTs || refTs;
  const lastTs = entry.lastTs || refTs;
  const byYear = entry.byYear || {};
  const byEra = entry.byEra || {};
  const recent60d = entry.recent60dPlays || 0;
  const recent120d = entry.recent120dPlays || 0;

  const daysSinceLast = Math.max(0, Math.round((refTs - lastTs) / DAY_MS));
  const firstEra = eraLabelFromTs(firstTs);
  const lastEra = eraLabelFromTs(lastTs);
  const firstYear = new Date(firstTs).getUTCFullYear();
  const refYear = new Date(refTs).getUTCFullYear();

  let peakYear = String(firstYear);
  let peakYearPlays = 0;
  for (const [y, count] of Object.entries(byYear)) {
    if (count > peakYearPlays) {
      peakYearPlays = count;
      peakYear = String(y);
    }
  }

  let peakEra = firstEra;
  let peakEraPlays = 0;
  for (const [era, count] of Object.entries(byEra)) {
    if (count > peakEraPlays) {
      peakEraPlays = count;
      peakEra = era;
    }
  }

  const activeYears = Object.keys(byYear).filter(y => byYear[y] > 0).sort();
  const playsBeforeRefYear = Object.entries(byYear)
    .filter(([y]) => Number(y) < refYear)
    .reduce((s, [, c]) => s + c, 0);

  const favThreshold = kind === 'artist' ? 28 : 12;
  const dormantMinPlays = kind === 'artist' ? 8 : 4;
  const stapleMinPlays = kind === 'artist' ? 60 : 20;

  const isDormant = fullPlays >= dormantMinPlays && daysSinceLast >= 120;
  const isPastFav = fullPlays >= favThreshold && daysSinceLast >= 25 && (
    (playsBeforeRefYear / plays >= 0.68 && recent60d <= Math.max(2, plays * 0.06)) ||
    (daysSinceLast >= 90 && recent120d <= Math.max(2, plays * 0.08))
  );
  const isCurrentRotation = fullPlays >= 2 && daysSinceLast <= 60 && (recent60d >= (kind === 'artist' ? 6 : 3) || (byYear[refYear] || 0) >= favThreshold * 0.5);
  const isAllTimeStaple = activeYears.length >= 3 && fullPlays >= stapleMinPlays && daysSinceLast <= 120;
  const isEarlyEra = fullPlays >= 2 && Number(peakYear) <= refYear - 1 && (byYear[refYear] || 0) <= Math.max(2, plays * 0.15);

  const tags = [];
  if (isPastFav) tags.push('past_fav');
  if (isDormant) tags.push('dormant');
  if (isCurrentRotation) tags.push('current_rotation');
  if (isAllTimeStaple) tags.push('all_time_staple');
  if (isEarlyEra) tags.push('early_era');

  for (const y of activeYears) {
    const share = byYear[y] / plays;
    if (byYear[y] >= (kind === 'artist' ? 3 : 2) || share >= 0.25) {
      if (Number(y) <= 2022) tags.push('era_2020_2022');
      else tags.push(`era_${y}`);
    }
  }
  // Years up to 2022 share one era lens, so only later years get an "Early" lens.
  const [eraPart, eraYear] = peakEra.split(' ');
  if (eraPart === 'Early' && Number(eraYear) > 2022) tags.push(`early_${eraYear}`);

  let status = 'casual';
  let statusLabel = `Heard in ${peakEra}`;
  let shortBadge = peakEra;

  if (isPastFav && isDormant) {
    status = 'past_fav';
    statusLabel = `Past favorite · Dormant (${formatRelativeDays(daysSinceLast)})`;
    shortBadge = `Past fav · ${peakEra}`;
  } else if (isPastFav) {
    status = 'past_fav';
    statusLabel = `Past favorite · Peaked ${peakEra}`;
    shortBadge = `Past fav · ${peakEra}`;
  } else if (isDormant) {
    status = 'dormant';
    statusLabel = `Haven’t heard in ${formatRelativeDays(daysSinceLast).replace(' ago', '')}`;
    shortBadge = `${formatRelativeDays(daysSinceLast)}`;
  } else if (isAllTimeStaple) {
    status = 'all_time_staple';
    statusLabel = `All-time staple (${activeYears[0]}–${activeYears[activeYears.length - 1]})`;
    shortBadge = `Staple · ${activeYears[0]}–${String(activeYears[activeYears.length - 1]).slice(-2)}`;
  } else if (isCurrentRotation) {
    status = 'current_rotation';
    statusLabel = 'Current rotation';
    shortBadge = 'Current rotation';
  } else if (isEarlyEra) {
    status = 'early_era';
    statusLabel = `Heard back in ${peakEra}`;
    shortBadge = peakEra;
  }

  let memoryNote = '';
  const relLast = formatRelativeDays(daysSinceLast);
  if (fullPlays === 0) {
    memoryNote = `Brief/skipped play (${totalOccurrences}×) in ${firstEra} (last seen ${formatMonthYear(lastTs)}).`;
  } else if (isPastFav && isDormant) {
    memoryNote = `Past favorite from ${peakEra} (${peakEraPlays} of ${plays} plays) — you haven’t played it in ${relLast.replace(' ago', '')} (since ${formatMonthYear(lastTs)}).`;
  } else if (isPastFav) {
    memoryNote = `Past favorite that peaked in ${peakEra} (${byYear[peakYear]} plays in ${peakYear} out of ${plays} total). Last heard ${relLast}.`;
  } else if (isDormant) {
    memoryNote = `Heard ${plays} times (mostly around ${peakEra}), and haven’t played since ${formatMonthYear(lastTs)} (${relLast}).`;
  } else if (isAllTimeStaple) {
    memoryNote = `All-time staple across ${activeYears.length} years (${activeYears[0]}–${activeYears[activeYears.length - 1]}), peaking in ${peakEra} with ${plays} total plays.`;
  } else if (isCurrentRotation) {
    memoryNote = firstYear < refYear
      ? `In your current rotation (${byYear[refYear] || recent60d} plays in ${refYear}; first heard in ${firstEra}).`
      : `Discovered in ${firstEra} and in heavy rotation (${plays} plays).`;
  } else if (isEarlyEra) {
    memoryNote = `Mostly heard back in ${peakEra} (${peakEraPlays} plays), last played ${formatMonthYear(lastTs)} (${relLast}).`;
  } else {
    memoryNote = `Played ${plays} time${plays === 1 ? '' : 's'} between ${formatMonthYear(firstTs)} and ${formatMonthYear(lastTs)}.`;
  }

  return {
    plays,
    fullPlays,
    minutes: Math.max(1, Math.round(totalMs / 60000)),
    firstPlayed: new Date(firstTs).toISOString().slice(0, 10),
    lastPlayed: new Date(lastTs).toISOString().slice(0, 10),
    firstTs,
    lastTs,
    daysSinceLast,
    firstEra,
    peakEra,
    peakYear,
    lastEra,
    byYear,
    byEra,
    status,
    statusLabel,
    shortBadge,
    tags: [...new Set(tags)],
    memoryNote
  };
}

/**
 * Parses an array of raw Spotify streaming history events into a compact,
 * rich summary object ready for universe merging or JSON storage.
 * Retains ALL unique artists and tracks from the records.
 */
export function parseStreamingEvents(rawEvents) {
  if (!Array.isArray(rawEvents)) {
    throw new Error('Expected an array of Spotify streaming history records.');
  }

  const seenEvents = new Set();
  const validEvents = [];
  let fullPlayCount = 0;
  let maxTs = 0;
  let minTs = Infinity;

  for (let i = 0; i < rawEvents.length; i++) {
    const r = rawEvents[i];
    if (!r || typeof r !== 'object') continue;

    const artistName = (r.master_metadata_album_artist_name || r.artistName || '').trim();
    const trackName = (r.master_metadata_track_name || r.trackName || '').trim();
    const msPlayed = Math.max(0, Number(r.ms_played ?? r.msPlayed ?? 0));
    const tsRaw = String(r.ts || r.endTime || '');

    // Date.parse is lenient enough to turn "not a date" into the year 2000, so check the shape first.
    if (!artistName || !trackName || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(tsRaw)) continue;
    const t = Date.parse(tsRaw.includes('T') ? tsRaw : `${tsRaw.replace(' ', 'T')}:00Z`);
    if (!Number.isFinite(t)) continue;

    const dedupKey = `${t}|${artistName}|${trackName}`;
    if (seenEvents.has(dedupKey)) continue;
    seenEvents.add(dedupKey);

    if (t > maxTs) maxTs = t;
    if (t < minTs) minTs = t;

    const isFull = msPlayed >= MIN_MS_FULL_STREAM;
    if (isFull) fullPlayCount++;

    const uri = typeof r.spotify_track_uri === 'string' ? r.spotify_track_uri : null;
    const spotifyTrackId = uri && uri.startsWith('spotify:track:') ? uri.slice('spotify:track:'.length) : null;

    validEvents.push({
      t,
      ms: msPlayed,
      isFull,
      artistName,
      trackName,
      albumName: r.master_metadata_album_album_name || null,
      spotifyTrackId
    });
  }

  if (validEvents.length === 0) {
    return {
      totalEvents: rawEvents.length,
      validPlays: 0,
      totalMs: 0,
      firstDate: null,
      lastDate: null,
      refTs: Date.now(),
      years: {},
      artists: [],
      tracks: [],
      togetherPairs: []
    };
  }

  validEvents.sort((a, b) => a.t - b.t);

  const refTs = maxTs;
  const recent60Cutoff = refTs - 60 * DAY_MS;
  const recent120Cutoff = refTs - 120 * DAY_MS;

  const artistsMap = new Map();
  const tracksMap = new Map();
  const yearsTotal = {};
  let totalMs = 0;

  const togetherCounts = new Map();

  for (let i = 0; i < validEvents.length; i++) {
    const ev = validEvents[i];
    totalMs += ev.ms;

    const year = String(new Date(ev.t).getUTCFullYear());
    const era = eraLabelFromTs(ev.t);
    if (ev.isFull) yearsTotal[year] = (yearsTotal[year] || 0) + 1;

    const normArtist = normalizeArtistKey(ev.artistName);
    const cleanedTrack = cleanTrackTitle(ev.trackName);
    if (!normArtist || !cleanedTrack) continue;

    // 1. Aggregate primary artist (all artists in records are retained)
    let aEntry = artistsMap.get(normArtist);
    if (!aEntry) {
      aEntry = {
        name: ev.artistName,
        normName: normArtist,
        plays: 0,
        rawCount: 0,
        totalMs: 0,
        firstTs: ev.t,
        lastTs: ev.t,
        recent60dPlays: 0,
        recent120dPlays: 0,
        byYear: {},
        byEra: {},
        trackCounts: new Map()
      };
      artistsMap.set(normArtist, aEntry);
    }
    aEntry.rawCount += 1;
    if (ev.isFull) aEntry.plays += 1;
    aEntry.totalMs += ev.ms;
    if (ev.t < aEntry.firstTs) aEntry.firstTs = ev.t;
    if (ev.t > aEntry.lastTs) aEntry.lastTs = ev.t;
    if (ev.isFull && ev.t >= recent60Cutoff) aEntry.recent60dPlays += 1;
    if (ev.isFull && ev.t >= recent120Cutoff) aEntry.recent120dPlays += 1;
    const playInc = ev.isFull ? 1 : (aEntry.plays === 0 ? 1 : 0);
    if (playInc) {
      aEntry.byYear[year] = (aEntry.byYear[year] || 0) + 1;
      aEntry.byEra[era] = (aEntry.byEra[era] || 0) + 1;
    }
    aEntry.trackCounts.set(ev.trackName, (aEntry.trackCounts.get(ev.trackName) || 0) + (ev.isFull ? 2 : 1));

    // 2. Aggregate track (merged by primary artist + cleaned title)
    const trackKey = `${normArtist}|${cleanedTrack}`;
    let tEntry = tracksMap.get(trackKey);
    if (!tEntry) {
      tEntry = {
        key: trackKey,
        name: ev.trackName,
        cleanName: cleanedTrack,
        artistName: ev.artistName,
        normArtist,
        featArtistNames: extractFeaturedArtists(ev.trackName, ev.artistName),
        spotifyTrackId: ev.spotifyTrackId || null,
        plays: 0,
        rawCount: 0,
        totalMs: 0,
        firstTs: ev.t,
        lastTs: ev.t,
        recent60dPlays: 0,
        recent120dPlays: 0,
        byYear: {},
        byEra: {}
      };
      tracksMap.set(trackKey, tEntry);
    }
    tEntry.rawCount += 1;
    if (ev.isFull) tEntry.plays += 1;
    tEntry.totalMs += ev.ms;
    if (!tEntry.spotifyTrackId && ev.spotifyTrackId) tEntry.spotifyTrackId = ev.spotifyTrackId;
    if (ev.t < tEntry.firstTs) tEntry.firstTs = ev.t;
    if (ev.t > tEntry.lastTs) tEntry.lastTs = ev.t;
    if (ev.isFull && ev.t >= recent60Cutoff) tEntry.recent60dPlays += 1;
    if (ev.isFull && ev.t >= recent120Cutoff) tEntry.recent120dPlays += 1;
    const tInc = ev.isFull ? 1 : (tEntry.plays === 0 ? 1 : 0);
    if (tInc) {
      tEntry.byYear[year] = (tEntry.byYear[year] || 0) + 1;
      tEntry.byEra[era] = (tEntry.byEra[era] || 0) + 1;
    }

    // 3. Session co-listening window across all events so even 1-play artists know what
    //    music session they appeared in!
    const wBase = ev.isFull ? 1.0 : 0.4;
    for (let d = 1; d <= SESSION_WINDOW && i + d < validEvents.length; d++) {
      const nextEv = validEvents[i + d];
      if (nextEv.t - ev.t > SESSION_GAP_MS) break;
      const nextNorm = normalizeArtistKey(nextEv.artistName);
      if (!nextNorm || nextNorm === normArtist) continue;
      const pairKey = normArtist < nextNorm ? `${normArtist}|${nextNorm}` : `${nextNorm}|${normArtist}`;
      togetherCounts.set(pairKey, (togetherCounts.get(pairKey) || 0) + wBase / d);
    }
  }

  const artists = [...artistsMap.values()]
    .map(a => {
      let topTrackName = '';
      let bestCount = 0;
      a.trackCounts.forEach((c, name) => {
        if (c > bestCount) { bestCount = c; topTrackName = name; }
      });
      const profile = computeTemporalProfile(a, refTs, 'artist');
      return {
        name: a.name,
        normName: a.normName,
        topTrackName,
        ...profile
      };
    })
    .sort((x, y) => (y.fullPlays - x.fullPlays) || (y.minutes - x.minutes));

  const tracks = [...tracksMap.values()]
    .map(t => {
      const profile = computeTemporalProfile(t, refTs, 'track');
      return {
        key: t.key,
        name: t.name,
        cleanName: t.cleanName,
        artistName: t.artistName,
        normArtist: t.normArtist,
        featArtistNames: t.featArtistNames,
        spotifyTrackId: t.spotifyTrackId,
        ...profile
      };
    })
    .sort((x, y) => (y.fullPlays - x.fullPlays) || (y.minutes - x.minutes));

  // Guarantee every artist has their top session co-listening bridges preserved
  // so less-frequent and single-play artists remain connected to their music session
  const artistBestPairs = new Map();
  for (const [k, w] of togetherCounts) {
    const [a, b] = k.split('|');
    if (!artistBestPairs.has(a)) artistBestPairs.set(a, []);
    if (!artistBestPairs.has(b)) artistBestPairs.set(b, []);
    artistBestPairs.get(a).push([k, w]);
    artistBestPairs.get(b).push([k, w]);
  }

  const guaranteedKeys = new Set();
  artistBestPairs.forEach((pairs) => {
    pairs.sort((x, y) => y[1] - x[1]);
    for (let i = 0; i < Math.min(4, pairs.length); i++) {
      guaranteedKeys.add(pairs[i][0]);
    }
  });

  const sortedPairs = [...togetherCounts.entries()]
    .filter(([, w]) => w >= 0.15)
    .sort((a, b) => b[1] - a[1]);

  const finalPairsMap = new Map();
  guaranteedKeys.forEach(k => {
    const w = togetherCounts.get(k);
    if (w) finalPairsMap.set(k, w);
  });
  for (const [k, w] of sortedPairs) {
    if (finalPairsMap.size >= 65000) break;
    finalPairsMap.set(k, w);
  }

  const togetherPairs = [...finalPairsMap.entries()]
    .map(([k, w]) => [k, Number(w.toFixed(2))]);

  return {
    isOrbituneHistorySummary: true,
    totalEvents: rawEvents.length,
    validPlays: fullPlayCount || validEvents.length,
    totalMs,
    totalMinutes: Math.round(totalMs / 60000),
    totalHours: Number((totalMs / 3600000).toFixed(1)),
    firstDate: new Date(minTs).toISOString().slice(0, 10),
    lastDate: new Date(maxTs).toISOString().slice(0, 10),
    refTs,
    years: yearsTotal,
    artists,
    tracks,
    togetherPairs
  };
}
