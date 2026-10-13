#include "json.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace tc {

namespace {
const Json kNull;
}

bool Json::as_bool() const {
  if (type_ != Type::Bool) throw JsonError("expected a JSON boolean");
  return bool_;
}

double Json::as_number() const {
  if (type_ != Type::Number) throw JsonError("expected a JSON number");
  return num_;
}

int64_t Json::as_int() const {
  double n = as_number();
  if (n != std::floor(n) || std::fabs(n) > 9007199254740991.0) throw JsonError("expected an integer");
  return static_cast<int64_t>(n);
}

const std::string& Json::as_string() const {
  if (type_ != Type::String) throw JsonError("expected a JSON string");
  return str_;
}

const std::vector<Json>& Json::items() const {
  if (type_ != Type::Array) throw JsonError("expected a JSON array");
  return arr_;
}

const std::vector<Json::Member>& Json::members() const {
  if (type_ != Type::Object) throw JsonError("expected a JSON object");
  return obj_;
}

const Json& Json::operator[](std::string_view key) const {
  if (type_ != Type::Object) return kNull;
  for (const auto& [k, v] : obj_)
    if (k == key) return v;
  return kNull;
}

const Json& Json::operator[](size_t index) const {
  if (type_ != Type::Array || index >= arr_.size()) return kNull;
  return arr_[index];
}

bool Json::has(std::string_view key) const {
  if (type_ != Type::Object) return false;
  for (const auto& m : obj_)
    if (m.first == key) return true;
  return false;
}

size_t Json::size() const {
  if (type_ == Type::Array) return arr_.size();
  if (type_ == Type::Object) return obj_.size();
  return 0;
}

std::string Json::str(std::string_view key, std::string fallback) const {
  const Json& v = (*this)[key];
  return v.is_string() ? v.str_ : fallback;
}

int64_t Json::num(std::string_view key, int64_t fallback) const {
  const Json& v = (*this)[key];
  if (!v.is_number()) return fallback;
  try {
    return v.as_int();
  } catch (const JsonError&) {
    return fallback;
  }
}

Json& Json::set(std::string key, Json value) {
  if (type_ == Type::Null) type_ = Type::Object;
  if (type_ != Type::Object) throw JsonError("set() on a non-object");
  for (auto& m : obj_) {
    if (m.first == key) {
      m.second = std::move(value);
      return *this;
    }
  }
  obj_.emplace_back(std::move(key), std::move(value));
  return *this;
}

Json& Json::push(Json value) {
  if (type_ == Type::Null) type_ = Type::Array;
  if (type_ != Type::Array) throw JsonError("push() on a non-array");
  arr_.push_back(std::move(value));
  return *this;
}

// ---------- writer ----------

void json_quote(std::string& out, std::string_view s) {
  static const char* hex = "0123456789abcdef";
  out.push_back('"');
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          out += "\\u00";
          out.push_back(hex[c >> 4]);
          out.push_back(hex[c & 15]);
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  out.push_back('"');
}

void Json::dump_to(std::string& out) const {
  switch (type_) {
    case Type::Null: out += "null"; break;
    case Type::Bool: out += bool_ ? "true" : "false"; break;
    case Type::Number: {
      if (!std::isfinite(num_)) {
        out += "null";  // what JSON.stringify does
      } else if (num_ == std::floor(num_) && std::fabs(num_) < 1e21) {
        char buf[32];
        std::snprintf(buf, sizeof buf, "%.0f", num_);
        out += (std::string_view(buf) == "-0") ? "0" : buf;
      } else {
        // Shortest representation that round-trips, like JS.
        char buf[32];
        for (int prec = 1; prec <= 17; ++prec) {
          std::snprintf(buf, sizeof buf, "%.*g", prec, num_);
          if (std::strtod(buf, nullptr) == num_) break;
        }
        out += buf;
      }
      break;
    }
    case Type::String: json_quote(out, str_); break;
    case Type::Array: {
      out.push_back('[');
      for (size_t i = 0; i < arr_.size(); ++i) {
        if (i) out.push_back(',');
        arr_[i].dump_to(out);
      }
      out.push_back(']');
      break;
    }
    case Type::Object: {
      out.push_back('{');
      for (size_t i = 0; i < obj_.size(); ++i) {
        if (i) out.push_back(',');
        json_quote(out, obj_[i].first);
        out.push_back(':');
        obj_[i].second.dump_to(out);
      }
      out.push_back('}');
      break;
    }
  }
}

std::string Json::dump() const {
  std::string out;
  dump_to(out);
  return out;
}

// ---------- UTF-8 ----------

static void put_utf8(std::string& out, uint32_t cp) {
  if (cp < 0x80) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp < 0x10000) {
    out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

std::string sanitize_utf8(std::string_view s) {
  std::string out;
  out.reserve(s.size());
  size_t i = 0;
  const auto* p = reinterpret_cast<const unsigned char*>(s.data());
  while (i < s.size()) {
    unsigned char c = p[i];
    size_t len = 0;
    uint32_t cp = 0, min = 0;
    if (c < 0x80) {
      out.push_back(static_cast<char>(c));
      ++i;
      continue;
    } else if ((c & 0xE0) == 0xC0) {
      len = 2, cp = c & 0x1F, min = 0x80;
    } else if ((c & 0xF0) == 0xE0) {
      len = 3, cp = c & 0x0F, min = 0x800;
    } else if ((c & 0xF8) == 0xF0) {
      len = 4, cp = c & 0x07, min = 0x10000;
    }
    bool ok = len && i + len <= s.size();
    for (size_t k = 1; ok && k < len; ++k) {
      if ((p[i + k] & 0xC0) != 0x80) ok = false;
      else cp = (cp << 6) | (p[i + k] & 0x3F);
    }
    if (ok && (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF))) ok = false;
    if (ok) {
      out.append(s.substr(i, len));
      i += len;
    } else {
      out += "\xEF\xBF\xBD";
      ++i;
    }
  }
  return out;
}

// ---------- reader ----------

class JsonParser {
 public:
  explicit JsonParser(std::string_view t) : t_(t) {}

  Json parse_document() {
    Json v = value(0);
    ws();
    if (i_ != t_.size()) fail("trailing characters");
    return v;
  }

 private:
  std::string_view t_;
  size_t i_ = 0;

  [[noreturn]] void fail(const char* what) {
    throw JsonError(std::string("invalid JSON: ") + what + " at offset " + std::to_string(i_));
  }

  void ws() {
    while (i_ < t_.size() && (t_[i_] == ' ' || t_[i_] == '\t' || t_[i_] == '\n' || t_[i_] == '\r')) ++i_;
  }

  bool literal(std::string_view word) {
    if (t_.substr(i_, word.size()) == word) {
      i_ += word.size();
      return true;
    }
    return false;
  }

  Json value(int depth) {
    if (depth > 200) fail("nested too deeply");
    ws();
    if (i_ >= t_.size()) fail("unexpected end");
    char c = t_[i_];
    if (c == '{') return object(depth);
    if (c == '[') return array(depth);
    if (c == '"') return Json(string());
    if (literal("true")) return Json(true);
    if (literal("false")) return Json(false);
    if (literal("null")) return Json();
    if (c == '-' || (c >= '0' && c <= '9')) return number();
    fail("unexpected character");
  }

  Json object(int depth) {
    Json obj = Json::object();
    ++i_;
    ws();
    if (i_ < t_.size() && t_[i_] == '}') {
      ++i_;
      return obj;
    }
    for (;;) {
      ws();
      if (i_ >= t_.size() || t_[i_] != '"') fail("expected a key");
      std::string key = string();
      ws();
      if (i_ >= t_.size() || t_[i_] != ':') fail("expected ':'");
      ++i_;
      obj.set(std::move(key), value(depth + 1));  // later duplicates win, like JSON.parse
      ws();
      if (i_ < t_.size() && t_[i_] == ',') {
        ++i_;
        continue;
      }
      if (i_ < t_.size() && t_[i_] == '}') {
        ++i_;
        return obj;
      }
      fail("expected ',' or '}'");
    }
  }

  Json array(int depth) {
    Json arr = Json::array();
    ++i_;
    ws();
    if (i_ < t_.size() && t_[i_] == ']') {
      ++i_;
      return arr;
    }
    for (;;) {
      arr.push(value(depth + 1));
      ws();
      if (i_ < t_.size() && t_[i_] == ',') {
        ++i_;
        continue;
      }
      if (i_ < t_.size() && t_[i_] == ']') {
        ++i_;
        return arr;
      }
      fail("expected ',' or ']'");
    }
  }

  Json number() {
    size_t start = i_;
    if (t_[i_] == '-') ++i_;
    auto digits = [&] {
      size_t s = i_;
      while (i_ < t_.size() && t_[i_] >= '0' && t_[i_] <= '9') ++i_;
      return i_ - s;
    };
    if (i_ < t_.size() && t_[i_] == '0') ++i_;
    else if (!digits()) fail("bad number");
    if (i_ < t_.size() && t_[i_] == '.') {
      ++i_;
      if (!digits()) fail("bad number");
    }
    if (i_ < t_.size() && (t_[i_] == 'e' || t_[i_] == 'E')) {
      ++i_;
      if (i_ < t_.size() && (t_[i_] == '+' || t_[i_] == '-')) ++i_;
      if (!digits()) fail("bad number");
    }
    std::string text(t_.substr(start, i_ - start));
    return Json(std::strtod(text.c_str(), nullptr));
  }

  uint32_t hex4() {
    if (i_ + 4 > t_.size()) fail("bad \\u escape");
    uint32_t v = 0;
    for (int k = 0; k < 4; ++k) {
      char c = t_[i_++];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= c - '0';
      else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10;
      else fail("bad \\u escape");
    }
    return v;
  }

  std::string string() {
    ++i_;  // opening quote
    std::string out;
    size_t run = i_;
    for (;;) {
      if (i_ >= t_.size()) fail("unterminated string");
      unsigned char c = static_cast<unsigned char>(t_[i_]);
      if (c == '"') {
        out.append(t_.substr(run, i_ - run));
        ++i_;
        break;
      }
      if (c < 0x20) fail("control character in string");
      if (c != '\\') {
        ++i_;
        continue;
      }
      out.append(t_.substr(run, i_ - run));
      ++i_;
      if (i_ >= t_.size()) fail("unterminated string");
      char e = t_[i_++];
      switch (e) {
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case 'u': {
          uint32_t cp = hex4();
          if (cp >= 0xD800 && cp <= 0xDBFF && t_.substr(i_, 2) == "\\u") {
            size_t save = i_;
            i_ += 2;
            uint32_t lo = hex4();
            if (lo >= 0xDC00 && lo <= 0xDFFF) {
              cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            } else {
              i_ = save;
              cp = 0xFFFD;
            }
          } else if (cp >= 0xD800 && cp <= 0xDFFF) {
            cp = 0xFFFD;  // lone surrogate: what TextEncoder would produce
          }
          put_utf8(out, cp);
          break;
        }
        default: fail("bad escape");
      }
      run = i_;
    }
    return out;
  }
};

Json Json::parse(std::string_view text) { return JsonParser(text).parse_document(); }

}  // namespace tc
