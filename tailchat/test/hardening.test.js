import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { chatAad, newMessageId } from '../public/crypto.js';
import { connectUser, startServer } from './helpers.js';

let dev;
let serve;

before(async () => {
  [dev, serve] = await Promise.all([
    startServer({ TAILCHAT_MAX_UPLOAD_MB: '1' }),
    startServer({ TAILCHAT_AUTH: 'serve' }),
  ]);
});

after(async () => {
  await Promise.all([dev?.stop(), serve?.stop()]);
});

// fetch can't set Host, so these go through node:http.
function raw(base, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method, headers }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const port = (server) => new URL(server.base).port;

test('requests for another host name are refused (DNS rebinding)', async () => {
  const user = { 'X-Dev-User': 'mallory' };
  assert.equal((await raw(dev.base, '/api/me', { headers: { ...user, Host: `evil.example:${port(dev)}` } })).status, 421);
  assert.equal((await raw(dev.base, '/api/me', { headers: { ...user, Host: `tailchat.example.ts.net` } })).status, 421, 'dev mode is loopback only');
  for (const host of [`127.0.0.1:${port(dev)}`, `localhost:${port(dev)}`, `[::1]:${port(dev)}`]) {
    assert.equal((await raw(dev.base, '/api/me', { headers: { ...user, Host: host } })).status, 200, host);
  }
  const page = await raw(dev.base, '/', { headers: { ...user, Host: 'evil.example' } });
  assert.equal(page.status, 421, 'the app shell too');

  const who = { 'Tailscale-User-Login': 'ana@example.com', 'Tailscale-User-Name': 'Ana' };
  assert.equal((await raw(serve.base, '/api/me', { headers: { ...who, Host: 'tailchat.example.ts.net' } })).status, 200);
  assert.equal((await raw(serve.base, '/api/me', { headers: { ...who, Host: 'evil.example' } })).status, 421);
  assert.equal((await raw(serve.base, '/api/me', { headers: { ...who, Host: '100.101.102.103' } })).status, 200);
  assert.equal((await raw(serve.base, '/api/me', { headers: { ...who, Host: '192.168.1.5' } })).status, 421);
});

test('Funnel requests are refused', async () => {
  const headers = { Host: 'tailchat.example.ts.net', 'Tailscale-Funnel-Request': '?1' };
  const res = await raw(serve.base, '/api/me', { headers });
  assert.equal(res.status, 403);
  assert.match(JSON.parse(res.text).error, /Funnel/);
  assert.equal((await raw(serve.base, '/', { headers })).status, 403);
});

test('cross-origin writes and WebSockets are refused', async () => {
  const body = JSON.stringify({ name: 'x', publicKey: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' } });
  const headers = { 'X-Dev-User': 'mallory', 'Content-Type': 'application/json' };
  const res = await raw(dev.base, '/api/devices', { method: 'POST', body, headers: { ...headers, Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
  const same = await raw(dev.base, '/api/devices', { method: 'POST', body, headers: { ...headers, Origin: dev.base } });
  assert.equal(same.status, 200);

  const ws = new WebSocket(dev.base.replace('http', 'ws') + '/ws', { headers: { 'X-Dev-User': 'mallory', Origin: 'https://evil.example' } });
  const status = await new Promise((resolve) => {
    ws.on('unexpected-response', (_req, r) => resolve(r.statusCode));
    ws.on('open', () => resolve('open'));
  });
  assert.equal(status, 403);
});

test('every response carries the security headers', async () => {
  const res = await raw(dev.base, '/api/me', { headers: { 'X-Dev-User': 'mallory' } });
  assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
  assert.match(res.headers['strict-transport-security'], /max-age=\d+/);
});

test('malformed and deeply nested JSON is a 400, not a crash', async () => {
  const headers = { 'X-Dev-User': 'mallory', 'Content-Type': 'application/json' };
  const deep = '['.repeat(100_000) + ']'.repeat(100_000);
  assert.equal((await raw(dev.base, '/api/devices', { method: 'POST', body: deep, headers })).status, 400);
  assert.equal((await raw(dev.base, '/api/devices', { method: 'POST', body: '{', headers })).status, 400);
});

test('uploads waiting to be sent are capped per person', async () => {
  const quinn = await connectUser(dev.base, 'quinn');
  const mb = new Uint8Array(1024 * 1024);
  const up = (bytes, q = '') => quinn.call('POST', `/api/files${q}`, bytes, { 'Content-Type': 'application/octet-stream' });
  const first = await up(mb);
  await up(mb);
  // 2 x the 1 MB file limit is waiting already.
  await assert.rejects(up(new Uint8Array(10)), (e) => e.status === 429);

  // Sending one frees its share.
  const { chat } = await quinn.call('POST', '/api/chats/direct', { userId: 'quinn@dev' });
  const id = newMessageId();
  const { devices } = await quinn.call('GET', `/api/chats/${chat.id}/devices`);
  const payload = await quinn.ring.seal({ type: 'document', text: '' }, chatAad(chat.id, id), devices);
  await quinn.call('POST', `/api/chats/${chat.id}/messages`, { id, payload, files: [first.id] });
  await up(new Uint8Array(10));

  // Profile photos nobody uses are capped by count.
  for (let i = 0; i < 20; i++) await up(new Uint8Array(10), '?public=1');
  await assert.rejects(up(new Uint8Array(10), '?public=1'), (e) => e.status === 429);
});
