import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { connectUser, startServer } from './helpers.js';

// A tailnet in the format of `tailscale status --json`: mo has a laptop, a
// phone and a tagged NAS; bo has a PC; the server is its own node.
const STATUS = {
  BackendState: 'Running',
  Self: { ID: 'nSERVER', DNSName: 'tailchat.tail1234.ts.net.', HostName: 'tailchat', OS: 'linux', UserID: 1 },
  Peer: {
    a: { ID: 'nLAPTOP', DNSName: 'laptop.tail1234.ts.net.', HostName: 'laptop', OS: 'windows', UserID: 1, Online: true },
    b: { ID: 'nPHONE', DNSName: 'phone.tail1234.ts.net.', HostName: 'phone', OS: 'android', UserID: 1, Online: false, LastSeen: '2026-10-30T08:00:00Z' },
    c: { ID: 'nNAS', DNSName: 'nas.tail1234.ts.net.', HostName: 'nas', OS: 'linux', UserID: 1, Tags: ['tag:server'], Online: true },
    d: { ID: 'nBOBPC', DNSName: 'bobs-pc.tail1234.ts.net.', HostName: 'bobs-pc', OS: 'macOS', UserID: 2, Online: true },
  },
  User: { 1: { ID: 1, LoginName: 'mo@dev' }, 2: { ID: 2, LoginName: 'bo@dev' } },
};

let server;
let plain;
let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-tailnet-'));
  const file = path.join(dir, 'tailnet.json');
  fs.writeFileSync(file, JSON.stringify(STATUS));
  [server, plain] = await Promise.all([startServer({ TAILCHAT_DEV_TAILNET: file }), startServer()]);
});

after(async () => {
  await Promise.all([server?.stop(), plain?.stop()]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('your machines are listed, and each device knows which one it is on', async () => {
  const laptop = await connectUser(server.base, 'mo', { machine: 'laptop' });
  const { devices } = await laptop.call('GET', '/api/devices');
  const me = devices.find((d) => d.id === laptop.deviceId);
  assert.deepEqual(me.machine, { id: 'nLAPTOP', name: 'laptop' });
  assert.equal(me.renamed, false);

  const { available, machines } = await laptop.call('GET', '/api/machines');
  assert.equal(available, true);
  // Not the tagged NAS, not bo's PC, and not the server's own node.
  assert.deepEqual(machines.map((m) => m.id), ['nLAPTOP', 'nPHONE']);
  assert.deepEqual(machines[1], { id: 'nPHONE', name: 'phone', os: 'android', online: false, lastSeen: Date.parse('2026-10-30T08:00:00Z') });
  const bo = await connectUser(server.base, 'bo', { machine: 'laptop' });
  assert.deepEqual((await bo.call('GET', '/api/machines')).machines.map((m) => m.id), ['nBOBPC']);
  // Claiming someone else's machine binds nothing.
  const boDevice = (await bo.call('GET', '/api/devices')).devices.find((d) => d.id === bo.deviceId);
  assert.equal(boDevice.machine, null);
});

test('a device linked before its machine was known is matched later, and your other devices hear of it', async () => {
  const laptop = await connectUser(server.base, 'mo', { machine: 'laptop' });
  await laptop.socket();
  const phone = await connectUser(server.base, 'mo');
  const listed = async () => (await laptop.call('GET', '/api/devices')).devices.find((d) => d.id === phone.deviceId);
  assert.equal((await listed()).machine, null);
  laptop.events.length = 0;
  phone.headers['X-Dev-Machine'] = 'phone';
  await phone.call('GET', '/api/chats');
  await laptop.waitFor((e) => e.type === 'devices' && e.userId === 'mo@dev');
  assert.deepEqual((await listed()).machine, { id: 'nPHONE', name: 'phone' });
  // Once matched it stays: a later request can't move it to another machine.
  phone.headers['X-Dev-Machine'] = 'laptop';
  await phone.call('GET', '/api/chats');
  assert.deepEqual((await listed()).machine, { id: 'nPHONE', name: 'phone' });
});

test('renaming a device marks it, so apps stop calling it after its machine', async () => {
  const laptop = await connectUser(server.base, 'mo', { machine: 'laptop' });
  const { device } = await laptop.call('PATCH', `/api/devices/${laptop.deviceId}`, { name: 'Work laptop' });
  assert.equal(device.name, 'Work laptop');
  assert.equal(device.renamed, true);
  assert.deepEqual(device.machine, { id: 'nLAPTOP', name: 'laptop' });
});

test('without a machine list, devices still work and the list says so', async () => {
  const mo = await connectUser(plain.base, 'mo', { machine: 'laptop' });
  assert.deepEqual(await mo.call('GET', '/api/machines'), { available: false, machines: [] });
  const { devices } = await mo.call('GET', '/api/devices');
  assert.equal(devices.find((d) => d.id === mo.deviceId).machine, null);
});
