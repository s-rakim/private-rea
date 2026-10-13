// Minimal HTTP(S) client for the Tailchat REST API, on libcurl.
#pragma once

#include <cstdint>
#include <functional>
#include <stdexcept>
#include <string>

#include "json.hpp"

namespace tc {

class ApiError : public std::runtime_error {
 public:
  ApiError(long status, const std::string& message) : std::runtime_error(message), status(status) {}
  long status;  // HTTP status, or 0 for a transport error
};

class Http {
 public:
  struct Options {
    std::string base;     // e.g. https://host.tailnet.ts.net (no trailing slash)
    std::string devUser;  // dev mode only: sent as X-Dev-User
    std::string caFile;   // optional CA bundle for https
    bool verbose = false;
  };

  explicit Http(Options opts);
  ~Http();
  Http(const Http&) = delete;
  Http& operator=(const Http&) = delete;

  void set_token(std::string token) { token_ = std::move(token); }

  // JSON request; body may be null for no body. Throws ApiError on non-2xx.
  Json call(const std::string& method, const std::string& path, const Json* body = nullptr);

  // Streams an upload of exactly `length` bytes as application/octet-stream.
  // `read` fills up to `max` bytes and returns how many it wrote (0 = end).
  using Reader = std::function<size_t(char* buf, size_t max)>;
  Json upload(const std::string& path, uint64_t length, Reader read);

  // Streams a download; `write` receives the body in pieces. Returns the
  // Content-Length the server announced (or -1).
  using Writer = std::function<void(const char* data, size_t len)>;
  int64_t download(const std::string& path, Writer write);

  const std::string& base() const { return opts_.base; }

  struct Exchange;  // per-request state shared with the libcurl callbacks

 private:
  Options opts_;
  std::string token_;
  void* curl_;  // CURL*, reused so connections are kept alive

  long perform(Exchange& ex, const std::string& method, const std::string& path);
};

std::string url_encode(const std::string& s);

}  // namespace tc
