// Offline tests for the crypto and JSON layers (known-answer vectors from the
// RFCs plus round trips and tamper checks). Interop with the JS web app is
// covered by interop.mjs.
#include <cstdio>
#include <cstring>
#include <functional>
#include <string>

#include "../src/client.hpp"
#include "../src/crypto.hpp"
#include "../src/json.hpp"

using namespace tc;

static int failures = 0, passes = 0;

#define CHECK(cond)                                                       \
  do {                                                                    \
    if (cond) {                                                           \
      ++passes;                                                           \
    } else {                                                              \
      ++failures;                                                         \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
    }                                                                     \
  } while (0)

template <class F>
static bool throws(F f) {
  try {
    f();
  } catch (const std::exception&) {
    return true;
  }
  return false;
}

static Bytes hex(const std::string& h) {
  Bytes out;
  for (size_t i = 0; i + 1 < h.size(); i += 2) out.push_back(static_cast<uint8_t>(std::stoul(h.substr(i, 2), nullptr, 16)));
  return out;
}

static std::string to_hex(const Bytes& b) {
  std::string s;
  char buf[3];
  for (uint8_t c : b) std::snprintf(buf, sizeof buf, "%02x", c), s += buf;
  return s;
}

static void test_base64url() {
  CHECK(b64u(to_bytes("")) == "");
  CHECK(b64u(to_bytes("f")) == "Zg");
  CHECK(b64u(to_bytes("fo")) == "Zm8");
  CHECK(b64u(to_bytes("foo")) == "Zm9v");
  CHECK(b64u(Bytes{0xfb, 0xff, 0xfe}) == "-__-");
  CHECK(unb64u("-__-") == (Bytes{0xfb, 0xff, 0xfe}));
  CHECK(unb64u("Zm8=") == to_bytes("fo"));
  CHECK(throws([] { unb64u("Z"); }));
  CHECK(throws([] { unb64u("Zm9v!"); }));
  for (size_t n = 0; n < 70; ++n) {
    Bytes r = random_bytes(n);
    CHECK(unb64u(b64u(r)) == r);
  }
}

static void test_aes_kw() {
  // RFC 3394 §4.6: 256 bits of key data with a 256-bit KEK.
  Bytes kek = hex("000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F");
  Bytes key = hex("00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F");
  Bytes wrapped = aes_kw_wrap(kek, key);
  CHECK(to_hex(wrapped) == "28c9f404c4b810f4cbccb35cfb87f8263f5786e2d80ed326cbc7f0e71a99f43bfb988b9b7a02dd21");
  CHECK(wrapped.size() == 40);
  CHECK(aes_kw_unwrap(kek, wrapped) == key);
  wrapped[5] ^= 1;
  CHECK(throws([&] { aes_kw_unwrap(kek, wrapped); }));
}

static void test_hkdf() {
  // RFC 5869 A.1
  Bytes ikm(22, 0x0b);
  Bytes salt = hex("000102030405060708090a0b0c");
  Bytes info = hex("f0f1f2f3f4f5f6f7f8f9");
  Bytes okm = hkdf_sha256(ikm, std::string(salt.begin(), salt.end()), std::string(info.begin(), info.end()), 42);
  CHECK(to_hex(okm) == "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
}

static void test_gcm() {
  // NIST GCM test case 13 (256-bit key, empty plaintext): tag only.
  Bytes key(32, 0), iv(12, 0);
  Bytes ct = gcm_encrypt(key, iv, "", nullptr, 0);
  CHECK(to_hex(ct) == "530f8afbc74536b9a963b4f1c4cb738b");
  // Test case 14: one zero block.
  Bytes pt(16, 0);
  ct = gcm_encrypt(key, iv, "", pt.data(), pt.size());
  CHECK(to_hex(ct) == "cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919");
  CHECK(gcm_decrypt(key, iv, "", ct.data(), ct.size()) == pt);
  CHECK(throws([&] { gcm_decrypt(key, iv, "other aad", ct.data(), ct.size()); }));
}

static void test_keys_and_ecdh() {
  DeviceKey a = DeviceKey::generate(), b = DeviceKey::generate();
  CHECK(unb64u(a.public_jwk().x).size() == 32);
  CHECK(unb64u(a.public_jwk().y).size() == 32);
  CHECK(unb64u(a.d()).size() == 32);
  DeviceKey a2 = DeviceKey::from_jwk(a.d(), a.public_jwk().x, a.public_jwk().y);
  PKey bPub = import_public_jwk(b.public_jwk().x, b.public_jwk().y);
  PKey aPub = import_public_jwk(a.public_jwk().x, a.public_jwk().y);
  Bytes k1 = derive_wrap_key(a2.pkey(), bPub.get(), "A", "B");
  Bytes k2 = derive_wrap_key(b.pkey(), aPub.get(), "A", "B");
  CHECK(k1 == k2);
  CHECK(k1.size() == 32);
  CHECK(derive_wrap_key(b.pkey(), aPub.get(), "B", "A") != k1);  // direction matters
  // A point that is not on the curve is rejected.
  Bytes y = unb64u(b.public_jwk().y);
  y[31] ^= 1;
  CHECK(throws([&] { import_public_jwk(b.public_jwk().x, b64u(y)); }));
  // A private key that doesn't match its public key is rejected.
  CHECK(throws([&] { DeviceKey::from_jwk(a.d(), b.public_jwk().x, b.public_jwk().y); }));
}

static void test_aads() {
  CHECK(chat_aad("c1", "m1") == "tailchat/v1|chat:c1|msg:m1");
  CHECK(status_aad("alice@dev") == "tailchat/v1|status:alice@dev");
  CHECK(chunk_aad(0, false) == "tailchat/v1|file|0|0");
  CHECK(chunk_aad(12, true) == "tailchat/v1|file|12|1");
  CHECK(to_hex(chunk_iv(hex("0102030405060708"), 0x01020304)) == "010203040506070801020304");
  CHECK(chunk_count(0) == 1);
  CHECK(chunk_count(1) == 1);
  CHECK(chunk_count(kChunk) == 1);
  CHECK(chunk_count(kChunk + 1) == 2);
  CHECK(encrypted_size(0) == 16);
  CHECK(encrypted_size(2 * kChunk + 5) == 2 * kChunk + 5 + 48);
}

struct Collected {
  Bytes data;
};
static void collect(void* u, const uint8_t* d, size_t n) {
  auto* c = static_cast<Collected*>(u);
  c->data.insert(c->data.end(), d, d + n);
}

static Bytes encrypt_whole(const Bytes& plain, FileEncryptor& enc) {
  Bytes blob, out(kChunk + kTag);
  size_t off = 0;
  for (uint64_t i = 0; i < enc.count(); ++i) {
    size_t len = enc.plain_len(i);
    size_t n = enc.next(plain.data() + off, len, out.data());
    blob.insert(blob.end(), out.begin(), out.begin() + n);
    off += len;
  }
  return blob;
}

static void test_file_chunks() {
  for (uint64_t size : {uint64_t(0), uint64_t(1), kChunk - 1, kChunk, kChunk + 1, 2 * kChunk + kChunk / 2 + 7}) {
    Bytes plain(size);
    for (size_t i = 0; i < size; ++i) plain[i] = static_cast<uint8_t>(i * 7);
    FileEncryptor enc(size);
    Bytes blob = encrypt_whole(plain, enc);
    std::string sha = enc.sha256_b64u();
    CHECK(blob.size() == encrypted_size(size));

    // Chunked digest = SHA-256 over the per-chunk SHA-256s.
    Sha256 outer;
    for (uint64_t i = 0; i < chunk_count(size); ++i) {
      size_t len = static_cast<size_t>(std::min<uint64_t>(kChunk, size - i * kChunk));
      auto d = sha256(plain.data() + i * kChunk, len);
      outer.update(d.data(), d.size());
    }
    auto h = outer.final();
    CHECK(sha == b64u(h.data(), h.size()));

    // Feed in awkward pieces.
    Collected c;
    FileDecryptor dec(enc.key(), enc.prefix(), size, sha, collect, &c);
    size_t off = 0, step = 1;
    while (off < blob.size()) {
      size_t n = std::min(step, blob.size() - off);
      dec.feed(blob.data() + off, n);
      off += n;
      step = step * 3 + 1;
    }
    dec.finish();
    CHECK(c.data == plain);

    // Truncation is detected (either a chunk fails or finish() complains).
    if (blob.size() > 1) {
      Collected t;
      CHECK(throws([&] {
        FileDecryptor d2(enc.key(), enc.prefix(), size, sha, collect, &t);
        d2.feed(blob.data(), blob.size() - 1);
        d2.finish();
      }));
    }
    // A flipped bit is detected.
    Bytes bad = blob;
    bad[bad.size() / 2] ^= 0x80;
    Collected t2;
    CHECK(throws([&] {
      FileDecryptor d3(enc.key(), enc.prefix(), size, sha, collect, &t2);
      d3.feed(bad.data(), bad.size());
      d3.finish();
    }));
    // Extra bytes are rejected.
    Bytes longer = blob;
    longer.push_back(0);
    Collected t3;
    CHECK(throws([&] {
      FileDecryptor d4(enc.key(), enc.prefix(), size, sha, collect, &t3);
      d4.feed(longer.data(), longer.size());
      d4.finish();
    }));
    // A wrong checksum is rejected.
    Collected t4;
    CHECK(throws([&] {
      FileDecryptor d5(enc.key(), enc.prefix(), size, "AAAA", collect, &t4);
      d5.feed(blob.data(), blob.size());
      d5.finish();
    }));
  }
  // Dropping the last chunk of a multi-chunk file: chunk 1 would need the
  // "last" AAD, so presenting a shorter file fails authentication.
  {
    uint64_t size = 2 * kChunk + 100;
    Bytes plain(size, 0x42);
    FileEncryptor enc(size);
    Bytes blob = encrypt_whole(plain, enc);
    Collected t;
    CHECK(throws([&] {
      FileDecryptor d(enc.key(), enc.prefix(), 2 * kChunk, "", collect, &t);
      d.feed(blob.data(), 2 * (kChunk + kTag));
      d.finish();
    }));
  }
}

static void test_json() {
  Json j = Json::parse(R"({"a":1,"b":[true,false,null],"c":"x\"\\\/\b\f\n\r\t\u00e9\ud83d\ude00","d":-0.5,"e":1e3})");
  CHECK(j["a"].as_int() == 1);
  CHECK(j["b"].size() == 3);
  CHECK(j["c"].as_string() == "x\"\\/\b\f\n\r\t\xC3\xA9\xF0\x9F\x98\x80");
  CHECK(j["e"].as_int() == 1000);
  // Matches JSON.stringify output.
  CHECK(j.dump() == "{\"a\":1,\"b\":[true,false,null],\"c\":\"x\\\"\\\\/\\b\\f\\n\\r\\t\xC3\xA9\xF0\x9F\x98\x80\",\"d\":-0.5,\"e\":1000}");
  Json o = Json::object();
  o.set("v", 1).set("s", std::string("\x01\x1f", 2)).set("n", static_cast<uint64_t>(3221225472ull));
  CHECK(o.dump() == "{\"v\":1,\"s\":\"\\u0001\\u001f\",\"n\":3221225472}");
  o.set("v", 2);
  CHECK(o.dump().rfind("{\"v\":2,", 0) == 0);  // set() keeps key position
  CHECK(throws([] { Json::parse("{\"a\":}"); }));
  CHECK(throws([] { Json::parse("[1,]"); }));
  CHECK(throws([] { Json::parse("{} x"); }));
  CHECK(Json::parse("\"\\ud800\"").as_string() == "\xEF\xBF\xBD");
  CHECK(sanitize_utf8("ok\xFF\xC3\xA9") == "ok\xEF\xBF\xBD\xC3\xA9");
}

static void test_names() {
  CHECK(safe_file_name("../../etc/passwd") == "passwd");
  CHECK(safe_file_name("a\\b\\c.txt") == "c.txt");
  CHECK(safe_file_name("..") == "download");
  CHECK(safe_file_name("") == "download");
  CHECK(safe_file_name("x\ny.bin") == "xy.bin");
  CHECK(guess_mime("/tmp/A.PNG") == "image/png");
  CHECK(guess_mime("/tmp.d/noext") == "application/octet-stream");
  CHECK(new_message_id().size() == 22);
}

int main() {
  test_base64url();
  test_aes_kw();
  test_hkdf();
  test_gcm();
  test_keys_and_ecdh();
  test_aads();
  test_file_chunks();
  test_json();
  test_names();
  std::printf("unit tests: %d passed, %d failed\n", passes, failures);
  return failures ? 1 : 0;
}
