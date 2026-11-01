import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app.js';

let server;
let base;

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

test('auth status works without a session or Spotify credentials', async () => {
  const res = await fetch(`${base}/api/auth/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.loggedIn, false);
});

test('a forged session cookie does not log anyone in', async () => {
  const res = await fetch(`${base}/api/auth/status`, { headers: { Cookie: 'orbitune_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } });
  assert.equal((await res.json()).loggedIn, false);
});

test('the universe route refuses anonymous callers, even with a history payload attached', async () => {
  const res = await post('/api/universe', JSON.stringify({ historySummary: { isOrbituneHistorySummary: true, artists: [], tracks: [] } }));
  assert.equal(res.status, 401);
});

test('malformed JSON gets a JSON 400, not an HTML error page', async () => {
  const res = await post('/api/enrich', '{not json');
  assert.equal(res.status, 400);
  assert.match(res.headers.get('content-type'), /json/);
});

test('an oversized body gets a JSON 413', async () => {
  const res = await post('/api/enrich', JSON.stringify({ artists: [{ id: 'x', name: 'x'.repeat(600_000) }] }));
  assert.equal(res.status, 413);
});
