import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { KeyRing, chatAad, newMessageId } from '../public/crypto.js';
import { connectUser, startServer } from './helpers.js';

let server;

before(async () => {
  server = await startServer();
});

after(async () => {
  await server?.stop();
});

async function send(user, chatId, content, extra = {}) {
  const id = newMessageId();
  const { devices } = await user.call('GET', `/api/chats/${chatId}/devices`);
  const payload = await user.ring.seal(content, chatAad(chatId, id), devices);
  return (await user.call('POST', `/api/chats/${chatId}/messages`, { id, payload, ...extra })).message;
}

const messagesOf = async (user, chatId) => (await user.call('GET', `/api/chats/${chatId}/messages?limit=200`)).messages.filter((m) => m.kind === 'msg');

// What the web app does when you tap Share: re-encrypt every message key this
// device can read for the asking device.
async function shareAll(from, chatId, toDevice, { done = true } = {}) {
  const keys = [];
  for (const m of await messagesOf(from, chatId)) {
    if (!m.payload || JSON.parse(m.payload).keys[toDevice]) continue;
    keys.push({ messageId: m.id, key: await from.ring.reshare(m.payload, chatAad(m.chatId, m.id), m.senderId, m.historyKey, toDevice) });
  }
  return from.call('POST', '/api/history/keys', { deviceId: toDevice, keys, done });
}

test('a newly linked device gets older messages when another device of yours shares them', async () => {
  const phone = await connectUser(server.base, 'alice');
  const bob = await connectUser(server.base, 'bob');
  const { chat } = await phone.call('POST', '/api/chats/direct', { userId: bob.id });
  await send(phone, chat.id, { type: 'text', text: 'one' });
  await send(bob, chat.id, { type: 'text', text: 'two' });
  await send(phone, chat.id, { type: 'text', text: 'three' });

  const laptop = await connectUser(server.base, 'alice');
  const before = await messagesOf(laptop, chat.id);
  assert.equal(before.length, 3);
  await assert.rejects(laptop.ring.open(before[0].payload, chatAad(chat.id, before[0].id), before[0].senderId), (e) => e.code === 'NO_KEY');

  await phone.socket();
  await laptop.socket();
  const { request } = await laptop.call('POST', '/api/history/request');
  assert.equal(request.state, 'pending');
  const ask = await phone.waitFor((e) => e.type === 'history' && e.request.deviceId === laptop.deviceId);
  assert.equal(ask.request.state, 'pending');
  const { requests } = await phone.call('GET', '/api/history/requests');
  assert.deepEqual(requests.map((r) => r.deviceId), [laptop.deviceId]);

  // Nobody else can answer or decline it.
  await assert.rejects(shareAll(bob, chat.id, laptop.deviceId), (e) => e.status === 404 || /not another device of yours/.test(e.message));
  await assert.rejects(bob.call('POST', '/api/history/keys', { deviceId: laptop.deviceId, keys: [] }), (e) => e.status === 404);
  await assert.rejects(bob.call('DELETE', `/api/history/requests/${laptop.deviceId}`), (e) => e.status === 404);

  const { stored } = await shareAll(phone, chat.id, laptop.deviceId);
  assert.equal(stored, 3);
  const done = await laptop.waitFor((e) => e.type === 'history' && e.request.state === 'done');
  assert.equal(done.request.byDevice, phone.deviceId);
  assert.equal(done.request.shared, 3);

  const now = await messagesOf(laptop, chat.id);
  const texts = [];
  for (const m of now) {
    assert.equal(m.historyKey.by, phone.deviceId);
    texts.push((await laptop.ring.open(m.payload, chatAad(chat.id, m.id), m.senderId, m.historyKey)).text);
  }
  assert.deepEqual(texts, ['one', 'two', 'three']);
  // The chat list's last message carries it too, for the preview.
  const { chats } = await laptop.call('GET', '/api/chats');
  assert.ok(chats.find((c) => c.id === chat.id).lastMessage.historyKey);
  // Other devices don't see keys that aren't theirs.
  assert.ok((await messagesOf(phone, chat.id)).every((m) => !m.historyKey));
  assert.ok((await messagesOf(bob, chat.id)).every((m) => !m.historyKey));

  // Once answered, the request is closed.
  await assert.rejects(shareAll(phone, chat.id, laptop.deviceId), (e) => e.status === 409);
});

test('shared history is checked against the message, the sender and your own devices', async () => {
  const phone = await connectUser(server.base, 'dana');
  const eve = await connectUser(server.base, 'eve');
  const { chat } = await phone.call('POST', '/api/chats/direct', { userId: eve.id });
  const first = await send(phone, chat.id, { type: 'text', text: 'mine' });
  const second = await send(eve, chat.id, { type: 'text', text: 'theirs' });
  const laptop = await connectUser(server.base, 'dana');
  await laptop.call('POST', '/api/history/request');
  await shareAll(phone, chat.id, laptop.deviceId);
  const [a, b] = await messagesOf(laptop, chat.id);
  assert.equal(a.id, first.id);
  assert.equal(b.id, second.id);

  // Moved to another message, the key doesn't open it.
  await assert.rejects(laptop.ring.open(b.payload, chatAad(chat.id, b.id), b.senderId, a.historyKey));
  // A server relabelling Eve's message as Dana's (rewriting the envelope's
  // sending device) is caught: the sharing device vouched for Eve's device.
  const relabelled = JSON.stringify({ ...JSON.parse(b.payload), from: phone.deviceId });
  await assert.rejects(laptop.ring.open(relabelled, chatAad(chat.id, b.id), phone.id, b.historyKey), /doesn't match/);
  // Even if the server also lies about who owns Eve's device, the sharing
  // device named Eve as the sender.
  const lying = new KeyRing({
    deviceId: laptop.deviceId,
    privateKey: laptop.ring.privateKey,
    fetchPublicKeys: async (ids) => (await laptop.call('GET', `/api/keys?ids=${ids.join(',')}`)).devices
      .map((d) => (d.id === eve.deviceId ? { ...d, userId: phone.id } : d)),
  });
  await assert.rejects(lying.open(b.payload, chatAad(chat.id, b.id), phone.id, b.historyKey), /doesn't match/);
  // History "shared" by somebody else's device is refused.
  await assert.rejects(laptop.ring.open(b.payload, chatAad(chat.id, b.id), b.senderId, { ...b.historyKey, by: eve.deviceId }), /not another device of yours/);
  // And nobody can share with a device that isn't theirs.
  await assert.rejects(phone.ring.reshare(a.payload, chatAad(chat.id, a.id), a.senderId, undefined, eve.deviceId), /not another device of yours/);
  await assert.rejects(phone.ring.reshare(a.payload, chatAad(chat.id, a.id), a.senderId, undefined, phone.deviceId), /not another device of yours/);
});

test('the server only stores history for messages you can see, and drops it when they change', async () => {
  const phone = await connectUser(server.base, 'finn');
  const gus = await connectUser(server.base, 'gus');
  const hal = await connectUser(server.base, 'hal');
  const { chat } = await phone.call('POST', '/api/chats/direct', { userId: gus.id });
  const kept = await send(phone, chat.id, { type: 'text', text: 'keep' });
  const edited = await send(phone, chat.id, { type: 'text', text: 'before edit' });
  const removed = await send(phone, chat.id, { type: 'text', text: 'delete me' });
  const once = await send(phone, chat.id, { type: 'media', kind: 'image' }, { viewOnce: true });
  const { chat: other } = await gus.call('POST', '/api/chats/direct', { userId: hal.id });
  const secret = await send(gus, other.id, { type: 'text', text: 'not for finn' });

  const laptop = await connectUser(server.base, 'finn');
  const key = await phone.ring.reshare(kept.payload, chatAad(chat.id, kept.id), kept.senderId, undefined, laptop.deviceId);
  // Not before the device asks.
  await assert.rejects(phone.call('POST', '/api/history/keys', { deviceId: laptop.deviceId, keys: [{ messageId: kept.id, key }] }), (e) => e.status === 409);
  await laptop.call('POST', '/api/history/request');
  // A device can't answer itself, and keys must look like keys.
  await assert.rejects(laptop.call('POST', '/api/history/keys', { deviceId: laptop.deviceId, keys: [] }), (e) => e.status === 400);
  await assert.rejects(phone.call('POST', '/api/history/keys', { deviceId: laptop.deviceId, keys: [{ messageId: kept.id, key: 'nope' }] }), (e) => e.status === 400);
  await assert.rejects(phone.call('POST', '/api/history/keys', { deviceId: { id: laptop.deviceId }, keys: [] }), (e) => e.status === 400);

  const keys = [kept, edited, removed, once, secret].map((m) => ({ messageId: m.id, key }));
  const { stored } = await phone.call('POST', '/api/history/keys', { deviceId: laptop.deviceId, keys });
  assert.equal(stored, 3, 'not the view once message, nor one from a chat finn is not in');

  // An edit has a new message key (sealed for the laptop too, now it's linked).
  const { devices } = await phone.call('GET', `/api/chats/${chat.id}/devices`);
  const payload = await phone.ring.seal({ type: 'text', text: 'after edit' }, chatAad(chat.id, edited.id), devices);
  await phone.call('PUT', `/api/messages/${edited.id}`, { payload });
  await phone.call('DELETE', `/api/messages/${removed.id}?for=everyone`);
  const byId = new Map((await messagesOf(laptop, chat.id)).map((m) => [m.id, m]));
  assert.ok(byId.get(kept.id).historyKey);
  assert.equal(byId.get(edited.id).historyKey, undefined);
  assert.equal((await laptop.ring.open(byId.get(edited.id).payload, chatAad(chat.id, edited.id), phone.id)).text, 'after edit');
  assert.equal(byId.get(removed.id).historyKey, undefined);

  // Retiring the old phone keeps the history on the laptop.
  await laptop.call('DELETE', `/api/devices/${phone.deviceId}`);
  const still = (await messagesOf(laptop, chat.id)).find((m) => m.id === kept.id);
  assert.equal((await laptop.ring.open(still.payload, chatAad(chat.id, kept.id), phone.id, still.historyKey)).text, 'keep');
});


test('a request can be declined or cancelled, and needs another device to ask', async () => {
  const only = await connectUser(server.base, 'ivy');
  await assert.rejects(only.call('POST', '/api/history/request'), (e) => e.status === 400);

  const second = await connectUser(server.base, 'ivy');
  await only.socket();
  await second.call('POST', '/api/history/request');
  await only.call('DELETE', `/api/history/requests/${second.deviceId}`);
  const declined = await only.waitFor((e) => e.type === 'history' && e.request.state === 'declined');
  assert.equal(declined.request.byDevice, only.deviceId);
  await assert.rejects(only.call('POST', '/api/history/keys', { deviceId: second.deviceId, keys: [] }), (e) => e.status === 409);
  await assert.rejects(only.call('DELETE', `/api/history/requests/${second.deviceId}`), (e) => e.status === 404);

  // Asking again reopens it; asking twice in a row doesn't spam your devices.
  const again = await second.call('POST', '/api/history/request');
  assert.equal(again.request.state, 'pending');
  await only.waitFor((e) => e.type === 'history' && e.request.state === 'pending' && e.request.updatedAt === again.request.updatedAt);
  const count = only.events.filter((e) => e.type === 'history').length;
  await second.call('POST', '/api/history/request');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(only.events.filter((e) => e.type === 'history').length, count);

  // Logging out the asking device drops its request.
  await only.call('DELETE', `/api/devices/${second.deviceId}`);
  await only.waitFor((e) => e.type === 'history' && e.request.state === 'gone');
  assert.deepEqual((await only.call('GET', '/api/history/requests')).requests, []);
});
