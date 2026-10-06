// Minimal, strict JSON reader/writer for the Orbis C++ parity module (no third-party dependencies).
// Keeps the integer/float distinction of the source text so schema validation matches Python's
// `isinstance(x, int)` semantics exactly.
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace orbis::json {

struct Value;
using Object = std::map<std::string, Value>;
using Array = std::vector<Value>;

struct Value {
  enum class Kind { Null, Bool, Int, Float, String, Array, Object };
  Kind kind = Kind::Null;
  bool b = false;
  int64_t i = 0;
  double d = 0.0;
  std::string s;
  std::shared_ptr<Array> arr;
  std::shared_ptr<Object> obj;

  bool is_null() const { return kind == Kind::Null; }
  bool is_bool() const { return kind == Kind::Bool; }
  bool is_int() const { return kind == Kind::Int; }
  bool is_number() const { return kind == Kind::Int || kind == Kind::Float; }
  bool is_string() const { return kind == Kind::String; }
  bool is_array() const { return kind == Kind::Array; }
  bool is_object() const { return kind == Kind::Object; }
  double number() const { return kind == Kind::Int ? static_cast<double>(i) : d; }

  /// Object member or nullptr when absent (distinguishes "missing" from explicit null).
  const Value* get(const std::string& key) const {
    if (!is_object()) return nullptr;
    auto it = obj->find(key);
    return it == obj->end() ? nullptr : &it->second;
  }
};

class ParseError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

Value parse(std::string_view text);
std::string dump_double(double v);  // shortest round-trip representation

}  // namespace orbis::json
