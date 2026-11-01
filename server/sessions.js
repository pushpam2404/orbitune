// server/sessions.js
/**
 * Stateless sessions: Spotify tokens live in an AES-256-GCM encrypted HttpOnly cookie,
 * so any serverless instance (Vercel) or a restarted dev server can read them.
 */
import crypto from 'node:crypto';
import { config } from './config.js';

const SESSION_COOKIE = 'orbitune_session';
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30;

/**
 * AES-256-GCM codec for one secret. With no secret there is no codec at all, so a
 * cookie anyone could have forged is never accepted as a session.
 */
export function createCodec(secret) {
  if (!secret) return null;
  const key = crypto.createHash('sha256').update(`orbitune-session:${secret}`).digest();
  return {
    encrypt(obj) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
    },
    decrypt(token) {
      try {
        const buf = Buffer.from(token, 'base64url');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
        decipher.setAuthTag(buf.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
      } catch {
        // Tampered, or encrypted with a different secret.
        return null;
      }
    }
  };
}

const codec = createCodec(config.sessionSecret);

export function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    // Cookies on 127.0.0.1 are shared with other local apps; skip any we can't decode.
    try { out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim()); } catch { /* not ours */ }
  });
  return out;
}

export function setCookie(req, res, name, value, { maxAgeSec } = {}) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') attrs.push('Secure');
  if (maxAgeSec !== undefined) attrs.push(`Max-Age=${maxAgeSec}`);
  res.append('Set-Cookie', attrs.join('; '));
}

export function getSession(req) {
  const raw = parseCookies(req)[SESSION_COOKIE];
  return raw && codec ? codec.decrypt(raw) : null;
}

/** Writes (or rewrites, e.g. after a token refresh) the session cookie. */
export function saveSession(req, res, tokens) {
  if (!codec) throw new Error('SESSION_SECRET (or SPOTIFY_CLIENT_SECRET) is not set');
  setCookie(req, res, SESSION_COOKIE, codec.encrypt(tokens), { maxAgeSec: SESSION_MAX_AGE_SEC });
}

export function destroySession(req, res) {
  setCookie(req, res, SESSION_COOKIE, '', { maxAgeSec: 0 });
}
