#include "crypto.hpp"

#include <openssl/bn.h>
#include <openssl/core_names.h>
#include <openssl/err.h>
#include <openssl/kdf.h>
#include <openssl/param_build.h>
#include <openssl/rand.h>

#include <algorithm>
#include <cstdio>
#include <cstring>

namespace tc {

namespace {

[[noreturn]] void ossl_fail(const char* what) {
  unsigned long e = ERR_get_error();
  char buf[256] = "";
  if (e) ERR_error_string_n(e, buf, sizeof buf);
  ERR_clear_error();
  throw CryptoError(std::string(what) + (e ? std::string(": ") + buf : std::string()));
}

void check(int ok, const char* what) {
  if (ok != 1) ossl_fail(what);
}

using CipherCtx = std::unique_ptr<EVP_CIPHER_CTX, void (*)(EVP_CIPHER_CTX*)>;
CipherCtx new_cipher_ctx() {
  CipherCtx c(EVP_CIPHER_CTX_new(), EVP_CIPHER_CTX_free);
  if (!c) ossl_fail("EVP_CIPHER_CTX_new");
  return c;
}

void require_len(const Bytes& b, size_t n, const char* what) {
  if (b.size() != n) throw CryptoError(std::string(what) + " must be " + std::to_string(n) + " bytes");
}

}  // namespace

// ---------- base64url ----------

std::string b64u(const uint8_t* data, size_t len) {
  static const char* alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  std::string out;
  out.reserve((len + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 3 <= len; i += 3) {
    uint32_t v = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    out.push_back(alphabet[v >> 18]);
    out.push_back(alphabet[(v >> 12) & 63]);
    out.push_back(alphabet[(v >> 6) & 63]);
    out.push_back(alphabet[v & 63]);
  }
  if (len - i == 1) {
    uint32_t v = data[i] << 16;
    out.push_back(alphabet[v >> 18]);
    out.push_back(alphabet[(v >> 12) & 63]);
  } else if (len - i == 2) {
    uint32_t v = (data[i] << 16) | (data[i + 1] << 8);
    out.push_back(alphabet[v >> 18]);
    out.push_back(alphabet[(v >> 12) & 63]);
    out.push_back(alphabet[(v >> 6) & 63]);
  }
  return out;
}

Bytes unb64u(std::string_view text) {
  while (!text.empty() && text.back() == '=') text.remove_suffix(1);
  if (text.size() % 4 == 1) throw CryptoError("invalid base64url length");
  Bytes out;
  out.reserve(text.size() * 3 / 4);
  uint32_t acc = 0;
  int bits = 0;
  for (char c : text) {
    int v;
    if (c >= 'A' && c <= 'Z') v = c - 'A';
    else if (c >= 'a' && c <= 'z') v = c - 'a' + 26;
    else if (c >= '0' && c <= '9') v = c - '0' + 52;
    else if (c == '-' || c == '+') v = 62;  // atob() in the web app accepts both alphabets after its replace()
    else if (c == '_' || c == '/') v = 63;
    else throw CryptoError("invalid base64url character");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<uint8_t>(acc >> bits));
    }
  }
  return out;
}

Bytes random_bytes(size_t n) {
  Bytes b(n);
  if (n && RAND_bytes(b.data(), static_cast<int>(n)) != 1) ossl_fail("RAND_bytes");
  return b;
}

// ---------- hashing ----------

Sha256::Sha256() : ctx_(EVP_MD_CTX_new(), EVP_MD_CTX_free) {
  if (!ctx_) ossl_fail("EVP_MD_CTX_new");
  check(EVP_DigestInit_ex(ctx_.get(), EVP_sha256(), nullptr), "EVP_DigestInit_ex");
}

void Sha256::update(const uint8_t* data, size_t len) {
  check(EVP_DigestUpdate(ctx_.get(), data, len), "EVP_DigestUpdate");
}

std::array<uint8_t, 32> Sha256::final() {
  std::array<uint8_t, 32> out{};
  unsigned int n = 0;
  check(EVP_DigestFinal_ex(ctx_.get(), out.data(), &n), "EVP_DigestFinal_ex");
  return out;
}

std::array<uint8_t, 32> sha256(const uint8_t* data, size_t len) {
  Sha256 h;
  h.update(data, len);
  return h.final();
}

// ---------- KDF / key wrap / AEAD ----------

Bytes hkdf_sha256(const Bytes& ikm, std::string_view salt, std::string_view info, size_t length) {
  std::unique_ptr<EVP_KDF, void (*)(EVP_KDF*)> kdf(EVP_KDF_fetch(nullptr, "HKDF", nullptr), EVP_KDF_free);
  if (!kdf) ossl_fail("EVP_KDF_fetch(HKDF)");
  std::unique_ptr<EVP_KDF_CTX, void (*)(EVP_KDF_CTX*)> ctx(EVP_KDF_CTX_new(kdf.get()), EVP_KDF_CTX_free);
  if (!ctx) ossl_fail("EVP_KDF_CTX_new");
  char digest[] = "SHA256";
  OSSL_PARAM params[] = {
      OSSL_PARAM_construct_utf8_string(OSSL_KDF_PARAM_DIGEST, digest, 0),
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_KEY, const_cast<uint8_t*>(ikm.data()), ikm.size()),
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_SALT, const_cast<char*>(salt.data()), salt.size()),
      OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_INFO, const_cast<char*>(info.data()), info.size()),
      OSSL_PARAM_construct_end(),
  };
  Bytes out(length);
  check(EVP_KDF_derive(ctx.get(), out.data(), out.size(), params), "HKDF derive");
  return out;
}

static Bytes aes_kw(const Bytes& kek, const Bytes& in, bool wrap) {
  require_len(kek, 32, "AES-KW key");
  if (in.size() % 8 || in.size() < (wrap ? 16u : 24u)) throw CryptoError("AES-KW input has a bad length");
  auto ctx = new_cipher_ctx();
  EVP_CIPHER_CTX_set_flags(ctx.get(), EVP_CIPHER_CTX_FLAG_WRAP_ALLOW);
  check(EVP_CipherInit_ex(ctx.get(), EVP_aes_256_wrap(), nullptr, kek.data(), nullptr, wrap ? 1 : 0), "AES-KW init");
  Bytes out(in.size() + 8);
  int n = 0, m = 0;
  if (EVP_CipherUpdate(ctx.get(), out.data(), &n, in.data(), static_cast<int>(in.size())) != 1 || n <= 0) {
    ERR_clear_error();
    throw CryptoError(wrap ? "AES-KW wrap failed" : "AES-KW unwrap failed (wrong key or corrupted)");
  }
  if (EVP_CipherFinal_ex(ctx.get(), out.data() + n, &m) != 1) ossl_fail("AES-KW final");
  out.resize(n + m);
  return out;
}

Bytes aes_kw_wrap(const Bytes& kek, const Bytes& key) { return aes_kw(kek, key, true); }
Bytes aes_kw_unwrap(const Bytes& kek, const Bytes& wrapped) { return aes_kw(kek, wrapped, false); }

Bytes gcm_encrypt(const Bytes& key, const Bytes& iv, std::string_view aad, const uint8_t* pt, size_t len) {
  require_len(key, 32, "AES-GCM key");
  require_len(iv, 12, "AES-GCM iv");
  auto ctx = new_cipher_ctx();
  check(EVP_EncryptInit_ex(ctx.get(), EVP_aes_256_gcm(), nullptr, key.data(), iv.data()), "GCM init");
  int n = 0;
  if (!aad.empty())
    check(EVP_EncryptUpdate(ctx.get(), nullptr, &n, reinterpret_cast<const uint8_t*>(aad.data()),
                            static_cast<int>(aad.size())),
          "GCM aad");
  Bytes out(len + kTag);
  int total = 0;
  if (len) {
    check(EVP_EncryptUpdate(ctx.get(), out.data(), &n, pt, static_cast<int>(len)), "GCM encrypt");
    total = n;
  }
  check(EVP_EncryptFinal_ex(ctx.get(), out.data() + total, &n), "GCM final");
  total += n;
  check(EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_GET_TAG, kTag, out.data() + total), "GCM tag");
  out.resize(total + kTag);
  return out;
}

Bytes gcm_decrypt(const Bytes& key, const Bytes& iv, std::string_view aad, const uint8_t* ct, size_t len) {
  require_len(key, 32, "AES-GCM key");
  require_len(iv, 12, "AES-GCM iv");
  if (len < kTag) throw CryptoError("ciphertext too short");
  auto ctx = new_cipher_ctx();
  check(EVP_DecryptInit_ex(ctx.get(), EVP_aes_256_gcm(), nullptr, key.data(), iv.data()), "GCM init");
  int n = 0;
  if (!aad.empty())
    check(EVP_DecryptUpdate(ctx.get(), nullptr, &n, reinterpret_cast<const uint8_t*>(aad.data()),
                            static_cast<int>(aad.size())),
          "GCM aad");
  size_t body = len - kTag;
  Bytes out(body);
  int total = 0;
  if (body) {
    check(EVP_DecryptUpdate(ctx.get(), out.data(), &n, ct, static_cast<int>(body)), "GCM decrypt");
    total = n;
  }
  check(EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_SET_TAG, kTag, const_cast<uint8_t*>(ct + body)), "GCM tag");
  if (EVP_DecryptFinal_ex(ctx.get(), out.data() + total, &n) != 1) {
    ERR_clear_error();
    throw CryptoError("decryption failed: message was tampered with or not meant for this context");
  }
  out.resize(total + n);
  return out;
}

// ---------- P-256 device keys ----------

namespace {

PKey pkey_from_parts(const Bytes& x, const Bytes& y, const Bytes* d) {
  require_len(x, 32, "JWK x");
  require_len(y, 32, "JWK y");
  Bytes point(65);
  point[0] = 0x04;
  std::copy(x.begin(), x.end(), point.begin() + 1);
  std::copy(y.begin(), y.end(), point.begin() + 33);

  std::unique_ptr<OSSL_PARAM_BLD, void (*)(OSSL_PARAM_BLD*)> bld(OSSL_PARAM_BLD_new(), OSSL_PARAM_BLD_free);
  std::unique_ptr<BIGNUM, void (*)(BIGNUM*)> priv(nullptr, BN_clear_free);
  if (!bld) ossl_fail("OSSL_PARAM_BLD_new");
  check(OSSL_PARAM_BLD_push_utf8_string(bld.get(), OSSL_PKEY_PARAM_GROUP_NAME, "prime256v1", 0), "param group");
  check(OSSL_PARAM_BLD_push_octet_string(bld.get(), OSSL_PKEY_PARAM_PUB_KEY, point.data(), point.size()),
        "param pub");
  if (d) {
    require_len(*d, 32, "JWK d");
    priv.reset(BN_bin2bn(d->data(), 32, nullptr));
    if (!priv) ossl_fail("BN_bin2bn");
    check(OSSL_PARAM_BLD_push_BN(bld.get(), OSSL_PKEY_PARAM_PRIV_KEY, priv.get()), "param priv");
  }
  std::unique_ptr<OSSL_PARAM, void (*)(OSSL_PARAM*)> params(OSSL_PARAM_BLD_to_param(bld.get()), OSSL_PARAM_free);
  if (!params) ossl_fail("OSSL_PARAM_BLD_to_param");

  std::unique_ptr<EVP_PKEY_CTX, void (*)(EVP_PKEY_CTX*)> ctx(EVP_PKEY_CTX_new_from_name(nullptr, "EC", nullptr),
                                                             EVP_PKEY_CTX_free);
  if (!ctx) ossl_fail("EVP_PKEY_CTX_new_from_name");
  check(EVP_PKEY_fromdata_init(ctx.get()), "fromdata init");
  EVP_PKEY* raw = nullptr;
  check(EVP_PKEY_fromdata(ctx.get(), &raw, d ? EVP_PKEY_KEYPAIR : EVP_PKEY_PUBLIC_KEY, params.get()),
        "EC key import");
  PKey key(raw, EVP_PKEY_free);

  // Reject points that are not on the curve (invalid-curve attacks) and, for a
  // key pair, a private scalar that doesn't match the public point.
  std::unique_ptr<EVP_PKEY_CTX, void (*)(EVP_PKEY_CTX*)> vctx(EVP_PKEY_CTX_new_from_pkey(nullptr, key.get(), nullptr),
                                                              EVP_PKEY_CTX_free);
  if (!vctx) ossl_fail("EVP_PKEY_CTX_new_from_pkey");
  if (EVP_PKEY_public_check(vctx.get()) != 1) ossl_fail("invalid P-256 public key");
  if (d && EVP_PKEY_pairwise_check(vctx.get()) != 1) ossl_fail("private key does not match public key");
  return key;
}

}  // namespace

DeviceKey DeviceKey::generate() {
  DeviceKey k;
  EVP_PKEY* raw = EVP_PKEY_Q_keygen(nullptr, nullptr, "EC", "P-256");
  if (!raw) ossl_fail("EC key generation");
  k.pkey_.reset(raw);

  uint8_t point[65];
  size_t plen = 0;
  check(EVP_PKEY_get_octet_string_param(raw, OSSL_PKEY_PARAM_PUB_KEY, point, sizeof point, &plen), "export pub");
  if (plen != 65 || point[0] != 0x04) throw CryptoError("unexpected public key encoding");
  k.pub_.x = b64u(point + 1, 32);
  k.pub_.y = b64u(point + 33, 32);

  BIGNUM* d = nullptr;
  check(EVP_PKEY_get_bn_param(raw, OSSL_PKEY_PARAM_PRIV_KEY, &d), "export priv");
  uint8_t dbytes[32];
  int ok = BN_bn2binpad(d, dbytes, 32);
  BN_clear_free(d);
  if (ok != 32) throw CryptoError("BN_bn2binpad");
  k.d_ = b64u(dbytes, 32);
  OPENSSL_cleanse(dbytes, sizeof dbytes);
  return k;
}

DeviceKey DeviceKey::from_jwk(const std::string& d, const std::string& x, const std::string& y) {
  DeviceKey k;
  Bytes db = unb64u(d);
  k.pkey_ = pkey_from_parts(unb64u(x), unb64u(y), &db);
  OPENSSL_cleanse(db.data(), db.size());
  k.pub_ = {x, y};
  k.d_ = d;
  return k;
}

PKey import_public_jwk(const std::string& x, const std::string& y) { return pkey_from_parts(unb64u(x), unb64u(y), nullptr); }

Bytes ecdh(EVP_PKEY* priv, EVP_PKEY* peer) {
  std::unique_ptr<EVP_PKEY_CTX, void (*)(EVP_PKEY_CTX*)> ctx(EVP_PKEY_CTX_new_from_pkey(nullptr, priv, nullptr),
                                                             EVP_PKEY_CTX_free);
  if (!ctx) ossl_fail("EVP_PKEY_CTX_new_from_pkey");
  check(EVP_PKEY_derive_init(ctx.get()), "ECDH init");
  check(EVP_PKEY_derive_set_peer(ctx.get(), peer), "ECDH peer");
  size_t len = 0;
  check(EVP_PKEY_derive(ctx.get(), nullptr, &len), "ECDH size");
  Bytes z(len);
  check(EVP_PKEY_derive(ctx.get(), z.data(), &len), "ECDH derive");
  z.resize(len);
  if (z.size() != 32) throw CryptoError("unexpected ECDH secret length");
  return z;
}

Bytes derive_wrap_key(EVP_PKEY* priv, EVP_PKEY* peer, const std::string& senderId, const std::string& recipientId) {
  Bytes z = ecdh(priv, peer);
  Bytes k = hkdf_sha256(z, "tailchat/v1/wrap", senderId + "|" + recipientId, 32);
  OPENSSL_cleanse(z.data(), z.size());
  return k;
}

std::string chat_aad(const std::string& chatId, const std::string& messageId) {
  return "tailchat/v1|chat:" + chatId + "|msg:" + messageId;
}

std::string status_aad(const std::string& userId) { return "tailchat/v1|status:" + userId; }

std::string security_code(const std::vector<PublicJwk>& keys) {
  std::vector<std::string> digests;
  for (const auto& k : keys) {
    Bytes raw = unb64u(k.x);
    Bytes y = unb64u(k.y);
    raw.insert(raw.end(), y.begin(), y.end());
    auto d = sha256(raw.data(), raw.size());
    digests.push_back(b64u(d.data(), d.size()));
  }
  std::sort(digests.begin(), digests.end());
  std::string joined;
  for (const auto& d : digests) joined += d;
  auto h = sha256(reinterpret_cast<const uint8_t*>(joined.data()), joined.size());
  std::string code;
  for (int i = 0; i < 12; ++i) {
    uint32_t n = ((uint32_t(h[2 * i]) << 16) | (uint32_t(h[2 * i + 1]) << 8) | h[24 + (i % 8)]) % 100000;
    char buf[8];
    std::snprintf(buf, sizeof buf, "%05u", n);
    if (i) code.push_back(' ');
    code += buf;
  }
  return code;
}

// ---------- §5 chunked files ----------

uint64_t chunk_count(uint64_t size) { return size == 0 ? 1 : (size + kChunk - 1) / kChunk; }
uint64_t encrypted_size(uint64_t size) { return size + kTag * chunk_count(size); }

Bytes chunk_iv(const Bytes& prefix, uint32_t i) {
  require_len(prefix, 8, "file prefix");
  Bytes iv(prefix);
  iv.push_back(static_cast<uint8_t>(i >> 24));
  iv.push_back(static_cast<uint8_t>(i >> 16));
  iv.push_back(static_cast<uint8_t>(i >> 8));
  iv.push_back(static_cast<uint8_t>(i));
  return iv;
}

std::string chunk_aad(uint64_t i, bool last) { return "tailchat/v1|file|" + std::to_string(i) + "|" + (last ? "1" : "0"); }

ChunkCipher::ChunkCipher(const Bytes& key, const Bytes& prefix, uint64_t plainSize)
    : ctx_(EVP_CIPHER_CTX_new()), key_(key), prefix_(prefix), size_(plainSize), count_(chunk_count(plainSize)) {
  if (!ctx_) ossl_fail("EVP_CIPHER_CTX_new");
  require_len(key_, 32, "file key");
  require_len(prefix_, 8, "file prefix");
  if (count_ > 0xFFFFFFFFull) throw CryptoError("file too large for a 32-bit chunk counter");
}

ChunkCipher::~ChunkCipher() {
  EVP_CIPHER_CTX_free(ctx_);
  OPENSSL_cleanse(key_.data(), key_.size());
}

size_t ChunkCipher::plain_len(uint64_t i) const {
  if (i + 1 < count_) return kChunk;
  return static_cast<size_t>(size_ - (count_ - 1) * kChunk);
}

void ChunkCipher::encrypt(uint64_t i, const uint8_t* pt, size_t len, uint8_t* out) {
  Bytes iv = chunk_iv(prefix_, static_cast<uint32_t>(i));
  std::string aad = chunk_aad(i, i + 1 == count_);
  int n = 0;
  check(EVP_EncryptInit_ex(ctx_, EVP_aes_256_gcm(), nullptr, key_.data(), iv.data()), "GCM init");
  check(EVP_EncryptUpdate(ctx_, nullptr, &n, reinterpret_cast<const uint8_t*>(aad.data()), static_cast<int>(aad.size())),
        "GCM aad");
  size_t total = 0;
  if (len) {
    check(EVP_EncryptUpdate(ctx_, out, &n, pt, static_cast<int>(len)), "GCM encrypt");
    total = n;
  }
  check(EVP_EncryptFinal_ex(ctx_, out + total, &n), "GCM final");
  total += n;
  if (total != len) throw CryptoError("GCM produced an unexpected length");
  check(EVP_CIPHER_CTX_ctrl(ctx_, EVP_CTRL_GCM_GET_TAG, kTag, out + total), "GCM tag");
}

void ChunkCipher::decrypt(uint64_t i, const uint8_t* ct, size_t len, uint8_t* out) {
  if (len < kTag) throw CryptoError("encrypted chunk too short");
  Bytes iv = chunk_iv(prefix_, static_cast<uint32_t>(i));
  std::string aad = chunk_aad(i, i + 1 == count_);
  int n = 0;
  check(EVP_DecryptInit_ex(ctx_, EVP_aes_256_gcm(), nullptr, key_.data(), iv.data()), "GCM init");
  check(EVP_DecryptUpdate(ctx_, nullptr, &n, reinterpret_cast<const uint8_t*>(aad.data()), static_cast<int>(aad.size())),
        "GCM aad");
  size_t body = len - kTag, total = 0;
  if (body) {
    check(EVP_DecryptUpdate(ctx_, out, &n, ct, static_cast<int>(body)), "GCM decrypt");
    total = n;
  }
  check(EVP_CIPHER_CTX_ctrl(ctx_, EVP_CTRL_GCM_SET_TAG, kTag, const_cast<uint8_t*>(ct + body)), "GCM tag");
  if (EVP_DecryptFinal_ex(ctx_, out + total, &n) != 1) {
    ERR_clear_error();
    throw CryptoError("chunk " + std::to_string(i) + " failed authentication (corrupted, reordered or truncated file)");
  }
}

FileEncryptor::FileEncryptor(uint64_t plainSize)
    : key_(random_bytes(32)), prefix_(random_bytes(8)), cipher_(key_, prefix_, plainSize) {}

size_t FileEncryptor::next(const uint8_t* pt, size_t len, uint8_t* out) {
  if (done()) throw CryptoError("all chunks already encrypted");
  if (len != cipher_.plain_len(next_)) throw CryptoError("chunk has the wrong length");
  auto d = sha256(pt, len);
  digests_.update(d.data(), d.size());
  cipher_.encrypt(next_, pt, len, out);
  ++next_;
  return len + kTag;
}

std::string FileEncryptor::sha256_b64u() {
  if (!done()) throw CryptoError("file not fully encrypted");
  auto h = digests_.final();
  return b64u(h.data(), h.size());
}

FileDecryptor::FileDecryptor(const Bytes& key, const Bytes& prefix, uint64_t plainSize, std::string expectedSha256,
                             Sink sink, void* user)
    : cipher_(key, prefix, plainSize), expected_(std::move(expectedSha256)), sink_(sink), user_(user) {
  buf_.resize(kChunk + kTag);
  plain_.resize(kChunk);
}

void FileDecryptor::flush_chunk() {
  size_t plen = cipher_.plain_len(next_);
  cipher_.decrypt(next_, buf_.data(), plen + kTag, plain_.data());
  auto d = sha256(plain_.data(), plen);
  digests_.update(d.data(), d.size());
  sink_(user_, plain_.data(), plen);
  ++next_;
  have_ = 0;
}

void FileDecryptor::feed(const uint8_t* data, size_t len) {
  received_ += len;
  while (len) {
    if (next_ >= cipher_.count()) throw CryptoError("encrypted file is longer than expected");
    size_t want = cipher_.plain_len(next_) + kTag;
    size_t take = std::min(len, want - have_);
    std::memcpy(buf_.data() + have_, data, take);
    have_ += take;
    data += take;
    len -= take;
    if (have_ == want) flush_chunk();
  }
}

void FileDecryptor::finish() {
  // An empty file is a single empty chunk: 16 bytes of tag.
  if (next_ != cipher_.count() || have_ != 0)
    throw CryptoError("encrypted file was truncated (" + std::to_string(received_) + " of " +
                      std::to_string(encrypted_size(cipher_.size())) + " bytes)");
  auto h = digests_.final();
  if (!expected_.empty() && b64u(h.data(), h.size()) != expected_) throw CryptoError("file checksum mismatch");
}

}  // namespace tc
