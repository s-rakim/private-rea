// A Tailchat device driven by the Ruby tests, using the reference crypto in
// public/crypto.js. Reads one JSON command per line on stdin and answers one
// JSON line on stdout: {"ok":true,...} or {"ok":false,"error":"..."}.
//
//   node peer.mjs http://127.0.0.1:PORT
import fs from 'node:fs';
import readline from 'node:readline';
import WebSocket from 'ws';
import {
  KeyRing, chatAad, decryptFile, encryptFile, generateDeviceKeys, newMessageId, securityCode,
} from '../../../../public/crypto.js';

const base = process.argv[2];
const state = { user: null, token: null, deviceId: null, ring: null, ws: null, events: [] };

async function call(method, url, body, extra = {}) {
  const res = await fetch(base + url, {
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
}

async function open(message) {
  try {
    const content = await state.ring.open(message.payload, chatAad(message.chatId, message.id), message.senderId);
    return { content, error: null };
  } catch (err) {
    return { content: null, error: err.code || err.message };
  }
}

async function waitFor(predicate, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const hit = state.events.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Timed out waiting for event');
}

async function seal(chatId, content, extra = {}) {
  const id = newMessageId();
  const { devices } = await call('GET', `/api/chats/${chatId}/devices`);
  const payload = await state.ring.seal(content, chatAad(chatId, id), devices);
  return (await call('POST', `/api/chats/${chatId}/messages`, { id, payload, ...extra })).message;
}

const commands = {
  async register({ user }) {
    state.user = user;
    const keys = await generateDeviceKeys();
    const reg = await call('POST', '/api/devices', { name: `${user} (node peer)`, publicKey: keys.publicJwk });
    state.token = reg.token;
    state.deviceId = reg.device.id;
    state.ring = new KeyRing({
      deviceId: reg.device.id,
      privateKey: keys.privateKey,
      fetchPublicKeys: async (ids) => (await call('GET', `/api/keys?ids=${ids.join(',')}`)).devices,
    });
    return { userId: reg.device.userId, deviceId: reg.device.id };
  },

  async socket() {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { 'X-Dev-User': state.user } });
    await new Promise((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: state.token })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ready') resolve();
        state.events.push(msg);
      });
      ws.on('error', reject);
    });
    state.ws = ws;
    return {};
  },

  async direct({ userId }) {
    return { chat: (await call('POST', '/api/chats/direct', { userId })).chat };
  },

  async sendText({ chatId, text, replyTo }) {
    return { message: await seal(chatId, { type: 'text', text, ...(replyTo ? { replyTo } : {}) }) };
  },

  async sendFile({ chatId, path, name, mime, caption }) {
    const bytes = fs.readFileSync(path);
    const { blob, file } = await encryptFile(new Blob([bytes]));
    const up = await call('POST', '/api/files', new Uint8Array(await blob.arrayBuffer()), { 'Content-Type': 'application/octet-stream' });
    const content = { type: 'media', kind: 'document', file: { ...file, id: up.id, name, mime }, ...(caption ? { caption } : {}) };
    return { message: await seal(chatId, content, { files: [up.id] }), file: content.file };
  },

  async history({ chatId }) {
    const { messages } = await call('GET', `/api/chats/${chatId}/messages?limit=200`);
    const out = [];
    for (const m of messages) {
      if (m.kind !== 'msg' || !m.payload) continue;
      out.push({ id: m.id, seq: m.seq, senderId: m.senderId, senderDevice: m.senderDevice, ...(await open(m)) });
    }
    return { messages: out };
  },

  async download({ file, out }) {
    const blob = await call('GET', `/api/files/${file.id}`);
    const plain = new Uint8Array(await (await decryptFile(blob, file)).arrayBuffer());
    fs.writeFileSync(out, plain);
    return { size: plain.length };
  },

  // A message event in chatId from senderId, decrypted.
  async waitMessage({ chatId, senderId, afterSeq = 0, timeout = 8000 }) {
    const evt = await waitFor(
      (e) => e.type === 'message' && e.message.chatId === chatId && e.message.senderId === senderId && e.message.seq > afterSeq,
      timeout,
    );
    return { message: evt.message, ...(await open(evt.message)) };
  },

  async waitReceipt({ chatId, userId, readSeq, timeout = 8000 }) {
    const evt = await waitFor(
      (e) => e.type === 'receipt' && e.chatId === chatId && e.member.userId === userId && e.member.readSeq >= readSeq,
      timeout,
    );
    return { member: evt.member };
  },

  async securityCode({ userId }) {
    const { devices } = await call('GET', `/api/users/${encodeURIComponent(userId)}/devices`);
    return { code: await securityCode(devices) };
  },

  async close() {
    state.ws?.close();
    setTimeout(() => process.exit(0), 10);
    return {};
  },
};

const rl = readline.createInterface({ input: process.stdin });
let queue = Promise.resolve();
rl.on('line', (line) => {
  queue = queue.then(async () => {
    let reply;
    try {
      const { cmd, ...args } = JSON.parse(line);
      if (!commands[cmd]) throw new Error(`unknown command ${cmd}`);
      reply = { ok: true, ...(await commands[cmd](args)) };
    } catch (err) {
      reply = { ok: false, error: err.message };
    }
    process.stdout.write(JSON.stringify(reply) + '\n');
  });
});
rl.on('close', () => {
  state.ws?.close();
  queue.then(() => process.exit(0));
});
