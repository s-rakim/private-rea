#include "client.hpp"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstring>
#include <fstream>
#include <set>
#include <sstream>

namespace tc {

namespace {

[[noreturn]] void sys_fail(const std::string& what) { throw std::runtime_error(what + ": " + std::strerror(errno)); }

std::string read_file(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return {};
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

void mkdirs(const std::string& dir, mode_t mode) {
  if (dir.empty()) return;
  std::string cur;
  size_t pos = 0;
  while (pos != std::string::npos) {
    pos = dir.find('/', pos + 1);
    cur = dir.substr(0, pos);
    if (cur.empty()) continue;
    if (::mkdir(cur.c_str(), mode) != 0 && errno != EEXIST) sys_fail("mkdir " + cur);
  }
}

std::string dirname_of(const std::string& path) {
  auto slash = path.rfind('/');
  return slash == std::string::npos ? "" : path.substr(0, slash);
}

void write_all(int fd, const uint8_t* data, size_t len, const std::string& what) {
  while (len) {
    ssize_t n = ::write(fd, data, len);
    if (n < 0) {
      if (errno == EINTR) continue;
      sys_fail("write " + what);
    }
    data += n;
    len -= static_cast<size_t>(n);
  }
}

// Atomically replaces `path` with `text`, readable by the owner only.
void write_private(const std::string& path, const std::string& text) {
  mkdirs(dirname_of(path), 0700);
  std::string tmp = path + ".tmp";
  ::unlink(tmp.c_str());
  int fd = ::open(tmp.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (fd < 0) sys_fail("create " + tmp);
  try {
    write_all(fd, reinterpret_cast<const uint8_t*>(text.data()), text.size(), tmp);
    if (::fchmod(fd, 0600) != 0 || ::fsync(fd) != 0) sys_fail("sync " + tmp);
  } catch (...) {
    ::close(fd);
    ::unlink(tmp.c_str());
    throw;
  }
  ::close(fd);
  if (::rename(tmp.c_str(), path.c_str()) != 0) sys_fail("rename " + tmp);
}

Json load_state(const std::string& path) {
  struct stat st {};
  if (::stat(path.c_str(), &st) != 0) return Json::object();
  if (st.st_mode & 077) {
    // The file holds a private key: tighten permissions that were loosened.
    ::chmod(path.c_str(), 0600);
  }
  std::string text = read_file(path);
  if (text.empty()) return Json::object();
  Json j = Json::parse(text);
  if (!j.is_object()) throw std::runtime_error("state file " + path + " is not a JSON object");
  return j;
}

}  // namespace

std::string new_message_id() { return b64u(random_bytes(16)); }

Client::Client(ClientOptions opts)
    : opts_(std::move(opts)), http_(Http::Options{opts_.server, opts_.devUser, opts_.caFile, opts_.verbose}) {}

std::string Client::profile_key() const {
  // One device per server and (in dev mode) per dev user.
  std::string server = opts_.server;
  while (!server.empty() && server.back() == '/') server.pop_back();
  return server + "|" + opts_.devUser;
}

void Client::ensure_device(bool force) {
  Json state = load_state(opts_.statePath);
  const Json& prof = state["profiles"][profile_key()];
  if (!force && prof.is_object() && prof["key"].is_object()) {
    const Json& k = prof["key"];
    key_.emplace(DeviceKey::from_jwk(k.str("d"), k.str("x"), k.str("y")));
    deviceId_ = prof.str("deviceId");
    userId_ = prof.str("userId");
    http_.set_token(prof.str("token"));
    return;
  }

  DeviceKey key = DeviceKey::generate();
  Json jwk = Json::object();
  jwk.set("kty", "EC").set("crv", "P-256").set("x", key.public_jwk().x).set("y", key.public_jwk().y);
  Json body = Json::object();
  body.set("name", opts_.deviceName).set("publicKey", jwk);
  http_.set_token("");
  Json reg = http_.call("POST", "/api/devices", &body);
  std::string token = reg.str("token");
  deviceId_ = reg["device"].str("id");
  userId_ = reg["device"].str("userId");
  if (token.empty() || deviceId_.empty()) throw ApiError(0, "device registration returned no token");

  Json saved = Json::object();
  Json priv = jwk;
  priv.set("d", key.d());
  saved.set("server", http_.base())
      .set("devUser", opts_.devUser)
      .set("userId", userId_)
      .set("deviceId", deviceId_)
      .set("token", token)
      .set("key", priv);
  Json profiles = state["profiles"].is_object() ? state["profiles"] : Json::object();
  profiles.set(profile_key(), saved);
  state.set("profiles", profiles);
  write_private(opts_.statePath, state.dump());

  http_.set_token(token);
  key_.emplace(std::move(key));
}

Json Client::me() { return http_.call("GET", "/api/me"); }

std::string Client::resolve_chat(const std::string& chatOrUser) {
  if (chatOrUser.find('@') == std::string::npos) return chatOrUser;
  Json body = Json::object();
  body.set("userId", chatOrUser);
  Json r = http_.call("POST", "/api/chats/direct", &body);
  return r["chat"].str("id");
}

// ---------- key ring ----------

void Client::add_public_key(const std::string& deviceId, const Json& jwk, const std::string& userId) {
  if (!userId.empty()) {
    auto [it, fresh] = owners_.emplace(deviceId, userId);
    if (!fresh && it->second != userId)
      throw CryptoError("the server now says device " + deviceId + " belongs to " + userId + ", not " + it->second);
  }
  if (publicKeys_.count(deviceId)) return;
  if (jwk.str("kty") != "EC" || jwk.str("crv") != "P-256") throw CryptoError("device " + deviceId + " has a non-P-256 key");
  publicKeys_.emplace(deviceId, import_public_jwk(jwk.str("x"), jwk.str("y")));
}

EVP_PKEY* Client::public_key(const std::string& deviceId) {
  auto it = publicKeys_.find(deviceId);
  if (it == publicKeys_.end() || !owners_.count(deviceId)) {
    Json r = http_.call("GET", "/api/keys?ids=" + url_encode(deviceId));
    for (const auto& d : r["devices"].items())
      if (d.str("id") == deviceId) add_public_key(d.str("id"), d["publicKey"], d.str("userId"));
    it = publicKeys_.find(deviceId);
    if (it == publicKeys_.end()) throw CryptoError("Unknown device " + deviceId);
  }
  return it->second.get();
}

const Bytes& Client::wrap_key(const std::string& senderId, const std::string& recipientId) {
  std::string cacheKey = senderId + "|" + recipientId;
  auto it = wrapKeys_.find(cacheKey);
  if (it != wrapKeys_.end()) return it->second;
  const std::string& peer = senderId == deviceId_ ? recipientId : senderId;
  Bytes k = derive_wrap_key(key_->pkey(), public_key(peer), senderId, recipientId);
  return wrapKeys_.emplace(cacheKey, std::move(k)).first->second;
}

std::string Client::seal(const Json& content, const std::string& aad, const Json& devices) {
  std::vector<std::string> ids;
  std::set<std::string> seen;
  for (const auto& d : devices.items()) {
    std::string id = d.str("id");
    add_public_key(id, d["publicKey"], d.str("userId"));
    if (seen.insert(id).second) ids.push_back(id);
  }
  if (seen.insert(deviceId_).second) ids.push_back(deviceId_);

  Bytes contentKey = random_bytes(32);
  Bytes iv = random_bytes(12);
  std::string plain = content.dump();
  Bytes ct = gcm_encrypt(contentKey, iv, aad, reinterpret_cast<const uint8_t*>(plain.data()), plain.size());
  Json keys = Json::object();
  for (const auto& id : ids) keys.set(id, b64u(aes_kw_wrap(wrap_key(deviceId_, id), contentKey)));
  OPENSSL_cleanse(contentKey.data(), contentKey.size());

  Json env = Json::object();
  env.set("v", 1).set("from", deviceId_).set("iv", b64u(iv)).set("ct", b64u(ct)).set("keys", keys);
  return env.dump();
}

Json Client::open_message(const Json& message) {
  return open(message["payload"].as_string(), chat_aad(message.str("chatId"), message.str("id")), message.str("senderId"));
}

Json Client::open(const std::string& payload, const std::string& aad, const std::string& senderId) {
  Json env = Json::parse(payload);
  if (!env["v"].is_number() || env["v"].as_number() != 1 || !env["from"].is_string())
    throw CryptoError("Unsupported envelope version");
  public_key(env.str("from"));
  auto owner = owners_.find(env.str("from"));
  if (owner == owners_.end() || owner->second != senderId)
    throw CryptoError("message was sealed by a device of " + (owner == owners_.end() ? std::string("an unknown user") : owner->second) +
                      ", not " + senderId);
  const Json& wrapped = env["keys"][deviceId_];
  if (!wrapped.is_string()) throw CryptoError("Not encrypted for this device");
  Bytes contentKey = aes_kw_unwrap(wrap_key(env.str("from"), deviceId_), unb64u(wrapped.as_string()));
  if (contentKey.size() != 32) throw CryptoError("content key has the wrong length");
  Bytes ct = unb64u(env.str("ct"));
  Bytes pt = gcm_decrypt(contentKey, unb64u(env.str("iv")), aad, ct.data(), ct.size());
  OPENSSL_cleanse(contentKey.data(), contentKey.size());
  return Json::parse(sanitize_utf8(std::string_view(reinterpret_cast<const char*>(pt.data()), pt.size())));
}

// ---------- sending ----------

SentMessage Client::send_content(const std::string& chatId, const Json& content, const std::vector<std::string>& files) {
  std::string id = new_message_id();
  Json devices = http_.call("GET", "/api/chats/" + url_encode(chatId) + "/devices")["devices"];
  std::string payload = seal(content, chat_aad(chatId, id), devices);
  Json body = Json::object();
  body.set("id", id).set("payload", payload);
  if (!files.empty()) {
    Json arr = Json::array();
    for (const auto& f : files) arr.push(f);
    body.set("files", arr);
  }
  Json r = http_.call("POST", "/api/chats/" + url_encode(chatId) + "/messages", &body);
  return {chatId, r["message"].str("id", id), r["message"]};
}

SentMessage Client::send_text(const std::string& chatOrUser, const std::string& text) {
  Json content = Json::object();
  content.set("type", "text").set("text", sanitize_utf8(text));
  return send_content(resolve_chat(chatOrUser), content, {});
}

FileInfo Client::upload_file(const std::string& path, Json& fileFields, Progress progress) {
  int fd = ::open(path.c_str(), O_RDONLY | O_CLOEXEC);
  if (fd < 0) sys_fail("open " + path);
  struct FdGuard {
    int fd;
    ~FdGuard() { ::close(fd); }
  } guard{fd};
  struct stat st {};
  if (::fstat(fd, &st) != 0) sys_fail("stat " + path);
  if (!S_ISREG(st.st_mode)) throw std::runtime_error(path + " is not a regular file");
#ifdef POSIX_FADV_SEQUENTIAL
  ::posix_fadvise(fd, 0, 0, POSIX_FADV_SEQUENTIAL);
#endif
  const uint64_t size = static_cast<uint64_t>(st.st_size);
  const uint64_t total = encrypted_size(size);

  FileEncryptor enc(size);
  Bytes plain(kChunk), out(kChunk + kTag);
  size_t outLen = 0, outPos = 0;
  uint64_t sent = 0;

  auto read_exact = [&](uint8_t* buf, size_t len) {
    size_t got = 0;
    while (got < len) {
      ssize_t n = ::read(fd, buf + got, len - got);
      if (n < 0) {
        if (errno == EINTR) continue;
        sys_fail("read " + path);
      }
      if (n == 0) throw std::runtime_error(path + " shrank while it was being sent");
      got += static_cast<size_t>(n);
    }
  };

  // libcurl pulls the body: encrypt one chunk at a time as it asks for more.
  uint64_t nextChunk = 0;
  Http::Reader reader = [&](char* buf, size_t max) -> size_t {
    if (outPos == outLen) {
      if (enc.done()) return 0;
      size_t len = enc.plain_len(nextChunk);
      read_exact(plain.data(), len);
      if (enc.count() == nextChunk + 1) {
        // Last chunk: the file must end here, or the upload would not match
        // what we announced.
        uint8_t extra;
        ssize_t n;
        do n = ::read(fd, &extra, 1);
        while (n < 0 && errno == EINTR);
        if (n != 0) throw std::runtime_error(path + " grew while it was being sent");
      }
      outLen = enc.next(plain.data(), len, out.data());
      outPos = 0;
      ++nextChunk;
    }
    size_t n = std::min(max, outLen - outPos);
    std::memcpy(buf, out.data() + outPos, n);
    outPos += n;
    sent += n;
    if (progress) progress(sent, total);
    return n;
  };

  Json r = http_.upload("/api/files", total, reader);
  OPENSSL_cleanse(plain.data(), plain.size());
  if (!enc.done() || sent != total) throw std::runtime_error("upload ended early");

  FileInfo info;
  info.fileId = r.str("id");
  info.size = size;
  info.uploaded = total;
  info.sha256 = enc.sha256_b64u();
  if (info.fileId.empty()) throw ApiError(0, "upload returned no file id");
  // Same field order as the web app's encryptFile() + spread.
  fileFields.set("key", b64u(enc.key()))
      .set("prefix", b64u(enc.prefix()))
      .set("size", static_cast<uint64_t>(size))
      .set("sha256", info.sha256)
      .set("id", info.fileId);
  return info;
}

SentMessage Client::send_file(const std::string& chatOrUser, const std::string& path, const std::string& caption,
                              const std::string& mime, FileInfo* infoOut, Progress progress) {
  std::string chatId = resolve_chat(chatOrUser);
  // Fail before uploading if we can't post to this chat.
  http_.call("GET", "/api/chats/" + url_encode(chatId) + "/devices");

  Json file = Json::object();
  FileInfo info = upload_file(path, file, std::move(progress));
  std::string name = path.substr(path.rfind('/') == std::string::npos ? 0 : path.rfind('/') + 1);
  file.set("name", sanitize_utf8(name)).set("mime", mime.empty() ? guess_mime(path) : mime);

  Json content = Json::object();
  content.set("type", "media").set("kind", "document").set("file", file);
  if (!caption.empty()) content.set("caption", sanitize_utf8(caption));
  if (infoOut) *infoOut = info;
  return send_content(chatId, content, {info.fileId});
}

// ---------- reading ----------

std::optional<Json> Client::find_message(const std::string& messageId, const std::string& chatId) {
  std::vector<std::string> chats;
  if (!chatId.empty()) {
    chats.push_back(chatId);
  } else {
    Json list = http_.call("GET", "/api/chats");
    for (const auto& c : list["chats"].items()) chats.push_back(c.str("id"));
  }
  for (const auto& cid : chats) {
    int64_t before = 0;
    for (;;) {
      std::string q = "/api/chats/" + url_encode(cid) + "/messages?limit=200";
      if (before) q += "&before=" + std::to_string(before);
      Json page = http_.call("GET", q);
      const auto& msgs = page["messages"].items();
      for (const auto& m : msgs)
        if (m.str("id") == messageId) return m;
      if (!page["hasMore"].is_bool() || !page["hasMore"].as_bool() || msgs.empty()) break;
      before = msgs.front().num("seq");
      if (before <= 1) break;
    }
  }
  return std::nullopt;
}

std::string safe_file_name(const std::string& raw) {
  std::string name = sanitize_utf8(raw);
  auto slash = name.find_last_of("/\\");
  if (slash != std::string::npos) name = name.substr(slash + 1);
  std::string out;
  for (unsigned char c : name)
    if (c >= 0x20 && c != 0x7F) out.push_back(static_cast<char>(c));
  while (!out.empty() && (out.back() == ' ' || out.back() == '.')) out.pop_back();
  while (!out.empty() && out.front() == ' ') out.erase(out.begin());
  if (out.empty() || out == "." || out == "..") out = "download";
  if (out.size() > 200) out = sanitize_utf8(out.substr(0, 200));
  return out;
}

namespace {
struct SinkState {
  int fd;
  std::string path;
};
void sink_to_fd(void* user, const uint8_t* data, size_t len) {
  auto* s = static_cast<SinkState*>(user);
  write_all(s->fd, data, len, s->path);
}
}  // namespace

DownloadResult Client::download(const Json& message, const std::string& outDir, Progress progress) {
  if (!message["payload"].is_string()) throw std::runtime_error("message was deleted or is no longer viewable");
  Json content = open_message(message);
  const Json& file = content["file"];
  if (content.str("type") != "media" || !file.is_object()) throw std::runtime_error("message has no attachment");
  std::string fileId = file.str("id");
  if (fileId.empty() || !file["size"].is_number()) throw std::runtime_error("attachment is missing id or size");
  int64_t size = file["size"].as_int();
  if (size < 0) throw std::runtime_error("attachment has a negative size");

  mkdirs(outDir, 0755);
  std::string name = safe_file_name(file.str("name", fileId));
  std::string stem = name, ext;
  auto dot = name.rfind('.');
  if (dot != std::string::npos && dot > 0) stem = name.substr(0, dot), ext = name.substr(dot);
  std::string target = outDir + "/" + name;
  struct stat st {};
  for (int n = 1; ::lstat(target.c_str(), &st) == 0; ++n) target = outDir + "/" + stem + " (" + std::to_string(n) + ")" + ext;

  std::string tmp = outDir + "/." + name + "." + new_message_id().substr(0, 8) + ".part";
  int fd = ::open(tmp.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
  if (fd < 0) sys_fail("create " + tmp);
  const uint64_t total = encrypted_size(static_cast<uint64_t>(size));
  SinkState sink{fd, tmp};
  try {
    FileDecryptor dec(unb64u(file.str("key")), unb64u(file.str("prefix")), static_cast<uint64_t>(size), file.str("sha256"),
                      sink_to_fd, &sink);
    uint64_t got = 0;
    int64_t announced = http_.download("/api/files/" + url_encode(fileId), [&](const char* data, size_t len) {
      dec.feed(reinterpret_cast<const uint8_t*>(data), len);
      got += len;
      if (progress) progress(got, total);
    });
    if (announced >= 0 && static_cast<uint64_t>(announced) != total)
      throw CryptoError("encrypted file has the wrong size (" + std::to_string(announced) + ", expected " +
                        std::to_string(total) + ")");
    dec.finish();
    if (::fsync(fd) != 0) sys_fail("fsync " + tmp);
  } catch (...) {
    ::close(fd);
    ::unlink(tmp.c_str());
    throw;
  }
  ::close(fd);
  if (::rename(tmp.c_str(), target.c_str()) != 0) {
    ::unlink(tmp.c_str());
    sys_fail("rename to " + target);
  }
  return {target, file.str("sha256"), file.str("name"), static_cast<uint64_t>(size)};
}

std::string guess_mime(const std::string& path) {
  static const std::pair<const char*, const char*> table[] = {
      {".txt", "text/plain"},        {".md", "text/markdown"},      {".csv", "text/csv"},
      {".json", "application/json"}, {".pdf", "application/pdf"},  {".zip", "application/zip"},
      {".gz", "application/gzip"},   {".tar", "application/x-tar"}, {".png", "image/png"},
      {".jpg", "image/jpeg"},        {".jpeg", "image/jpeg"},       {".gif", "image/gif"},
      {".webp", "image/webp"},       {".svg", "image/svg+xml"},     {".mp4", "video/mp4"},
      {".webm", "video/webm"},       {".mov", "video/quicktime"},   {".mp3", "audio/mpeg"},
      {".ogg", "audio/ogg"},         {".wav", "audio/wav"},         {".m4a", "audio/mp4"},
      {".html", "text/html"},        {".doc", "application/msword"},
      {".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
      {".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
  };
  auto dot = path.rfind('.');
  auto slash = path.rfind('/');
  if (dot != std::string::npos && (slash == std::string::npos || dot > slash)) {
    std::string ext = path.substr(dot);
    std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char c) { return std::tolower(c); });
    for (const auto& [e, m] : table)
      if (ext == e) return m;
  }
  return "application/octet-stream";
}

}  // namespace tc
