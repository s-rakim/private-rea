// A JavaScript Tailchat device for the C# interop tests. It uses the web app's
// own crypto (public/crypto.js) so whatever it seals or opens is exactly what
// the browser would. Each command prints one JSON object on stdout.
//
//   node peer.mjs init BASE NAME STATE           register a device for dev user NAME
//   node peer.mjs direct STATE USER_ID           open the direct chat with USER_ID
//   node peer.mjs send-text STATE CHAT TEXT      seal and send a text message
//   node peer.mjs send-file STATE CHAT IN NAME MIME   encrypt, upload and send a file
//   node peer.mjs open STATE CHAT MSG [OUT]      decrypt a message (and its file into OUT)
//   node peer.mjs security-code STATE USER_ID    security code for USER_ID and STATE's user
//
// TAILCHAT_CRYPTO_JS must point at public/crypto.js.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const cryptoPath = process.env.TAILCHAT_CRYPTO_JS;
if (!cryptoPath) throw new Error('TAILCHAT_CRYPTO_JS is not set');
const { KeyRing, chatAad, decryptFile, encryptFile, newMessageId, securityCode } = await import(pathToFileURL(cryptoPath).href);
const subtle = globalThis.crypto.subtle;

async function call(state, method, url, body) {
  const headers = { 'X-Dev-User': state.name };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const binary = body instanceof Uint8Array;
  if (body !== undefined) headers['Content-Type'] = binary ? 'application/octet-stream' : 'application/json';
  const res = await fetch(state.base + url, {
    method,
    headers,
    body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${data.error}`);
  return data;
}

const load = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

async function ring(state) {
  const privateKey = await subtle.importKey('jwk', { ...state.jwk, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return new KeyRing({
    deviceId: state.deviceId,
    privateKey,
    fetchPublicKeys: async (ids) => (await call(state, 'GET', `/api/keys?ids=${ids.join(',')}`)).devices,
  });
}

async function send(state, chatId, content, extra = {}) {
  const id = newMessageId();
  const { devices } = await call(state, 'GET', `/api/chats/${encodeURIComponent(chatId)}/devices`);
  const payload = await (await ring(state)).seal(content, chatAad(chatId, id), devices);
  return (await call(state, 'POST', `/api/chats/${encodeURIComponent(chatId)}/messages`, { id, payload, ...extra })).message;
}

const [cmd, ...args] = process.argv.slice(2);
let out;
switch (cmd) {
  case 'init': {
    const [base, name, file] = args;
    const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const jwk = await subtle.exportKey('jwk', pair.privateKey);
    const state = { base, name, jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d } };
    const reg = await call(state, 'POST', '/api/devices', { name: `${name}'s JS peer`, publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } });
    Object.assign(state, { token: reg.token, deviceId: reg.device.id, userId: reg.device.userId });
    fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    out = { userId: state.userId, deviceId: state.deviceId };
    break;
  }
  case 'direct': {
    const [file, userId] = args;
    out = { chatId: (await call(load(file), 'POST', '/api/chats/direct', { userId })).chat.id };
    break;
  }
  case 'send-text': {
    const [file, chatId, text] = args;
    const m = await send(load(file), chatId, { type: 'text', text });
    out = { id: m.id, seq: m.seq };
    break;
  }
  case 'send-file': {
    const [file, chatId, input, name, mime] = args;
    const state = load(file);
    const { blob, file: meta } = await encryptFile(new Blob([fs.readFileSync(input)]));
    const up = await call(state, 'POST', '/api/files', new Uint8Array(await blob.arrayBuffer()));
    const content = { type: 'media', kind: 'document', file: { ...meta, id: up.id, name, mime }, caption: 'from js' };
    const m = await send(state, chatId, content, { files: [up.id] });
    out = { id: m.id, seq: m.seq, fileId: up.id, sha256: meta.sha256 };
    break;
  }
  case 'open': {
    const [file, chatId, messageId, output] = args;
    const state = load(file);
    const { messages } = await call(state, 'GET', `/api/chats/${encodeURIComponent(chatId)}/messages?limit=200`);
    const m = messages.find((x) => x.id === messageId);
    if (!m) throw new Error(`message ${messageId} not found`);
    const content = await (await ring(state)).open(m.payload, chatAad(chatId, m.id));
    if (content.type === 'media' && output) {
      const encrypted = await call(state, 'GET', `/api/files/${content.file.id}`);
      const plain = new Uint8Array(await (await decryptFile(encrypted, content.file)).arrayBuffer());
      fs.writeFileSync(output, plain);
    }
    out = { senderId: m.senderId, senderDevice: m.senderDevice, content };
    break;
  }
  case 'security-code': {
    const [file, userId] = args;
    const state = load(file);
    const mine = (await call(state, 'GET', `/api/users/${encodeURIComponent(state.userId)}/devices`)).devices;
    const theirs = userId === state.userId ? [] : (await call(state, 'GET', `/api/users/${encodeURIComponent(userId)}/devices`)).devices;
    out = { code: await securityCode([...mine, ...theirs]) };
    break;
  }
  default:
    throw new Error(`unknown command ${cmd}`);
}
process.stdout.write(JSON.stringify(out) + '\n');
