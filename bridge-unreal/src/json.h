// Telos Unreal bridge: minimal JSON parser + serializer (no dependencies).
// Dependency-free on purpose: adapter.cpp includes this for the DLL, and the
// host-side unit test compiles it directly with the native compiler.
#pragma once

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <string>
#include <vector>

namespace adapter {

// ------------------------------------------------------------------ JSON ----
// Minimal recursive-descent parser + value model. No dependencies, no guessing.

struct Json {
  enum class Type { Null, Bool, Num, Str, Arr, Obj } type = Type::Null;
  bool b = false;
  double num = 0;
  std::string str;
  std::vector<Json> arr;
  std::map<std::string, Json> obj;

  static Json boolean(bool v) { Json j; j.type = Type::Bool; j.b = v; return j; }
  static Json number(double v) { Json j; j.type = Type::Num; j.num = v; return j; }
  static Json string(const std::string& v) { Json j; j.type = Type::Str; j.str = v; return j; }

  bool isNull() const { return type == Type::Null; }
  const Json& at(const std::string& key) const {
    static Json null;
    auto it = obj.find(key);
    return it == obj.end() ? null : it->second;
  }
  std::string strOr(const std::string& dflt) const {
    return type == Type::Str ? str : dflt;
  }
  double numOr(double dflt) const {
    if (type == Type::Num) return num;
    if (type == Type::Bool) return b ? 1 : 0;
    if (type == Type::Str) {
      char* end = nullptr;
      double v = strtod(str.c_str(), &end);
      if (end != str.c_str()) return v;
    }
    return dflt;
  }
  bool boolOr(bool dflt) const {
    if (type == Type::Bool) return b;
    if (type == Type::Num) return num != 0;
    if (type == Type::Str) {
      std::string s = str;
      for (auto& c : s) c = static_cast<char>(tolower((unsigned char)c));
      if (s == "true" || s == "1" || s == "yes") return true;
      if (s == "false" || s == "0" || s == "no") return false;
    }
    return dflt;
  }
};

struct Parser {
  const char* p;
  const char* end;
  bool ok = true;

  explicit Parser(const std::string& s) : p(s.data()), end(s.data() + s.size()) {}

  void ws() { while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p++; }
  bool eat(char c) {
    ws();
    if (p < end && *p == c) { p++; return true; }
    return false;
  }
  Json parse() {
    ws();
    Json v = value();
    ws();
    if (p != end) ok = false;
    return v;
  }
  Json value() {
    ws();
    if (p >= end) { ok = false; return {}; }
    switch (*p) {
      case '{': return object();
      case '[': return array();
      case '"': { Json j; j.type = Json::Type::Str; j.str = string(); return j; }
      case 't': return literal("true", Json::boolean(true));
      case 'f': return literal("false", Json::boolean(false));
      case 'n': return literal("null", Json());
      default: return number();
    }
  }
  Json literal(const char* word, Json v) {
    for (const char* w = word; *w; w++, p++) {
      if (p >= end || *p != *w) { ok = false; return {}; }
    }
    return v;
  }
  Json number() {
    const char* s = p;
    if (p < end && (*p == '-')) p++;
    while (p < end && (isdigit((unsigned char)*p) || *p == '.' || *p == 'e' || *p == 'E' ||
                       *p == '+' || *p == '-'))
      p++;
    if (p == s) { ok = false; return {}; }
    Json j;
    j.type = Json::Type::Num;
    j.num = strtod(s, nullptr);
    return j;
  }
  std::string string() {
    std::string out;
    p++;  // opening quote
    while (p < end && *p != '"') {
      if (*p == '\\') {
        p++;
        if (p >= end) { ok = false; break; }
        switch (*p) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            if (p + 4 >= end) { ok = false; break; }
            char hex[5] = {p[1], p[2], p[3], p[4], 0};
            unsigned cp = strtoul(hex, nullptr, 16);
            p += 4;
            if (cp < 0x80) out += (char)cp;
            else if (cp < 0x800) {
              out += (char)(0xC0 | (cp >> 6));
              out += (char)(0x80 | (cp & 0x3F));
            } else {
              out += (char)(0xE0 | (cp >> 12));
              out += (char)(0x80 | ((cp >> 6) & 0x3F));
              out += (char)(0x80 | (cp & 0x3F));
            }
            break;
          }
          default: out += *p; break;
        }
        p++;
      } else {
        out += *p++;
      }
    }
    if (p < end) p++;  // closing quote
    else ok = false;  // unterminated string
    return out;
  }
  Json object() {
    Json j;
    j.type = Json::Type::Obj;
    p++;  // {
    if (eat('}')) return j;
    while (true) {
      ws();
      if (p >= end || *p != '"') { ok = false; return j; }
      std::string key = string();
      if (!eat(':')) { ok = false; return j; }
      j.obj[key] = value();
      if (eat('}')) return j;
      if (!eat(',')) { ok = false; return j; }
    }
  }
  Json array() {
    Json j;
    j.type = Json::Type::Arr;
    p++;  // [
    if (eat(']')) return j;
    while (true) {
      j.arr.push_back(value());
      if (eat(']')) return j;
      if (!eat(',')) { ok = false; return j; }
    }
  }
};

static Json ParseJson(const std::string& s, bool& ok) {
  Parser p(s);
  Json v = p.parse();
  ok = p.ok;
  return v;
}

static void EscapeInto(const std::string& s, std::string& out) {
  for (char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if ((unsigned char)c < 0x20) {
          char buf[8];
          snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += c;
        }
    }
  }
}

static void DumpInto(const Json& j, std::string& out) {
  switch (j.type) {
    case Json::Type::Null: out += "null"; break;
    case Json::Type::Bool: out += j.b ? "true" : "false"; break;
    case Json::Type::Num: {
      char buf[32];
      snprintf(buf, sizeof(buf), "%.17g", j.num);
      out += buf;
      break;
    }
    case Json::Type::Str: out += '"'; EscapeInto(j.str, out); out += '"'; break;
    case Json::Type::Arr:
      out += '[';
      for (size_t i = 0; i < j.arr.size(); i++) {
        if (i) out += ',';
        DumpInto(j.arr[i], out);
      }
      out += ']';
      break;
    case Json::Type::Obj:
      out += '{';
      { bool first = true;
        for (auto& kv : j.obj) {
          if (!first) out += ',';
          first = false;
          out += '"'; EscapeInto(kv.first, out); out += "\":";
          DumpInto(kv.second, out);
        } }
      out += '}';
      break;
  }
}

static std::string Dump(const Json& j) {
  std::string out;
  DumpInto(j, out);
  return out;
}


}  // namespace adapter
