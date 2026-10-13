// A Tailchat peer built on the reference crypto (public/crypto.js), driven by
// the Rust integration test over stdin/stdout, one JSON object per line:
//   -> {"id": 1, "cmd": "register", "user": "jsuser"}
//   <- {"id": 1, "ok": true, "result": {...}}
// Usage: node peer.mjs <server base URL>
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const cryptoUrl = process.env.TAILCHAT_CRYPTO_JS
  ? new URL(`file://${path.resolve(process.env.TAILCHAT_CRYPTO_JS)}`)
  : new URL('../../../../public/crypto.js', import.meta.url);
const { KeyRing, generateDeviceKeys, chatAad, newMessageId, encryptFile, decryptFile, securityCode } = await import(cryptoUrl);

const base = process.argv[2];
let user = null;
let token = null;
let ring = null;

async function call(method, url, body) {
  const headers = { 'X-Dev-User': user };
  if (token) headers.Authorization = `Bearer ${token}`;
  let data;
  if (body instanceof Uint8Array) {
    headers['Content-Type'] = 'application/octet-stream';
    data = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    data = JSON.stringify(body);
  }
  const res = await fetch(base + url, { method, headers, body: data });
  const type = res.headers.get('content-type') || '';
  const out = type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${out.error ?? ''}`);
  return out;
}

async function send(chatId, content, files = []) {
  const id = newMessageId();
  const { devices } = await call('GET', `/api/chats/${encodeURIComponent(chatId)}/devices`);
  const payload = await ring.seal(content, chatAad(chatId, id), devices);
  return (await call('POST', `/api/chats/${encodeURIComponent(chatId)}/messages`, { id, payload, files })).message;
}

async function history(chatId) {
  const { messages } = await call('GET', `/api/chats/${encodeURIComponent(chatId)}/messages?limit=200`);
  const out = [];
  for (const m of messages) {
    if (m.kind !== 'msg' || !m.payload) continue;
    try {
      out.push({ id: m.id, senderId: m.senderId, content: await ring.open(m.payload, chatAad(chatId, m.id), m.senderId) });
    } catch (err) {
      out.push({ id: m.id, senderId: m.senderId, error: String(err.message || err) });
    }
  }
  return out;
}

const commands = {
  async register({ user: name }) {
    user = name;
    const keys = await generateDeviceKeys();
    const reg = await call('POST', '/api/devices', { name: `${name}'s JS peer`, publicKey: keys.publicJwk });
    token = reg.token;
    ring = new KeyRing({
      deviceId: reg.device.id,
      privateKey: keys.privateKey,
      fetchPublicKeys: async (ids) => (await call('GET', `/api/keys?ids=${ids.map(encodeURIComponent).join(',')}`)).devices,
    });
    return { userId: reg.device.userId, deviceId: reg.device.id };
  },
  async direct({ userId }) {
    return { chatId: (await call('POST', '/api/chats/direct', { userId })).chat.id };
  },
  async sendText({ chatId, text }) {
    return { messageId: (await send(chatId, { type: 'text', text })).id };
  },
  async sendFile({ chatId, file, name, mime, kind }) {
    const bytes = fs.readFileSync(file);
    const { blob, file: meta } = await encryptFile(new Blob([bytes]));
    const up = await call('POST', '/api/files', new Uint8Array(await blob.arrayBuffer()));
    const content = { type: 'media', kind, file: { ...meta, id: up.id, name, mime } };
    return { messageId: (await send(chatId, content, [up.id])).id, fileId: up.id };
  },
  async messages({ chatId }) {
    return history(chatId);
  },
  // Download and decrypt every file in the chat with decryptFile().
  async download({ chatId, outDir }) {
    fs.mkdirSync(outDir, { recursive: true });
    const saved = [];
    for (const m of await history(chatId)) {
      if (m.error || m.content.type !== 'media') continue;
      const f = m.content.file;
      const encrypted = await call('GET', `/api/files/${encodeURIComponent(f.id)}`);
      const plain = new Uint8Array(await (await decryptFile(encrypted, f)).arrayBuffer());
      fs.writeFileSync(path.join(outDir, path.basename(f.name)), plain);
      saved.push({ name: f.name, size: f.size, kind: m.content.kind, mime: f.mime, caption: m.content.caption ?? null });
    }
    return saved;
  },
  async securityCode({ userId }) {
    const { devices } = await call('GET', `/api/users/${encodeURIComponent(userId)}/devices`);
    return { code: await securityCode(devices) };
  },
};

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  const req = JSON.parse(line);
  if (req.cmd === 'quit') break;
  let reply;
  try {
    const fn = commands[req.cmd];
    if (!fn) throw new Error(`unknown command ${req.cmd}`);
    reply = { id: req.id, ok: true, result: await fn(req) };
  } catch (err) {
    reply = { id: req.id, ok: false, error: String(err.stack || err) };
  }
  process.stdout.write(JSON.stringify(reply) + '\n');
}
process.exit(0);
