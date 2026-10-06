#include "orbis/json.hpp"

#include <charconv>
#include <cstdio>
#include <cstdlib>

namespace orbis::json {
namespace {

class Parser {
 public:
  explicit Parser(std::string_view t) : t_(t) {}

  Value run() {
    Value v = value();
    ws();
    if (p_ != t_.size()) fail("trailing characters");
    return v;
  }

 private:
  std::string_view t_;
  size_t p_ = 0;
  int depth_ = 0;

  [[noreturn]] void fail(const char* why) { throw ParseError(std::string(why) + " at offset " + std::to_string(p_)); }
  void ws() {
    while (p_ < t_.size() && (t_[p_] == ' ' || t_[p_] == '\n' || t_[p_] == '\r' || t_[p_] == '\t')) ++p_;
  }
  char peek() {
    ws();
    if (p_ >= t_.size()) fail("unexpected end");
    return t_[p_];
  }
  bool lit(std::string_view w) {
    if (t_.substr(p_, w.size()) == w) {
      p_ += w.size();
      return true;
    }
    return false;
  }

  Value value() {
    if (++depth_ > 256) fail("nesting too deep");
    Value v;
    char c = peek();
    if (c == '{') v = object();
    else if (c == '[') v = array();
    else if (c == '"') { v.kind = Value::Kind::String; v.s = string(); }
    else if (lit("true")) { v.kind = Value::Kind::Bool; v.b = true; }
    else if (lit("false")) { v.kind = Value::Kind::Bool; v.b = false; }
    else if (lit("null")) { v.kind = Value::Kind::Null; }
    else v = number();
    --depth_;
    return v;
  }

  Value object() {
    Value v;
    v.kind = Value::Kind::Object;
    v.obj = std::make_shared<Object>();
    ++p_;
    if (peek() == '}') { ++p_; return v; }
    for (;;) {
      if (peek() != '"') fail("expected key");
      std::string k = string();
      if (peek() != ':') fail("expected ':'");
      ++p_;
      (*v.obj)[k] = value();
      char c = peek();
      ++p_;
      if (c == '}') return v;
      if (c != ',') fail("expected ',' or '}'");
    }
  }

  Value array() {
    Value v;
    v.kind = Value::Kind::Array;
    v.arr = std::make_shared<Array>();
    ++p_;
    if (peek() == ']') { ++p_; return v; }
    for (;;) {
      v.arr->push_back(value());
      char c = peek();
      ++p_;
      if (c == ']') return v;
      if (c != ',') fail("expected ',' or ']'");
    }
  }

  static void utf8(std::string& out, uint32_t cp) {
    if (cp < 0x80) out += static_cast<char>(cp);
    else if (cp < 0x800) { out += static_cast<char>(0xC0 | (cp >> 6)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { out += static_cast<char>(0xE0 | (cp >> 12)); out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
    else { out += static_cast<char>(0xF0 | (cp >> 18)); out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F)); out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
  }

  uint32_t hex4() {
    if (p_ + 4 > t_.size()) fail("bad \\u escape");
    uint32_t v = 0;
    for (int k = 0; k < 4; ++k) {
      char c = t_[p_++];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= static_cast<uint32_t>(c - '0');
      else if (c >= 'a' && c <= 'f') v |= static_cast<uint32_t>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') v |= static_cast<uint32_t>(c - 'A' + 10);
      else fail("bad hex digit");
    }
    return v;
  }

  std::string string() {
    ++p_;  // opening quote
    std::string out;
    for (;;) {
      if (p_ >= t_.size()) fail("unterminated string");
      char c = t_[p_++];
      if (c == '"') return out;
      if (static_cast<unsigned char>(c) < 0x20) fail("control character in string");
      if (c != '\\') { out += c; continue; }
      if (p_ >= t_.size()) fail("bad escape");
      char e = t_[p_++];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          uint32_t cp = hex4();
          if (cp >= 0xD800 && cp <= 0xDBFF && lit("\\u")) {
            uint32_t lo = hex4();
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          }
          utf8(out, cp);
          break;
        }
        default: fail("bad escape");
      }
    }
  }

  Value number() {
    size_t start = p_;
    bool is_float = false;
    if (p_ < t_.size() && t_[p_] == '-') ++p_;
    while (p_ < t_.size()) {
      char c = t_[p_];
      if (c >= '0' && c <= '9') ++p_;
      else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') { is_float = true; ++p_; }
      else break;
    }
    if (p_ == start) fail("unexpected character");
    std::string_view tok = t_.substr(start, p_ - start);
    Value v;
    if (!is_float) {
      v.kind = Value::Kind::Int;
      auto r = std::from_chars(tok.data(), tok.data() + tok.size(), v.i);
      if (r.ec == std::errc()) return v;
    }
    v.kind = Value::Kind::Float;
    std::string tmp(tok);
    char* end = nullptr;
    v.d = std::strtod(tmp.c_str(), &end);
    if (end != tmp.c_str() + tmp.size()) fail("bad number");
    return v;
  }
};

}  // namespace

Value parse(std::string_view text) { return Parser(text).run(); }

std::string dump_double(double v) {
  char buf[40];
  for (int prec = 15; prec <= 17; ++prec) {
    std::snprintf(buf, sizeof buf, "%.*g", prec, v);
    if (std::strtod(buf, nullptr) == v) break;
  }
  return buf;
}

}  // namespace orbis::json
