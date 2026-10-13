// A tiny JS client built on the reference implementation (public/crypto.js),
// used by the Python tests to prove interoperability in both directions.
//
//   node interop.mjs register BASE USER STATE
//   node interop.mjs send STATE CHAT_OR_USER TEXT
//   node interop.mjs send-file STATE CHAT_OR_USER PATH NAME MIME
//   node interop.mjs read STATE CHAT_ID OUTDIR
//   node interop.mjs security-code DEVICES_JSON
//   node interop.mjs decrypt-file BLOB FILE_JSON OUT
//
// Every command prints one JSON value on stdout.
import fs from 'node:fs';
import path from 'node:path';
import { KeyRing, chatAad, decryptFile, encryptFile, newMessageId, securityCode } from '../../../public/crypto.js';

const subtle = globalThis.crypto.subtle;
const [cmd, ...args] = process.argv.slice(2);

function client(state) {
  return async (method, url, body, extra = {}) => {
    const res = await fetch(state.base + url, {
      method,
      headers: {
        'X-Dev-User': state.user,
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
        ...(body !== undefined && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${data.error}`);
    return data;
  };
}

async function load(statePath) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const call = client(state);
  const privateKey = await subtle.importKey('jwk', state.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const ring = new KeyRing({
    deviceId: state.deviceId,
    privateKey,
    fetchPublicKeys: async (ids) => (await call('GET', `/api/keys?ids=${ids.join(',')}`)).devices,
  });
  return { state, call, ring };
}

async function chatFor(call, target) {
  if (!target.includes('@')) return target;
  return (await call('POST', '/api/chats/direct', { userId: target })).chat.id;
}

async function send(call, ring, chatId, content, extra = {}) {
  const id = newMessageId();
  const { devices } = await call('GET', `/api/chats/${chatId}/devices`);
  const payload = await ring.seal(content, chatAad(chatId, id), devices);
  return (await call('POST', `/api/chats/${chatId}/messages`, { id, payload, ...extra })).message;
}

const commands = {
  async register(base, user, statePath) {
    // Extractable only so the test helper can keep it between invocations.
    const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const jwk = await subtle.exportKey('jwk', pair.privateKey);
    const state = { base, user, token: null };
    const reg = await client(state)('POST', '/api/devices', {
      name: `${user}'s JS interop device`,
      publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    });
    Object.assign(state, { token: reg.token, deviceId: reg.device.id, userId: reg.device.userId, privateJwk: jwk });
    fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    return { deviceId: state.deviceId, userId: state.userId };
  },

  async send(statePath, target, text) {
    const { call, ring } = await load(statePath);
    const chatId = await chatFor(call, target);
    return { chatId, message: await send(call, ring, chatId, { type: 'text', text }) };
  },

  async 'send-file'(statePath, target, filePath, name, mime) {
    const { call, ring } = await load(statePath);
    const chatId = await chatFor(call, target);
    const { blob, file } = await encryptFile(new Blob([fs.readFileSync(filePath)]));
    const up = await call('POST', '/api/files', new Uint8Array(await blob.arrayBuffer()), { 'Content-Type': 'application/octet-stream' });
    const content = { type: 'media', kind: 'document', file: { ...file, id: up.id, name, mime } };
    return { chatId, message: await send(call, ring, chatId, content, { files: [up.id] }) };
  },

  async read(statePath, chatId, outDir) {
    const { call, ring } = await load(statePath);
    const { messages } = await call('GET', `/api/chats/${chatId}/messages?limit=200`);
    const out = [];
    for (const m of messages) {
      if (m.kind !== 'msg' || !m.payload) continue;
      const row = { id: m.id, senderId: m.senderId };
      try {
        row.content = await ring.open(m.payload, chatAad(chatId, m.id));
        if (row.content.type === 'media') {
          const encrypted = await call('GET', `/api/files/${row.content.file.id}`);
          const plain = new Uint8Array(await (await decryptFile(encrypted, row.content.file)).arrayBuffer());
          row.savedTo = path.join(outDir, m.id);
          fs.writeFileSync(row.savedTo, plain);
        }
      } catch (err) {
        row.error = String(err?.message || err);
      }
      out.push(row);
    }
    return out;
  },

  async 'security-code'(devicesPath) {
    return { code: await securityCode(JSON.parse(fs.readFileSync(devicesPath, 'utf8'))) };
  },

  // Offline: decrypt a blob that Python encrypted, with crypto.js.
  async 'decrypt-file'(blobPath, fileJsonPath, outPath) {
    const file = JSON.parse(fs.readFileSync(fileJsonPath, 'utf8'));
    const plain = await decryptFile(new Uint8Array(fs.readFileSync(blobPath)), file);
    fs.writeFileSync(outPath, new Uint8Array(await plain.arrayBuffer()));
    return { ok: true };
  },
};

try {
  if (!commands[cmd]) throw new Error(`unknown command ${cmd}`);
  process.stdout.write(JSON.stringify(await commands[cmd](...args)) + '\n');
} catch (err) {
  process.stderr.write(`interop.mjs ${cmd}: ${err.stack || err}\n`);
  process.exit(1);
}
