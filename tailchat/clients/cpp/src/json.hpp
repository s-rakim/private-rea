// A small JSON value with a reader and a writer.
//
// The writer produces the same text as JavaScript's JSON.stringify for the
// values Tailchat uses (objects keep insertion order, integers print without a
// fraction, non-ASCII is emitted as UTF-8, control characters as \uXXXX), so
// envelopes serialised here are byte-for-byte what the web app would produce.
#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace tc {

class JsonError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

class Json {
 public:
  enum class Type { Null, Bool, Number, String, Array, Object };
  using Member = std::pair<std::string, Json>;

  Json() = default;
  Json(std::nullptr_t) {}
  Json(bool b) : type_(Type::Bool), bool_(b) {}
  Json(int n) : type_(Type::Number), num_(n) {}
  Json(long n) : type_(Type::Number), num_(static_cast<double>(n)) {}
  Json(long long n) : type_(Type::Number), num_(static_cast<double>(n)) {}
  Json(unsigned long n) : type_(Type::Number), num_(static_cast<double>(n)) {}
  Json(unsigned long long n) : type_(Type::Number), num_(static_cast<double>(n)) {}
  Json(double n) : type_(Type::Number), num_(n) {}
  Json(const char* s) : type_(Type::String), str_(s) {}
  Json(std::string s) : type_(Type::String), str_(std::move(s)) {}
  Json(std::string_view s) : type_(Type::String), str_(s) {}

  static Json object() {
    Json j;
    j.type_ = Type::Object;
    return j;
  }
  static Json array() {
    Json j;
    j.type_ = Type::Array;
    return j;
  }

  static Json parse(std::string_view text);
  std::string dump() const;

  Type type() const { return type_; }
  bool is_null() const { return type_ == Type::Null; }
  bool is_bool() const { return type_ == Type::Bool; }
  bool is_number() const { return type_ == Type::Number; }
  bool is_string() const { return type_ == Type::String; }
  bool is_array() const { return type_ == Type::Array; }
  bool is_object() const { return type_ == Type::Object; }

  // Typed accessors throw JsonError on a type mismatch.
  bool as_bool() const;
  double as_number() const;
  int64_t as_int() const;
  const std::string& as_string() const;
  const std::vector<Json>& items() const;
  const std::vector<Member>& members() const;

  // Lenient lookups: a missing key (or a non-object) yields null.
  const Json& operator[](std::string_view key) const;
  const Json& operator[](size_t index) const;
  bool has(std::string_view key) const;
  size_t size() const;

  // Convenience: the string at key, or fallback when missing / not a string.
  std::string str(std::string_view key, std::string fallback = "") const;
  int64_t num(std::string_view key, int64_t fallback = 0) const;

  // Builders. set() replaces an existing key in place (keeping its position).
  Json& set(std::string key, Json value);
  Json& push(Json value);

 private:
  Type type_ = Type::Null;
  bool bool_ = false;
  double num_ = 0;
  std::string str_;
  std::vector<Json> arr_;
  std::vector<Member> obj_;

  void dump_to(std::string& out) const;
  friend class JsonParser;
};

// JSON.stringify-compatible string quoting.
void json_quote(std::string& out, std::string_view s);

// Replace invalid UTF-8 sequences with U+FFFD, as TextEncoder/TextDecoder do.
std::string sanitize_utf8(std::string_view s);

}  // namespace tc
