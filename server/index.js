// server/index.js
/**
 * Local server: the /api app plus the frontend (Vite middleware in dev, dist/ in production).
 * On Vercel, api/index.js serves /api and Vercel serves dist/ itself.
 */
import path from 'node:path';
import express from 'express';
import { config, isSpotifyConfigured, ROOT_DIR } from './config.js';
import { createApp } from './app.js';

const app = createApp();

if (config.isProd) {
  const distDir = path.join(ROOT_DIR, 'dist');
  app.use(express.static(distDir));
  app.use((req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root: ROOT_DIR, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

app.listen(config.port, config.host, () => {
  console.log(`Orbitune running at http://${config.host}:${config.port}/`);
  if (!isSpotifyConfigured()) {
    console.warn('Spotify not configured: set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env');
  } else {
    console.log(`Spotify redirect URI (must be registered in the dashboard): ${config.redirectUriOverride || `http://${config.host}:${config.port}/api/auth/callback`}`);
  }
});
