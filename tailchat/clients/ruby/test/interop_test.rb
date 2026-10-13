# frozen_string_literal: true

require_relative 'test_helper'

# Ruby <-> public/crypto.js through the real server: whatever one side seals,
# the other opens.
class InteropTest < Minitest::Test
  include TestSupport

  def setup
    @ruby = client(unique('ruby'))
    @js = JsPeer.new(server.base, unique('js'))
    @chat = @ruby.direct_chat(@js.user_id)
  end

  def teardown
    @js&.close
  end

  def test_text_from_ruby_decrypts_in_js
    text = "hello from Ruby ✨ ünïcödé \u{1F44B} \"quotes\" \\ </script>"
    sent = @ruby.send_text(@chat['id'], text, mentions: [@js.user_id])
    refute_includes sent.raw['payload'], 'hello', 'only ciphertext reaches the server'

    got = @js.call('history', chatId: @chat['id'])['messages'].find { |m| m['id'] == sent.id }
    assert_nil got['error']
    assert_equal({ 'type' => 'text', 'text' => text, 'mentions' => [@js.user_id] }, got['content'])
    assert_equal @ruby.device_id, got['senderDevice']
  end

  def test_text_from_js_decrypts_in_ruby
    reply_to = { 'id' => 'x' * 22, 'senderId' => @ruby.user_id, 'preview' => 'earlier' }
    sent = @js.call('sendText', chatId: @chat['id'], text: 'hi from JS 🚀', replyTo: reply_to)['message']
    msg = @ruby.history(@chat['id']).find { |m| m.id == sent['id'] }
    assert_nil msg.error
    assert_equal 'hi from JS 🚀', msg.text
    assert_equal reply_to, msg.reply_to
    assert_equal @js.user_id, msg.sender_id

    # The same envelope can't be replayed under another message id.
    moved = msg.raw.merge('id' => 'y' * 22)
    assert_kind_of Tailchat::CryptoError, @ruby.open_message(moved).error
  end

  def test_files_from_ruby_decrypt_in_js
    chunk = Tailchat::Crypto::CHUNK
    [0, chunk, (2 * chunk) + 12_345].each do |size|
      bytes = Tailchat::Crypto.random_bytes(size)
      path = File.join(scratch, "ruby-#{size}.bin")
      File.binwrite(path, bytes)
      sent = @ruby.send_file(@chat['id'], path, mime: 'application/octet-stream', caption: "#{size} bytes")
      file = sent.content['file']
      assert_equal size, file['size']

      got = @js.call('history', chatId: @chat['id'])['messages'].find { |m| m['id'] == sent.id }
      assert_nil got['error']
      assert_equal "#{size} bytes", got['content']['caption']
      out = File.join(scratch, "js-out-#{size}.bin")
      assert_equal size, @js.call('download', file: got['content']['file'], out: out)['size']
      assert_equal bytes, File.binread(out), "#{size}-byte file"
    end
  end

  def test_file_from_js_decrypts_in_ruby
    bytes = Tailchat::Crypto.random_bytes((Tailchat::Crypto::CHUNK * 3 / 2) + 7)
    path = File.join(scratch, 'js-in.bin')
    File.binwrite(path, bytes)
    sent = @js.call('sendFile', chatId: @chat['id'], path: path, name: 'photo.raw', mime: 'image/x-raw', caption: 'from JS')

    msg = @ruby.history(@chat['id']).find { |m| m.id == sent['message']['id'] }
    assert_nil msg.error
    assert msg.media?
    assert_equal 'from JS', msg.text
    assert_equal 'photo.raw', msg.attachment.name
    assert_equal bytes, msg.attachment.read

    saved = msg.attachment.save(File.join(scratch, 'saved'))
    assert_equal bytes, File.binread(saved)
    again = msg.attachment.save(File.join(scratch, 'saved'))
    assert_equal 'photo (1).raw', File.basename(again), 'never overwrites'
  end

  def test_security_codes_match
    assert_equal @js.call('securityCode', userId: @ruby.user_id)['code'], @ruby.security_code(@ruby.user_id)
    assert_equal @js.call('securityCode', userId: @js.user_id)['code'], @ruby.security_code(@js.user_id)
  end
end
