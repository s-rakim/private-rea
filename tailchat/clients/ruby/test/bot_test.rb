# frozen_string_literal: true

require_relative 'test_helper'

# The example bots, running against the real server over the WebSocket.
class BotTest < Minitest::Test
  include TestSupport

  def setup
    %w[echo_bot.rb reminder_bot.rb file_archiver_bot.rb].each { |f| load_example(f) }
    @bots = []
    @peers = []
  end

  def teardown
    @bots.each(&:stop)
    @bots.each { |b| b.join(5) }
    @peers.each(&:close)
  end

  def bot_options(user, state: nil)
    { server: server.base, dev_user: user, logger: TestSupport.logger,
      state: state || File.join(scratch, "#{user}.json") }
  end

  def start(bot)
    @bots << bot
    bot.start.wait_until_ready(15)
  end

  # Polls `client`'s history for the bot's reply to `sent`.
  def reply_to(client, bot, sent, timeout: 10)
    wait_until(timeout, 0.1) do
      client.history(sent.chat_id).find { |m| m.sender_device == bot.client.device_id && m.reply_to&.fetch('id') == sent.id }
    end
  end

  def test_echo_bot_round_trip_with_the_js_client
    bot = start(EchoBot.build(**bot_options(unique('echo'))))
    js = JsPeer.new(server.base, unique('jsfriend')).tap { |p| @peers << p }
    js.call('socket')
    chat = js.call('direct', userId: bot.client.user_id)['chat']

    sent = js.call('sendText', chatId: chat['id'], text: 'Hello bot 👋')['message']
    reply = js.call('waitMessage', chatId: chat['id'], senderId: bot.client.user_id, afterSeq: sent['seq'])
    assert_nil reply['error']
    assert_equal 'text', reply['content']['type']
    assert_equal 'Hello bot 👋', reply['content']['text']
    assert_equal({ 'id' => sent['id'], 'senderId' => js.user_id, 'preview' => 'Hello bot 👋' }, reply['content']['replyTo'])

    # Delivered and read receipts arrive on their own.
    member = js.call('waitReceipt', chatId: chat['id'], userId: bot.client.user_id, readSeq: sent['seq'])['member']
    assert_operator member['deliveredSeq'], :>=, sent['seq']

    help = js.call('sendText', chatId: chat['id'], text: '/help')['message']
    listing = js.call('waitMessage', chatId: chat['id'], senderId: bot.client.user_id, afterSeq: help['seq'])['content']['text']
    assert_includes listing, '/start - What I do'
    assert_includes listing, '/help'
  end

  def test_echo_bot_sends_files_back
    bot = start(EchoBot.build(**bot_options(unique('echo'))))
    me = client(unique('sender'))
    chat = me.direct_chat(bot.client.user_id)
    bytes = Tailchat::Crypto.random_bytes(Tailchat::Crypto::CHUNK + 4321)
    sent = me.send_file(chat['id'], StringIO.new(bytes), name: 'notes.bin', caption: 'round trip')

    reply = reply_to(me, bot, sent)
    assert_nil reply.error
    assert_equal 'round trip', reply.text
    assert_equal 'notes.bin', reply.attachment.name
    assert_equal bytes, reply.attachment.read
  end

  def test_messages_sent_while_the_bot_was_offline_are_handled_on_connect
    user = unique('echo')
    EchoBot.build(**bot_options(user)).client.register! # the bot's device exists, but it is offline
    me = client(unique('early'))
    chat = me.direct_chat("#{user}@dev")
    first = me.send_text(chat['id'], 'are you there?')
    second = me.send_text(chat['id'], 'hello?')

    bot = start(EchoBot.build(**bot_options(user)))
    assert_equal 'are you there?', reply_to(me, bot, first).text
    assert_equal 'hello?', reply_to(me, bot, second).text
    assert_equal second.seq, wait_until { c = me.chat(chat['id']); c['members'].find { |m| m['userId'] == "#{user}@dev" && m['readSeq'] >= second.seq } && second.seq }
  end

  def test_bot_reconnects_and_catches_up_after_a_dropped_connection
    bot = start(EchoBot.build(**bot_options(unique('echo'))))
    me = client(unique('sender'))
    chat = me.direct_chat(bot.client.user_id)
    bot.client.instance_variable_get(:@socket).shutdown # the network drops
    sent = me.send_text(chat['id'], 'while you were away')
    assert_equal 'while you were away', reply_to(me, bot, sent).text
    assert wait_until { bot.client.listening? }
    live = me.send_text(chat['id'], 'and now?')
    assert_equal 'and now?', reply_to(me, bot, live).text
  end

  def test_own_messages_only_in_the_self_chat
    user = unique('owner')
    bot = start(EchoBot.build(**bot_options(user)))
    phone = Tailchat::Client.new(**bot_options(user, state: File.join(scratch, "#{user}-phone.json")))
    friend = client(unique('friend'))
    friend.register!

    note = phone.send_text(phone.direct_chat(phone.user_id)['id'], 'note to self')
    assert_equal 'note to self', reply_to(phone, bot, note).text

    with_friend = phone.direct_chat(friend.user_id)
    mine = phone.send_text(with_friend['id'], 'my own message')
    theirs = friend.send_text(with_friend['id'], 'from the friend')
    assert_equal 'from the friend', reply_to(friend, bot, theirs).text
    refute friend.history(with_friend['id']).any? { |m| m.reply_to&.fetch('id') == mine.id }, 'owner messages to others are left alone'
  end

  def test_reminder_bot
    store = File.join(scratch, "#{unique('reminders')}.json")
    user = unique('remind')
    bot = start(ReminderBot.build(store: store, **bot_options(user)))
    me = client(unique('forgetful'))
    chat = me.direct_chat(bot.client.user_id)

    bad = me.send_text(chat['id'], '/remind soon please')
    assert_includes reply_to(me, bot, bad).text, 'Usage: /remind'

    sent = me.send_text(chat['id'], '/remind 1s stretch')
    ack = reply_to(me, bot, sent)
    assert_equal "OK, I'll remind you in 1 second.", ack.text
    reminder = wait_until(10, 0.1) do
      me.history(chat['id']).find { |m| m.sender_device == bot.client.device_id && m.text == '⏰ Reminder: stretch' }
    end
    assert_equal sent.id, reminder.reply_to['id']
    assert_equal [], JSON.parse(File.read(store))

    # Pending reminders survive a restart.
    later = me.send_text(chat['id'], '/remind 2s drink water')
    reply_to(me, bot, later)
    bot.stop
    bot.join(5)
    assert_equal ['drink water'], JSON.parse(File.read(store)).map { |r| r['text'] }
    again = start(ReminderBot.build(store: store, **bot_options(user)))
    fired = wait_until(10, 0.1) do
      me.history(chat['id']).find { |m| m.sender_device == again.client.device_id && m.text == '⏰ Reminder: drink water' }
    end
    assert_equal later.id, fired.reply_to['id']
  end

  def test_file_archiver_bot
    dir = File.join(scratch, unique('archive'))
    bot = start(FileArchiverBot.build(dir: dir, **bot_options(unique('archiver'))))
    me = client(unique('sharer'))
    chat = me.direct_chat(bot.client.user_id)
    bytes = Tailchat::Crypto.random_bytes((Tailchat::Crypto::CHUNK * 3 / 2) + 99)

    sent = me.send_file(chat['id'], StringIO.new(bytes), name: '../../../escape attempt.bin', mime: 'application/octet-stream')
    assert_equal 'Archived escape attempt.bin (1.5 MB).', reply_to(me, bot, sent).text
    saved = File.join(dir, me.user_id, 'escape attempt.bin')
    assert_equal bytes, File.binread(saved)
    assert_equal [saved], Dir.glob(File.join(dir, '**', '*')).select { |f| File.file?(f) }

    dup = me.send_file(chat['id'], StringIO.new('second'), name: 'escape attempt.bin')
    assert_equal 'Archived escape attempt (1).bin (6 B).', reply_to(me, bot, dup).text

    once = me.send_file(chat['id'], StringIO.new('secret'), name: 'once.jpg', mime: 'image/jpeg', view_once: true)
    assert_equal "I don't archive view-once media.", reply_to(me, bot, once).text

    stats = me.send_text(chat['id'], '/stats')
    assert_match(/\A2 files, 1\.5 MB archived for you\.\z/, reply_to(me, bot, stats).text)
  end
end
