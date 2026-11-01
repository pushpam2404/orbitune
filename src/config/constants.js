// src/config/constants.js
/**
 * ORBITUNE // 3D Music Universe - Physical, Visual & Telemetry Constants
 */

// Visual radius range per tier (log-scaled by play count in graphNormalizer).
export const TIER_BOUNDS = {
  genre: { minR: 5.0, maxR: 9.0, haloMult: 4.0 },
  // Wide range + curve (graphNormalizer) so artists you play a lot are unmistakably bigger.
  artist: { minR: 1.0, maxR: 6.0, haloMult: 2.6, curve: 1.6 },
  track: { minR: 0.45, maxR: 1.0, haloMult: 2.2 }
};

// 3D cloud layout geometry (src/physics/galaxyLayout.js).
export const LAYOUT_CONFIG = {
  sunCoreFactor: 1.6,        // empty space around a sun, in sun radii
  cloudInnerGap: 5.0,
  cloudSpacing: 9.0,         // typical gap between neighbouring planets inside a cloud
  cloudDensity: 1.1,         // >1 loosens clouds, <1 packs them
  clusterGap: 8.0,           // space between neighbouring clouds on the sphere
  bridgeSpacing: 7.0,
  moonInnerGap: 2.2,
  moonSpacing: 1.35,
  moonSpeed: 0.55,           // rad/s for the innermost moon
  moonInclinationRange: 1.4
};

export const COLOR_SPOTIFY_GREEN = '#1DB954';
