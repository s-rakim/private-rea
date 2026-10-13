# frozen_string_literal: true

# End-to-end encryption, PROTOCOL.md §2-5. A byte-for-byte port of
# public/crypto.js on top of Ruby's OpenSSL bindings:
#
#   ECDH P-256          OpenSSL::PKey::EC#derive
#   HKDF-SHA256         OpenSSL::KDF.hkdf
#   AES-KW (RFC 3394)   OpenSSL "id-aes256-wrap", with a pure Ruby fallback
#   AES-256-GCM         OpenSSL::Cipher "aes-256-gcm"
require 'base64'
require 'json'
require 'openssl'
require 'stringio'

module Tailchat
  class Error < StandardError; end

  # Anything that fails to decrypt or verify: a wrong key, a tampered or
  # truncated ciphertext, an envelope moved to another message.
  class CryptoError < Error; end

  # The message was sealed before this device existed, so it has no wrapped
  # key for us (PROTOCOL.md §3).
  class NoKeyError < CryptoError; end

  module Crypto
    CHUNK = 1024 * 1024
    TAG_LEN = 16
    WRAP_SALT = 'tailchat/v1/wrap'
    CURVE = 'prime256v1'
    RFC3394_IV = ("\xA6".b * 8).freeze

    module_function

    # ---------- encoding ----------

    def b64u(bytes)
      Base64.urlsafe_encode64(bytes.to_s.b, padding: false)
    end

    def unb64u(text)
      raise CryptoError, 'expected a base64url string' unless text.is_a?(String) && text.match?(/\A[A-Za-z0-9_-]*\z/)
      Base64.urlsafe_decode64(text).b
    rescue ArgumentError
      raise CryptoError, 'malformed base64url'
    end

    def random_bytes(n)
      OpenSSL::Random.random_bytes(n)
    end

    def sha256(bytes)
      OpenSSL::Digest.digest('SHA256', bytes)
    end

    def new_message_id
      b64u(random_bytes(16))
    end

    def chat_aad(chat_id, message_id)
      "tailchat/v1|chat:#{chat_id}|msg:#{message_id}"
    end

    def status_aad(user_id)
      "tailchat/v1|status:#{user_id}"
    end

    # ---------- device keys ----------

    def generate_key
      OpenSSL::PKey::EC.generate(CURVE)
    end

    # {"kty":"EC","crv":"P-256","x":…,"y":…} with 32-byte coordinates.
    def public_jwk(key)
      point = key.public_key.to_octet_string(:uncompressed)
      { 'kty' => 'EC', 'crv' => 'P-256', 'x' => b64u(point.byteslice(1, 32)), 'y' => b64u(point.byteslice(33, 32)) }
    end

    # Imports a P-256 public JWK. OpenSSL rejects points that are not on the curve.
    def import_public_jwk(jwk)
      jwk = jwk.transform_keys(&:to_s)
      raise CryptoError, 'not a P-256 public key' unless jwk['kty'] == 'EC' && jwk['crv'] == 'P-256'
      x = unb64u(jwk['x'])
      y = unb64u(jwk['y'])
      raise CryptoError, 'P-256 coordinates must be 32 bytes' unless x.bytesize == 32 && y.bytesize == 32
      spki = OpenSSL::ASN1::Sequence.new([
        OpenSSL::ASN1::Sequence.new([OpenSSL::ASN1::ObjectId.new('id-ecPublicKey'), OpenSSL::ASN1::ObjectId.new(CURVE)]),
        OpenSSL::ASN1::BitString.new("\x04".b + x + y),
      ])
      key = OpenSSL::PKey.read(spki.to_der)
      raise CryptoError, 'not an EC key' unless key.is_a?(OpenSSL::PKey::EC)
      key
    rescue OpenSSL::PKey::PKeyError, OpenSSL::ASN1::ASN1Error, ArgumentError => e
      raise CryptoError, "invalid public key: #{e.message}"
    end

    # Z = ECDH(private, public): the 32-byte shared x coordinate.
    def ecdh(private_key, public_key)
      private_key.derive(public_key)
    end

    # wrapKey = HKDF-SHA256(Z, salt "tailchat/v1/wrap", info "S|R", 32 bytes)
    def wrap_key(shared, sender_id, recipient_id)
      OpenSSL::KDF.hkdf(shared, salt: WRAP_SALT, info: "#{sender_id}|#{recipient_id}".b, length: 32, hash: 'SHA256')
    end

    # ---------- AES key wrap (RFC 3394) ----------

    def aes_kw_wrap(kek, key)
      openssl_wrap? ? openssl_kw(:encrypt, kek, key) : rfc3394_wrap(kek, key)
    end

    def aes_kw_unwrap(kek, wrapped)
      raise CryptoError, 'wrapped key must be 40 bytes' unless wrapped.bytesize == 40
      openssl_wrap? ? openssl_kw(:decrypt, kek, wrapped) : rfc3394_unwrap(kek, wrapped)
    end

    def openssl_kw(mode, kek, data)
      c = OpenSSL::Cipher.new('id-aes256-wrap')
      c.public_send(mode)
      c.key = kek
      c.update(data) + c.final
    rescue OpenSSL::Cipher::CipherError
      raise CryptoError, 'key unwrap failed (integrity check)'
    end

    # Some OpenSSL builds refuse wrap mode through the EVP API; probe once.
    def openssl_wrap?
      return @openssl_wrap unless @openssl_wrap.nil?
      @openssl_wrap = begin
        c = OpenSSL::Cipher.new('id-aes256-wrap')
        c.encrypt
        c.key = "\0".b * 32
        (c.update("\0".b * 32) + c.final).bytesize == 40
      rescue StandardError
        false
      end
    end

    def aes_block(kek, block, mode)
      c = OpenSSL::Cipher.new('aes-256-ecb')
      c.public_send(mode)
      c.key = kek
      c.padding = 0
      c.update(block) + c.final
    end

    # RFC 3394 §2.2.1, written out for builds without OpenSSL's wrap mode.
    def rfc3394_wrap(kek, key)
      raise CryptoError, 'key to wrap must be a multiple of 8 bytes' unless (key.bytesize % 8).zero? && key.bytesize >= 16
      n = key.bytesize / 8
      a = RFC3394_IV.dup
      r = Array.new(n) { |i| key.byteslice(i * 8, 8) }
      6.times do |j|
        n.times do |i|
          b = aes_block(kek, a + r[i], :encrypt)
          t = (n * j) + i + 1
          a = [b.byteslice(0, 8).unpack1('Q>') ^ t].pack('Q>')
          r[i] = b.byteslice(8, 8)
        end
      end
      a + r.join
    end

    def rfc3394_unwrap(kek, wrapped)
      n = (wrapped.bytesize / 8) - 1
      a = wrapped.byteslice(0, 8)
      r = Array.new(n) { |i| wrapped.byteslice((i + 1) * 8, 8) }
      5.downto(0) do |j|
        (n - 1).downto(0) do |i|
          t = (n * j) + i + 1
          b = aes_block(kek, [a.unpack1('Q>') ^ t].pack('Q>') + r[i], :decrypt)
          a = b.byteslice(0, 8)
          r[i] = b.byteslice(8, 8)
        end
      end
      raise CryptoError, 'key unwrap failed (integrity check)' unless OpenSSL.fixed_length_secure_compare(a, RFC3394_IV)
      r.join
    end

    # ---------- AES-256-GCM ----------

    # Returns ciphertext || 16-byte tag, like WebCrypto.
    def gcm_encrypt(key, iv, plaintext, aad)
      c = OpenSSL::Cipher.new('aes-256-gcm')
      c.encrypt
      c.key = key
      c.iv = iv
      c.auth_data = aad.b
      out = plaintext.empty? ? ''.b : c.update(plaintext.b) # Cipher#update refuses empty input
      out + c.final + c.auth_tag(TAG_LEN)
    end

    def gcm_decrypt(key, iv, data, aad)
      # OpenSSL accepts truncated tags, so insist on the full 16 bytes.
      raise CryptoError, 'ciphertext is shorter than its tag' if data.bytesize < TAG_LEN
      raise CryptoError, 'iv must be 12 bytes' unless iv.bytesize == 12
      c = OpenSSL::Cipher.new('aes-256-gcm')
      c.decrypt
      c.key = key
      c.iv = iv
      c.auth_tag = data.byteslice(-TAG_LEN, TAG_LEN)
      c.auth_data = aad.b
      body = data.byteslice(0, data.bytesize - TAG_LEN)
      out = body.empty? ? ''.b : c.update(body)
      out + c.final
    rescue OpenSSL::Cipher::CipherError
      raise CryptoError, 'decryption failed (wrong key, or the data was tampered with or moved)'
    end

    # ---------- files (§5) ----------

    def chunk_count(size)
      [1, (size + CHUNK - 1) / CHUNK].max
    end

    def chunk_iv(prefix, index)
      prefix + [index].pack('N')
    end

    def chunk_aad(index, last)
      "tailchat/v1|file|#{index}|#{last ? 1 : 0}"
    end

    # Streams `input` (anything with #read(n)) of `size` bytes into `output`
    # (anything with #write) as the encrypted blob. Returns the content's
    # `file` fields: {"key","prefix","size","sha256"} (add "id","name","mime").
    def encrypt_stream(input, output, size)
      key = random_bytes(32)
      prefix = random_bytes(8)
      count = chunk_count(size)
      digests = ''.b
      count.times do |i|
        want = i == count - 1 ? size - (i * CHUNK) : CHUNK
        plain = want.zero? ? ''.b : input.read(want).to_s.b
        raise Error, "file changed while encrypting (chunk #{i}: #{plain.bytesize} of #{want} bytes)" if plain.bytesize != want
        digests << sha256(plain)
        output.write(gcm_encrypt(key, chunk_iv(prefix, i), plain, chunk_aad(i, i == count - 1)))
      end
      { 'key' => b64u(key), 'prefix' => b64u(prefix), 'size' => size, 'sha256' => b64u(sha256(digests)) }
    end

    # In-memory variant: returns [blob, file_fields].
    def encrypt_file(bytes)
      out = StringIO.new(''.b)
      file = encrypt_stream(StringIO.new(bytes.b), out, bytes.bytesize)
      [out.string, file]
    end

    def decrypt_file(blob, file)
      out = StringIO.new(''.b)
      FileDecryptor.new(file, out).tap { |d| d << blob }.finish
      out.string
    end

    # Feed it the encrypted blob in pieces of any size; plaintext goes to
    # `output` one authenticated chunk at a time. #finish checks the length
    # and the chunked SHA-256, so a truncated or reordered blob always fails.
    class FileDecryptor
      attr_reader :bytes_written

      def initialize(file, output)
        file = file.transform_keys(&:to_s)
        @key = Crypto.unb64u(file['key'])
        @prefix = Crypto.unb64u(file['prefix'])
        @size = file['size']
        @sha256 = file['sha256']
        raise CryptoError, 'file key must be 32 bytes' unless @key.bytesize == 32
        raise CryptoError, 'file prefix must be 8 bytes' unless @prefix.bytesize == 8
        raise CryptoError, 'file size must be a non-negative integer' unless @size.is_a?(Integer) && @size >= 0
        @count = Crypto.chunk_count(@size)
        @expected = @size + (@count * TAG_LEN)
        @output = output
        @buffer = ''.b
        @received = 0
        @index = 0
        @digests = ''.b
        @bytes_written = 0
      end

      def <<(data)
        @received += data.bytesize
        raise CryptoError, 'Encrypted file has the wrong size' if @received > @expected
        @buffer << data.b
        # Every chunk but the last is exactly CHUNK + 16 bytes.
        while @index < @count - 1 && @buffer.bytesize >= CHUNK + TAG_LEN
          decrypt_chunk(@buffer.slice!(0, CHUNK + TAG_LEN), last: false)
        end
        self
      end

      def finish
        raise CryptoError, 'Encrypted file has the wrong size' unless @received == @expected
        decrypt_chunk(@buffer, last: true)
        @buffer = ''.b
        # sha256 is required (§5): without it a sender could hand different
        # recipients different files under one message.
        unless @sha256.is_a?(String) && OpenSSL.secure_compare(Crypto.b64u(Crypto.sha256(@digests)), @sha256)
          raise CryptoError, 'File checksum mismatch'
        end
        @bytes_written
      end

      private

      def decrypt_chunk(data, last:)
        plain = Crypto.gcm_decrypt(@key, Crypto.chunk_iv(@prefix, @index), data, Crypto.chunk_aad(@index, last))
        @digests << Crypto.sha256(plain)
        @output.write(plain) unless plain.empty?
        @bytes_written += plain.bytesize
        @index += 1
      end
    end

    # ---------- security code (§3) ----------

    def security_code(devices)
      digests = devices.map do |d|
        jwk = (d['publicKey'] || d[:publicKey]).transform_keys(&:to_s)
        b64u(sha256(unb64u(jwk['x']) + unb64u(jwk['y'])))
      end
      h = sha256(digests.sort.join.b).bytes
      Array.new(12) { |i| format('%05d', ((h[2 * i] << 16) | (h[(2 * i) + 1] << 8) | h[24 + (i % 8)]) % 100_000) }.join(' ')
    end
  end

  # A device's private key plus caches of peers' public keys and the derived
  # wrap keys (each costs an ECDH). Mirrors KeyRing in public/crypto.js.
  class KeyRing
    attr_reader :device_id

    # user_id: the tailnet user this device belongs to.
    # fetch_devices: ->(ids) { [{"id","userId","publicKey"}, …] } (GET /api/keys)
    def initialize(device_id:, private_key:, user_id: nil, fetch_devices: nil)
      @device_id = device_id
      @private_key = private_key
      @fetch_devices = fetch_devices
      @devices = {} # id -> {"userId", "key" => OpenSSL::PKey::EC}
      @wrap_keys = {}
      @lock = Mutex.new
      add_device('id' => device_id, 'userId' => user_id, 'publicKey' => Crypto.public_jwk(private_key))
    end

    def add_device(device)
      id = device['id']
      known = @lock.synchronize { @devices[id] }
      if known
        known['userId'] ||= device['userId']
        return
      end
      entry = { 'userId' => device['userId'], 'key' => Crypto.import_public_jwk(device['publicKey']) }
      @lock.synchronize { @devices[id] ||= entry }
    end

    def device(id)
      found = @lock.synchronize { @devices[id] }
      return found if found
      raise NoKeyError, "Unknown device #{id}" unless @fetch_devices
      @fetch_devices.call([id]).each { |d| add_device(d) }
      @lock.synchronize { @devices[id] } || raise(CryptoError, "Unknown device #{id}")
    end

    # The tailnet user a device id belongs to, as the server reported it.
    def device_user(id)
      device(id)['userId']
    end

    # sender|recipient always names the sender first, so both ends derive the same key.
    def wrap_key(sender_id, recipient_id)
      cache_key = "#{sender_id}|#{recipient_id}"
      cached = @lock.synchronize { @wrap_keys[cache_key] }
      return cached if cached
      peer = sender_id == @device_id ? recipient_id : sender_id
      key = Crypto.wrap_key(Crypto.ecdh(@private_key, device(peer)['key']), sender_id, recipient_id)
      @lock.synchronize { @wrap_keys[cache_key] = key }
    end

    # recipients: [{"id","publicKey",…}] - every device that may read it.
    # Returns the envelope as a JSON string (the message `payload`).
    def seal(content, aad, recipients)
      recipients.each { |d| add_device(d) }
      content_key = Crypto.random_bytes(32)
      iv = Crypto.random_bytes(12)
      ct = Crypto.gcm_encrypt(content_key, iv, JSON.generate(content), aad)
      ids = (recipients.map { |d| d['id'] } + [@device_id]).uniq
      keys = ids.to_h { |id| [id, Crypto.b64u(Crypto.aes_kw_wrap(wrap_key(@device_id, id), content_key))] }
      JSON.generate({ 'v' => 1, 'from' => @device_id, 'iv' => Crypto.b64u(iv), 'ct' => Crypto.b64u(ct), 'keys' => keys })
    end

    # Returns the decrypted content Hash. sender_id: the user the server says
    # sent it; the sealing device must be one of theirs, or the server is
    # relabelling messages (§3).
    def open(payload, aad, sender_id: nil)
      env = Envelope.parse(payload)
      if sender_id && (owner = device_user(env.from)) != sender_id
        raise CryptoError, "message was sealed by device #{env.from} of #{owner.inspect}, not by #{sender_id}"
      end
      wrapped = env.keys[@device_id] or raise NoKeyError, 'Not encrypted for this device'
      content_key = Crypto.aes_kw_unwrap(wrap_key(env.from, @device_id), Crypto.unb64u(wrapped))
      plain = Crypto.gcm_decrypt(content_key, env.iv, env.ct, aad).force_encoding(Encoding::UTF_8)
      raise CryptoError, 'content is not UTF-8' unless plain.valid_encoding?
      content = JSON.parse(plain)
      raise CryptoError, 'content must be a JSON object' unless content.is_a?(Hash)
      content
    rescue JSON::ParserError
      raise CryptoError, 'content is not JSON'
    end
  end

  # A parsed and shape-checked message envelope (PROTOCOL.md §3).
  Envelope = Struct.new(:from, :iv, :ct, :keys) do
    def self.parse(payload)
      env = payload.is_a?(String) ? JSON.parse(payload) : payload
      raise CryptoError, 'envelope must be a JSON object' unless env.is_a?(Hash)
      raise CryptoError, 'Unsupported envelope version' unless env['v'] == 1
      raise CryptoError, 'envelope has no sender' unless env['from'].is_a?(String) && !env['from'].empty?
      raise CryptoError, 'envelope keys must be an object' unless env['keys'].is_a?(Hash)
      iv = Crypto.unb64u(env['iv'])
      raise CryptoError, 'iv must be 12 bytes' unless iv.bytesize == 12
      new(env['from'], iv, Crypto.unb64u(env['ct']), env['keys'])
    rescue JSON::ParserError
      raise CryptoError, 'envelope is not JSON'
    end
  end
end
