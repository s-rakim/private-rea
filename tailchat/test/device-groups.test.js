import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chatAad, newMessageId } from '../public/crypto.js';
import { connectUser, startServer } from './helpers.js';

let server;

before(async () => {
  server = await startServer();
});

after(async () => {
  await server?.stop();
});

async function send(user, chatId, content) {
  const id = newMessageId();
  const { devices } = await user.call('GET', `/api/chats/${chatId}/devices`);
  const payload = await user.ring.seal(content, chatAad(chatId, id), devices);
  return { message: (await user.call('POST', `/api/chats/${chatId}/messages`, { id, payload })).message, devices };
}

const quiet = () => new Promise((r) => setTimeout(r, 200));
const about = (chatId) => (e) => e.chat?.id === chatId || e.message?.chatId === chatId || e.chatId === chatId;

test('a device group is a named chat between the devices you pick', async () => {
  const pc = await connectUser(server.base, 'mal');
  const phone = await connectUser(server.base, 'mal');
  const tablet = await connectUser(server.base, 'mal');
  const tv = await connectUser(server.base, 'mal');
  const bob = await connectUser(server.base, 'bob');
  await Promise.all([pc.socket(), phone.socket(), tablet.socket(), tv.socket()]);

  // It needs a name and at least two other devices of yours.
  await assert.rejects(pc.call('POST', '/api/chats/device-group', { name: 'Home', deviceIds: [phone.deviceId] }), (e) => e.status === 400);
  await assert.rejects(pc.call('POST', '/api/chats/device-group', { name: ' ', deviceIds: [phone.deviceId, tablet.deviceId] }), (e) => e.status === 400);
  await assert.rejects(pc.call('POST', '/api/chats/device-group', { name: 'Home', deviceIds: [phone.deviceId, bob.deviceId] }), (e) => e.status === 404);
  await assert.rejects(bob.call('POST', '/api/chats/device-group', { name: 'Mine', deviceIds: [phone.deviceId, tablet.deviceId] }), (e) => e.status === 404);

  const { chat } = await pc.call('POST', '/api/chats/device-group', { name: 'Home', deviceIds: [phone.deviceId, tablet.deviceId, pc.deviceId] });
  assert.equal(chat.name, 'Home');
  assert.equal(chat.deviceGroup, true);
  assert.deepEqual(chat.devices, [pc.deviceId, phone.deviceId, tablet.deviceId].sort());
  await phone.waitFor((e) => e.type === 'chat' && e.chat.id === chat.id);
  await tablet.waitFor((e) => e.type === 'chat' && e.chat.id === chat.id);
  // Two groups can have the same devices.
  const second = (await pc.call('POST', '/api/chats/device-group', { name: 'Work', deviceIds: [phone.deviceId, tablet.deviceId] })).chat;
  assert.notEqual(second.id, chat.id);
  // Device chats are unaffected.
  const pair = (await pc.call('POST', '/api/chats/devices', { deviceId: phone.deviceId })).chat;
  assert.equal(pair.deviceGroup, false);

  // A message is sealed for the group's devices, and each of them can open it.
  const { message, devices } = await send(phone, chat.id, { type: 'text', text: 'hello devices' });
  assert.deepEqual(devices.map((d) => d.id).sort(), chat.devices);
  for (const d of [pc, tablet]) {
    const got = await d.waitFor((e) => e.type === 'message' && e.message.id === message.id);
    assert.equal(got.message.senderDevice, phone.deviceId);
    assert.equal((await d.ring.open(got.message.payload, chatAad(chat.id, message.id), got.message.senderId)).text, 'hello devices');
  }

  // A device outside it doesn't see it, hear about it or get to use it.
  await quiet();
  assert.ok(!tv.events.some(about(chat.id)), 'the device outside the group hears nothing');
  assert.ok(!(await tv.call('GET', '/api/chats')).chats.some((c) => c.id === chat.id));
  for (const [method, path, body] of [
    ['GET', `/api/chats/${chat.id}`],
    ['GET', `/api/chats/${chat.id}/messages`],
    ['GET', `/api/chats/${chat.id}/devices`],
    ['GET', `/api/messages/${message.id}`],
    ['PATCH', `/api/chats/${chat.id}`, { name: 'Mine' }],
    ['PATCH', `/api/chats/${chat.id}`, { devices: [tv.deviceId] }],
    ['DELETE', `/api/chats/${chat.id}`],
  ]) await assert.rejects(tv.call(method, path, body), (e) => e.status === 404, `${method} ${path}`);
  await assert.rejects(send(tv, chat.id, { type: 'text', text: 'nope' }), (e) => e.status === 404);
  await assert.rejects(bob.call('GET', `/api/chats/${chat.id}`), (e) => e.status === 404 || e.status === 403);

  // Group-only features don't apply, and neither does view once.
  await assert.rejects(pc.call('POST', `/api/chats/${chat.id}/members`, { userIds: [bob.id] }), (e) => e.status === 400);
  await assert.rejects(pc.call('POST', `/api/chats/${chat.id}/invite`), (e) => e.status === 400);
  await assert.rejects(
    pc.call('POST', `/api/chats/${chat.id}/messages`, { id: newMessageId(), payload: message.payload, viewOnce: true }),
    (e) => e.status === 400,
  );

  // History sharing never copies it to a device outside the group.
  await tv.call('POST', '/api/history/request');
  const key = await pc.ring.reshare(message.payload, chatAad(chat.id, message.id), message.senderId, undefined, tv.deviceId);
  assert.equal((await pc.call('POST', '/api/history/keys', { deviceId: tv.deviceId, keys: [{ messageId: message.id, key }] })).stored, 0);

  // It can be renamed.
  const renamed = (await tablet.call('PATCH', `/api/chats/${chat.id}`, { name: 'House' })).chat;
  assert.equal(renamed.name, 'House');
});

test('devices can be added to and removed from a device group', async () => {
  const pc = await connectUser(server.base, 'kai');
  const phone = await connectUser(server.base, 'kai');
  const tablet = await connectUser(server.base, 'kai');
  const tv = await connectUser(server.base, 'kai');
  await Promise.all([pc.socket(), phone.socket(), tablet.socket(), tv.socket()]);
  const { chat } = await pc.call('POST', '/api/chats/device-group', { name: 'All', deviceIds: [phone.deviceId, tablet.deviceId] });

  // Adding the TV: it gets the chat, and new messages are sealed for it too.
  let view = (await pc.call('PATCH', `/api/chats/${chat.id}`, { devices: [phone.deviceId, tablet.deviceId, tv.deviceId] })).chat;
  assert.deepEqual(view.devices, [pc.deviceId, phone.deviceId, tablet.deviceId, tv.deviceId].sort());
  await tv.waitFor((e) => e.type === 'chat' && e.chat.id === chat.id);
  const sys = await tv.waitFor((e) => e.type === 'message' && e.message.chatId === chat.id && e.message.kind === 'system');
  assert.deepEqual(JSON.parse(sys.message.payload), { event: 'devices', added: [tv.deviceId], removed: [], by: pc.deviceId });
  const { devices } = await send(tablet, chat.id, { type: 'text', text: 'hi tv' });
  assert.ok(devices.some((d) => d.id === tv.deviceId));

  // Removing the phone: it's told, and can no longer read or post.
  view = (await tv.call('PATCH', `/api/chats/${chat.id}`, { devices: [pc.deviceId, tablet.deviceId] })).chat;
  assert.ok(!view.devices.includes(phone.deviceId));
  await phone.waitFor((e) => e.type === 'chat-removed' && e.chatId === chat.id);
  await assert.rejects(phone.call('GET', `/api/chats/${chat.id}/messages`), (e) => e.status === 404);
  phone.events.length = 0;
  const after = await send(pc, chat.id, { type: 'text', text: 'phone is out' });
  assert.ok(!after.devices.some((d) => d.id === phone.deviceId));
  await quiet();
  assert.ok(!phone.events.some(about(chat.id)));

  // A device of someone else can't be added.
  const eve = await connectUser(server.base, 'eve');
  await assert.rejects(pc.call('PATCH', `/api/chats/${chat.id}`, { devices: [tablet.deviceId, eve.deviceId] }), (e) => e.status === 404);
  // Device chats don't have devices to change.
  const pair = (await pc.call('POST', '/api/chats/devices', { deviceId: tablet.deviceId })).chat;
  await assert.rejects(pc.call('PATCH', `/api/chats/${pair.id}`, { devices: [tablet.deviceId, tv.deviceId] }), (e) => e.status === 400);

  // A logged-out device's messages stay, and the group carries on without it.
  await pc.call('DELETE', `/api/devices/${tv.deviceId}`);
  const list = (await pc.call('GET', '/api/chats')).chats;
  assert.ok(list.some((c) => c.id === chat.id));
  assert.deepEqual((await pc.call('GET', `/api/chats/${chat.id}/devices`)).devices.map((d) => d.id).sort(), [pc.deviceId, tablet.deviceId].sort());

  // Leaving on one device takes only that device out.
  await tablet.call('DELETE', `/api/chats/${chat.id}`);
  assert.ok(!(await tablet.call('GET', '/api/chats')).chats.some((c) => c.id === chat.id));
  view = (await pc.call('GET', `/api/chats/${chat.id}`)).chat;
  assert.ok(!view.devices.includes(tablet.deviceId));
  // The last device to leave deletes it.
  await pc.call('DELETE', `/api/chats/${chat.id}`);
  assert.ok(!(await pc.call('GET', '/api/chats')).chats.some((c) => c.id === chat.id));
});

test('a call in a device group rings its other logged-in devices only', async () => {
  const pc = await connectUser(server.base, 'cal');
  const phone = await connectUser(server.base, 'cal');
  const tablet = await connectUser(server.base, 'cal');
  const tv = await connectUser(server.base, 'cal');
  const outside = await connectUser(server.base, 'cal');
  const ws = await pc.socket();
  await Promise.all([phone.socket(), tablet.socket(), tv.socket(), outside.socket()]);
  const { chat } = await pc.call('POST', '/api/chats/device-group', { name: 'Ring', deviceIds: [phone.deviceId, tablet.deviceId, tv.deviceId] });
  await pc.call('DELETE', `/api/devices/${tv.deviceId}`);
  const callId = `call-${Date.now()}`;
  ws.send(JSON.stringify({ type: 'call', action: 'ring', callId, chatId: chat.id, video: false }));
  for (const d of [phone, tablet]) await d.waitFor((e) => e.type === 'call' && e.action === 'ring' && e.callId === callId);
  await quiet();
  assert.ok(!outside.events.some((e) => e.type === 'call' && e.callId === callId), 'a device outside the group is not rung');
});

test('each device in a device group has its own unread count, and ticks wait for all of them', async () => {
  const pc = await connectUser(server.base, 'reads');
  const phone = await connectUser(server.base, 'reads');
  const tablet = await connectUser(server.base, 'reads');
  await Promise.all([pc.socket(), phone.socket(), tablet.socket()]);
  const { chat } = await pc.call('POST', '/api/chats/device-group', { name: 'Home', deviceIds: [phone.deviceId, tablet.deviceId] });
  const view = async (user) => (await user.call('GET', `/api/chats/${chat.id}`)).chat;
  const seqs = (v) => Object.fromEntries(v.peers.map((p) => [p.deviceId, [p.deliveredSeq, p.readSeq]]));

  const { message } = await send(pc, chat.id, { type: 'text', text: 'to everyone' });
  assert.equal((await view(phone)).unread, 1);
  assert.equal((await view(tablet)).unread, 1);
  assert.equal((await view(pc)).unread, 0, 'not unread on the device that sent it');
  assert.deepEqual((await view(pc)).peers.map((p) => p.deviceId).sort(), [phone.deviceId, tablet.deviceId].sort());

  await phone.call('POST', `/api/chats/${chat.id}/receipts`, { read: message.seq });
  assert.equal((await view(phone)).unread, 0);
  assert.equal((await view(tablet)).unread, 1, "reading on the phone doesn't read it on the tablet");
  assert.deepEqual(seqs(await view(pc)), { [phone.deviceId]: [message.seq, message.seq], [tablet.deviceId]: [0, 0] });
  await pc.waitFor((e) => e.type === 'chat' && e.chat.id === chat.id && e.chat.peers?.some((p) => p.deviceId === phone.deviceId && p.readSeq === message.seq));

  // A reply from the tablet is unread on the two others.
  const { message: reply } = await send(tablet, chat.id, { type: 'text', text: 'back' });
  assert.equal(reply.senderDevice, tablet.deviceId);
  assert.equal((await view(pc)).unread, 1);
  assert.equal((await view(phone)).unread, 1);
  assert.equal((await view(tablet)).unread, 0);

  // A logged-out device no longer counts for the ticks.
  await pc.call('DELETE', `/api/devices/${tablet.deviceId}`);
  assert.deepEqual((await view(pc)).peers.map((p) => p.deviceId), [phone.deviceId]);
});
