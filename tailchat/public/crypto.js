// End-to-end encryption (PROTOCOL.md §2-5). Runs in browsers and in Node,
// which both provide WebCrypto as globalThis.crypto.
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const CHUNK = 1024 * 1024;

export function b64u(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(text) {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export function newMessageId() {
  return b64u(randomBytes(16));
}

export async function generateDeviceKeys() {
  // The private key is non-extractable: it can be stored in IndexedDB and used,
  // but script can never read its bytes.
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
}

export function importPublicKey(jwk) {
  return subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

// Wrap keys are cached: deriving one costs an ECDH operation.
export class KeyRing {
  constructor({ deviceId, privateKey, fetchPublicKeys }) {
    this.deviceId = deviceId;
    this.privateKey = privateKey;
    this.fetchPublicKeys = fetchPublicKeys; // async (ids) => [{id, publicKey}]
    this.publicKeys = new Map(); // deviceId -> CryptoKey
    this.wrapKeys = new Map(); // "S|R" -> CryptoKey
  }

  async addPublicKey(deviceId, jwk) {
    if (!this.publicKeys.has(deviceId)) this.publicKeys.set(deviceId, await importPublicKey(jwk));
  }

  async publicKey(deviceId) {
    if (!this.publicKeys.has(deviceId)) {
      const devices = await this.fetchPublicKeys([deviceId]);
      for (const d of devices) await this.addPublicKey(d.id, d.publicKey);
    }
    const key = this.publicKeys.get(deviceId);
    if (!key) throw new Error(`Unknown device ${deviceId}`);
    return key;
  }

  // senderId|recipientId always names the sender first, so both ends derive
  // the same key.
  async wrapKey(senderId, recipientId) {
    const cacheKey = `${senderId}|${recipientId}`;
    let key = this.wrapKeys.get(cacheKey);
    if (key) return key;
    const peer = senderId === this.deviceId ? recipientId : senderId;
    const shared = await subtle.deriveBits({ name: 'ECDH', public: await this.publicKey(peer) }, this.privateKey, 256);
    const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    key = await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('tailchat/v1/wrap'), info: enc.encode(cacheKey) },
      hkdf,
      { name: 'AES-KW', length: 256 },
      false,
      ['wrapKey', 'unwrapKey'],
    );
    this.wrapKeys.set(cacheKey, key);
    return key;
  }

  // recipients: [{id, publicKey}] - every device that may read the message.
  async seal(content, aad, recipients) {
    for (const d of recipients) await this.addPublicKey(d.id, d.publicKey);
    const contentKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const iv = randomBytes(12);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, contentKey, enc.encode(JSON.stringify(content)));
    const keys = {};
    const ids = new Set(recipients.map((d) => d.id));
    ids.add(this.deviceId);
    for (const id of ids) {
      keys[id] = b64u(await subtle.wrapKey('raw', contentKey, await this.wrapKey(this.deviceId, id), 'AES-KW'));
    }
    return JSON.stringify({ v: 1, from: this.deviceId, iv: b64u(iv), ct: b64u(ct), keys });
  }

  async open(payload, aad) {
    const env = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (env.v !== 1) throw new Error('Unsupported envelope version');
    const wrapped = env.keys?.[this.deviceId];
    if (!wrapped) {
      const err = new Error('Not encrypted for this device');
      err.code = 'NO_KEY';
      throw err;
    }
    const contentKey = await subtle.unwrapKey(
      'raw', unb64u(wrapped), await this.wrapKey(env.from, this.deviceId), 'AES-KW', 'AES-GCM', false, ['decrypt'],
    );
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(env.iv), additionalData: enc.encode(aad) }, contentKey, unb64u(env.ct));
    return JSON.parse(dec.decode(pt));
  }
}

export const chatAad = (chatId, messageId) => `tailchat/v1|chat:${chatId}|msg:${messageId}`;
export const statusAad = (userId) => `tailchat/v1|status:${userId}`;

function chunkIv(prefix, i) {
  const iv = new Uint8Array(12);
  iv.set(prefix, 0);
  new DataView(iv.buffer).setUint32(8, i, false);
  return iv;
}

const chunkAad = (i, last) => enc.encode(`tailchat/v1|file|${i}|${last ? 1 : 0}`);

// blob: a Blob/File. Returns { blob: encrypted Blob, file: fields for the content }.
export async function encryptFile(blob, onProgress) {
  const rawKey = randomBytes(32);
  const prefix = randomBytes(8);
  const key = await subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const parts = [];
  const count = Math.max(1, Math.ceil(blob.size / CHUNK));
  // SHA-256 over the whole plaintext; WebCrypto has no streaming digest, so
  // for big files we hash the per-chunk digests instead (still verifies all bytes).
  const digests = [];
  for (let i = 0; i < count; i++) {
    const plain = new Uint8Array(await blob.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer());
    digests.push(new Uint8Array(await subtle.digest('SHA-256', plain)));
    parts.push(await subtle.encrypt({ name: 'AES-GCM', iv: chunkIv(prefix, i), additionalData: chunkAad(i, i === count - 1) }, key, plain));
    onProgress?.((i + 1) / count);
  }
  return {
    blob: new Blob(parts, { type: 'application/octet-stream' }),
    file: { key: b64u(rawKey), prefix: b64u(prefix), size: blob.size, sha256: b64u(await chunkedDigest(digests)) },
  };
}

async function chunkedDigest(digests) {
  const all = new Uint8Array(digests.length * 32);
  digests.forEach((d, i) => all.set(d, i * 32));
  return new Uint8Array(await subtle.digest('SHA-256', all));
}

// encrypted: ArrayBuffer/Uint8Array of the uploaded blob. Returns a Blob.
export async function decryptFile(encrypted, file, mime = 'application/octet-stream') {
  const data = encrypted instanceof Uint8Array ? encrypted : new Uint8Array(encrypted);
  const key = await subtle.importKey('raw', unb64u(file.key), 'AES-GCM', false, ['decrypt']);
  const prefix = unb64u(file.prefix);
  const count = Math.max(1, Math.ceil(file.size / CHUNK));
  if (data.length !== file.size + count * 16) throw new Error('Encrypted file has the wrong size');
  const parts = [];
  const digests = [];
  for (let i = 0; i < count; i++) {
    const start = i * (CHUNK + 16);
    const ct = data.subarray(start, Math.min(start + CHUNK + 16, data.length));
    const pt = new Uint8Array(
      await subtle.decrypt({ name: 'AES-GCM', iv: chunkIv(prefix, i), additionalData: chunkAad(i, i === count - 1) }, key, ct),
    );
    digests.push(new Uint8Array(await subtle.digest('SHA-256', pt)));
    parts.push(pt);
  }
  if (file.sha256 && b64u(await chunkedDigest(digests)) !== file.sha256) throw new Error('File checksum mismatch');
  return new Blob(parts, { type: mime });
}

// Security code for a set of device keys (PROTOCOL.md §3).
export async function securityCode(devices) {
  const digests = [];
  for (const d of devices) {
    const raw = new Uint8Array(64);
    raw.set(unb64u(d.publicKey.x), 0);
    raw.set(unb64u(d.publicKey.y), 32);
    digests.push(b64u(await subtle.digest('SHA-256', raw)));
  }
  digests.sort();
  const all = new Uint8Array(await subtle.digest('SHA-256', enc.encode(digests.join(''))));
  const groups = [];
  for (let i = 0; i < 12; i++) {
    const n = ((all[i * 2] << 16) | (all[i * 2 + 1] << 8) | all[24 + (i % 8)]) % 100000;
    groups.push(String(n).padStart(5, '0'));
  }
  return groups.join(' ');
}
