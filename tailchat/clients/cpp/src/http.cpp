#include "http.hpp"

#include <curl/curl.h>

#include <cctype>
#include <cstring>
#include <exception>
#include <mutex>

namespace tc {

namespace {

std::once_flag g_init;

CURL* handle(void* p) { return static_cast<CURL*>(p); }

}  // namespace

struct Http::Exchange {
  // request
  const std::string* body = nullptr;
  Reader reader;
  uint64_t uploadLength = 0;
  const char* contentType = nullptr;
  // response
  Writer writer;
  std::string response;
  std::exception_ptr error;
  CURL* curl = nullptr;
};

static size_t on_write(char* data, size_t size, size_t n, void* user) {
  auto* ex = static_cast<Http::Exchange*>(user);
  size_t len = size * n;
  try {
    long status = 0;
    curl_easy_getinfo(ex->curl, CURLINFO_RESPONSE_CODE, &status);
    if (ex->writer && status >= 200 && status < 300) {
      ex->writer(data, len);
    } else {
      if (ex->response.size() + len > 16 * 1024 * 1024) throw ApiError(0, "response too large");
      ex->response.append(data, len);
    }
    return len;
  } catch (...) {
    ex->error = std::current_exception();
    return 0;  // aborts the transfer
  }
}

static size_t on_read(char* buf, size_t size, size_t n, void* user) {
  auto* ex = static_cast<Http::Exchange*>(user);
  try {
    return ex->reader(buf, size * n);
  } catch (...) {
    ex->error = std::current_exception();
    return CURL_READFUNC_ABORT;
  }
}

Http::Http(Options opts) : opts_(std::move(opts)) {
  std::call_once(g_init, [] { curl_global_init(CURL_GLOBAL_DEFAULT); });
  while (!opts_.base.empty() && opts_.base.back() == '/') opts_.base.pop_back();
  curl_ = curl_easy_init();
  if (!curl_) throw ApiError(0, "curl_easy_init failed");
}

Http::~Http() { curl_easy_cleanup(handle(curl_)); }

std::string url_encode(const std::string& s) {
  static const char* hex = "0123456789ABCDEF";
  std::string out;
  for (unsigned char c : s) {
    if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
      out.push_back(static_cast<char>(c));
    } else {
      out.push_back('%');
      out.push_back(hex[c >> 4]);
      out.push_back(hex[c & 15]);
    }
  }
  return out;
}

static std::string error_text(const std::string& body) {
  try {
    Json j = Json::parse(body);
    if (j["error"].is_string()) return j["error"].as_string();
  } catch (const JsonError&) {
  }
  std::string s = body.substr(0, 200);
  return s.empty() ? "(no body)" : s;
}

long Http::perform(Exchange& ex, const std::string& method, const std::string& path) {
  CURL* c = handle(curl_);
  curl_easy_reset(c);  // keeps the connection cache
  ex.curl = c;
  std::string url = opts_.base + path;
  curl_easy_setopt(c, CURLOPT_URL, url.c_str());
  curl_easy_setopt(c, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(c, CURLOPT_PROTOCOLS_STR, "http,https");
  // Tailnet traffic goes straight to the peer: never through a proxy from
  // the environment.
  curl_easy_setopt(c, CURLOPT_PROXY, "");
  curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT, 20L);
  // Abort if the connection stalls (below 1 byte/s for 120 s), but allow
  // arbitrarily long transfers.
  curl_easy_setopt(c, CURLOPT_LOW_SPEED_LIMIT, 1L);
  curl_easy_setopt(c, CURLOPT_LOW_SPEED_TIME, 120L);
  curl_easy_setopt(c, CURLOPT_USERAGENT, "tailchat-cpp/1");
  if (!opts_.caFile.empty()) curl_easy_setopt(c, CURLOPT_CAINFO, opts_.caFile.c_str());
  if (opts_.verbose) curl_easy_setopt(c, CURLOPT_VERBOSE, 1L);
  curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, on_write);
  curl_easy_setopt(c, CURLOPT_WRITEDATA, &ex);

  curl_slist* headers = nullptr;
  std::string auth, dev, type;
  if (!token_.empty()) {
    auth = "Authorization: Bearer " + token_;
    headers = curl_slist_append(headers, auth.c_str());
  }
  if (!opts_.devUser.empty()) {
    dev = "X-Dev-User: " + opts_.devUser;
    headers = curl_slist_append(headers, dev.c_str());
  }
  if (ex.contentType) {
    type = std::string("Content-Type: ") + ex.contentType;
    headers = curl_slist_append(headers, type.c_str());
  }
  headers = curl_slist_append(headers, "Expect:");  // no 100-continue round trip
  headers = curl_slist_append(headers, "Accept: application/json, application/octet-stream");
  curl_easy_setopt(c, CURLOPT_HTTPHEADER, headers);

  if (ex.reader) {
    curl_easy_setopt(c, CURLOPT_POST, 1L);
    curl_easy_setopt(c, CURLOPT_READFUNCTION, on_read);
    curl_easy_setopt(c, CURLOPT_READDATA, &ex);
    curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(ex.uploadLength));
    curl_easy_setopt(c, CURLOPT_UPLOAD_BUFFERSIZE, 2L * 1024 * 1024);
  } else if (ex.body) {
    curl_easy_setopt(c, CURLOPT_POSTFIELDS, ex.body->data());
    curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(ex.body->size()));
  }
  if (method == "GET" && !ex.body && !ex.reader) {
    curl_easy_setopt(c, CURLOPT_HTTPGET, 1L);
  } else if (method != "POST") {
    curl_easy_setopt(c, CURLOPT_CUSTOMREQUEST, method.c_str());
  }
  if (ex.writer) curl_easy_setopt(c, CURLOPT_BUFFERSIZE, 512L * 1024);

  CURLcode rc = curl_easy_perform(c);
  curl_slist_free_all(headers);
  if (ex.error) std::rethrow_exception(ex.error);
  long status = 0;
  curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &status);
  if (rc != CURLE_OK) {
    // The server may answer an upload early (e.g. 413) and close the
    // connection; report its answer when we have one.
    if (status >= 400) throw ApiError(status, method + " " + path + " -> " + std::to_string(status) + " " + error_text(ex.response));
    throw ApiError(0, method + " " + url + ": " + curl_easy_strerror(rc));
  }
  if (status < 200 || status >= 300)
    throw ApiError(status, method + " " + path + " -> " + std::to_string(status) + " " + error_text(ex.response));
  return status;
}

static Json parse_body(const std::string& method, const std::string& path, const std::string& body) {
  if (body.empty()) return Json::object();
  try {
    return Json::parse(body);
  } catch (const JsonError& e) {
    throw ApiError(0, method + " " + path + ": server sent invalid JSON (" + e.what() + ")");
  }
}

Json Http::call(const std::string& method, const std::string& path, const Json* body) {
  Exchange ex;
  std::string text;
  if (body) {
    text = body->dump();
    ex.body = &text;
    ex.contentType = "application/json";
  }
  perform(ex, method, path);
  return parse_body(method, path, ex.response);
}

Json Http::upload(const std::string& path, uint64_t length, Reader read) {
  Exchange ex;
  ex.reader = std::move(read);
  ex.uploadLength = length;
  ex.contentType = "application/octet-stream";
  perform(ex, "POST", path);
  return parse_body("POST", path, ex.response);
}

int64_t Http::download(const std::string& path, Writer write) {
  Exchange ex;
  ex.writer = std::move(write);
  perform(ex, "GET", path);
  curl_off_t len = -1;
  curl_easy_getinfo(handle(curl_), CURLINFO_CONTENT_LENGTH_DOWNLOAD_T, &len);
  return len;
}

}  // namespace tc
