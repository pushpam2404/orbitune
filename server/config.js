// server/config.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(ROOT_DIR, '.env'));
} catch {
  // No .env file (e.g. on Vercel); rely on the real environment.
}

const port = Number(process.env.PORT || 5173);

// user-library-read is needed for Liked Songs.
export const REQUIRED_SCOPES = ['user-top-read', 'user-read-recently-played', 'user-library-read'];

export const config = {
  port,
  // Spotify only allows plain-http redirects for an explicit loopback IP, never "localhost".
  host: process.env.HOST || '127.0.0.1',
  // `--production` because Windows shells can't set NODE_ENV inline in the npm script.
  isProd: process.env.NODE_ENV === 'production' || process.argv.includes('--production'),
  clientId: process.env.SPOTIFY_CLIENT_ID || '',
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
  // Optional override; otherwise derived from the incoming request (see getRedirectUri).
  redirectUriOverride: process.env.SPOTIFY_REDIRECT_URI || '',
  sessionSecret: process.env.SESSION_SECRET || process.env.SPOTIFY_CLIENT_SECRET || '',
  scopes: REQUIRED_SCOPES.join(' ')
};

export function isSpotifyConfigured() {
  return Boolean(config.clientId && config.clientSecret);
}

/** e.g. https://orbitune-music.vercel.app/api/auth/callback or http://127.0.0.1:5173/api/auth/callback */
export function getRedirectUri(req) {
  if (config.redirectUriOverride) return config.redirectUriOverride;
  const proto = req.headers['x-forwarded-proto']?.split(',')[0] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/auth/callback`;
}
