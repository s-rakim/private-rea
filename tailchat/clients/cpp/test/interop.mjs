// Interop test: the C++ client against a real dev-mode Tailchat server, with
// the web app's public/crypto.js on the other end. Proves both directions:
// C++-sealed text and multi-chunk files open in JS, JS-sealed ones open in C++.
//
//   node --no-warnings=ExperimentalWarning test/interop.mjs path/to/tailchat-cpp
//
// Server selection (startServer): $TAILCHAT_SERVER_CMD (a shell command) if
// set, else the Python server (tailchat/tailchat_server) when present, else
// the Node server (tailchat/server/index.js).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '../../..'); // tailchat/
const { CHUNK, chatAad, decryptFile, encryptFile, generateDeviceKeys, KeyRing, newMessageId, securityCode, b64u } =
  await import(path.join(appDir, 'public/crypto.js'));

const bin = path.resolve(process.argv[2] || path.join(here, '../build/tailchat-cpp'));
if (!fs.existsSync(bin)) {
  console.error(`tailchat-cpp binary not found at ${bin}; build first (cmake --build build)`);
  process.exit(2);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-cpp-interop-'));
const dataDir = path.join(work, 'data');
const statePath = path.join(work, 'state', 'cpp-state.json');
fs.mkdirSync(dataDir);

// ---------- server ----------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// The one place that decides how to run the server.
function serverCommand() {
  if (process.env.TAILCHAT_SERVER_CMD) {
    return { cmd: '/bin/sh', args: ['-c', process.env.TAILCHAT_SERVER_CMD], label: `TAILCHAT_SERVER_CMD (${process.env.TAILCHAT_SERVER_CMD})` };
  }
  if (fs.existsSync(path.join(appDir, 'tailchat_server', '__main__.py'))) {
    return { cmd: 'python3', args: ['-m', 'tailchat_server'], label: 'python3 -m tailchat_server' };
  }
  if (!fs.existsSync(path.join(appDir, 'node_modules'))) {
    const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: appDir, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('npm install failed');
  }
  return {
    cmd: process.execPath,
    args: ['--no-warnings=ExperimentalWarning', 'server/index.js'],
    label: 'node server/index.js',
  };
}

async function startServer() {
  const port = await freePort();
  const { cmd, args, label } = serverCommand();
  const log = fs.openSync(path.join(work, 'server.log'), 'w');
  const child = spawn(cmd, args, {
    cwd: appDir,
    env: { ...process.env, TAILCHAT_AUTH: 'dev', TAILCHAT_HOST: '127.0.0.1', TAILCHAT_PORT: String(port), TAILCHAT_DATA: dataDir },
    stdio: ['ignore', log, log],
  });
  let exited = null;
  child.on('exit', (code) => (exited = code));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (exited !== null) throw new Error(`server exited with ${exited}:\n${fs.readFileSync(path.join(work, 'server.log'), 'utf8')}`);
    try {
      const r = await fetch(base + '/api/me', { headers: { 'X-Dev-User': 'probe' } });
      if (r.status === 401 || r.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`# server: ${label} on ${base}`);
  return { base, stop: () => child.kill('SIGTERM') };
}

// ---------- JS user (the web app's crypto) ----------

async function connectJsUser(base, name) {
  const keys = await generateDeviceKeys();
  const client = { id: `${name}@dev`, token: null };
  client.call = async (method, url, body, extra = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        'X-Dev-User': name,
        ...(client.token ? { Authorization: `Bearer ${client.token}` } : {}),
        ...(body !== undefined && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
    if (!res.ok) throw Object.assign(new Error(`${method} ${url} -> ${res.status} ${data.error}`), { status: res.status });
    return data;
  };
  const reg = await client.call('POST', '/api/devices', { name: `${name}'s JS device`, publicKey: keys.publicJwk });
  client.token = reg.token;
  client.deviceId = reg.device.id;
  client.ring = new KeyRing({
    deviceId: reg.device.id,
    privateKey: keys.privateKey,
    fetchPublicKeys: async (ids) => (await client.call('GET', `/api/keys?ids=${ids.join(',')}`)).devices,
  });
  client.send = async (chatId, content, extra = {}) => {
    const id = newMessageId();
    const { devices } = await client.call('GET', `/api/chats/${chatId}/devices`);
    const payload = await client.ring.seal(content, chatAad(chatId, id), devices);
    return (await client.call('POST', `/api/chats/${chatId}/messages`, { id, payload, ...extra })).message;
  };
  client.message = async (chatId, id) => {
    const { messages } = await client.call('GET', `/api/chats/${chatId}/messages?limit=200`);
    const m = messages.find((x) => x.id === id);
    assert.ok(m, `message ${id} not found in ${chatId}`);
    return m;
  };
  return client;
}

// ---------- C++ client ----------

function cpp(user, args, { expectFail = false } = {}) {
  const r = spawnSync(bin, ['--server', server.base, '--dev-user', user, '--state', statePath, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (expectFail) {
    assert.notEqual(r.status, 0, `expected failure of tailchat-cpp ${args.join(' ')}, got:\n${r.stdout}`);
    return r;
  }
  if (r.status !== 0) throw new Error(`tailchat-cpp ${args.join(' ')} exited ${r.status}:\n${r.stderr}`);
  return r;
}
const cppJson = (user, args) => {
  const r = cpp(user, ['--json', ...args]);
  const lines = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { lines, first: lines[0], stderr: r.stderr };
};
const peakRssKiB = (stderr) => Number(/peak RSS (\d+) KiB/.exec(stderr)?.[1]);

function writeRandomFile(p, size) {
  const fd = fs.openSync(p, 'w');
  const buf = Buffer.alloc(4 * 1024 * 1024);
  for (let left = size; left > 0; ) {
    const n = Math.min(left, buf.length);
    crypto.randomFillSync(buf, 0, n);
    fs.writeSync(fd, buf, 0, n);
    left -= n;
  }
  fs.closeSync(fd);
}
const fileSha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ---------- runner ----------

let failed = 0;
let passed = 0;
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    passed++;
    console.log(`ok - ${name} (${Date.now() - t} ms)`);
  } catch (err) {
    failed++;
    console.log(`not ok - ${name}\n  ${String(err.stack || err).split('\n').join('\n  ')}`);
  }
}

const server = await startServer();
let bob, alice, chatId;
const files = path.join(work, 'files');
fs.mkdirSync(files);

try {
  bob = await connectJsUser(server.base, 'bob');

  await step('C++ registers a device; state file is 0600; security code matches JS', async () => {
    const { first: me } = cppJson('alice', ['whoami']);
    assert.equal(me.user.id, 'alice@dev');
    assert.equal(me.authMode, 'dev');
    alice = { deviceId: me.device.id };
    assert.equal((fs.statSync(statePath).mode & 0o777).toString(8), '600');
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const prof = Object.values(saved.profiles)[0];
    assert.equal(prof.deviceId, me.device.id);
    assert.equal(Buffer.from(prof.key.d, 'base64url').length, 32);
    // Same device on a second run (no re-registration).
    assert.equal(cppJson('alice', ['whoami']).first.device.id, me.device.id);
    const { devices } = await bob.call('GET', '/api/users/alice@dev/devices');
    assert.equal(devices.length, 1);
    assert.equal(Buffer.from(devices[0].publicKey.x, 'base64url').length, 32);
    assert.equal(me.securityCode, await securityCode(devices));
  });

  const text = 'héllo from C++ 👋 "quotes" \\ back\nslash\ttab \u0001 <end>';
  await step('C++ text message decrypts in JS (envelope is byte-identical JSON)', async () => {
    const { first: sent } = cppJson('alice', ['send', 'bob@dev', '--', text]);
    chatId = sent.chatId;
    const m = await bob.message(chatId, sent.id);
    assert.equal(m.senderDevice, alice.deviceId);
    const content = await bob.ring.open(m.payload, chatAad(chatId, sent.id));
    assert.deepEqual(content, { type: 'text', text });
    const env = JSON.parse(m.payload);
    assert.equal(JSON.stringify(env), m.payload, 'envelope serialises exactly like JSON.stringify');
    assert.deepEqual(Object.keys(env), ['v', 'from', 'iv', 'ct', 'keys']);
    assert.equal(env.v, 1);
    assert.equal(Buffer.from(env.iv, 'base64url').length, 12);
    assert.ok(!/[=+/]/.test(env.iv + env.ct), 'base64url without padding');
    assert.deepEqual(Object.keys(env.keys).sort(), [alice.deviceId, bob.deviceId].sort());
    for (const k of Object.values(env.keys)) assert.equal(Buffer.from(k, 'base64url').length, 40);
    // AAD binds it to the message id.
    await assert.rejects(bob.ring.open(m.payload, chatAad(chatId, 'some-other-message-id')));
  });

  for (const [label, size] of [
    ['multi-chunk 2.5 MiB + 123 B', 2.5 * CHUNK + 123],
    ['empty', 0],
    ['exactly 1 MiB', CHUNK],
    ['exactly 2 MiB', 2 * CHUNK],
  ]) {
    await step(`C++ send-file (${label}) decrypts in JS`, async () => {
      const p = path.join(files, `cpp-${size}.bin`);
      writeRandomFile(p, size);
      const { first: sent } = cppJson('alice', ['send-file', 'bob@dev', p, '--caption', 'from C++']);
      const chunks = Math.max(1, Math.ceil(size / CHUNK));
      assert.equal(sent.size, size);
      assert.equal(sent.uploaded, size + 16 * chunks);
      const m = await bob.message(sent.chatId, sent.id);
      assert.deepEqual(m.files, [sent.fileId]);
      const content = await bob.ring.open(m.payload, chatAad(sent.chatId, sent.id));
      assert.equal(content.type, 'media');
      assert.equal(content.kind, 'document');
      assert.equal(content.caption, 'from C++');
      assert.deepEqual(Object.keys(content.file), ['key', 'prefix', 'size', 'sha256', 'id', 'name', 'mime']);
      assert.equal(content.file.id, sent.fileId);
      assert.equal(content.file.size, size);
      assert.equal(content.file.name, path.basename(p));
      assert.equal(content.file.sha256, sent.sha256);
      const blob = await bob.call('GET', `/api/files/${content.file.id}`);
      assert.equal(blob.length, size + 16 * chunks);
      const plain = new Uint8Array(await (await decryptFile(blob, content.file)).arrayBuffer());
      assert.ok(Buffer.from(plain).equals(fs.readFileSync(p)), 'plaintext matches');
      // And the JS encoder agrees on the chunked sha256 of the same bytes.
      const { file: jsFile } = await encryptFile(new Blob([fs.readFileSync(p)]));
      assert.equal(jsFile.sha256, content.file.sha256);
    });
  }

  await step('JS text message decrypts in C++ (history)', async () => {
    const jsText = 'hi from the web app ✓ "ok"\n line 2';
    const sent = await bob.send(chatId, { type: 'text', text: jsText, mentions: ['alice@dev'] });
    const { lines } = cppJson('alice', ['history', chatId]);
    const mine = lines.find((l) => l.id === sent.id);
    assert.ok(mine, 'message listed');
    assert.equal(mine.error, undefined);
    assert.deepEqual(mine.content, { type: 'text', text: jsText, mentions: ['alice@dev'] });
    // Every message in the chat decrypts for alice, including her own (self-wrap).
    for (const l of lines) assert.ok(l.content, `message ${l.id} decrypted: ${l.error}`);
    const own = lines.find((l) => l.content.text === text);
    assert.ok(own, 'own C++ message decrypts');
    // Human-readable output too.
    const plainOut = cpp('alice', ['history', chatId]).stdout;
    assert.ok(plainOut.includes('hi from the web app ✓'));
    // history also accepts a user id for the direct chat.
    assert.ok(cppJson('alice', ['history', 'bob@dev']).lines.some((l) => l.id === sent.id));
  });

  for (const [label, size] of [
    ['multi-chunk 3 MiB + 1 B', 3 * CHUNK + 1],
    ['empty', 0],
    ['exactly 1 MiB', CHUNK],
  ]) {
    await step(`JS file (${label}) downloads and verifies in C++`, async () => {
      const bytes = crypto.randomBytes(size);
      const { blob, file } = await encryptFile(new Blob([bytes]));
      const up = await bob.call('POST', '/api/files', new Uint8Array(await blob.arrayBuffer()), { 'Content-Type': 'application/octet-stream' });
      const name = `from js ${size}.bin`;
      const sent = await bob.send(chatId, { type: 'media', kind: 'document', file: { ...file, id: up.id, name, mime: 'application/octet-stream' } }, { files: [up.id] });
      const out = path.join(work, 'dl-js');
      const { first: r } = cppJson('alice', ['download', sent.id, out]);
      assert.equal(path.basename(r.path), name);
      assert.equal(r.size, size);
      assert.ok(fs.readFileSync(r.path).equals(bytes), 'bytes match');
      // Downloading again doesn't overwrite: it picks a new name.
      const { first: r2 } = cppJson('alice', ['download', sent.id, out, '--chat', chatId]);
      assert.notEqual(r2.path, r.path);
      assert.ok(fs.readFileSync(r2.path).equals(bytes));
    });
  }

  await step('C++ downloads its own file (self-wrapped key)', async () => {
    const p = path.join(files, 'own.bin');
    writeRandomFile(p, CHUNK + 77);
    const { first: sent } = cppJson('alice', ['send-file', 'bob@dev', p]);
    const { first: r } = cppJson('alice', ['download', sent.id, path.join(work, 'dl-own')]);
    assert.equal(fileSha(r.path), fileSha(p));
  });

  await step('C++ rejects tampered files and leaves nothing behind', async () => {
    const bytes = crypto.randomBytes(2 * CHUNK + 10);
    const { blob, file } = await encryptFile(new Blob([bytes]));
    const enc = new Uint8Array(await blob.arrayBuffer());
    const out = path.join(work, 'dl-bad');
    fs.mkdirSync(out);

    // 1. Wrong checksum in the (authentic) message.
    const up1 = await bob.call('POST', '/api/files', enc, { 'Content-Type': 'application/octet-stream' });
    const wrongSha = { ...file, id: up1.id, name: 'badsum.bin', mime: 'application/octet-stream', sha256: b64u(new Uint8Array(32)) };
    const m1 = await bob.send(chatId, { type: 'media', kind: 'document', file: wrongSha }, { files: [up1.id] });
    const r1 = cpp('alice', ['download', m1.id, out], { expectFail: true });
    assert.match(r1.stderr, /checksum/);

    // 2. Server drops the last chunk (claimed size unchanged).
    const up2 = await bob.call('POST', '/api/files', enc.subarray(0, 2 * (CHUNK + 16)), { 'Content-Type': 'application/octet-stream' });
    const m2 = await bob.send(chatId, { type: 'media', kind: 'document', file: { ...file, id: up2.id, name: 'cut.bin', mime: 'x/y' } }, { files: [up2.id] });
    cpp('alice', ['download', m2.id, out], { expectFail: true });

    // 3. Server truncates and claims the file was shorter: the "last" flag in
    //    the AAD makes chunk 1 fail.
    const m3 = await bob.send(chatId, { type: 'media', kind: 'document', file: { ...file, size: 2 * CHUNK, id: up2.id, name: 'short.bin', mime: 'x/y', sha256: undefined } }, { files: [up2.id] });
    const r3 = cpp('alice', ['download', m3.id, out], { expectFail: true });
    assert.match(r3.stderr, /authentication/);

    // 4. A flipped ciphertext bit.
    const flipped = enc.slice();
    flipped[CHUNK + 100] ^= 1;
    const up4 = await bob.call('POST', '/api/files', flipped, { 'Content-Type': 'application/octet-stream' });
    const m4 = await bob.send(chatId, { type: 'media', kind: 'document', file: { ...file, id: up4.id, name: 'flip.bin', mime: 'x/y' } }, { files: [up4.id] });
    cpp('alice', ['download', m4.id, out], { expectFail: true });

    assert.deepEqual(fs.readdirSync(out), [], 'no partial files left');
  });

  await step('streaming: 64 MiB C++ -> C++ transfer stays within bounded memory', async () => {
    const size = 64 * CHUNK + 5;
    const p = path.join(files, 'big.bin');
    writeRandomFile(p, size);
    // A second C++ device (another dev user) in the same state file.
    cppJson('dave', ['whoami']);
    const up = cppJson('dave', ['--stats', 'send-file', 'alice@dev', p]);
    const upRss = peakRssKiB(up.stderr);
    assert.equal(up.first.uploaded, size + 16 * 65);
    const down = cppJson('alice', ['--stats', 'download', up.first.id, path.join(work, 'dl-big')]);
    const downRss = peakRssKiB(down.stderr);
    assert.equal(fileSha(down.first.path), fileSha(p));
    console.log(`#   upload:   ${/stats: (.*)/.exec(up.stderr)[1]}`);
    console.log(`#   download: ${/stats: (.*)/.exec(down.stderr)[1]}`);
    assert.ok(upRss < 32 * 1024, `upload peak RSS ${upRss} KiB should be far below the 64 MiB file`);
    assert.ok(downRss < 32 * 1024, `download peak RSS ${downRss} KiB should be far below the 64 MiB file`);
    // Both profiles live in one state file.
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(statePath, 'utf8')).profiles).length, 2);
  });

  await step('chats lists both direct chats; errors exit non-zero', async () => {
    const { lines } = cppJson('alice', ['chats']);
    const others = lines.map((c) => c.members.map((m) => m.userId).filter((u) => u !== 'alice@dev')[0]).sort();
    assert.deepEqual(others, ['bob@dev', 'dave@dev']);
    const r = cpp('alice', ['send', 'nobody@dev', 'hi'], { expectFail: true });
    assert.match(r.stderr, /404/);
    cpp('alice', ['download', 'no-such-message-id-123', work], { expectFail: true });
    cpp('alice', ['send-file', 'bob@dev', path.join(work, 'missing.bin')], { expectFail: true });
  });
} finally {
  server.stop();
}

console.log(`# ${passed} passed, ${failed} failed`);
if (failed) {
  console.log(`# work dir kept for debugging: ${work}`);
  process.exit(1);
}
fs.rmSync(work, { recursive: true, force: true });
