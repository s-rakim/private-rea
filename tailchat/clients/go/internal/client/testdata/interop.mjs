// Interop peer for the Go tests: the reference crypto (public/crypto.js) on
// the other end. Talks to the Go test over stdin/stdout, one JSON line each.
//
//   node interop.mjs files MANIFEST   offline: decrypt Go blobs, encrypt blobs for Go
//   node interop.mjs chat             a dev-mode user chatting with the Go user
//
// Environment: TAILCHAT_CRYPTO_URL (file:// URL of public/crypto.js), and for
// chat mode TAILCHAT_BASE, GO_USER, JS_USER.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const { KeyRing, generateDeviceKeys, chatAad, newMessageId, encryptFile, decryptFile, securityCode } = await import(
  process.env.TAILCHAT_CRYPTO_URL
);

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lines = readline.createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const nextLine = async () => {
  const { value, done } = await lines.next();
  if (done) throw new Error('stdin closed');
  return value;
};

async function filesMode(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const decrypted = [];
  for (const g of manifest.goBlobs) {
    const blob = fs.readFileSync(g.path);
    const plain = new Uint8Array(await (await decryptFile(blob, g.file)).arrayBuffer());
    decrypted.push({ size: plain.length, sha256: sha256hex(plain) });
  }
  const encrypted = [];
  for (const [i, size] of manifest.jsSizes.entries()) {
    const plain = randomBytes(size);
    const { blob, file } = await encryptFile(new Blob([plain]));
    const p = path.join(manifest.outDir, `js-${i}.bin`);
    fs.writeFileSync(p, new Uint8Array(await blob.arrayBuffer()));
    encrypted.push({ path: p, file, sha256: sha256hex(plain) });
  }
  out({ decrypted, encrypted });
}

async function chatMode() {
  const base = process.env.TAILCHAT_BASE;
  const goUser = process.env.GO_USER;
  const me = process.env.JS_USER;
  let token = null;
  const call = async (method, url, body) => {
    const headers = { 'X-Dev-User': me };
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body instanceof Uint8Array) {
      headers['Content-Type'] = 'application/octet-stream';
      payload = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${data.error}`);
    return data;
  };

  const keys = await generateDeviceKeys();
  const reg = await call('POST', '/api/devices', { name: 'JS interop peer', publicKey: keys.publicJwk });
  token = reg.token;
  const ring = new KeyRing({
    deviceId: reg.device.id,
    privateKey: keys.privateKey,
    fetchPublicKeys: async (ids) => (await call('GET', `/api/keys?ids=${ids.join(',')}`)).devices,
  });
  const { chat } = await call('POST', '/api/chats/direct', { userId: goUser });
  out({ phase: 'registered', chatId: chat.id, deviceId: reg.device.id, userId: reg.device.userId });

  if ((await nextLine()) !== 'send') throw new Error('expected "send"');
  const send = async (content, extra = {}) => {
    const id = newMessageId();
    const { devices } = await call('GET', `/api/chats/${chat.id}/devices`);
    const payload = await ring.seal(content, chatAad(chat.id, id), devices);
    return (await call('POST', `/api/chats/${chat.id}/messages`, { id, payload, ...extra })).message;
  };
  const text = 'hello from JS ✓ 🙂 "quoted" <b>&amp;</b>\nsecond line';
  const textMsg = await send({ type: 'text', text });
  const plain = randomBytes(1024 * 1024 + 512 * 1024 + 321);
  const { blob, file } = await encryptFile(new Blob([plain]));
  const up = await call('POST', '/api/files', new Uint8Array(await blob.arrayBuffer()));
  const fileName = 'from-js ✓.bin';
  const fileMsg = await send(
    { type: 'media', kind: 'document', caption: 'js file', file: { ...file, id: up.id, name: fileName, mime: 'application/octet-stream' } },
    { files: [up.id] },
  );
  out({
    phase: 'sent',
    textId: textMsg.id,
    fileMessageId: fileMsg.id,
    text,
    fileSha256: sha256hex(plain),
    fileSize: plain.length,
    fileName,
    codeGo: await securityCode((await call('GET', `/api/users/${encodeURIComponent(goUser)}/devices`)).devices),
    codeJs: await securityCode((await call('GET', `/api/users/${encodeURIComponent(me)}/devices`)).devices),
  });

  const want = JSON.parse(await nextLine());
  const { messages } = await call('GET', `/api/chats/${chat.id}/messages?limit=200`);
  const find = (id) => {
    const m = messages.find((x) => x.id === id);
    if (!m) throw new Error(`message ${id} not found`);
    return m;
  };
  const goText = find(want.textId);
  const goFile = find(want.fileMessageId);
  const opened = await ring.open(goText.payload, chatAad(chat.id, goText.id));
  const media = await ring.open(goFile.payload, chatAad(chat.id, goFile.id));
  const downloaded = await call('GET', `/api/files/${media.file.id}`);
  // decryptFile verifies every chunk and the chunked sha256.
  const filePlain = new Uint8Array(await (await decryptFile(downloaded, media.file)).arrayBuffer());
  out({
    phase: 'opened',
    text: opened.text,
    textSender: goText.senderId,
    fileSha256: sha256hex(filePlain),
    fileSize: filePlain.length,
    fileName: media.file.name,
    fileMime: media.file.mime,
    kind: media.kind,
    caption: media.caption ?? null,
  });
}

try {
  if (process.argv[2] === 'files') await filesMode(process.argv[3]);
  else if (process.argv[2] === 'chat') await chatMode();
  else throw new Error('usage: interop.mjs files MANIFEST | chat');
  process.exit(0);
} catch (err) {
  process.stderr.write(`interop.mjs: ${err.stack || err}\n`);
  process.exit(1);
}
