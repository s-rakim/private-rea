# frozen_string_literal: true

require_relative 'test_helper'

# Offline tests of the primitives; interop with public/crypto.js is in interop_test.rb.
class CryptoTest < Minitest::Test
  C = Tailchat::Crypto

  def test_b64u_has_no_padding_and_round_trips
    [0, 1, 2, 3, 31, 32, 33].each do |n|
      bytes = C.random_bytes(n)
      text = C.b64u(bytes)
      refute_includes text, '='
      assert_match(/\A[A-Za-z0-9_-]*\z/, text)
      assert_equal bytes, C.unb64u(text)
    end
    assert_raises(Tailchat::CryptoError) { C.unb64u('ab+/') }
  end

  # RFC 3394 §4.6: 256 bits of key data with a 256-bit KEK.
  def test_aes_key_wrap_matches_rfc3394
    kek = [*0..31].pack('C*')
    data = ['00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F'].pack('H*')
    want = ['28C9F404C4B810F4CBCCB35CFB87F8263F5786E2D80ED326CBC7F0E71A99F43BFB988B9B7A02DD21'].pack('H*')
    assert_equal want, C.rfc3394_wrap(kek, data)
    assert_equal data, C.rfc3394_unwrap(kek, want)
    assert_equal want, C.aes_kw_wrap(kek, data)
    assert_equal data, C.aes_kw_unwrap(kek, want)
    tampered = want.dup
    tampered.setbyte(39, tampered.getbyte(39) ^ 1)
    assert_raises(Tailchat::CryptoError) { C.rfc3394_unwrap(kek, tampered) }
    assert_raises(Tailchat::CryptoError) { C.aes_kw_unwrap(kek, tampered) }
  end

  def test_ecdh_and_wrap_keys_agree_both_ways
    a = C.generate_key
    b = C.generate_key
    b_pub = C.import_public_jwk(C.public_jwk(b))
    a_pub = C.import_public_jwk(C.public_jwk(a))
    z = C.ecdh(a, b_pub)
    assert_equal 32, z.bytesize
    assert_equal z, C.ecdh(b, a_pub)
    assert_equal C.wrap_key(z, 'A', 'B'), C.wrap_key(C.ecdh(b, a_pub), 'A', 'B')
    refute_equal C.wrap_key(z, 'A', 'B'), C.wrap_key(z, 'B', 'A')
  end

  def test_public_jwk_shape_and_rejects_bad_points
    jwk = C.public_jwk(C.generate_key)
    assert_equal %w[kty crv x y], jwk.keys
    assert_equal 32, C.unb64u(jwk['x']).bytesize
    assert_raises(Tailchat::CryptoError) { C.import_public_jwk(jwk.merge('crv' => 'P-384')) }
    assert_raises(Tailchat::CryptoError) { C.import_public_jwk(jwk.merge('y' => C.b64u("\x01".b * 32))) }
  end

  def test_gcm_rejects_short_tags_and_handles_empty_plaintext
    key = C.random_bytes(32)
    iv = C.random_bytes(12)
    ct = C.gcm_encrypt(key, iv, '', 'aad')
    assert_equal 16, ct.bytesize
    assert_equal '', C.gcm_decrypt(key, iv, ct, 'aad')
    full = C.gcm_encrypt(key, iv, 'hello', 'aad')
    assert_raises(Tailchat::CryptoError) { C.gcm_decrypt(key, iv, full.byteslice(0, full.bytesize - 4), 'aad') }
    assert_raises(Tailchat::CryptoError) { C.gcm_decrypt(key, iv, full, 'other aad') }
  end

  def test_seal_and_open
    a = Tailchat::KeyRing.new(device_id: 'devA', private_key: C.generate_key)
    b_key = C.generate_key
    b = Tailchat::KeyRing.new(device_id: 'devB', private_key: b_key)
    b.add_device('id' => 'devA', 'publicKey' => C.public_jwk(a.instance_variable_get(:@private_key)))
    c = Tailchat::KeyRing.new(device_id: 'devC', private_key: C.generate_key)
    payload = a.seal({ 'type' => 'text', 'text' => 'héllo 👋' }, 'aad', [{ 'id' => 'devB', 'publicKey' => C.public_jwk(b_key) }])
    env = JSON.parse(payload)
    assert_equal 1, env['v']
    assert_equal %w[devB devA].sort, env['keys'].keys.sort
    assert_equal 40, C.unb64u(env['keys']['devB']).bytesize
    assert_equal 'héllo 👋', b.open(payload, 'aad')['text']
    assert_equal 'héllo 👋', a.open(payload, 'aad')['text'], 'the sender can read its own message'
    assert_raises(Tailchat::CryptoError) { b.open(payload, 'moved') }
    assert_raises(Tailchat::NoKeyError) { c.open(payload, 'aad') }
    b.add_device('id' => 'devA', 'userId' => 'alice')
    assert_equal 'héllo 👋', b.open(payload, 'aad', sender_id: 'alice')['text']
    assert_raises(Tailchat::CryptoError) { b.open(payload, 'aad', sender_id: 'mallory') }
    env['ct'] = C.b64u(C.unb64u(env['ct']).tap { |s| s.setbyte(0, s.getbyte(0) ^ 1) })
    assert_raises(Tailchat::CryptoError) { b.open(JSON.generate(env), 'aad') }
  end

  def test_file_chunks_at_the_boundaries
    [0, 1, C::CHUNK - 1, C::CHUNK, C::CHUNK + 1, (2 * C::CHUNK) + 17].each do |size|
      bytes = C.random_bytes(size)
      blob, file = C.encrypt_file(bytes)
      count = [1, (size + C::CHUNK - 1) / C::CHUNK].max
      assert_equal size + (16 * count), blob.bytesize, "size #{size}"
      assert_equal bytes, C.decrypt_file(blob, file), "size #{size}"
      # Streaming in odd-sized pieces gives the same result.
      out = StringIO.new(''.b)
      decryptor = C::FileDecryptor.new(file, out)
      blob.bytes.each_slice(333_333) { |piece| decryptor << piece.pack('C*') }
      decryptor.finish
      assert_equal bytes, out.string
    end
  end

  def test_file_tampering_is_detected
    bytes = C.random_bytes((2 * C::CHUNK) + 5)
    blob, file = C.encrypt_file(bytes)
    assert_raises(Tailchat::CryptoError) { C.decrypt_file(blob.byteslice(0, blob.bytesize - 1), file) }
    # Dropping the last chunk entirely (and lying about the size) fails on the last-chunk flag.
    two = blob.byteslice(0, 2 * (C::CHUNK + 16))
    digest = C.b64u(C.sha256(C.sha256(bytes.byteslice(0, C::CHUNK)) + C.sha256(bytes.byteslice(C::CHUNK, C::CHUNK))))
    error = assert_raises(Tailchat::CryptoError) { C.decrypt_file(two, file.merge('size' => 2 * C::CHUNK, 'sha256' => digest)) }
    assert_match(/decryption failed/, error.message)
    assert_raises(Tailchat::CryptoError) { C.decrypt_file(blob, file.merge('sha256' => nil)) }
    flipped = blob.dup
    flipped.setbyte(C::CHUNK + 20, flipped.getbyte(C::CHUNK + 20) ^ 0x80)
    assert_raises(Tailchat::CryptoError) { C.decrypt_file(flipped, file) }
    assert_raises(Tailchat::CryptoError) { C.decrypt_file(blob, file.merge('sha256' => C.b64u(C.random_bytes(32)))) }
  end

  def test_security_code_format_and_order_independence
    devices = Array.new(3) { |i| { 'id' => "d#{i}", 'publicKey' => C.public_jwk(C.generate_key) } }
    code = C.security_code(devices)
    assert_match(/\A(\d{5} ){11}\d{5}\z/, code)
    assert_equal code, C.security_code(devices.reverse)
  end

  def test_attachment_names_are_sanitised
    assert_equal 'evil.sh', Tailchat::Attachment.sanitize('../../etc/evil.sh')
    assert_equal 'x.txt', Tailchat::Attachment.sanitize('..\\..\\x.txt')
    assert_equal 'file', Tailchat::Attachment.sanitize('..')
    assert_equal 'file', Tailchat::Attachment.sanitize('')
    assert_equal 'a_b.txt', Tailchat::Attachment.sanitize("a\u0000\u0007|b.txt")
    assert_equal 'résumé 2024.pdf', Tailchat::Attachment.sanitize('résumé 2024.pdf')
    assert_operator Tailchat::Attachment.sanitize('é' * 200).bytesize, :<=, 120
  end
end
