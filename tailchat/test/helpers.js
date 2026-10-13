import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { KeyRing, generateDeviceKeys } from '../public/crypto.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Starts the Python server (python -m tailchat_server) in dev mode on a free
// port. TAILCHAT_SERVER_CMD overrides the command.
export async function startServer(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-test-'));
  const port = await freePort();
  const cmd = process.env.TAILCHAT_SERVER_CMD || `${process.env.PYTHON || 'python3'} -m tailchat_server`;
  const child = spawn(cmd, {
    cwd: ROOT,
    shell: true,
    detached: true, // own process group, so stop() also ends the shell's child
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TAILCHAT_AUTH: 'dev',
      TAILCHAT_HOST: '127.0.0.1',
      TAILCHAT_PORT: String(port),
      TAILCHAT_DATA: dataDir,
      TAILCHAT_SWEEP_INTERVAL_MS: '200',
      ...env,
    },
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await fetch(base + '/api/me');
      break;
    } catch {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`server did not start:\n${output}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    base,
    output: () => output,
    async stop() {
      const exited = new Promise((r) => (child.exitCode !== null ? r() : child.on('exit', r)));
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
      await exited;
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
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
