// src/config/presets.js
/**
 * Curated Galaxy Presets for ORBITUNE // 3D Music Universe
 * Provides immediate astrophysical visualization without requiring Spotify login.
 */

export const GALAXY_PRESETS = {
  cosmic_synth: {
    id: 'cosmic_synth',
    name: 'Cosmic Synth & Retrowave',
    description: 'Neon interstellar synth arpeggios, cyberpunk basslines, and French electro dreamscapes.',
    genres: [
      { id: 'g_synthwave', name: 'Synthwave & Cyberpunk', color: '#FF007F', basePlays: 6200, energy: 0.88, bpm: 128 },
      { id: 'g_ambient_elec', name: 'Ambient & Electronic', color: '#00F0FF', basePlays: 4800, energy: 0.62, bpm: 110 },
      { id: 'g_french_touch', name: 'French Touch & Electro', color: '#FFB800', basePlays: 5100, energy: 0.84, bpm: 124 }
    ],
    artists: [
      {
        id: 'a_the_midnight',
        name: 'The Midnight',
        genres: ['g_synthwave'],
        basePlays: 2450,
        energy: 0.78,
        valence: 0.68,
        acoustic: 0.15,
        dance: 0.64,
        bpm: 122,
        followers: '680K'
      },
      {
        id: 'a_gunship',
        name: 'Gunship',
        genres: ['g_synthwave'],
        basePlays: 1980,
        energy: 0.85,
        valence: 0.52,
        acoustic: 0.10,
        dance: 0.59,
        bpm: 126,
        followers: '420K'
      },
      {
        id: 'a_daft_punk',
        name: 'Daft Punk',
        genres: ['g_french_touch', 'g_ambient_elec'], // Bridge artist!
        basePlays: 3200,
        energy: 0.82,
        valence: 0.76,
        acoustic: 0.12,
        dance: 0.79,
        bpm: 123,
        followers: '12.8M'
      },
      {
        id: 'a_kavinsky',
        name: 'Kavinsky',
        genres: ['g_synthwave', 'g_french_touch'], // Bridge artist!
        basePlays: 1650,
        energy: 0.90,
        valence: 0.44,
        acoustic: 0.05,
        dance: 0.68,
        bpm: 118,
        followers: '1.2M'
      },
      {
        id: 'a_tycho',
        name: 'Tycho',
        genres: ['g_ambient_elec'],
        basePlays: 2150,
        energy: 0.58,
        valence: 0.62,
        acoustic: 0.38,
        dance: 0.55,
        bpm: 104,
        followers: '890K'
      },
      {
        id: 'a_carpenter_brut',
        name: 'Carpenter Brut',
        genres: ['g_synthwave'],
        basePlays: 1420,
        energy: 0.96,
        valence: 0.32,
        acoustic: 0.02,
        dance: 0.52,
        bpm: 140,
        followers: '560K'
      },
      {
        id: 'a_justice',
        name: 'Justice',
        genres: ['g_french_touch'],
        basePlays: 1890,
        energy: 0.91,
        valence: 0.70,
        acoustic: 0.08,
        dance: 0.72,
        bpm: 125,
        followers: '1.9M'
      },
      {
        id: 'a_bonobo',
        name: 'Bonobo',
        genres: ['g_ambient_elec'],
        basePlays: 1780,
        energy: 0.66,
        valence: 0.58,
        acoustic: 0.42,
        dance: 0.65,
        bpm: 112,
        followers: '1.6M'
      }
    ],
    tracks: [
      { id: 't_sunset', name: 'Sunset', artistId: 'a_the_midnight', basePlays: 840, bpm: 122, valence: 0.72, energy: 0.81, acoustic: 0.12, dance: 0.65, durationMin: 5.4 },
      { id: 't_days_of_thunder', name: 'Days of Thunder', artistId: 'a_the_midnight', basePlays: 690, bpm: 118, valence: 0.66, energy: 0.74, acoustic: 0.18, dance: 0.62, durationMin: 5.7 },
      { id: 't_tech_noir', name: 'Tech Noir', artistId: 'a_gunship', basePlays: 720, bpm: 126, valence: 0.48, energy: 0.86, acoustic: 0.08, dance: 0.58, durationMin: 4.9 },
      { id: 't_when_you_grow_up', name: 'When You Grow Up, Your Heart Dies', artistId: 'a_gunship', basePlays: 580, bpm: 130, valence: 0.60, energy: 0.89, acoustic: 0.10, dance: 0.56, durationMin: 5.8 },
      { id: 't_veridis_quo', name: 'Veridis Quo', artistId: 'a_daft_punk', basePlays: 1120, bpm: 106, valence: 0.52, energy: 0.64, acoustic: 0.22, dance: 0.71, durationMin: 5.7 },
      { id: 't_voyager', name: 'Voyager', artistId: 'a_daft_punk', basePlays: 980, bpm: 120, valence: 0.88, energy: 0.84, acoustic: 0.05, dance: 0.82, durationMin: 3.8 },
      { id: 't_nightcall', name: 'Nightcall', artistId: 'a_kavinsky', basePlays: 890, bpm: 118, valence: 0.42, energy: 0.85, acoustic: 0.04, dance: 0.66, durationMin: 4.3 },
      { id: 't_awake', name: 'Awake', artistId: 'a_tycho', basePlays: 790, bpm: 102, valence: 0.65, energy: 0.61, acoustic: 0.35, dance: 0.58, durationMin: 4.7 },
      { id: 't_a_walk', name: 'A Walk', artistId: 'a_tycho', basePlays: 640, bpm: 98, valence: 0.59, energy: 0.54, acoustic: 0.41, dance: 0.52, durationMin: 5.3 },
      { id: 't_turbo_killer', name: 'Turbo Killer', artistId: 'a_carpenter_brut', basePlays: 610, bpm: 142, valence: 0.30, energy: 0.98, acoustic: 0.01, dance: 0.49, durationMin: 3.5 },
      { id: 't_genesis', name: 'Genesis', artistId: 'a_justice', basePlays: 760, bpm: 117, valence: 0.62, energy: 0.92, acoustic: 0.06, dance: 0.70, durationMin: 3.9 },
      { id: 't_cirrus', name: 'Cirrus', artistId: 'a_bonobo', basePlays: 730, bpm: 114, valence: 0.61, energy: 0.69, acoustic: 0.36, dance: 0.68, durationMin: 5.9 }
    ]
  }
};
