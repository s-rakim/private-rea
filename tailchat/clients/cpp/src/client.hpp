// A Tailchat device: local state, key ring and the encrypted operations.
#pragma once

#include <functional>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "crypto.hpp"
#include "http.hpp"
#include "json.hpp"

namespace tc {

struct ClientOptions {
  std::string server;      // base URL
  std::string devUser;     // dev mode only
  std::string statePath;   // JSON state file (0600)
  std::string deviceName;  // used when registering
  std::string caFile;
  bool verbose = false;
};

// Progress callback: bytes done, bytes total.
using Progress = std::function<void(uint64_t done, uint64_t total)>;

struct SentMessage {
  std::string chatId, messageId;
  Json message;  // the server's view
};

struct FileInfo {
  std::string fileId, sha256;
  uint64_t size = 0, uploaded = 0;
};

struct DownloadResult {
  std::string path, sha256, name;
  uint64_t size = 0;
};

class Client {
 public:
  explicit Client(ClientOptions opts);

  // Loads this server/user's device from the state file, registering a new
  // device (and saving its key and token) if there is none or `force`.
  void ensure_device(bool force = false);

  const std::string& device_id() const { return deviceId_; }
  const std::string& user_id() const { return userId_; }
  Http& http() { return http_; }

  Json me();
  // A chat id, or a user id (contains '@') whose direct chat is used.
  std::string resolve_chat(const std::string& chatOrUser);

  SentMessage send_content(const std::string& chatId, const Json& content, const std::vector<std::string>& files);
  SentMessage send_text(const std::string& chatOrUser, const std::string& text);
  SentMessage send_file(const std::string& chatOrUser, const std::string& path, const std::string& caption,
                        const std::string& mime, FileInfo* info, Progress progress);

  // Streams an encrypted upload of `path` (§5). Never holds more than one
  // chunk in memory.
  FileInfo upload_file(const std::string& path, Json& fileFields, Progress progress);

  // Decrypts a message payload (throws CryptoError / ApiError).
  Json open(const std::string& payload, const std::string& aad);
  std::string seal(const Json& content, const std::string& aad, const Json& devices);

  // Finds a message by id: in `chatId` when given, otherwise in every chat.
  std::optional<Json> find_message(const std::string& messageId, const std::string& chatId = "");

  // Streams the file of a media message into outDir (decrypting and
  // verifying as it goes).
  DownloadResult download(const Json& message, const std::string& outDir, Progress progress);

 private:
  ClientOptions opts_;
  Http http_;
  std::optional<DeviceKey> key_;
  std::string deviceId_, userId_;
  std::map<std::string, PKey> publicKeys_;
  std::map<std::string, Bytes> wrapKeys_;

  EVP_PKEY* public_key(const std::string& deviceId);
  void add_public_key(const std::string& deviceId, const Json& jwk);
  const Bytes& wrap_key(const std::string& senderId, const std::string& recipientId);
  std::string profile_key() const;
};

std::string new_message_id();
std::string guess_mime(const std::string& path);
// A safe local file name for an attachment name chosen by someone else.
std::string safe_file_name(const std::string& name);

}  // namespace tc
