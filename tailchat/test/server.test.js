import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chatAad, decryptFile, encryptFile, newMessageId, securityCode } from '../public/crypto.js';
import { connectUser, startServer } from './helpers.js';

let server;
let alice;
let bob;
let carol;

before(async () => {
  server = await startServer();
  alice = await connectUser(server.base, 'alice');
  bob = await connectUser(server.base, 'bob');
  carol = await connectUser(server.base, 'carol');
  await alice.socket();
  await bob.socket();
});

after(async () => {
  for (const c of [alice, bob, carol]) c?.ws?.close();
  await server.stop();
});

async function send(from, chatId, content, extra = {}) {
  const id = newMessageId();
  const { devices } = await from.call('GET', `/api/chats/${chatId}/devices`);
  const payload = await from.ring.seal(content, chatAad(chatId, id), devices);
  return (await from.call('POST', `/api/chats/${chatId}/messages`, { id, payload, ...extra })).message;
}

test('identity comes from the tailnet, not the request body', async () => {
  const me = await alice.call('GET', '/api/me');
  assert.equal(me.user.id, 'alice@dev');
  assert.equal(me.device.id, alice.deviceId);
  // A device token only works for the user it was issued to.
  await assert.rejects(
    fetch(server.base + '/api/chats', { headers: { 'X-Dev-User': 'bob', Authorization: `Bearer ${alice.token}` } }).then(async (r) => {
      if (!r.ok) throw Object.assign(new Error('refused'), { status: r.status });
    }),
    (err) => err.status === 403,
  );
  const anon = await fetch(server.base + '/api/me');
  assert.equal(anon.status, 401);
});

test('direct chat: end-to-end encrypted text, receipts and reactions', async () => {
  const { chat } = await alice.call('POST', '/api/chats/direct', { userId: 'bob@dev' });
  const again = await bob.call('POST', '/api/chats/direct', { userId: 'alice@dev' });
  assert.equal(again.chat.id, chat.id, 'one direct chat per pair');

  const sent = await send(alice, chat.id, { type: 'text', text: 'hello over the tailnet' });
  assert.ok(!sent.payload.includes('hello'), 'server only stores ciphertext');

  const evt = await bob.waitFor((e) => e.type === 'message' && e.message.id === sent.id);
  const content = await bob.ring.open(evt.message.payload, chatAad(chat.id, sent.id));
  assert.equal(content.text, 'hello over the tailnet');

  // Moving the ciphertext to another message id breaks decryption.
  await assert.rejects(bob.ring.open(evt.message.payload, chatAad(chat.id, 'other-message-id-x')));

  const list = await bob.call('GET', '/api/chats');
  assert.equal(list.chats.find((c) => c.id === chat.id).unread, 1);

  await bob.call('POST', `/api/chats/${chat.id}/receipts`, { delivered: sent.seq, read: sent.seq });
  const receipt = await alice.waitFor((e) => e.type === 'receipt' && e.member.userId === 'bob@dev' && e.member.readSeq >= sent.seq);
  assert.equal(receipt.member.deliveredSeq, sent.seq);

  await bob.call('POST', `/api/messages/${sent.id}/react`, { emoji: '👍' });
  const reacted = await alice.waitFor((e) => e.type === 'message-update' && e.message.reactions.length);
  assert.deepEqual(reacted.message.reactions, [{ userId: 'bob@dev', emoji: '👍' }]);
  await assert.rejects(bob.call('POST', `/api/messages/${sent.id}/react`, { emoji: 'lol' }), (e) => e.status === 400);
});

test('edit and delete for everyone', async () => {
  const { chat } = await alice.call('POST', '/api/chats/direct', { userId: 'bob@dev' });
  const sent = await send(alice, chat.id, { type: 'text', text: 'typo' });
  const { devices } = await alice.call('GET', `/api/chats/${chat.id}/devices`);
  const payload = await alice.ring.seal({ type: 'text', text: 'fixed' }, chatAad(chat.id, sent.id), devices);
  await assert.rejects(bob.call('PUT', `/api/messages/${sent.id}`, { payload }), (e) => e.status === 403);
  const edited = (await alice.call('PUT', `/api/messages/${sent.id}`, { payload })).message;
  assert.ok(edited.editedAt);
  assert.equal((await bob.ring.open(edited.payload, chatAad(chat.id, sent.id))).text, 'fixed');

  await alice.call('DELETE', `/api/messages/${sent.id}?for=everyone`);
  const { messages } = await bob.call('GET', `/api/chats/${chat.id}/messages`);
  const gone = messages.find((m) => m.id === sent.id);
  assert.equal(gone.payload, null);
  assert.ok(gone.deletedAt);
});

test('encrypted file sharing, including multi-chunk files', async () => {
  const { chat } = await alice.call('POST', '/api/chats/direct', { userId: 'bob@dev' });
  const bytes = new Uint8Array(2.5 * 1024 * 1024).map((_, i) => (i * 7) & 0xff);
  const { blob, file } = await encryptFile(new Blob([bytes]));
  const encrypted = new Uint8Array(await blob.arrayBuffer());
  const up = await alice.call('POST', '/api/files', encrypted, { 'Content-Type': 'application/octet-stream' });
  const sent = await send(alice, chat.id, { type: 'media', kind: 'document', file: { ...file, id: up.id, name: 'big.bin', mime: 'application/octet-stream' } }, { files: [up.id] });

  const content = await bob.ring.open(sent.payload, chatAad(chat.id, sent.id));
  const downloaded = await bob.call('GET', `/api/files/${content.file.id}`);
  const plain = new Uint8Array(await (await decryptFile(downloaded, content.file)).arrayBuffer());
  assert.deepEqual(plain, bytes);

  // Truncating the last chunk is detected.
  await assert.rejects(decryptFile(downloaded.subarray(0, downloaded.length - 10), content.file));

  // Carol is not in the chat and can't fetch the file.
  await assert.rejects(carol.call('GET', `/api/files/${up.id}`), (e) => e.status === 404);
  // Nor can she attach Alice's file to her own messages.
  const { chat: cc } = await carol.call('POST', '/api/chats/direct', { userId: 'bob@dev' });
  await assert.rejects(carol.call('POST', `/api/chats/${cc.id}/messages`, { payload: '{}', files: [up.id] }), (e) => e.status === 400);
});

test('groups: admins, invite links, new members cannot read history', async () => {
  const { chat } = await alice.call('POST', '/api/chats/group', { name: 'Weekend', members: ['bob@dev'] });
  const before = await send(alice, chat.id, { type: 'text', text: 'before carol' });

  await assert.rejects(bob.call('POST', `/api/chats/${chat.id}/members`, { userIds: ['carol@dev'] }), (e) => e.status === 403);
  const { code } = await alice.call('POST', `/api/chats/${chat.id}/invite`);
  const preview = await carol.call('GET', `/api/invite/${code}`);
  assert.equal(preview.chat.name, 'Weekend');
  await carol.call('POST', `/api/invite/${code}/join`);

  const { messages } = await carol.call('GET', `/api/chats/${chat.id}/messages`);
  assert.ok(!messages.some((m) => m.id === before.id), 'history before joining stays hidden');
  const afterJoin = await send(bob, chat.id, { type: 'text', text: 'hi carol' });
  assert.equal((await carol.ring.open(afterJoin.payload, chatAad(chat.id, afterJoin.id))).text, 'hi carol');

  await alice.call('PATCH', `/api/chats/${chat.id}`, { adminsOnlySend: true });
  await assert.rejects(send(bob, chat.id, { type: 'text', text: 'nope' }), (e) => e.status === 403);
  await alice.call('POST', `/api/chats/${chat.id}/admins`, { userId: 'bob@dev', admin: true });
  await send(bob, chat.id, { type: 'text', text: 'admin now' });

  // The last admin leaving hands admin to someone else.
  await alice.call('DELETE', `/api/chats/${chat.id}/members/alice@dev`);
  await bob.call('DELETE', `/api/chats/${chat.id}/members/bob@dev`);
  const view = (await carol.call('GET', `/api/chats/${chat.id}`)).chat;
  assert.equal(view.members.find((m) => m.userId === 'carol@dev').role, 'admin');
  await assert.rejects(send(alice, chat.id, { type: 'text', text: 'gone' }), (e) => e.status === 403);
});

test('disappearing and view-once messages', async () => {
  const { chat } = await alice.call('POST', '/api/chats/direct', { userId: 'carol@dev' });
  await alice.call('PATCH', `/api/chats/${chat.id}`, { disappearing: 1 });
  const temp = await send(alice, chat.id, { type: 'text', text: 'poof' });
  assert.ok(temp.expiresAt);
  await new Promise((r) => setTimeout(r, 1100));
  server.app.sweep();
  const { messages } = await carol.call('GET', `/api/chats/${chat.id}/messages`);
  assert.ok(!messages.some((m) => m.id === temp.id));
  await alice.call('PATCH', `/api/chats/${chat.id}`, { disappearing: 0 });

  const { blob, file } = await encryptFile(new Blob(['secret photo']));
  const up = await alice.call('POST', '/api/files', new Uint8Array(await blob.arrayBuffer()), { 'Content-Type': 'application/octet-stream' });
  const once = await send(alice, chat.id, { type: 'media', kind: 'image', file: { ...file, id: up.id } }, { files: [up.id], viewOnce: true });
  await carol.call('GET', `/api/files/${up.id}`);
  await carol.call('POST', `/api/messages/${once.id}/opened`);
  await assert.rejects(carol.call('GET', `/api/files/${up.id}`), (e) => e.status === 404);
  const reread = (await carol.call('GET', `/api/chats/${chat.id}/messages`)).messages.find((m) => m.id === once.id);
  assert.equal(reread.payload, null);
  assert.equal(reread.opened, true);
});

test('blocking stops direct messages', async () => {
  const { chat } = await bob.call('POST', '/api/chats/direct', { userId: 'carol@dev' });
  await carol.call('POST', '/api/blocks', { userId: 'bob@dev' });
  await assert.rejects(send(bob, chat.id, { type: 'text', text: 'hey' }), (e) => e.status === 403);
  await carol.call('DELETE', '/api/blocks/bob@dev');
  await send(bob, chat.id, { type: 'text', text: 'hey' });
});

test('polls store only vote indices', async () => {
  const { chat } = await alice.call('POST', '/api/chats/direct', { userId: 'bob@dev' });
  const poll = await send(alice, chat.id, { type: 'poll', question: 'Lunch?', options: ['Pizza', 'Sushi'], multiple: false });
  await bob.call('POST', `/api/messages/${poll.id}/vote`, { options: [1] });
  const { messages } = await alice.call('GET', `/api/chats/${chat.id}/messages`);
  assert.deepEqual(messages.find((m) => m.id === poll.id).votes, [{ userId: 'bob@dev', options: [1] }]);
});

test('status updates expire and record viewers', async () => {
  const { devices } = await alice.call('GET', '/api/status/devices');
  const payload = await alice.ring.seal({ type: 'text', text: 'at the beach', background: '#0a7' }, 'tailchat/v1|status:alice@dev', devices);
  const { status } = await alice.call('POST', '/api/status', { payload });
  const seen = (await bob.call('GET', '/api/status')).statuses.find((s) => s.id === status.id);
  assert.equal((await bob.ring.open(seen.payload, 'tailchat/v1|status:alice@dev')).text, 'at the beach');
  await bob.call('POST', `/api/status/${status.id}/view`);
  const mine = (await alice.call('GET', '/api/status')).statuses.find((s) => s.id === status.id);
  assert.deepEqual(mine.viewers.map((v) => v.userId), ['bob@dev']);
});

test('logging out a device revokes its token but keeps its key for old messages', async () => {
  const dave = await connectUser(server.base, 'dave');
  const other = await connectUser(server.base, 'dave');
  await other.call('DELETE', `/api/devices/${dave.deviceId}`);
  await assert.rejects(dave.call('GET', '/api/chats'), (e) => e.status === 401);
  const { devices } = await other.call('GET', `/api/keys?ids=${dave.deviceId}`);
  assert.ok(devices[0].revokedAt);
});

test('security codes are stable and order independent', async () => {
  const devices = (await alice.call('GET', '/api/users/bob@dev/devices')).devices;
  const one = await securityCode(devices);
  assert.match(one, /^(\d{5} ){11}\d{5}$/);
  assert.equal(await securityCode([...devices].reverse()), one);
});
