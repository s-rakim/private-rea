// A JS Tailchat device driven by the Java interop tests. It uses the reference
// implementation (tailchat/public/crypto.js, path in $TAILCHAT_CRYPTO) for all crypto.
//
//   register BASE USER STATEFILE
//   send-text STATEFILE CHAT TEXT_B64U           -> {"id","chatId","seq"} (text is base64url UTF-8, so
//                                                   non-ASCII survives a non-UTF-8 locale)
//   send-file STATEFILE CHAT PATH NAME           -> {"id","chatId","seq","file"}
//   open STATEFILE CHAT MESSAGE_ID [OUTFILE]     -> decrypted content (file decrypted to OUTFILE)
//   open-bad-aad STATEFILE CHAT MESSAGE_ID       -> exits 0 only if decrypting with a wrong AAD fails
//   code STATEFILE USER                          -> security code of USER's devices
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const C = await import(pathToFileURL(process.env.TAILCHAT_CRYPTO).href);
const subtle = globalThis.crypto.subtle;

function client(state) {
  const call = async (method, url, body, extra = {}) => {
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
  return call;
}

async function ring(state, call) {
  const privateKey = await subtle.importKey('jwk', state.priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return new C.KeyRing({
    deviceId: state.deviceId,
    privateKey,
    fetchPublicKeys: async (ids) => (await call('GET', `/api/keys?ids=${ids.join(',')}`)).devices,
  });
}

async function findMessage(call, chatId, id) {
  let before = 0;
  for (;;) {
    const page = await call('GET', `/api/chats/${chatId}/messages?limit=200${before ? `&before=${before}` : ''}`);
    const hit = page.messages.find((m) => m.id === id);
    if (hit) return hit;
    if (!page.hasMore || !page.messages.length) throw new Error(`message ${id} not found`);
    before = page.messages[0].seq;
  }
}

async function send(state, chatId, content, files) {
  const call = client(state);
  const r = await ring(state, call);
  const id = C.newMessageId();
  const { devices } = await call('GET', `/api/chats/${chatId}/devices`);
  const payload = await r.seal(content, C.chatAad(chatId, id), devices);
  return (await call('POST', `/api/chats/${chatId}/messages`, { id, payload, ...(files ? { files } : {}) })).message;
}

const [cmd, ...args] = process.argv.slice(2);
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const print = (v) => process.stdout.write(JSON.stringify(v) + '\n');

switch (cmd) {
  case 'register': {
    const [base, user, file] = args;
    const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const priv = await subtle.exportKey('jwk', pair.privateKey);
    const pub = await subtle.exportKey('jwk', pair.publicKey);
    const state = { base, user, token: null };
    const reg = await client(state)('POST', '/api/devices', {
      name: `${user}'s JS test device`,
      publicKey: { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y },
    });
    Object.assign(state, {
      token: reg.token,
      deviceId: reg.device.id,
      userId: reg.device.userId,
      priv: { kty: 'EC', crv: 'P-256', x: priv.x, y: priv.y, d: priv.d },
    });
    fs.writeFileSync(file, JSON.stringify(state));
    print({ deviceId: state.deviceId, userId: state.userId });
    break;
  }
  case 'send-text': {
    const [file, chatId, text64] = args;
    const text = new TextDecoder().decode(C.unb64u(text64));
    const m = await send(load(file), chatId, { type: 'text', text });
    print({ id: m.id, chatId: m.chatId, seq: m.seq });
    break;
  }
  case 'send-file': {
    const [file, chatId, path, name] = args;
    const state = load(file);
    const call = client(state);
    const bytes = fs.readFileSync(path);
    const { blob, file: secrets } = await C.encryptFile(new Blob([bytes]));
    const up = await call('POST', '/api/files', new Uint8Array(await blob.arrayBuffer()), { 'Content-Type': 'application/octet-stream' });
    const f = { ...secrets, id: up.id, name, mime: 'application/octet-stream' };
    const m = await send(state, chatId, { type: 'media', kind: 'document', file: f, caption: 'from JS' }, [up.id]);
    print({ id: m.id, chatId: m.chatId, seq: m.seq, file: f });
    break;
  }
  case 'open': {
    const [file, chatId, id, out] = args;
    const state = load(file);
    const call = client(state);
    const r = await ring(state, call);
    const m = await findMessage(call, chatId, id);
    const content = await r.open(m.payload, C.chatAad(chatId, id));
    if (content.type === 'media' && out) {
      const blob = await call('GET', `/api/files/${content.file.id}`);
      const plain = await C.decryptFile(blob, content.file);
      fs.writeFileSync(out, new Uint8Array(await plain.arrayBuffer()));
    }
    print({ message: { id: m.id, senderId: m.senderId, senderDevice: m.senderDevice }, content, keyCount: Object.keys(JSON.parse(m.payload).keys).length });
    break;
  }
  case 'open-bad-aad': {
    const [file, chatId, id] = args;
    const state = load(file);
    const call = client(state);
    const r = await ring(state, call);
    const m = await findMessage(call, chatId, id);
    try {
      await r.open(m.payload, C.chatAad(chatId, 'some-other-message-id'));
    } catch {
      print({ rejected: true });
      break;
    }
    throw new Error('wrong AAD was accepted');
  }
  case 'code': {
    const [file, user] = args;
    const call = client(load(file));
    const { devices } = await call('GET', `/api/users/${encodeURIComponent(user)}/devices`);
    print({ code: await C.securityCode(devices) });
    break;
  }
  default:
    throw new Error(`unknown command ${cmd}`);
}
