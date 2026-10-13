// HTTP(S) server: static web app, REST API and the WebSocket endpoint.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { createApi } from './api.js';
import { openDatabase } from './db.js';
import { HttpError, sendJson } from './http.js';
import { Hub } from './realtime.js';
import { createIdentityResolver, IdentityError, DEV_USER } from './tailnet.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' blob: data: https:",
    "media-src 'self' blob:",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(self), display-capture=(self)',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export function createApp(config) {
  const db = openDatabase(config.dataDir);
  const hub = new Hub();
  const api = createApi({ db, hub, config });
  const identify = createIdentityResolver(config);

  async function handleApi(req, res, url) {
    const match = api.router.match(req.method, url.pathname);
    if (!match) return sendJson(res, 404, { error: 'Not found' });
    if (match.methodNotAllowed) return sendJson(res, 405, { error: 'Method not allowed' });
    const identity = await identify(req);
    const user = api.upsertUser(identity);
    const ctx = { req, res, params: match.params, query: url.searchParams, identity, user, device: null };
    const needs = match.route.options.device ?? true;
    const auth = req.headers.authorization || '';
    if (needs !== false && auth.startsWith('Bearer ')) {
      ctx.device = await api.authenticateToken(auth.slice(7), identity);
    } else if (needs === true) {
      throw new HttpError(401, 'Missing device token');
    }
    const result = await match.route.handler(ctx);
    if (!ctx.streamed) sendJson(res, 200, result ?? { ok: true });
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    // Client-side routes (invite links) load the app shell.
    if (rel === '/' || rel.startsWith('/invite/')) rel = '/index.html';
    const file = path.normalize(path.join(config.publicDir, rel));
    if (!file.startsWith(config.publicDir + path.sep)) return sendJson(res, 404, { error: 'Not found' });
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return sendJson(res, 404, { error: 'Not found' });
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  function devLogin(req, res, url) {
    const user = (url.searchParams.get('user') || '').toLowerCase();
    if (DEV_USER.test(user)) {
      res.writeHead(302, {
        'Set-Cookie': `tailchat_dev_user=${user}; Path=/; HttpOnly; SameSite=Strict`,
        Location: '/',
      });
      return res.end();
    }
    const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Tailchat dev login</title><body style="font-family:system-ui;max-width:420px;margin:15vh auto;padding:0 16px">
<h1>Tailchat (dev mode)</h1><p>In production your identity comes from Tailscale. Pick a test user:</p>
<form><input name="user" placeholder="alice" pattern="[a-z0-9._-]{1,32}" required autofocus> <button>Sign in</button></form>`;
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
    res.end(body);
  }

  async function onRequest(req, res) {
    const url = new URL(req.url, 'http://tailchat.invalid');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (config.auth === 'dev' && url.pathname === '/dev/login') return devLogin(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
      // The app shell is only served to people on the tailnet, too.
      if (url.pathname === '/' || url.pathname.startsWith('/invite/')) {
        try {
          await identify(req);
        } catch (err) {
          if (config.auth === 'dev' && err.status === 401) {
            res.writeHead(302, { Location: '/dev/login' });
            return res.end();
          }
          throw err;
        }
      }
      serveStatic(req, res, url);
    } catch (err) {
      const status = err instanceof HttpError || err instanceof IdentityError ? err.status : 500;
      if (status === 500) console.error(err);
      if (res.headersSent) return res.destroy();
      sendJson(res, status, { error: status === 500 ? 'Internal error' : err.message });
    }
  }

  const server = config.tlsCert
    ? https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }, onRequest)
    : http.createServer(onRequest);
  server.requestTimeout = 0; // large uploads over slow links
  server.headersTimeout = 30_000;

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://tailchat.invalid');
    try {
      if (url.pathname !== '/ws') throw new HttpError(404, 'Not found');
      // Browsers always send Origin on WebSocket upgrades; it must be this site.
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin WebSocket refused');
      const identity = await identify(req);
      api.upsertUser(identity);
      hub.accept(req, socket, head, identity, api.authenticateToken);
    } catch (err) {
      socket.end(`HTTP/1.1 ${err.status || 500} Refused\r\nConnection: close\r\n\r\n`);
    }
  });

  const sweeper = setInterval(() => {
    try {
      api.sweep();
    } catch (err) {
      console.error('sweep failed', err);
    }
  }, 15_000);
  sweeper.unref();

  return {
    server,
    db,
    sweep: api.sweep,
    listen() {
      return new Promise((resolve) => server.listen(config.port, config.host || undefined, () => resolve(server.address())));
    },
    async close() {
      clearInterval(sweeper);
      hub.close();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}
