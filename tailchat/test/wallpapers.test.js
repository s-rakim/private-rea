import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { encryptFile, newMessageId, wallpaperAad } from '../public/crypto.js';
import { connectUser, startServer } from './helpers.js';

let server;

before(async () => {
  server = await startServer();
});

after(async () => {
  await server?.stop();
});

async function seal(user, chatId, content, id = newMessageId()) {
  const { devices } = await user.call('GET', `/api/chats/${chatId}/devices`);
  return { id, payload: await user.ring.seal(content, wallpaperAad(chatId, id), devices) };
}

async function setWallpaper(user, chatId, content, file = null) {
  const sealed = await seal(user, chatId, content);
  return (await user.call('PUT', `/api/chats/${chatId}/wallpaper`, { ...sealed, file })).chat;
}

const open = (user, chatId, wp) => user.ring.open(wp.payload, wallpaperAad(chatId, wp.id), wp.by);

async function uploadImage(user) {
  const { blob, file } = await encryptFile(new Blob([new Uint8Array(4096).fill(7)], { type: 'image/jpeg' }));
  const up = await user.call('POST', '/api/files', new Uint8Array(await blob.arrayBuffer()), { 'Content-Type': 'application/octet-stream' });
  return { ...file, id: up.id, name: 'wallpaper.jpg', mime: 'image/jpeg', size: 4096 };
}

test('a wallpaper is sealed for everyone in the chat and reaches all of them', async () => {
  const alice = await connectUser(server.base, 'wa');
  const bob = await connectUser(server.base, 'wb');
  const carol = await connectUser(server.base, 'wc');
  await bob.socket();
  const { chat } = await alice.call('POST', '/api/chats/direct', { userId: bob.id });
  assert.equal(chat.wallpaper, null);

  const set = await setWallpaper(alice, chat.id, { type: 'wallpaper', color: '#cfe1f0', dim: 10 });
  assert.equal(set.wallpaper.by, alice.id);
  const ev = await bob.waitFor((e) => e.type === 'chat' && e.chat.id === chat.id && e.chat.wallpaper);
  assert.deepEqual(await open(bob, chat.id, ev.chat.wallpaper), { type: 'wallpaper', color: '#cfe1f0', dim: 10 });
  assert.ok(!ev.chat.wallpaper.payload.includes('cfe1f0'), 'the server only sees ciphertext');
  // Read as someone else's, it fails: the sealing device isn't theirs.
  await assert.rejects(bob.ring.open(ev.chat.wallpaper.payload, wallpaperAad(chat.id, ev.chat.wallpaper.id), bob.id));
  const { messages } = await bob.call('GET', `/api/chats/${chat.id}/messages`);
  assert.deepEqual(JSON.parse(messages.at(-1).payload), { event: 'wallpaper' });

  // An image: members can download it, nobody else can.
  const image = await uploadImage(alice);
  const withImage = await setWallpaper(alice, chat.id, { type: 'wallpaper', color: '#000000', dim: 30, file: image }, image.id);
  assert.equal(withImage.wallpaper.file, image.id);
  await bob.call('GET', `/api/files/${image.id}`);
  await assert.rejects(carol.call('GET', `/api/files/${image.id}`), (e) => e.status === 404);
  await assert.rejects(carol.call('PUT', `/api/chats/${chat.id}/wallpaper`, { ...(await seal(alice, chat.id, { type: 'wallpaper' })), file: null }), (e) => e.status === 403);

  // Bob changes only the dimming and keeps Alice's image.
  const dimmer = await setWallpaper(bob, chat.id, { type: 'wallpaper', color: '#000000', dim: 50, file: image }, image.id);
  assert.equal(dimmer.wallpaper.by, bob.id);
  await bob.call('GET', `/api/files/${image.id}`);

  // Ids are fresh for each wallpaper, and only your own uploads go on one.
  const again = await seal(bob, chat.id, { type: 'wallpaper' }, dimmer.wallpaper.id);
  await assert.rejects(bob.call('PUT', `/api/chats/${chat.id}/wallpaper`, again), (e) => e.status === 409);
  const carolsImage = await uploadImage(carol);
  await assert.rejects(
    bob.call('PUT', `/api/chats/${chat.id}/wallpaper`, { ...(await seal(bob, chat.id, { type: 'wallpaper' })), file: carolsImage.id }),
    (e) => e.status === 400,
  );

  // Replacing the image deletes the old one.
  const next = await uploadImage(bob);
  await setWallpaper(bob, chat.id, { type: 'wallpaper', color: '#000000', file: next }, next.id);
  await assert.rejects(alice.call('GET', `/api/files/${image.id}`), (e) => e.status === 404);

  // Removing it goes back to the theme, and the image goes too.
  const removed = await alice.call('DELETE', `/api/chats/${chat.id}/wallpaper`);
  assert.equal(removed.chat.wallpaper, null);
  await assert.rejects(bob.call('GET', `/api/files/${next.id}`), (e) => e.status === 404);
  const after = (await bob.call('GET', `/api/chats/${chat.id}/messages`)).messages;
  assert.deepEqual(JSON.parse(after.at(-1).payload), { event: 'wallpaper', removed: true });
});

test('devices linked later get the wallpaper once it is sealed again', async () => {
  const alice = await connectUser(server.base, 'ra');
  const bob = await connectUser(server.base, 'rb');
  const { chat } = await alice.call('POST', '/api/chats/direct', { userId: bob.id });
  const image = await uploadImage(alice);
  const content = { type: 'wallpaper', color: '#2f3b46', dim: 0, file: image };
  const set = await setWallpaper(alice, chat.id, content, image.id);
  const before = (await alice.call('GET', `/api/chats/${chat.id}/messages`)).messages.length;

  const bobsTablet = await connectUser(server.base, 'rb');
  const wp = (await bobsTablet.call('GET', `/api/chats/${chat.id}`)).chat.wallpaper;
  await assert.rejects(open(bobsTablet, chat.id, wp), (e) => e.code === 'NO_KEY');

  // Bob's first device notices and seals it again, without a notice in the chat.
  const { devices } = await bob.call('GET', `/api/chats/${chat.id}/devices`);
  const payload = await bob.ring.seal(await open(bob, chat.id, wp), wallpaperAad(chat.id, wp.id), devices);
  await assert.rejects(
    bob.call('PUT', `/api/chats/${chat.id}/wallpaper`, { id: wp.id, payload, file: null, reseal: true }),
    (e) => e.status === 409,
    'a reseal keeps the image',
  );
  await assert.rejects(
    bob.call('PUT', `/api/chats/${chat.id}/wallpaper`, { id: newMessageId(), payload, file: image.id, reseal: true }),
    (e) => e.status === 409,
    'and the id',
  );
  const resealed = (await bob.call('PUT', `/api/chats/${chat.id}/wallpaper`, { id: wp.id, payload, file: image.id, reseal: true })).chat.wallpaper;
  assert.equal(resealed.id, set.wallpaper.id);
  assert.deepEqual(await open(bobsTablet, chat.id, resealed), content);
  await bobsTablet.call('GET', `/api/files/${image.id}`);
  assert.equal((await alice.call('GET', `/api/chats/${chat.id}/messages`)).messages.length, before);
});

test('who may change a wallpaper', async () => {
  const alice = await connectUser(server.base, 'pa');
  const bob = await connectUser(server.base, 'pb');
  const { chat: group } = await alice.call('POST', '/api/chats/group', { name: 'Walls', members: [bob.id] });
  await setWallpaper(bob, group.id, { type: 'wallpaper', color: '#d5e8d4' });
  await alice.call('PATCH', `/api/chats/${group.id}`, { adminsOnlyEdit: true });
  await assert.rejects(setWallpaper(bob, group.id, { type: 'wallpaper', color: '#e6d7ef' }), (e) => e.status === 403);
  await assert.rejects(bob.call('DELETE', `/api/chats/${group.id}/wallpaper`), (e) => e.status === 403);
  await setWallpaper(alice, group.id, { type: 'wallpaper', color: '#e6d7ef' });

  const { chat: channel } = await alice.call('POST', '/api/chats/channel', { name: 'Wall news' });
  await assert.rejects(alice.call('PUT', `/api/chats/${channel.id}/wallpaper`, { id: newMessageId(), payload: '{}' }), (e) => e.status === 400);

  // A device chat's wallpaper belongs to its two devices alone.
  const phone = await connectUser(server.base, 'pd');
  const laptop = await connectUser(server.base, 'pd');
  const tablet = await connectUser(server.base, 'pd');
  const { chat } = await phone.call('POST', '/api/chats/devices', { deviceId: laptop.deviceId });
  const set = await setWallpaper(phone, chat.id, { type: 'wallpaper', color: '#0f4c5c' });
  assert.deepEqual(Object.keys(JSON.parse(set.wallpaper.payload).keys).sort(), chat.devices);
  assert.equal((await open(laptop, chat.id, (await laptop.call('GET', `/api/chats/${chat.id}`)).chat.wallpaper)).color, '#0f4c5c');
  await assert.rejects(tablet.call('PUT', `/api/chats/${chat.id}/wallpaper`, { id: newMessageId(), payload: '{}' }), (e) => e.status === 404);
  await assert.rejects(tablet.call('DELETE', `/api/chats/${chat.id}/wallpaper`), (e) => e.status === 404);
});
