# frozen_string_literal: true

# A minimal RFC 6455 WebSocket client over TCPSocket / OpenSSL::SSL::SSLSocket:
# text frames, fragmentation, ping/pong and the close handshake. Enough for
# Tailchat's realtime channel without any gems.
require 'base64'
require 'ipaddr'
require 'openssl'
require 'socket'
require 'uri'

module Tailchat
  class WebSocket
    class Error < Tailchat::Error; end

    # The server ended the connection; `code` is the close code (e.g. 4003).
    class Closed < Error
      attr_reader :code, :reason

      def initialize(code, reason)
        @code = code
        @reason = reason
        super("WebSocket closed (#{code}#{reason.to_s.empty? ? '' : " #{reason}"})")
      end
    end

    GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
    MAX_MESSAGE = 64 * 1024 * 1024
    OP_CONT = 0x0
    OP_TEXT = 0x1
    OP_BINARY = 0x2
    OP_CLOSE = 0x8
    OP_PING = 0x9
    OP_PONG = 0xA

    # cert_store: an OpenSSL::X509::Store to trust instead of the system CAs.
    def self.connect(url, headers: {}, cert_store: nil, timeout: 10)
      new(url, headers: headers, cert_store: cert_store, timeout: timeout)
    end

    def initialize(url, headers: {}, cert_store: nil, timeout: 10)
      uri = URI(url)
      raise ArgumentError, "not a ws:// or wss:// URL: #{url}" unless %w[ws wss].include?(uri.scheme)
      @buffer = ''.b
      @write_lock = Mutex.new
      @closed = false
      tcp = Socket.tcp(uri.hostname, uri.port, connect_timeout: timeout)
      tcp.setsockopt(Socket::IPPROTO_TCP, Socket::TCP_NODELAY, 1)
      @io = uri.scheme == 'wss' ? start_tls(tcp, uri.hostname, cert_store) : tcp
      handshake(uri, headers, timeout)
    rescue StandardError
      tcp&.close
      raise
    end

    def send_text(text)
      write_frame(OP_TEXT, text.to_s.encode(Encoding::UTF_8).b)
    end

    def ping(data = '')
      write_frame(OP_PING, data.b)
    end

    # Returns the next text message (a UTF-8 String), answering pings on the
    # way. Returns nil if nothing arrived within `timeout` seconds. Raises
    # Closed when the server closes the connection.
    def read(timeout: nil)
      message = nil
      opcode = nil
      loop do
        return nil if timeout && message.nil? && @buffer.empty? && !wait_readable(timeout)
        fin, op, payload = read_frame
        case op
        when OP_PING # may arrive between the fragments of a message
          write_frame(OP_PONG, payload)
          next
        when OP_PONG then next
        when OP_CLOSE
          code = payload.bytesize >= 2 ? payload.unpack1('n') : 1005
          reason = payload.bytesize > 2 ? payload.byteslice(2..).force_encoding(Encoding::UTF_8) : ''
          close(code == 1005 ? 1000 : code) unless @closed
          shutdown
          raise Closed.new(code, reason)
        when OP_TEXT, OP_BINARY
          raise Error, 'new message before the previous one finished' if message
          opcode = op
          message = payload
        when OP_CONT
          raise Error, 'continuation frame without a message' unless message
          message << payload
        else
          raise Error, "unknown opcode #{op}"
        end
        raise Error, 'message too large' if message && message.bytesize > MAX_MESSAGE
        next unless fin && message
        return message if opcode == OP_BINARY
        text = message.force_encoding(Encoding::UTF_8)
        raise Error, 'text frame is not UTF-8' unless text.valid_encoding?
        return text
      end
    end

    def close(code = 1000, reason = '')
      return if @closed
      @closed = true
      write_frame(OP_CLOSE, [code].pack('n') + reason.b)
    rescue IOError, SystemCallError, OpenSSL::SSL::SSLError
      nil
    end

    # Close politely and drop the socket.
    def shutdown
      close
      @io.close unless @io.closed?
    rescue IOError, SystemCallError, OpenSSL::SSL::SSLError
      nil
    end

    def closed?
      @io.closed?
    end

    private

    # Always verifies the certificate chain and the host name.
    def start_tls(tcp, host, cert_store)
      ip = ip_address?(host)
      context = OpenSSL::SSL::SSLContext.new
      # SNI (and so verify_hostname) takes names only; post_connection_check
      # below verifies IP addresses too.
      context.set_params({ verify_mode: OpenSSL::SSL::VERIFY_PEER, verify_hostname: !ip, cert_store: cert_store }.compact)
      ssl = OpenSSL::SSL::SSLSocket.new(tcp, context)
      ssl.hostname = host unless ip
      ssl.sync_close = true
      ssl.connect
      ssl.post_connection_check(host)
      ssl
    end

    def ip_address?(host)
      IPAddr.new(host)
      true
    rescue IPAddr::Error
      false
    end

    def handshake(uri, headers, timeout)
      key = Base64.strict_encode64(OpenSSL::Random.random_bytes(16))
      default_port = uri.scheme == 'wss' ? 443 : 80
      host = uri.port == default_port ? uri.host : "#{uri.host}:#{uri.port}"
      lines = [
        "GET #{uri.request_uri} HTTP/1.1",
        "Host: #{host}",
        'Upgrade: websocket',
        'Connection: Upgrade',
        "Sec-WebSocket-Key: #{key}",
        'Sec-WebSocket-Version: 13',
        'User-Agent: tailchat-ruby',
      ]
      headers.each do |name, value|
        raise ArgumentError, 'header contains a line break' if "#{name}#{value}".match?(/[\r\n]/)
        lines << "#{name}: #{value}"
      end
      @io.write("#{lines.join("\r\n")}\r\n\r\n")

      until (split = @buffer.index("\r\n\r\n"))
        raise Error, 'handshake response too large' if @buffer.bytesize > 16_384
        raise Error, 'timed out waiting for the WebSocket handshake' unless wait_readable(timeout)
        fill
      end
      head = @buffer.slice!(0, split + 4).force_encoding(Encoding::ISO_8859_1)
      status_line, *header_lines = head.split("\r\n")
      status = status_line.to_s.split(' ', 3)[1].to_i
      raise Error, "WebSocket upgrade refused: #{status_line}" unless status == 101
      fields = header_lines.to_h { |l| n, v = l.split(':', 2); [n.to_s.strip.downcase, v.to_s.strip] }
      expected = Base64.strict_encode64(OpenSSL::Digest.digest('SHA1', key + GUID))
      raise Error, 'bad Sec-WebSocket-Accept' unless fields['sec-websocket-accept'] == expected
      raise Error, 'server did not upgrade the connection' unless fields['upgrade'].to_s.casecmp?('websocket')
    end

    def read_frame
      b0, b1 = read_exact(2).bytes
      fin = b0 & 0x80 != 0
      raise Error, 'reserved bits set (no extensions were negotiated)' if b0 & 0x70 != 0
      raise Error, 'server frames must not be masked' if b1 & 0x80 != 0
      op = b0 & 0x0F
      len = b1 & 0x7F
      len = read_exact(2).unpack1('n') if len == 126
      len = read_exact(8).unpack1('Q>') if len == 127
      raise Error, 'frame too large' if len > MAX_MESSAGE
      raise Error, 'bad control frame' if op >= 0x8 && (len > 125 || !fin)
      [fin, op, read_exact(len)]
    end

    def write_frame(opcode, payload)
      header = [0x80 | opcode].pack('C')
      len = payload.bytesize
      header << if len < 126 then [0x80 | len].pack('C')
                elsif len < 65_536 then [0x80 | 126, len].pack('Cn')
                else [0x80 | 127, len].pack('CQ>')
                end
      mask = OpenSSL::Random.random_bytes(4)
      frame = header + mask + mask_bytes(payload, mask)
      @write_lock.synchronize { @io.write(frame) }
    end

    # XOR with the 4-byte mask, a word at a time.
    def mask_bytes(payload, mask)
      return ''.b if payload.empty?
      pad = (4 - (payload.bytesize % 4)) % 4
      key = mask.unpack1('N')
      words = (payload + ("\0".b * pad)).unpack('N*').map! { |w| w ^ key }
      words.pack('N*').byteslice(0, payload.bytesize)
    end

    def read_exact(n)
      fill while @buffer.bytesize < n
      @buffer.slice!(0, n)
    end

    def fill
      @buffer << @io.readpartial(65_536).b
    rescue EOFError
      raise Error, 'connection closed by the server'
    end

    def wait_readable(timeout)
      return true if @io.respond_to?(:pending) && @io.pending.positive?
      !IO.select([@io], nil, nil, timeout).nil?
    end
  end
end
