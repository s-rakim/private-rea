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

test('a device chat is between two of your devices and nobody else', async () => {
  const phone = await connectUser(server.base, 'mo');
  const laptop = await connectUser(server.base, 'mo');
  const tablet = await connectUser(server.base, 'mo');
  const bob = await connectUser(server.base, 'bo');
  await Promise.all([laptop.socket(), tablet.socket()]);

  const { chat } = await phone.call('POST', '/api/chats/devices', { deviceId: laptop.deviceId });
  assert.deepEqual(chat.devices, [phone.deviceId, laptop.deviceId].sort());
  assert.equal(chat.type, 'direct');
  const again = await laptop.call('POST', '/api/chats/devices', { deviceId: phone.deviceId });
  assert.equal(again.chat.id, chat.id, 'one chat per pair, whichever side opens it');
  await laptop.waitFor((e) => e.type === 'chat' && e.chat.id === chat.id);

  // Only the pair can see it, use it or seal to it.
  assert.ok((await laptop.call('GET', '/api/chats')).chats.some((c) => c.id === chat.id));
  assert.ok(!(await tablet.call('GET', '/api/chats')).chats.some((c) => c.id === chat.id));
  await assert.rejects(tablet.call('GET', `/api/chats/${chat.id}`), (e) => e.status === 404);
  await assert.rejects(tablet.call('GET', `/api/chats/${chat.id}/messages`), (e) => e.status === 404);
  await assert.rejects(tablet.call('GET', `/api/chats/${chat.id}/devices`), (e) => e.status === 404);
  await assert.rejects(send(tablet, chat.id, { type: 'text', text: 'nope' }), (e) => e.status === 404);
  await assert.rejects(bob.call('POST', '/api/chats/devices', { deviceId: phone.deviceId }), (e) => e.status === 404);
  await assert.rejects(phone.call('POST', '/api/chats/devices', { deviceId: phone.deviceId }), (e) => e.status === 404);

  const { message, devices } = await send(phone, chat.id, { type: 'text', text: 'to my laptop' });
  assert.deepEqual(devices.map((d) => d.id).sort(), chat.devices);
  const got = await laptop.waitFor((e) => e.type === 'message' && e.message.id === message.id);
  assert.equal((await laptop.ring.open(got.message.payload, chatAad(chat.id, message.id), got.message.senderId)).text, 'to my laptop');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!tablet.events.some((e) => e.chat?.id === chat.id || e.message?.chatId === chat.id || e.chatId === chat.id), 'the third device hears nothing');
  await assert.rejects(tablet.call('GET', `/api/messages/${message.id}`), (e) => e.status === 404);
  // Nor can it change the chat or its messages, even knowing their ids.
  const refused = (e) => e.status === 404;
  for (const [method, path, body] of [
    ['PATCH', `/api/chats/${chat.id}`, { disappearing: 60 }],
    ['PATCH', `/api/chats/${chat.id}/prefs`, { archived: true }],
    ['POST', `/api/chats/${chat.id}/clear`],
    ['DELETE', `/api/chats/${chat.id}`],
    ['POST', `/api/chats/${chat.id}/pin`, { messageId: message.id }],
    ['POST', `/api/chats/${chat.id}/receipts`, { read: 1 }],
    ['POST', `/api/messages/${message.id}/react`, { emoji: '👍' }],
    ['POST', `/api/messages/${message.id}/star`, { starred: true }],
    ['POST', `/api/messages/${message.id}/vote`, { options: [0] }],
    ['POST', `/api/messages/${message.id}/opened`],
    ['PUT', `/api/messages/${message.id}`, { payload: message.payload }],
    ['DELETE', `/api/messages/${message.id}?for=everyone`],
  ]) await assert.rejects(tablet.call(method, path, body), refused, `${method} ${path}`);
  assert.ok(!(await laptop.call('GET', `/api/chats/${chat.id}/messages`)).messages.find((m) => m.id === message.id).deletedAt);
  // View once can't work here: the other device is you, and you can't open your own.
  await assert.rejects(
    phone.call('POST', `/api/chats/${chat.id}/messages`, { id: newMessageId(), payload: message.payload, viewOnce: true }),
    (e) => e.status === 400,
  );

  // History sharing never copies a device chat to another device.
  await tablet.call('POST', '/api/history/request');
  const key = await phone.ring.reshare(message.payload, chatAad(chat.id, message.id), message.senderId, undefined, tablet.deviceId);
  const { stored } = await phone.call('POST', '/api/history/keys', { deviceId: tablet.deviceId, keys: [{ messageId: message.id, key }] });
  assert.equal(stored, 0);

  // Deleting it sticks until you open it again yourself.
  await phone.call('DELETE', `/api/chats/${chat.id}`);
  assert.equal((await phone.call('POST', '/api/chats/devices', { deviceId: laptop.deviceId, open: false })).chat, null);
  assert.equal((await phone.call('POST', '/api/chats/devices', { deviceId: laptop.deviceId })).chat.id, chat.id);

  // It goes away when either device is logged out.
  await phone.call('DELETE', `/api/devices/${laptop.deviceId}`);
  assert.ok(!(await phone.call('GET', '/api/chats')).chats.some((c) => c.id === chat.id));
  await assert.rejects(phone.call('GET', `/api/chats/${chat.id}/messages`), (e) => e.status === 404);
});

test('you can rename your own devices', async () => {
  const phone = await connectUser(server.base, 'nia');
  const laptop = await connectUser(server.base, 'nia');
  const other = await connectUser(server.base, 'oz');
  await laptop.socket();
  const { device } = await phone.call('PATCH', `/api/devices/${laptop.deviceId}`, { name: '  Work laptop ' });
  assert.equal(device.name, 'Work laptop');
  await laptop.waitFor((e) => e.type === 'devices' && e.userId === 'nia@dev');
  assert.equal((await laptop.call('GET', '/api/devices')).devices.find((d) => d.id === laptop.deviceId).name, 'Work laptop');
  await assert.rejects(other.call('PATCH', `/api/devices/${laptop.deviceId}`, { name: 'mine now' }), (e) => e.status === 404);
  await assert.rejects(phone.call('PATCH', `/api/devices/${laptop.deviceId}`, { name: '   ' }), (e) => e.status === 400);
});

test('device chats only take up pins on their own two devices', async () => {
  const phone = await connectUser(server.base, 'pia');
  const laptop = await connectUser(server.base, 'pia');
  const tablet = await connectUser(server.base, 'pia');
  const friends = await Promise.all(['qa', 'ra', 'sa'].map((n) => connectUser(server.base, n)));
  const { chat: pair } = await phone.call('POST', '/api/chats/devices', { deviceId: tablet.deviceId });
  await phone.call('PATCH', `/api/chats/${pair.id}/prefs`, { pinned: true });
  const chats = [];
  for (const f of friends) chats.push((await laptop.call('POST', '/api/chats/direct', { userId: f.id })).chat);
  await laptop.call('PATCH', `/api/chats/${chats[0].id}/prefs`, { pinned: true });
  await laptop.call('PATCH', `/api/chats/${chats[1].id}/prefs`, { pinned: true });
  await laptop.call('PATCH', `/api/chats/${chats[2].id}/prefs`, { pinned: true });
  // On the phone the device chat counts, so a fourth pin is one too many.
  await assert.rejects(phone.call('PATCH', `/api/chats/${chats[2].id}/prefs`, { pinned: true }), (e) => e.status === 400);
  // Once the tablet is logged out its chat is gone, and so is its pin.
  await laptop.call('PATCH', `/api/chats/${chats[2].id}/prefs`, { pinned: false });
  await phone.call('DELETE', `/api/devices/${tablet.deviceId}`);
  await phone.call('PATCH', `/api/chats/${chats[2].id}/prefs`, { pinned: true });
});
