import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { KeyRing, generateDeviceKeys } from '../public/crypto.js';

export async function startServer(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-test-'));
  const config = { ...loadConfig({ TAILCHAT_AUTH: 'dev', TAILCHAT_HOST: '127.0.0.1' }), port: 0, dataDir, ...overrides };
  const app = createApp(config);
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  return {
    app,
    base,
    async stop() {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// A test user with one registered device, talking to the dev-mode server.
export async function connectUser(base, name) {
  const keys = await generateDeviceKeys();
  const headers = { 'X-Dev-User': name };
  const call = async (method, url, body, extra = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...headers,
        ...(client.token ? { Authorization: `Bearer ${client.token}` } : {}),
        ...(body !== undefined && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
    if (!res.ok) {
      const err = new Error(`${method} ${url} -> ${res.status} ${data.error}`);
      err.status = res.status;
      throw err;
    }
    return data;
  };
  const client = { id: `${name}@dev`, token: null, call };
  const reg = await call('POST', '/api/devices', { name: `${name}'s test device`, publicKey: keys.publicJwk });
  client.token = reg.token;
  client.deviceId = reg.device.id;
  client.ring = new KeyRing({
    deviceId: reg.device.id,
    privateKey: keys.privateKey,
    fetchPublicKeys: async (ids) => (await call('GET', `/api/keys?ids=${ids.join(',')}`)).devices,
  });
  client.events = [];
  client.socket = async () => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers });
    await new Promise((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: client.token })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ready') resolve();
        client.events.push(msg);
      });
      ws.on('error', reject);
      ws.on('close', (code) => reject(new Error(`closed ${code}`)));
    });
    client.ws = ws;
    return ws;
  };
  client.waitFor = async (predicate, timeout = 3000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const hit = client.events.find(predicate);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('Timed out waiting for event');
  };
  return client;
}
