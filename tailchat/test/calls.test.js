import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { newMessageId } from '../public/crypto.js';
import { connectUser, startServer } from './helpers.js';

let server;

before(async () => {
  // Short ring and reconnect times, so the tests don't wait 45 seconds.
  server = await startServer({ TAILCHAT_RING_MS: '2500', TAILCHAT_CALL_GRACE_MS: '1500' });
});

after(async () => {
  await server?.stop();
});

const frame = (user, msg) => user.ws.send(JSON.stringify({ type: 'call', ...msg }));
const callEvent = (callId, action) => (e) => e.type === 'call' && e.callId === callId && e.action === action;
const quiet = (ms = 200) => new Promise((r) => setTimeout(r, ms));

test('calls are Tailchat\'s own: no call service and nothing else may be framed', async () => {
  const me = await connectUser(server.base, 'cal');
  assert.equal((await me.call('GET', '/api/me')).calls, undefined);
  const res = await fetch(`${server.base}/`, { headers: me.headers });
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.doesNotMatch(res.headers.get('content-security-policy'), /frame-src/);
  assert.equal(res.headers.get('permissions-policy'), 'camera=(self), microphone=(self), geolocation=(self), display-capture=(self)');
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

// Two people in a direct chat, both connected.
async function pair(a, b) {
  const one = await connectUser(server.base, a);
  const two = await connectUser(server.base, b);
  await Promise.all([one.socket(), two.socket()]);
  const { chat } = await one.call('POST', '/api/chats/direct', { userId: two.id });
  return { one, two, chat };
}

test('a ringing device tells the caller, so the caller hears it ring', async () => {
  const { one: amy, two: ben, chat } = await pair('amy', 'ben');
  const callId = newMessageId();
  frame(amy, { action: 'ring', callId, chatId: chat.id, video: true });
  const ring = await ben.waitFor(callEvent(callId, 'ring'));
  assert.equal(ring.ongoing, false);
  frame(ben, { action: 'ringing', callId });
  const ringing = await amy.waitFor(callEvent(callId, 'ringing'));
  assert.equal(ringing.deviceId, ben.deviceId);
  assert.equal(ringing.userId, ben.id);
  // Someone who wasn't rung can't pretend to ring.
  const eve = await connectUser(server.base, 'eva');
  await eve.socket();
  frame(eve, { action: 'ringing', callId });
  await quiet();
  assert.equal(amy.events.filter(callEvent(callId, 'ringing')).length, 1);

  // Busy: declined with a reason, and the call ends with it.
  frame(ben, { action: 'decline', callId, reason: 'busy' });
  assert.equal((await amy.waitFor(callEvent(callId, 'declined'))).reason, 'busy');
  assert.equal((await amy.waitFor(callEvent(callId, 'ended'))).reason, 'busy');
});

test('nobody answering ends the call as missed', async () => {
  const { one: cy, two: di, chat } = await pair('cyd', 'dia');
  const callId = newMessageId();
  frame(cy, { action: 'ring', callId, chatId: chat.id, video: false });
  await di.waitFor(callEvent(callId, 'ring'));
  assert.equal((await di.waitFor(callEvent(callId, 'ended'), 5000)).reason, 'missed');
  const log = (await cy.call('GET', '/api/calls')).calls.find((c) => c.id === callId);
  assert.ok(log.endedAt && !log.answeredAt);
});

test('a device whose connection drops stays in the call and carries on when it is back', async () => {
  const { one: fay, two: gus, chat } = await pair('fay', 'gus');
  const callId = newMessageId();
  frame(fay, { action: 'ring', callId, chatId: chat.id, video: true });
  await gus.waitFor(callEvent(callId, 'ring'));
  frame(gus, { action: 'accept', callId });
  await fay.waitFor(callEvent(callId, 'peer-joined'));

  // gus loses his connection and gets it back within the grace time.
  gus.ws.close();
  await quiet(500);
  gus.events.length = 0;
  await gus.socket();
  frame(gus, { action: 'rejoin', callId });
  const back = await gus.waitFor(callEvent(callId, 'rejoined'));
  assert.deepEqual(back.peers, [{ deviceId: fay.deviceId, userId: fay.id }]);
  await quiet(1600);
  assert.ok(!fay.events.some(callEvent(callId, 'peer-left')), 'gus was never dropped');

  // Signals still reach him on his new connection.
  frame(fay, { action: 'signal', callId, toDevice: gus.deviceId, data: { sealed: 'x' } });
  await gus.waitFor(callEvent(callId, 'signal'));

  // This time he doesn't come back: the call ends once the grace time is up.
  gus.ws.close();
  await fay.waitFor(callEvent(callId, 'peer-left'), 4000);
  assert.equal((await fay.waitFor(callEvent(callId, 'ended'))).reason, 'ended');

  // A device that was away when the call ended hears so when it rejoins.
  await gus.socket();
  frame(gus, { action: 'rejoin', callId });
  await gus.waitFor(callEvent(callId, 'ended'));
});

test('a device that was ringing hears the call was answered elsewhere when it reconnects', async () => {
  const hal = await connectUser(server.base, 'hal');
  const ivy1 = await connectUser(server.base, 'ivy');
  const ivy2 = await connectUser(server.base, 'ivy');
  await Promise.all([hal.socket(), ivy1.socket(), ivy2.socket()]);
  const { chat } = await hal.call('POST', '/api/chats/direct', { userId: 'ivy@dev' });
  const callId = newMessageId();
  frame(hal, { action: 'ring', callId, chatId: chat.id, video: false });
  await ivy2.waitFor(callEvent(callId, 'ring'));
  ivy2.ws.close();
  frame(ivy1, { action: 'accept', callId });
  await hal.waitFor(callEvent(callId, 'peer-joined'));
  ivy2.events.length = 0;
  await ivy2.socket();
  frame(ivy2, { action: 'rejoin', callId });
  await ivy2.waitFor(callEvent(callId, 'answered-elsewhere'));
  frame(hal, { action: 'hangup', callId });
});

test('in a group call whoever has not answered stops ringing, and can be rung again', async () => {
  const jo = await connectUser(server.base, 'jo');
  const kim = await connectUser(server.base, 'kim');
  const lou = await connectUser(server.base, 'lou');
  await Promise.all([jo.socket(), kim.socket(), lou.socket()]);
  const { chat } = await jo.call('POST', '/api/chats/group', { name: 'Band', members: [kim.id, lou.id] });
  const callId = newMessageId();
  frame(jo, { action: 'ring', callId, chatId: chat.id, video: true });
  await Promise.all([kim.waitFor(callEvent(callId, 'ring')), lou.waitFor(callEvent(callId, 'ring'))]);
  frame(kim, { action: 'accept', callId });
  await jo.waitFor(callEvent(callId, 'peer-joined'));

  // lou never picks up: his ringing stops, the call goes on.
  await lou.waitFor(callEvent(callId, 'missed'), 5000);
  assert.ok(!jo.events.some(callEvent(callId, 'ended')));

  // Only someone in the call can ring people again.
  frame(lou, { action: 'invite', callId });
  await quiet();
  assert.equal(lou.events.filter(callEvent(callId, 'ring')).length, 1);
  frame(kim, { action: 'invite', callId });
  const again = await lou.waitFor((e) => callEvent(callId, 'ring')(e) && e.ongoing);
  assert.equal(again.from, kim.id);
  assert.ok(!jo.events.some(callEvent(callId, 'ring')), 'people in the call are not rung');
  frame(lou, { action: 'accept', callId });
  const joined = await lou.waitFor(callEvent(callId, 'joined'));
  assert.deepEqual(joined.peers.map((p) => p.userId).sort(), [jo.id, kim.id].sort());

  // Nobody left to ring.
  frame(jo, { action: 'invite', callId });
  assert.match((await jo.waitFor(callEvent(callId, 'error'))).message, /already in the call/);
  for (const u of [jo, kim, lou]) frame(u, { action: 'hangup', callId });
  await quiet();
});

test('a revoked device is dropped from its call at once', async () => {
  const mo = await connectUser(server.base, 'mo');
  const ned1 = await connectUser(server.base, 'ned');
  const ned2 = await connectUser(server.base, 'ned');
  await Promise.all([mo.socket(), ned1.socket(), ned2.socket()]);
  const { chat } = await mo.call('POST', '/api/chats/direct', { userId: 'ned@dev' });
  const callId = newMessageId();
  frame(mo, { action: 'ring', callId, chatId: chat.id, video: false });
  await ned2.waitFor(callEvent(callId, 'ring'));
  frame(ned2, { action: 'accept', callId });
  await mo.waitFor(callEvent(callId, 'peer-joined'));
  await ned1.call('DELETE', `/api/devices/${encodeURIComponent(ned2.deviceId)}`);
  await mo.waitFor(callEvent(callId, 'peer-left'), 1000);
  await mo.waitFor(callEvent(callId, 'ended'));
});
