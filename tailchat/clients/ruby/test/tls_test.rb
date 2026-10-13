# frozen_string_literal: true

require_relative 'test_helper'

# Production servers sit behind HTTPS (tailscale serve): check https:// and
# wss:// with certificate verification.
class TlsTest < Minitest::Test
  include TestSupport

  def setup
    @tls = TestServer.new(tls: true).tap(&:start)
  end

  def teardown
    @tls&.stop
  end

  def tls_client(user, **options)
    Tailchat::Client.new(server: @tls.base, dev_user: user, logger: QUIET,
                         state: File.join(scratch, "tls-#{user}.json"), **options)
  end

  def test_https_and_wss_with_a_trusted_ca
    alice = tls_client(unique('alice'), ca_file: @tls.ca_path)
    bob = tls_client(unique('bob'), ca_file: @tls.ca_path)
    bob.register!
    events = Queue.new
    listener = Thread.new { bob.listen { |e| events << e } }
    assert_equal 'ready', events.pop(timeout: 10)&.fetch('type')

    chat = alice.direct_chat(bob.user_id)
    sent = alice.send_text(chat['id'], 'over TLS')
    event = next_event(events) { |e| e['type'] == 'message' && e['message']['id'] == sent.id }
    assert_equal 'over TLS', bob.open_message(event['message']).text

    bytes = Tailchat::Crypto.random_bytes(Tailchat::Crypto::CHUNK + 1)
    file = alice.send_file(chat['id'], StringIO.new(bytes), name: 'tls.bin')
    assert_equal bytes, bob.message(file.id).attachment.read
  ensure
    bob&.stop
    listener&.join(5)
  end

  def test_untrusted_certificates_are_refused
    stranger = tls_client(unique('stranger'))
    assert_raises(OpenSSL::SSL::SSLError) { stranger.register! }
    refute stranger.registered?
    assert_raises(OpenSSL::SSL::SSLError) do
      Tailchat::WebSocket.connect(stranger.ws_url, headers: { 'X-Dev-User' => stranger.dev_user })
    end
  end
end
