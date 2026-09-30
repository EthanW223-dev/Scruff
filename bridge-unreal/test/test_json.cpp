// Host-side unit test for the Unreal bridge's JSON parser/serializer
// (bridge-unreal/src/json.h). Compiles with the native compiler: `make test`.
// The DLL itself can only be validated against a real Unreal game, but the
// protocol layer it speaks is pinned down here.
#include <cassert>
#include <cstdio>
#include <string>

#include "../src/json.h"

using adapter::Json;
using adapter::ParseJson;
using adapter::Dump;

static int failures = 0;
#define CHECK(cond) do { \
  if (!(cond)) { printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); failures++; } \
} while (0)

static Json mustParse(const std::string& s) {
  bool ok = false;
  Json v = ParseJson(s, ok);
  CHECK(ok);
  return v;
}

int main() {
  // Scalars and nesting.
  {
    Json v = mustParse(R"({"tool":"get","input":{"name":"Player/Health","min":0,"max":100,"tags":["a","b"],"flag":true,"nothing":null}})");
    CHECK(v.at("tool").strOr("") == "get");
    CHECK(v.at("input").at("name").strOr("") == "Player/Health");
    CHECK(v.at("input").at("min").numOr(-1) == 0);
    CHECK(v.at("input").at("max").numOr(-1) == 100);
    CHECK(v.at("input").at("tags").arr.size() == 2);
    CHECK(v.at("input").at("tags").arr[1].strOr("") == "b");
    CHECK(v.at("input").at("flag").boolOr(false) == true);
    CHECK(v.at("input").at("nothing").isNull());
    CHECK(v.at("missing").isNull());
    CHECK(v.at("missing").strOr("dflt") == "dflt");
  }
  // Numbers: ints, negatives, fractions, exponents.
  {
    Json v = mustParse("[1,-2,3.5,1e3,2.5e-2]");
    CHECK(v.arr.size() == 5);
    CHECK(v.arr[0].numOr(0) == 1);
    CHECK(v.arr[1].numOr(0) == -2);
    CHECK(v.arr[2].numOr(0) == 3.5);
    CHECK(v.arr[3].numOr(0) == 1000);
    CHECK(v.arr[4].numOr(0) == 0.025);
  }
  // Escapes round-trip: quotes, backslashes, control chars, \u00e9.
  {
    Json v = mustParse(R"("a\"b\\c\nd\te\u0041")");
    CHECK(v.strOr("") == "a\"b\\c\nd\teA");
    bool ok = false;
    Json w = ParseJson(Dump(v), ok);
    CHECK(ok && w.strOr("") == v.strOr(""));
  }
  // Deep nesting round-trips byte-identical through the serializer.
  {
    std::string nested = R"({"a":[1,{"b":[true,false,null]}],"c":{"d":"e"}})";
    bool ok = false;
    Json v = ParseJson(nested, ok);
    CHECK(ok);
    bool ok2 = false;
    Json w = ParseJson(Dump(v), ok2);
    CHECK(ok2 && Dump(w) == Dump(v));
  }
  // Malformed input is rejected, not silently accepted.
  {
    const char* bad[] = {
      "{", "[1,", "{\"a\":}", "{\"a\" 1}", "[1 2]", "tru", "nul", "\"unterminated",
      "{\"a\":1} trailing", "", "[,]", "{,}",
    };
    for (const char* s : bad) {
      bool ok = true;
      ParseJson(s, ok);
      CHECK(!ok);
    }
  }
  // Empty containers.
  {
    Json o = mustParse("{}");
    CHECK(o.type == Json::Type::Obj && o.obj.empty());
    Json a = mustParse("[]");
    CHECK(a.type == Json::Type::Arr && a.arr.empty());
    CHECK(Dump(o) == "{}");
    CHECK(Dump(a) == "[]");
  }
  // Coercion helpers used by the tool handlers.
  {
    Json t = mustParse(R"({"n":"42","b":"yes","f":"0"})");
    CHECK(t.at("n").numOr(0) == 42);
    CHECK(t.at("b").boolOr(false) == true);
    CHECK(t.at("f").boolOr(true) == false);
    CHECK(mustParse("true").boolOr(false) == true);
    CHECK(mustParse("0").boolOr(true) == false);
  }
  // An adapter result serializes to structured content the hub can parse.
  {
    Json r;
    r.type = Json::Type::Obj;
    r.obj["ok"] = Json::boolean(true);
    Json content;
    content.type = Json::Type::Arr;
    Json row;
    row.type = Json::Type::Obj;
    row.obj["name"] = Json::string("Player");
    row.obj["health"] = Json::number(87.5);
    content.arr.push_back(row);
    r.obj["content"] = content;
    std::string s = Dump(r);
    bool ok = false;
    Json back = ParseJson(s, ok);
    CHECK(ok);
    CHECK(back.at("ok").boolOr(false) == true);
    CHECK(back.at("content").arr[0].at("health").numOr(0) == 87.5);
  }

  if (failures == 0) printf("json: all tests passed\n");
  return failures ? 1 : 0;
}
