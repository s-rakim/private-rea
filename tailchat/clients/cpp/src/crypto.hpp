// Tailchat end-to-end encryption (PROTOCOL.md §2-5) on OpenSSL 3 EVP.
// Mirrors public/crypto.js in the web app.
#pragma once

#include <openssl/evp.h>

#include <array>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace tc {

using Bytes = std::vector<uint8_t>;

class CryptoError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

constexpr uint64_t kChunk = 1024 * 1024;  // §5: 1 MiB plaintext chunks
constexpr size_t kTag = 16;

// ---------- encoding / primitives ----------

std::string b64u(const uint8_t* data, size_t len);
inline std::string b64u(const Bytes& b) { return b64u(b.data(), b.size()); }
Bytes unb64u(std::string_view text);  // throws CryptoError on bad input

Bytes random_bytes(size_t n);
inline Bytes to_bytes(std::string_view s) { return Bytes(s.begin(), s.end()); }

class Sha256 {
 public:
  Sha256();
  void update(const uint8_t* data, size_t len);
  std::array<uint8_t, 32> final();

 private:
  std::unique_ptr<EVP_MD_CTX, void (*)(EVP_MD_CTX*)> ctx_;
};
std::array<uint8_t, 32> sha256(const uint8_t* data, size_t len);

Bytes hkdf_sha256(const Bytes& ikm, std::string_view salt, std::string_view info, size_t length);
Bytes aes_kw_wrap(const Bytes& kek, const Bytes& key);        // RFC 3394
Bytes aes_kw_unwrap(const Bytes& kek, const Bytes& wrapped);  // throws on integrity failure
Bytes gcm_encrypt(const Bytes& key, const Bytes& iv, std::string_view aad, const uint8_t* pt, size_t len);
Bytes gcm_decrypt(const Bytes& key, const Bytes& iv, std::string_view aad, const uint8_t* ct, size_t len);

// ---------- device keys ----------

using PKey = std::unique_ptr<EVP_PKEY, void (*)(EVP_PKEY*)>;

struct PublicJwk {
  std::string x, y;  // base64url of the 32-byte big-endian coordinates
};

class DeviceKey {
 public:
  static DeviceKey generate();
  static DeviceKey from_jwk(const std::string& d, const std::string& x, const std::string& y);

  const PublicJwk& public_jwk() const { return pub_; }
  const std::string& d() const { return d_; }
  EVP_PKEY* pkey() const { return pkey_.get(); }

 private:
  DeviceKey() : pkey_(nullptr, EVP_PKEY_free) {}
  PKey pkey_;
  PublicJwk pub_;
  std::string d_;
};

// Imports and validates (point on curve) a peer's public JWK.
PKey import_public_jwk(const std::string& x, const std::string& y);
// Raw ECDH shared secret: the 32-byte x coordinate.
Bytes ecdh(EVP_PKEY* priv, EVP_PKEY* peer);
// §2: HKDF-SHA256(Z, "tailchat/v1/wrap", sender|recipient).
Bytes derive_wrap_key(EVP_PKEY* priv, EVP_PKEY* peer, const std::string& senderId, const std::string& recipientId);

// §3 AAD strings.
std::string chat_aad(const std::string& chatId, const std::string& messageId);
std::string status_aad(const std::string& userId);

// §3 security code over a set of public keys.
std::string security_code(const std::vector<PublicJwk>& keys);

// ---------- §5 chunked file encryption ----------

uint64_t chunk_count(uint64_t size);
uint64_t encrypted_size(uint64_t size);
Bytes chunk_iv(const Bytes& prefix, uint32_t i);
std::string chunk_aad(uint64_t i, bool last);

// Reusable AES-256-GCM context for many chunks under one key.
class ChunkCipher {
 public:
  ChunkCipher(const Bytes& key, const Bytes& prefix, uint64_t plainSize);
  ~ChunkCipher();
  ChunkCipher(const ChunkCipher&) = delete;
  ChunkCipher& operator=(const ChunkCipher&) = delete;

  uint64_t count() const { return count_; }
  uint64_t size() const { return size_; }
  // Plaintext length of chunk i.
  size_t plain_len(uint64_t i) const;

  // out must hold len + 16 bytes.
  void encrypt(uint64_t i, const uint8_t* pt, size_t len, uint8_t* out);
  // out must hold len - 16 bytes. Throws CryptoError if authentication fails.
  void decrypt(uint64_t i, const uint8_t* ct, size_t len, uint8_t* out);

 private:
  EVP_CIPHER_CTX* ctx_;
  Bytes key_, prefix_;
  uint64_t size_, count_;
};

// Streaming encryptor: feed whole plaintext chunks in order, get ciphertext
// chunks; computes the chunked sha256 as it goes.
class FileEncryptor {
 public:
  explicit FileEncryptor(uint64_t plainSize);
  const Bytes& key() const { return key_; }
  const Bytes& prefix() const { return prefix_; }
  uint64_t count() const { return cipher_.count(); }
  size_t plain_len(uint64_t i) const { return cipher_.plain_len(i); }
  // Encrypts the next chunk (must be exactly plain_len(next) bytes) into out.
  // Returns the ciphertext length (len + 16).
  size_t next(const uint8_t* pt, size_t len, uint8_t* out);
  bool done() const { return next_ == cipher_.count(); }
  std::string sha256_b64u();  // after done()

 private:
  Bytes key_, prefix_;
  ChunkCipher cipher_;
  uint64_t next_ = 0;
  Sha256 digests_;
};

// Streaming decryptor: feed the encrypted blob in arbitrary pieces; whole
// verified plaintext chunks are passed to the sink.
class FileDecryptor {
 public:
  using Sink = void (*)(void* user, const uint8_t* data, size_t len);
  FileDecryptor(const Bytes& key, const Bytes& prefix, uint64_t plainSize, std::string expectedSha256, Sink sink,
                void* user);
  void feed(const uint8_t* data, size_t len);
  // Throws unless every chunk arrived and the chunked sha256 matches.
  void finish();
  uint64_t received() const { return received_; }

 private:
  ChunkCipher cipher_;
  std::string expected_;
  Sink sink_;
  void* user_;
  Bytes buf_, plain_;
  size_t have_ = 0;
  uint64_t next_ = 0, received_ = 0;
  Sha256 digests_;
  void flush_chunk();
};

}  // namespace tc
