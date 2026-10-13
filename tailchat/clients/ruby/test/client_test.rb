# frozen_string_literal: true

require_relative 'test_helper'

class ClientTest < Minitest::Test
  include TestSupport

  def test_state_file_is_private_and_reused
    user = unique('state')
    path = File.join(scratch, "#{user}/device.json")
    first = Tailchat::Client.new(server: server.base, dev_user: user, state: path, logger: QUIET)
    refute first.registered?
    me = first.me
    assert_equal "#{user}@dev", me['user']['id']
    assert_equal first.device_id, me['device']['id']
    assert_equal 0o600, File.stat(path).mode & 0o777
    assert_equal 0o700, File.stat(File.dirname(path)).mode & 0o777

    second = Tailchat::Client.new(server: server.base, dev_user: user, state: path, logger: QUIET)
    assert second.registered?
    assert_equal first.device_id, second.device_id
    assert_equal 1, second.devices.size, 'no second registration'

    assert_raises(Tailchat::Error) { Tailchat::Client.new(server: 'http://127.0.0.1:1', dev_user: user, state: path) }
  end

  def test_errors_carry_the_http_status
    c = client(unique('err'))
    err = assert_raises(Tailchat::HTTPError) { c.chat('nope') }
    assert_equal 404, err.status
    assert_raises(ArgumentError) { Tailchat::Client.new(server: server.base, dev_user: 'Not Valid') }
  end

  def test_group_chat_and_late_joiner_has_no_key
    alice = client(unique('alice'))
    bob = client(unique('bob'))
    bob.register!
    group = alice.create_group('Ruby group', [bob.user_id])
    early = alice.send_text(group['id'], 'before the new device')
    bob_laptop = Tailchat::Client.new(server: server.base, dev_user: bob.dev_user, logger: QUIET,
                                      state: File.join(scratch, "#{bob.dev_user}-laptop.json"))
    late = alice.send_text(group['id'], 'after the new device')

    texts = bob_laptop.history(group['id']).select(&:readable?).map(&:text)
    assert_equal ['after the new device'], texts
    old = bob_laptop.history(group['id']).find { |m| m.id == early.id }
    assert_kind_of Tailchat::NoKeyError, old.error
    assert_equal %w[before\ the\ new\ device after\ the\ new\ device], bob.history(group['id']).select(&:readable?).map(&:text)
    assert(bob.history(group['id']).any?(&:system?))
    assert_equal late.id, bob.history(group['id']).last.id
  end

  def test_listen_receives_messages_and_receipts_over_websocket
    ruby = client(unique('listener'))
    js = JsPeer.new(server.base, unique('talker'))
    js.call('socket')
    chat = ruby.direct_chat(js.user_id)
    events = Queue.new
    listener = Thread.new { ruby.listen { |e| events << e } }
    assert_equal 'ready', events.pop['type']
    sent = js.call('sendText', chatId: chat['id'], text: 'over the socket')['message']

    event = wait_until { e = events.pop; e if e['type'] == 'message' && e['message']['id'] == sent['id'] }
    msg = ruby.open_message(event['message'])
    assert_equal 'over the socket', msg.text

    ruby.receipts(chat['id'], delivered: msg.seq, read: msg.seq)
    member = js.call('waitReceipt', chatId: chat['id'], userId: ruby.user_id, readSeq: msg.seq)['member']
    assert_equal msg.seq, member['deliveredSeq']

    ruby.typing(chat['id'])
    ruby.react(msg.id, '👍')
    assert_equal [{ 'userId' => ruby.user_id, 'emoji' => '👍' }], ruby.raw_messages(chat['id'])['messages'].last['reactions']
  ensure
    ruby&.stop
    listener&.join(5)
    js&.close
  end

  def test_edit_and_delete
    a = client(unique('editor'))
    b = client(unique('reader'))
    b.register!
    chat = a.direct_chat(b.user_id)
    sent = a.send_text(chat['id'], 'tpyo')
    edited = a.edit(sent, 'typo')
    assert edited.edited?
    assert_equal 'typo', b.history(chat['id']).find { |m| m.id == sent.id }.text
    a.delete_message(sent.id, for_everyone: true)
    gone = b.history(chat['id']).find { |m| m.id == sent.id }
    assert gone.deleted?
    refute gone.readable?
  end
end
