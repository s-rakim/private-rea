import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { newMessageId } from '../public/crypto.js';
import { connectUser, startServer } from './helpers.js';

let server;

before(async () => {
  server = await startServer({ TAILCHAT_CALLS_PORT: '3443' });
});

after(async () => {
  await server?.stop();
});

const frame = (user, msg) => user.ws.send(JSON.stringify({ type: 'call', ...msg }));
const callEvent = (callId, action) => (e) => e.type === 'call' && e.callId === callId && e.action === action;
const quiet = () => new Promise((r) => setTimeout(r, 200));

test('the call service is announced, and only it may be framed', async () => {
  const me = await connectUser(server.base, 'cal');
  assert.deepEqual((await me.call('GET', '/api/me')).calls, { port: 3443 });
  const res = await fetch(`${server.base}/`, { headers: me.headers });
  assert.match(res.headers.get('content-security-policy'), /; frame-src https:\/\/127\.0\.0\.1:3443$/);
  assert.match(res.headers.get('permissions-policy'), /camera=\(self "https:\/\/127\.0\.0\.1:3443"\)/);
  // A Host that isn't a plain hostname never makes it into the policy.
  const { port } = new URL(server.base);
  const csp = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/', headers: { ...me.headers, Host: `x"; script-src *:${port}` } }, (res) => {
      res.resume();
      resolve(res.headers['content-security-policy'] || '');
    }).on('error', reject);
  });
  assert.doesNotMatch(csp, /frame-src|\*/);
});

test('a device chat call rings the other device only', async () => {
  const phone = await connectUser(server.base, 'dee');
  const laptop = await connectUser(server.base, 'dee');
  const tablet = await connectUser(server.base, 'dee');
  await Promise.all([phone.socket(), laptop.socket(), tablet.socket()]);
  const { chat } = await phone.call('POST', '/api/chats/devices', { deviceId: laptop.deviceId });

  const callId = newMessageId();
  frame(phone, { action: 'ring', callId, chatId: chat.id, video: true });
  const ring = await laptop.waitFor(callEvent(callId, 'ring'));
  assert.equal(ring.from, 'dee@dev');
  assert.equal(ring.fromDevice, phone.deviceId);
  assert.equal(ring.video, true);
  await quiet();
  assert.ok(!tablet.events.some(callEvent(callId, 'ring')), 'the third device is not rung');
  assert.ok(!phone.events.some(callEvent(callId, 'ring')), 'nor the calling one');

  // The third device can't pick it up, even knowing the call id.
  frame(tablet, { action: 'accept', callId });
  await quiet();
  assert.ok(!phone.events.some(callEvent(callId, 'peer-joined')));

  frame(laptop, { action: 'accept', callId });
  const joined = await laptop.waitFor(callEvent(callId, 'joined'));
  assert.deepEqual(joined.peers, [{ deviceId: phone.deviceId, userId: 'dee@dev' }]);
  const peer = await phone.waitFor(callEvent(callId, 'peer-joined'));
  assert.equal(peer.deviceId, laptop.deviceId);
  // Not even once both are in it.
  frame(tablet, { action: 'accept', callId });
  await quiet();
  assert.equal(phone.events.filter(callEvent(callId, 'peer-joined')).length, 1);

  const log = (await phone.call('GET', '/api/calls')).calls.find((c) => c.id === callId);
  assert.ok(log.answeredAt);
  frame(laptop, { action: 'hangup', callId });
  await phone.waitFor(callEvent(callId, 'ended'));
});

test('calling yourself rings every other device, and each one answers for itself', async () => {
  const a = await connectUser(server.base, 'eve');
  const b = await connectUser(server.base, 'eve');
  const c = await connectUser(server.base, 'eve');
  await Promise.all([a.socket(), b.socket(), c.socket()]);
  const { chat } = await a.call('POST', '/api/chats/direct', { userId: 'eve@dev' });

  const callId = newMessageId();
  frame(a, { action: 'ring', callId, chatId: chat.id, video: false });
  await Promise.all([b.waitFor(callEvent(callId, 'ring')), c.waitFor(callEvent(callId, 'ring'))]);

  // b picks up; c keeps ringing and can still join.
  frame(b, { action: 'accept', callId });
  await b.waitFor(callEvent(callId, 'joined'));
  await quiet();
  assert.ok(!c.events.some(callEvent(callId, 'answered-elsewhere')), 'c is still ringing');
  frame(c, { action: 'accept', callId });
  const joined = await c.waitFor(callEvent(callId, 'joined'));
  assert.deepEqual(joined.peers.map((p) => p.deviceId).sort(), [a.deviceId, b.deviceId].sort());
  frame(a, { action: 'hangup', callId });
  frame(b, { action: 'hangup', callId });
  await c.waitFor(callEvent(callId, 'ended'));

  // Every device declining ends the call.
  const next = newMessageId();
  frame(a, { action: 'ring', callId: next, chatId: chat.id, video: true });
  await Promise.all([b.waitFor(callEvent(next, 'ring')), c.waitFor(callEvent(next, 'ring'))]);
  frame(b, { action: 'decline', callId: next });
  const declined = await a.waitFor(callEvent(next, 'declined'));
  assert.equal(declined.deviceId, b.deviceId);
  await quiet();
  assert.ok(!a.events.some(callEvent(next, 'ended')), 'still ringing c');
  frame(c, { action: 'decline', callId: next });
  assert.equal((await a.waitFor(callEvent(next, 'ended'))).reason, 'declined');
});

test('with no other device there is nobody to call', async () => {
  const solo = await connectUser(server.base, 'sol');
  await solo.socket();
  const { chat } = await solo.call('POST', '/api/chats/direct', { userId: 'sol@dev' });
  const callId = newMessageId();
  frame(solo, { action: 'ring', callId, chatId: chat.id, video: false });
  assert.match((await solo.waitFor(callEvent(callId, 'error'))).message, /another device/);
});

test('calls between people are unchanged: one device picking up stops the others ringing', async () => {
  const ann = await connectUser(server.base, 'ann');
  const bobPhone = await connectUser(server.base, 'bob');
  const bobLaptop = await connectUser(server.base, 'bob');
  await Promise.all([ann.socket(), bobPhone.socket(), bobLaptop.socket()]);
  const { chat } = await ann.call('POST', '/api/chats/direct', { userId: 'bob@dev' });
  const callId = newMessageId();
  frame(ann, { action: 'ring', callId, chatId: chat.id, video: false });
  await Promise.all([bobPhone.waitFor(callEvent(callId, 'ring')), bobLaptop.waitFor(callEvent(callId, 'ring'))]);
  frame(bobPhone, { action: 'accept', callId });
  await bobLaptop.waitFor(callEvent(callId, 'answered-elsewhere'));
  await ann.waitFor(callEvent(callId, 'peer-joined'));
  frame(ann, { action: 'hangup', callId });
  await bobPhone.waitFor(callEvent(callId, 'ended'));
});
