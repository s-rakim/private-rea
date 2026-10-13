import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chatAad, newMessageId } from '../public/crypto.js';
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
  for (const c of [alice, bob, carol]) await c.socket();
});

after(async () => {
  for (const c of [alice, bob, carol]) c?.ws?.close();
  await server.stop();
});

const rejects = (promise, status) => assert.rejects(promise, (e) => e.status === status);

async function post(from, chatId, content) {
  const id = newMessageId();
  return (await from.call('POST', `/api/chats/${chatId}/messages`, { id, payload: JSON.stringify(content) })).message;
}

test('communities: groups inside, joining, announcements and leaving', async () => {
  const { chat: community } = await alice.call('POST', '/api/chats/community', { name: 'Home lab', description: 'Everyone on the tailnet' });
  assert.equal(community.type, 'community');
  assert.ok(community.adminsOnlySend && community.adminsOnlyEdit, 'only admins post announcements');
  await rejects(alice.call('PATCH', `/api/chats/${community.id}`, { adminsOnlySend: false }), 400);

  // A new group inside the community brings its members into the community.
  const { chat: servers } = await alice.call('POST', `/api/communities/${community.id}/groups`, { name: 'Servers', members: ['bob@dev'] });
  assert.equal(servers.communityId, community.id);
  assert.equal(servers.communityName, 'Home lab');
  const bobView = (await bob.call('GET', `/api/chats/${community.id}`)).chat;
  assert.equal(bobView.me.left, false);
  assert.deepEqual(bobView.groups.map((g) => [g.name, g.joined]), [['Servers', true]]);
  await rejects(bob.call('POST', `/api/communities/${community.id}/groups`, { name: 'Mine' }), 403);

  // Only admins post in the announcements group.
  const { devices } = await alice.call('GET', `/api/chats/${community.id}/devices`);
  const id = newMessageId();
  const payload = await alice.ring.seal({ type: 'text', text: 'Maintenance tonight' }, chatAad(community.id, id), devices);
  await alice.call('POST', `/api/chats/${community.id}/messages`, { id, payload });
  const evt = await bob.waitFor((e) => e.type === 'message' && e.message.id === id);
  assert.equal((await bob.ring.open(evt.message.payload, chatAad(community.id, id), 'alice@dev')).text, 'Maintenance tonight');
  const bobId = newMessageId();
  await rejects(bob.call('POST', `/api/chats/${community.id}/messages`, { id: bobId, payload }), 403);

  // Carol joins the community by link, sees its groups and joins one.
  const { code } = await alice.call('POST', `/api/chats/${community.id}/invite`);
  const preview = await carol.call('GET', `/api/invite/${code}`);
  assert.equal(preview.chat.type, 'community');
  await carol.call('POST', `/api/invite/${code}/join`);
  const carolView = (await carol.call('GET', `/api/chats/${community.id}`)).chat;
  assert.deepEqual(carolView.groups.map((g) => [g.name, g.joined, g.members]), [['Servers', false, 2]]);
  await rejects(carol.call('GET', `/api/chats/${servers.id}`), 403);
  const joined = await carol.call('POST', `/api/communities/${community.id}/groups/${servers.id}/join`);
  assert.equal(joined.chat.me.left, false);
  const joinMsg = (await alice.call('GET', `/api/chats/${servers.id}/messages`)).messages.at(-1);
  assert.deepEqual(JSON.parse(joinMsg.payload), { event: 'joined', users: ['carol@dev'], via: 'community' });

  // Linking an existing group needs admin rights in both.
  const { chat: games } = await bob.call('POST', '/api/chats/group', { name: 'Games', members: ['alice@dev'] });
  await rejects(alice.call('POST', `/api/communities/${community.id}/groups`, { groupId: games.id }), 403);
  await bob.call('POST', `/api/chats/${games.id}/admins`, { userId: 'alice@dev', admin: true });
  await alice.call('POST', `/api/communities/${community.id}/groups`, { groupId: games.id });
  assert.equal((await bob.call('GET', `/api/chats/${games.id}`)).chat.communityId, community.id);
  await rejects(alice.call('POST', `/api/communities/${community.id}/groups`, { groupId: games.id }), 400);
  await rejects(alice.call('POST', `/api/communities/${community.id}/groups`, { groupId: community.id }), 400);

  // Leaving the community leaves its groups too.
  await carol.call('DELETE', `/api/chats/${community.id}/members/carol@dev`);
  assert.equal((await carol.call('GET', `/api/chats/${servers.id}`)).chat.me.left, true);
  await rejects(carol.call('POST', `/api/communities/${community.id}/groups/${servers.id}/join`), 403);

  // Unlinking keeps the group going on its own.
  await alice.call('DELETE', `/api/communities/${community.id}/groups/${games.id}`);
  const unlinked = (await bob.call('GET', `/api/chats/${games.id}`)).chat;
  assert.equal(unlinked.communityId, null);
  assert.equal(unlinked.me.left, false);

  // Deactivating unlinks every group and closes the announcements.
  await rejects(bob.call('DELETE', `/api/communities/${community.id}`), 403);
  await alice.call('DELETE', `/api/communities/${community.id}`);
  assert.equal((await bob.call('GET', `/api/chats/${servers.id}`)).chat.communityId, null);
  assert.equal((await bob.call('GET', `/api/chats/${community.id}`)).chat.me.left, true);
  await rejects(carol.call('GET', `/api/invite/${code}`), 404);
});

test('channels: plain posts, followers stay private, admins only', async () => {
  const { chat: channel } = await alice.call('POST', '/api/chats/channel', { name: 'Release notes', description: 'What changed' });
  assert.equal(channel.type, 'channel');
  assert.equal(channel.followers, 1);

  const before = await post(alice, channel.id, { type: 'text', text: 'v1 is out' });
  for (const c of [bob, carol]) {
    const dir = (await c.call('GET', '/api/channels')).channels;
    const entry = dir.find((x) => x.id === channel.id);
    assert.deepEqual([entry.name, entry.following], ['Release notes', false]);
    await c.call('POST', `/api/channels/${channel.id}/follow`, { follow: true });
  }

  // Followers read posts from before they followed, as plain JSON.
  const history = (await bob.call('GET', `/api/chats/${channel.id}/messages`)).messages;
  assert.equal(JSON.parse(history.find((m) => m.id === before.id).payload).text, 'v1 is out');
  const live = await post(alice, channel.id, { type: 'poll', question: 'Next?', options: ['A', 'B'] });
  const evt = await carol.waitFor((e) => e.type === 'message' && e.message.id === live.id);
  assert.equal(JSON.parse(evt.message.payload).question, 'Next?');

  // Posts must be plain objects, never an envelope, and only admins post.
  const bad = { id: newMessageId(), payload: JSON.stringify({ v: 1, iv: 'x', ct: 'y', keys: {} }) };
  await rejects(alice.call('POST', `/api/chats/${channel.id}/messages`, bad), 400);
  await rejects(alice.call('POST', `/api/chats/${channel.id}/messages`, { id: newMessageId(), payload: '"text"' }), 400);
  await rejects(post(bob, channel.id, { type: 'text', text: 'hi' }), 403);
  await rejects(bob.call('GET', `/api/chats/${channel.id}/devices`), 400);

  // Followers see each other's reactions and votes as counts, admins see who.
  await bob.call('POST', `/api/messages/${live.id}/react`, { emoji: '🎉' });
  await bob.call('POST', `/api/messages/${live.id}/vote`, { options: [1] });
  const asCarol = (await carol.call('GET', `/api/messages/${live.id}`)).message;
  assert.deepEqual(asCarol.reactions, [{ userId: null, emoji: '🎉' }]);
  assert.deepEqual(asCarol.votes, [{ userId: null, options: [1] }]);
  const asBob = (await bob.call('GET', `/api/messages/${live.id}`)).message;
  assert.equal(asBob.reactions[0].userId, 'bob@dev', 'you see your own reaction');
  const asAlice = (await alice.call('GET', `/api/messages/${live.id}`)).message;
  assert.equal(asAlice.reactions[0].userId, 'bob@dev');

  // Followers don't see who else follows, and their read receipts stay with the admins.
  const carolChat = (await carol.call('GET', `/api/chats/${channel.id}`)).chat;
  assert.equal(carolChat.followers, 3);
  assert.deepEqual(carolChat.members.map((m) => m.userId).sort(), ['alice@dev', 'carol@dev']);
  assert.equal((await alice.call('GET', `/api/chats/${channel.id}`)).chat.members.length, 3);
  carol.events.length = 0;
  alice.events.length = 0;
  await bob.call('POST', `/api/chats/${channel.id}/receipts`, { delivered: live.seq, read: live.seq });
  await alice.waitFor((e) => e.type === 'receipt' && e.member.userId === 'bob@dev');
  bob.ws.send(JSON.stringify({ type: 'typing', chatId: channel.id, on: true }));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!carol.events.some((e) => e.type === 'receipt' || e.type === 'typing'), 'nothing about bob reaches carol');

  // No calls in channels; the last admin can't walk away.
  const callId = `call-${newMessageId()}`;
  alice.ws.send(JSON.stringify({ type: 'call', action: 'ring', callId, chatId: channel.id, video: false }));
  await alice.waitFor((e) => e.type === 'call' && e.callId === callId && e.action === 'error');
  await rejects(alice.call('POST', `/api/channels/${channel.id}/follow`, { follow: false }), 400);
  const unfollowed = await bob.call('POST', `/api/channels/${channel.id}/follow`, { follow: false });
  assert.equal(unfollowed.chat.me.left, true);
  assert.equal((await alice.call('GET', `/api/chats/${channel.id}`)).chat.followers, 2);
  const quiet = (await alice.call('GET', `/api/chats/${channel.id}/messages`)).messages.filter((m) => m.kind === 'system');
  assert.deepEqual(quiet.map((m) => JSON.parse(m.payload).event), ['created'], 'follows and unfollows post nothing');
});
