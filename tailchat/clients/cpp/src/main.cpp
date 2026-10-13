// tailchat-cpp: command-line Tailchat client focused on streaming,
// end-to-end encrypted file transfer over the tailnet.
#include <sys/resource.h>
#include <unistd.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <iostream>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "client.hpp"

using namespace tc;

namespace {

const char* kUsage = R"(usage: tailchat-cpp [options] <command> [args]

Commands:
  whoami                          show your tailnet user and this device
  register [--force]              link this machine as a device (automatic on first use)
  users                           people on the tailnet
  chats                           your chats
  send CHAT_OR_USER TEXT          send an encrypted text message
  send-file CHAT_OR_USER PATH     stream-encrypt and send a file (1 MiB AES-256-GCM chunks)
  history CHAT                    decrypt and show recent messages
  download MESSAGE_ID OUTDIR      stream-download, decrypt and verify an attachment

CHAT_OR_USER is a chat id, or a user id such as alice@example.com (uses
your direct chat with them).

Options:
  --server URL        Tailchat server (env TAILCHAT_SERVER; defaults to the
                      server in the state file when there is only one)
  --dev-user NAME     dev-mode identity, sent as X-Dev-User (testing only)
  --state PATH        device state file (env TAILCHAT_STATE; default
                      ~/.config/tailchat/cpp-client.json), created with 0600
  --device-name NAME  name shown in your linked devices
  --cacert FILE       CA bundle for https
  --chat CHAT         download: only look in this chat
  --caption TEXT      send-file: caption
  --mime TYPE         send-file: override the guessed MIME type
  --limit N           history: number of messages (default 50, max 200)
  --json              machine-readable output (one JSON object per line)
  --stats             print time, throughput and peak memory to stderr
  -q, --quiet         no progress output
  -v, --verbose       show HTTP traffic
  -h, --help          this help
)";

struct Args {
  std::map<std::string, std::string> opts;
  std::set<std::string> flags;
  std::vector<std::string> pos;
};

Args parse_args(int argc, char** argv) {
  static const std::set<std::string> withValue = {"--server", "--dev-user",  "--state", "--device-name", "--cacert",
                                                  "--chat",   "--caption",   "--mime",  "--limit"};
  static const std::set<std::string> flags = {"--json", "--stats", "--quiet", "-q",     "--verbose",
                                              "-v",     "--help",  "-h",      "--force"};
  Args a;
  bool rest = false;
  for (int i = 1; i < argc; ++i) {
    std::string s = argv[i];
    if (!rest && s == "--") {
      rest = true;
    } else if (!rest && s.rfind("--", 0) == 0 && s.find('=') != std::string::npos &&
               withValue.count(s.substr(0, s.find('=')))) {
      a.opts[s.substr(0, s.find('='))] = s.substr(s.find('=') + 1);
    } else if (!rest && withValue.count(s)) {
      if (i + 1 >= argc) throw std::runtime_error(s + " needs a value");
      a.opts[s] = argv[++i];
    } else if (!rest && flags.count(s)) {
      a.flags.insert(s);
    } else if (!rest && s.size() > 1 && s[0] == '-') {
      throw std::runtime_error("unknown option " + s + " (use -- before arguments that start with -)");
    } else {
      a.pos.push_back(s);
    }
  }
  return a;
}

std::string env(const char* name) {
  const char* v = std::getenv(name);
  return v ? v : "";
}

std::string default_state_path() {
  std::string s = env("TAILCHAT_STATE");
  if (!s.empty()) return s;
  std::string base = env("XDG_CONFIG_HOME");
  if (base.empty()) {
    std::string home = env("HOME");
    if (home.empty()) throw std::runtime_error("set --state (no HOME)");
    base = home + "/.config";
  }
  return base + "/tailchat/cpp-client.json";
}

std::string server_from_state(const std::string& statePath) {
  FILE* f = std::fopen(statePath.c_str(), "rb");
  if (!f) return "";
  std::string text;
  char buf[4096];
  size_t n;
  while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) text.append(buf, n);
  std::fclose(f);
  std::set<std::string> servers;
  try {
    Json state = Json::parse(text);
    for (const auto& [k, p] : state["profiles"].members()) servers.insert(p.str("server"));
  } catch (const std::exception&) {
    return "";
  }
  return servers.size() == 1 ? *servers.begin() : "";
}

std::string host_name() {
  char buf[256] = "";
  if (gethostname(buf, sizeof buf - 1) != 0) return "unknown";
  return buf;
}

std::string format_time(int64_t ms) {
  if (ms <= 0) return "-";
  std::time_t t = static_cast<std::time_t>(ms / 1000);
  std::tm tm{};
  localtime_r(&t, &tm);
  char buf[32];
  std::strftime(buf, sizeof buf, "%Y-%m-%d %H:%M:%S", &tm);
  return buf;
}

std::string human_bytes(double b) {
  const char* units[] = {"B", "KiB", "MiB", "GiB", "TiB"};
  int u = 0;
  while (b >= 1024 && u < 4) b /= 1024, ++u;
  char buf[32];
  std::snprintf(buf, sizeof buf, u ? "%.1f %s" : "%.0f %s", b, units[u]);
  return buf;
}

class ProgressBar {
 public:
  ProgressBar(bool enabled, std::string label) : enabled_(enabled), label_(std::move(label)) {}
  void operator()(uint64_t done, uint64_t total) {
    if (!enabled_) return;
    auto now = std::chrono::steady_clock::now();
    if (done != total && now - last_ < std::chrono::milliseconds(200)) return;
    last_ = now;
    double secs = std::chrono::duration<double>(now - start_).count();
    double pct = total ? 100.0 * done / total : 100.0;
    std::fprintf(stderr, "\r%s %5.1f%%  %s / %s  %s/s   ", label_.c_str(), pct, human_bytes(done).c_str(),
                 human_bytes(total).c_str(), human_bytes(secs > 0 ? done / secs : 0).c_str());
    if (done == total) std::fputc('\n', stderr);
    std::fflush(stderr);
  }

 private:
  bool enabled_;
  std::string label_;
  std::chrono::steady_clock::time_point start_ = std::chrono::steady_clock::now();
  std::chrono::steady_clock::time_point last_{};
};

std::string describe(const Json& content) {
  std::string type = content.str("type");
  if (type == "text") return content.str("text");
  if (type == "media") {
    const Json& f = content["file"];
    std::string s = "[" + content.str("kind", "media") + "] " + f.str("name", f.str("id")) + " (" +
                    human_bytes(static_cast<double>(f.num("size"))) + ", " + f.str("mime", "?") + ")";
    if (content["caption"].is_string()) s += " " + content.str("caption");
    return s;
  }
  if (type == "location") return "[location] " + content["lat"].dump() + "," + content["lon"].dump();
  if (type == "contact") return "[contact] " + content.str("name") + " <" + content.str("userId") + ">";
  if (type == "poll") return "[poll] " + content.str("question");
  if (type == "call") return "[call]";
  return "[" + type + "]";
}

// Peak resident memory of this process. VmHWM is per address space; the
// getrusage() figure would include whatever the parent had before execve().
long peak_rss_kib() {
  if (FILE* f = std::fopen("/proc/self/status", "r")) {
    char line[256];
    long kib = -1;
    while (std::fgets(line, sizeof line, f))
      if (std::sscanf(line, "VmHWM: %ld kB", &kib) == 1) break;
    std::fclose(f);
    if (kib >= 0) return kib;
  }
  rusage ru{};
  getrusage(RUSAGE_SELF, &ru);
  return ru.ru_maxrss;
}

void print_json(const Json& j) { std::cout << j.dump() << "\n"; }

void need(const Args& a, size_t n, const char* usage) {
  if (a.pos.size() != n + 1) throw std::runtime_error(std::string("usage: tailchat-cpp ") + usage);
}

int run(int argc, char** argv) {
  Args a = parse_args(argc, argv);
  if (a.flags.count("--help") || a.flags.count("-h") || a.pos.empty()) {
    std::cout << kUsage;
    return a.pos.empty() && !a.flags.count("--help") && !a.flags.count("-h") ? 2 : 0;
  }
  const bool json = a.flags.count("--json");
  const bool quiet = a.flags.count("--quiet") || a.flags.count("-q") || json || !isatty(2);
  const bool stats = a.flags.count("--stats");

  ClientOptions o;
  o.statePath = a.opts.count("--state") ? a.opts["--state"] : default_state_path();
  o.server = a.opts.count("--server") ? a.opts["--server"] : env("TAILCHAT_SERVER");
  if (o.server.empty()) o.server = server_from_state(o.statePath);
  if (o.server.empty()) throw std::runtime_error("no server: pass --server https://<host>.<tailnet>.ts.net");
  while (!o.server.empty() && o.server.back() == '/') o.server.pop_back();
  o.devUser = a.opts.count("--dev-user") ? a.opts["--dev-user"] : env("TAILCHAT_DEV_USER");
  o.deviceName = a.opts.count("--device-name") ? a.opts["--device-name"] : "tailchat-cpp on " + host_name();
  if (o.deviceName.size() > 80) o.deviceName.resize(80);
  o.caFile = a.opts.count("--cacert") ? a.opts["--cacert"] : "";
  o.verbose = a.flags.count("--verbose") || a.flags.count("-v");

  Client client(o);
  const std::string& cmd = a.pos[0];
  auto t0 = std::chrono::steady_clock::now();
  uint64_t moved = 0;

  if (cmd == "register") {
    need(a, 0, "register [--force]");
    client.ensure_device(a.flags.count("--force"));
  } else {
    client.ensure_device();
  }

  if (cmd == "whoami" || cmd == "register") {
    Json me = client.me();
    Json devices = client.http().call("GET", "/api/users/" + url_encode(me["user"].str("id")) + "/devices")["devices"];
    std::vector<PublicJwk> keys;
    for (const auto& d : devices.items()) keys.push_back({d["publicKey"].str("x"), d["publicKey"].str("y")});
    std::string code = security_code(keys);
    if (json) {
      Json out = Json::object();
      out.set("server", client.http().base())
          .set("user", me["user"])
          .set("device", me["device"])
          .set("authMode", me["authMode"])
          .set("securityCode", code);
      print_json(out);
    } else {
      std::cout << "user:     " << me["user"].str("id") << " (" << me["user"].str("name") << ")\n"
                << "device:   " << me["device"].str("id") << " \"" << me["device"].str("name") << "\"\n"
                << "server:   " << client.http().base() << " (auth: " << me.str("authMode") << ")\n"
                << "security: " << code << "\n";
    }
  } else if (cmd == "users") {
    need(a, 0, "users");
    Json list = client.http().call("GET", "/api/users");
    for (const auto& u : list["users"].items()) {
      if (json) print_json(u);
      else std::cout << u.str("id") << "\t" << u.str("name") << "\n";
    }
  } else if (cmd == "chats") {
    need(a, 0, "chats");
    Json list = client.http().call("GET", "/api/chats");
    for (const auto& c : list["chats"].items()) {
      if (json) {
        print_json(c);
        continue;
      }
      std::string title = c.str("name");
      if (title.empty()) {
        for (const auto& m : c["members"].items())
          if (m.str("userId") != client.user_id()) title += (title.empty() ? "" : ", ") + m.str("userId");
      }
      std::cout << c.str("id") << "\t" << c.str("type") << "\t" << title << "\tunread=" << c.num("unread") << "\n";
    }
  } else if (cmd == "send") {
    need(a, 2, "send CHAT_OR_USER TEXT");
    SentMessage s = client.send_text(a.pos[1], a.pos[2]);
    if (json) {
      Json out = Json::object();
      out.set("chatId", s.chatId).set("id", s.messageId).set("seq", s.message["seq"]);
      print_json(out);
    } else {
      std::cout << "sent " << s.messageId << " in chat " << s.chatId << "\n";
    }
  } else if (cmd == "send-file") {
    need(a, 2, "send-file CHAT_OR_USER PATH");
    ProgressBar bar(!quiet, "upload  ");
    FileInfo info;
    SentMessage s = client.send_file(a.pos[1], a.pos[2], a.opts["--caption"], a.opts["--mime"], &info,
                                     [&](uint64_t d, uint64_t t) { bar(d, t); });
    moved = info.uploaded;
    if (json) {
      Json out = Json::object();
      out.set("chatId", s.chatId)
          .set("id", s.messageId)
          .set("fileId", info.fileId)
          .set("size", info.size)
          .set("uploaded", info.uploaded)
          .set("sha256", info.sha256);
      print_json(out);
    } else {
      std::cout << "sent " << s.messageId << " in chat " << s.chatId << " (" << human_bytes(info.size)
                << ", sha256 " << info.sha256 << ")\n";
    }
  } else if (cmd == "history") {
    need(a, 1, "history CHAT");
    std::string chatId = client.resolve_chat(a.pos[1]);
    std::string limit = a.opts.count("--limit") ? a.opts["--limit"] : "50";
    Json page = client.http().call("GET", "/api/chats/" + url_encode(chatId) + "/messages?limit=" + url_encode(limit));
    for (const auto& m : page["messages"].items()) {
      Json out = Json::object();
      out.set("id", m["id"]).set("chatId", m["chatId"]).set("seq", m["seq"]).set("senderId", m["senderId"])
          .set("senderDevice", m["senderDevice"]).set("createdAt", m["createdAt"]);
      std::string line;
      if (!m["payload"].is_string()) {
        out.set("deleted", true);
        line = m["deletedAt"].is_number() ? "(deleted)" : "(view once: opened)";
      } else if (m.str("kind", "msg") != "msg") {
        out.set("kind", m["kind"]);
        line = "(" + m.str("kind") + ")";
      } else {
        try {
          Json content = client.open_message(m);
          line = describe(content);
          out.set("content", content);
        } catch (const std::exception& e) {
          line = std::string("(cannot decrypt: ") + e.what() + ")";
          out.set("error", e.what());
        }
      }
      if (json) print_json(out);
      else
        std::cout << "[" << format_time(m.num("createdAt")) << "] " << m.str("senderId") << " (" << m.str("id")
                  << "): " << line << "\n";
    }
  } else if (cmd == "download") {
    need(a, 2, "download MESSAGE_ID OUTDIR");
    std::string chat = a.opts.count("--chat") ? client.resolve_chat(a.opts["--chat"]) : "";
    auto msg = client.find_message(a.pos[1], chat);
    if (!msg) throw std::runtime_error("no message " + a.pos[1] + " in your chats");
    ProgressBar bar(!quiet, "download");
    DownloadResult r = client.download(*msg, a.pos[2], [&](uint64_t d, uint64_t t) { bar(d, t); });
    moved = encrypted_size(r.size);
    if (json) {
      Json out = Json::object();
      out.set("path", r.path).set("name", r.name).set("size", r.size).set("sha256", r.sha256);
      print_json(out);
    } else {
      std::cout << r.path << " (" << human_bytes(r.size) << ", sha256 verified)\n";
    }
  } else {
    throw std::runtime_error("unknown command " + cmd + " (see --help)");
  }

  if (stats) {
    double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    std::fprintf(stderr, "stats: %.3f s, %llu bytes, %.1f MiB/s, peak RSS %ld KiB\n", secs,
                 static_cast<unsigned long long>(moved), secs > 0 ? moved / secs / 1048576.0 : 0.0, peak_rss_kib());
  }
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    return run(argc, argv);
  } catch (const ApiError& e) {
    std::fprintf(stderr, "tailchat-cpp: %s\n", e.what());
    if (e.status == 401)
      std::fprintf(stderr, "hint: if this device was logged out, run `tailchat-cpp register --force`\n");
    return 1;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "tailchat-cpp: %s\n", e.what());
    return 1;
  }
}
