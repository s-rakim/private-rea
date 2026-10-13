# frozen_string_literal: true

require_relative 'test_helper'

# The hand-written WebSocket client against a scripted server: fragmentation,
# interleaved pings, every length encoding, masking and close codes.
class WebSocketTest < Minitest::Test
  GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

  def frame(opcode, payload, fin: true, mask: nil)
    payload = payload.b
    head = [(fin ? 0x80 : 0) | opcode].pack('C')
    m = mask ? 0x80 : 0
    len = payload.bytesize
    head << if len < 126 then [m | len].pack('C')
            elsif len < 65_536 then [m | 126, len].pack('Cn')
            else [m | 127, len].pack('CQ>')
            end
    return head + payload unless mask
    head + mask + payload.bytes.each_with_index.map { |b, i| b ^ mask.getbyte(i % 4) }.pack('C*')
  end

  # Reads one client frame; client frames must be masked.
  def read_client_frame(sock)
    b0, b1 = sock.read(2).bytes
    assert b1 & 0x80 != 0, 'client frames are masked'
    len = b1 & 0x7F
    len = sock.read(2).unpack1('n') if len == 126
    len = sock.read(8).unpack1('Q>') if len == 127
    mask = sock.read(4)
    data = sock.read(len).bytes.each_with_index.map { |b, i| b ^ mask.getbyte(i % 4) }.pack('C*')
    [b0 & 0x0F, data]
  end

  # Accepts one connection, answers the handshake (with `accept` instead of
  # the right Sec-WebSocket-Accept if given), then runs `script` on the socket.
  def with_server(script, accept: nil)
    server = TCPServer.new('127.0.0.1', 0)
    errors = Queue.new
    thread = Thread.new do
      sock = server.accept
      request = +''
      request << sock.readpartial(4096) until request.include?("\r\n\r\n")
      @request = request
      key = request[/^Sec-WebSocket-Key: (\S+)\r$/i, 1]
      accept ||= Base64.strict_encode64(OpenSSL::Digest.digest('SHA1', key + GUID))
      sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: #{accept}\r\n\r\n")
      script&.call(sock)
    rescue StandardError, Minitest::Assertion => e
      errors << e
    ensure
      sock&.close
    end
    yield "ws://127.0.0.1:#{server.addr[1]}/ws"
    thread.join(5)
    raise errors.pop unless errors.empty?
  ensure
    server&.close
  end

  def test_fragments_pings_lengths_and_close
    done = Queue.new
    script = lambda do |sock|
      sock.write(frame(0x1, 'hé', fin: false) + frame(0x9, 'are you there') + frame(0x0, 'llo ✓'))
      assert_equal [0xA, 'are you there'], read_client_frame(sock), 'pong echoes the ping'
      sock.write(frame(0x1, 'y' * 300) + frame(0x1, 'x' * 70_000))
      assert_equal [0x1, '{"type":"auth"}'], read_client_frame(sock)
      done.pop
      sock.write(frame(0x8, [4003].pack('n') + 'auth failed'))
      assert_equal [0x8, [4003].pack('n')], read_client_frame(sock)
    end
    with_server(script) do |url|
      ws = Tailchat::WebSocket.connect(url, headers: { 'X-Dev-User' => 'alice' })
      assert_includes @request, "X-Dev-User: alice\r\n"
      text = ws.read
      assert_equal 'héllo ✓', text
      assert_equal Encoding::UTF_8, text.encoding
      assert_equal 'y' * 300, ws.read
      assert_equal 'x' * 70_000, ws.read
      ws.send_text('{"type":"auth"}')
      assert_nil ws.read(timeout: 0.2), 'nothing more yet'
      done << true
      error = assert_raises(Tailchat::WebSocket::Closed) { ws.read }
      assert_equal 4003, error.code
      assert_equal 'auth failed', error.reason
      assert ws.closed?
    end
  end

  def test_refuses_a_bad_handshake_and_masked_server_frames
    with_server(nil, accept: 'bogus') do |url|
      assert_raises(Tailchat::WebSocket::Error) { Tailchat::WebSocket.connect(url) }
    end
    with_server(->(sock) { sock.write(frame(0x1, 'sneaky', mask: 'abcd')) }) do |url|
      ws = Tailchat::WebSocket.connect(url)
      assert_raises(Tailchat::WebSocket::Error) { ws.read }
    end
  end
end
