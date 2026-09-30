// Telos Unreal bridge: WinHTTP WebSocket client + tool implementations.
//
// Speaks the adapter protocol from docs/ADAPTERS.md:
//   hello {name, game, description, tools[]} -> welcome {id, prefix}
//   call {id, tool, input} -> result {id, ok, content|error}
//
// Tools (all reads/writes go through the engine's own reflection, so they follow
// renames and version drift; GObjects/GNames patterns are validated per game):
//   find  - locate objects by name/class substring  -> [{id, name, class}]
//   get   - read a property (float/int/bool/string) -> the value as JSON
//   set   - write a property                        -> {before, after} as JSON
//   world - read/set UWorld.TimeDilation (slow-mo)  -> {time_dilation}
//
// Honest limits, documented in the README:
// - Data-property reads/writes are direct memory operations (same as the memory-
//   editing path Telos already uses); they do not need the game thread.
// - UFunction invocation (calling game code, SpawnActor) is NOT implemented: there
//   is no stable cross-version way to call ProcessEvent without engine headers.
//   `spawn` is therefore not advertised. When it lands, it will need game-thread
//   marshaling; the worker thread below is where that queue would drain.
#include <windows.h>
#include <winhttp.h>

#include <cctype>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

#include "ue.h"
#include "json.h"

#pragma comment(lib, "winhttp.lib")  // MSVC only; mingw links -lwinhttp via the Makefile

namespace adapter {

// --------------------------------------------------------------- websocket ----

class WsClient {
 public:
  WsClient() = default;
  ~WsClient() { Close(); }

  bool Connect(const std::string& url) {
    // url: ws://host:port/path
    std::string u = url;
    if (u.rfind("ws://", 0) == 0) u = u.substr(5);
    size_t slash = u.find('/');
    std::string hostport = slash == std::string::npos ? u : u.substr(0, slash);
    std::string path = slash == std::string::npos ? "/" : u.substr(slash);
    size_t colon = hostport.find(':');
    std::wstring host(hostport.begin(), hostport.begin() + (colon == std::string::npos ? hostport.size() : colon));
    INTERNET_PORT port = colon == std::string::npos
                            ? 80
                            : (INTERNET_PORT)atoi(hostport.c_str() + colon + 1);
    std::wstring wpath(path.begin(), path.end());

    session_ = WinHttpOpen(L"TelosUnrealBridge/1.0", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                          nullptr, nullptr, 0);
    if (!session_) return false;
    conn_ = WinHttpConnect(session_, host.c_str(), port, 0);
    if (!conn_) return false;
    req_ = WinHttpOpenRequest(conn_, L"GET", wpath.c_str(), nullptr, nullptr, nullptr,
                              WINHTTP_FLAG_SECURE * 0);
    if (!req_) return false;
    if (!WinHttpSetOption(req_, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0))
      return false;
    if (!WinHttpSendRequest(req_, WINHTTP_NO_ADDITIONAL_HEADERS, 0, nullptr, 0, 0, 0))
      return false;
    if (!WinHttpReceiveResponse(req_, nullptr)) return false;
    ws_ = WinHttpWebSocketCompleteUpgrade(req_, 0);
    req_ = nullptr;  // ownership transferred
    return ws_ != nullptr;
  }

  bool Send(const std::string& msg) {
    if (!ws_) return false;
    return WinHttpWebSocketSend(ws_, WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
                                (void*)msg.data(), (DWORD)msg.size()) == ERROR_SUCCESS;
  }

  // Blocking receive of one whole message. Empty string = closed/error.
  std::string Receive() {
    if (!ws_) return "";
    std::string out;
    while (true) {
      BYTE buf[8192];
      DWORD read = 0;
      WINHTTP_WEB_SOCKET_BUFFER_TYPE type;
      DWORD status = WinHttpWebSocketReceive(ws_, buf, sizeof(buf), &read, &type);
      if (status != ERROR_SUCCESS) return "";
      out.append((char*)buf, read);
      if (type == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE) return "";
      if (type == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE) return out;
      // Fragments (binary/fragment types): keep accumulating.
    }
  }

  void Close() {
    if (ws_) {
      WinHttpWebSocketClose(ws_, WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
      WinHttpCloseHandle(ws_);
      ws_ = nullptr;
    }
    if (req_) { WinHttpCloseHandle(req_); req_ = nullptr; }
    if (conn_) { WinHttpCloseHandle(conn_); conn_ = nullptr; }
    if (session_) { WinHttpCloseHandle(session_); session_ = nullptr; }
  }

 private:
  HINTERNET session_ = nullptr, conn_ = nullptr, req_ = nullptr, ws_ = nullptr;
};

// ----------------------------------------------------------------- helpers ----

static std::string GameName() {
  char path[MAX_PATH];
  DWORD n = GetModuleFileNameA(nullptr, path, MAX_PATH);
  std::string exe = n ? std::string(path, n) : std::string();
  size_t slash = exe.find_last_of("\\/");
  std::string base = slash == std::string::npos ? exe : exe.substr(slash + 1);
  // Foo-Win64-Shipping.exe -> Foo
  size_t dash = base.find('-');
  if (dash != std::string::npos) base = base.substr(0, dash);
  size_t dot = base.rfind('.');
  if (dot != std::string::npos) base = base.substr(0, dot);
  return base.empty() ? "Unreal game" : base;
}

// Hub URL: TelosBridgeUE/hub.txt next to this DLL (written by the Telos installer),
// else the hub default.
static std::string HubUrl() {
  char dllPath[MAX_PATH];
  std::string def = "ws://127.0.0.1:7777/ws/adapter";
  HMODULE self = nullptr;
  GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, (LPCSTR)&HubUrl, &self);
  if (self && GetModuleFileNameA(self, dllPath, MAX_PATH)) {
    std::string dir(dllPath);
    size_t slash = dir.find_last_of("\\/");
    std::string hubFile =
        (slash == std::string::npos ? dir : dir.substr(0, slash)) + "\\hub.txt";
    FILE* f = fopen(hubFile.c_str(), "r");
    if (f) {
      char line[512];
      if (fgets(line, sizeof(line), f)) {
        std::string u = line;
        while (!u.empty() && (u.back() == '\n' || u.back() == '\r' || u.back() == ' '))
          u.pop_back();
        if (u.rfind("ws://", 0) == 0) {
          fclose(f);
          return u;
        }
      }
      fclose(f);
    }
  }
  return def;
}

// Object ids: stable per session, hex pointer string.
static std::string ObjId(UE::UObject* o) {
  char buf[24];
  snprintf(buf, sizeof(buf), "%p", (void*)o);
  return buf;
}

static UE::UObject* ObjById(const std::string& id) {
  if (id.empty()) return nullptr;
  char* end = nullptr;
  unsigned long long addr = strtoull(id.c_str(), &end, 16);  // %p prints hex
  if (end == id.c_str()) return nullptr;
  auto* o = reinterpret_cast<UE::UObject*>((uintptr_t)addr);
  return UE::CanRead(o, sizeof(UE::UObject)) ? o : nullptr;
}

// ------------------------------------------------------------------- tools ----

static Json ToolFind(const Json& input) {
  std::string name = input.at("name").strOr("");
  std::string cls = input.at("class").strOr("");
  int limit = (int)input.at("limit").numOr(25);
  if (limit < 1) limit = 1;
  if (limit > 200) limit = 200;
  Json out;
  out.type = Json::Type::Arr;
  if (!UE::GObjects()) return out;  // caller reports the degraded-mode error
  UE::ForEachObject([&](UE::UObject* o) {
    if ((int)out.arr.size() >= limit) return false;
    std::string full = o->GetFullName();
    if (full.empty()) return true;
    std::string lf = full, ln = name, lc = cls;
    for (auto& c : lf) c = (char)tolower((unsigned char)c);
    for (auto& c : ln) c = (char)tolower((unsigned char)c);
    for (auto& c : lc) c = (char)tolower((unsigned char)c);
    if (!ln.empty() && lf.find(ln) == std::string::npos) return true;
    if (!lc.empty() && lf.find(lc) == std::string::npos) return true;
    Json e;
    e.type = Json::Type::Obj;
    e.obj["id"] = Json::string(ObjId(o));
    e.obj["name"] = Json::string(full);
    out.arr.push_back(e);
    return true;
  });
  return out;
}

static Json PropValueJson(UE::UObject* obj, const std::string& prop) {
  float f;
  if (UE::GetPropertyFloat(obj, prop, f)) return Json::number(f);
  UE::int32 i;
  if (UE::GetPropertyInt(obj, prop, i)) return Json::number(i);
  bool b;
  if (UE::GetPropertyBool(obj, prop, b)) return Json::boolean(b);
  std::string s;
  if (UE::GetPropertyString(obj, prop, s)) return Json::string(s);
  return Json();
}

static Json ToolGet(const Json& input, std::string& err) {
  UE::UObject* obj = ObjById(input.at("id").strOr(""));
  if (!obj) { err = "object id not found (ids change when the level reloads)"; return {}; }
  std::string prop = input.at("property").strOr("");
  Json v = PropValueJson(obj, prop);
  if (v.isNull()) { err = "property '" + prop + "' not found or unreadable on that object"; }
  return v;
}

static Json ToolSet(const Json& input, std::string& err) {
  UE::UObject* obj = ObjById(input.at("id").strOr(""));
  if (!obj) { err = "object id not found (ids change when the level reloads)"; return {}; }
  std::string prop = input.at("property").strOr("");
  Json v = input.at("value");
  Json before = PropValueJson(obj, prop);
  bool ok = false;
  // Coerce by the incoming JSON type; fall back to the property's own type.
  if (v.type == Json::Type::Bool) {
    ok = UE::SetPropertyBool(obj, prop, v.b);
  } else if (v.type == Json::Type::Num) {
    float f;
    if (UE::GetPropertyFloat(obj, prop, f))
      ok = UE::SetPropertyFloat(obj, prop, (float)v.num);
    else {
      UE::int32 i;
      if (UE::GetPropertyInt(obj, prop, i)) ok = UE::SetPropertyInt(obj, prop, (UE::int32)v.num);
    }
  } else if (v.type == Json::Type::Str) {
    float f;
    bool b;
    UE::int32 i;
    if (UE::GetPropertyBool(obj, prop, b)) ok = UE::SetPropertyBool(obj, prop, v.boolOr(b));
    else if (UE::GetPropertyFloat(obj, prop, f))
      ok = UE::SetPropertyFloat(obj, prop, (float)v.numOr(f));
    else if (UE::GetPropertyInt(obj, prop, i))
      ok = UE::SetPropertyInt(obj, prop, (UE::int32)v.numOr(i));
    else
      err = "string properties are read-only in this bridge";
  } else {
    err = "value must be a number, boolean, or numeric string";
  }
  if (!ok && err.empty()) err = "property '" + prop + "' not found or not writable";
  Json out;
  out.type = Json::Type::Obj;
  out.obj["before"] = before;
  out.obj["after"] = PropValueJson(obj, prop);
  return out;
}

static Json ToolWorld(const Json& input, std::string& err) {
  UE::UObject* world = UE::FindWorld();
  if (!world) { err = "no UWorld found (GObjects not resolved or game not in a level)"; return {}; }
  Json v = input.at("time_dilation");
  Json out;
  out.type = Json::Type::Obj;
  if (!v.isNull()) {
    float want = (float)v.numOr(1.0);
    if (want < 0.01) want = 0.01f;
    if (want > 10) want = 10;
    float before = 1;
    UE::GetPropertyFloat(world, "TimeDilation", before);
    if (!UE::SetPropertyFloat(world, "TimeDilation", want)) {
      err = "UWorld has no writable TimeDilation property on this version";
      return {};
    }
    out.obj["before"] = Json::number(before);
    out.obj["after"] = Json::number(want);
  } else {
    float cur = 1;
    if (!UE::GetPropertyFloat(world, "TimeDilation", cur)) {
      err = "UWorld has no readable TimeDilation property on this version";
      return {};
    }
    out.obj["time_dilation"] = Json::number(cur);
  }
  return out;
}

// ------------------------------------------------------------------ runner ----

static volatile bool g_stop = false;

static std::string ToolDefs() {
  // Valid JSON Schema input_schemas (the hub forwards them to the model).
  return R"json([
{"name":"find","description":"Find Unreal objects by name/class substring. Returns [{id,name}]. Ids are session-local; re-find after level changes.","input_schema":{"type":"object","properties":{"name":{"type":"string","description":"substring of the object's full name case-insensitive"},"class":{"type":"string","description":"optional substring of the class/outer path"},"limit":{"type":"integer","description":"max results, default 25"}},"required":["name"]}},
{"name":"get","description":"Read a property (float/int/bool/name/string) from an object found by find.","input_schema":{"type":"object","properties":{"id":{"type":"string","description":"object id from find"},"property":{"type":"string","description":"property name, e.g. Health"}},"required":["id","property"]}},
{"name":"set","description":"Write a property on an object found by find. Returns {before,after}.","input_schema":{"type":"object","properties":{"id":{"type":"string","description":"object id from find"},"property":{"type":"string","description":"property name"},"value":{"description":"new value: number or boolean"}},"required":["id","property","value"]}},
{"name":"world","description":"Read or set world time dilation (slow-mo). Omit time_dilation to read.","input_schema":{"type":"object","properties":{"time_dilation":{"type":"number","description":"0.01-10, 1 is normal speed"}}}}
])json";
}

static void Run(const char* hubUrl) {
  while (!g_stop) {
    WsClient ws;
    if (!ws.Connect(hubUrl ? hubUrl : HubUrl().c_str())) {
      Sleep(5000);
      continue;
    }
    std::string hello = std::string("{\"type\":\"hello\",\"name\":") +
                        Dump(Json::string(std::string("Unreal bridge: ") + GameName())) +
                        ",\"game\":\"unreal\"," +
                        "\"description\":\"Unreal Engine 4.25+/5.x adapter: object "
                        "search and property read/write through engine reflection. "
                        "Untested against real games; patterns validated per game.\"," +
                        "\"tools\":" + ToolDefs() + "}";
    if (!ws.Send(hello)) {
      Sleep(5000);
      continue;
    }
    // Wait for welcome (ignore anything else until it arrives).
    std::string prefix;
    for (;;) {
      std::string msg = ws.Receive();
      if (msg.empty()) break;
      bool ok = false;
      Json m = ParseJson(msg, ok);
      if (ok && m.at("type").strOr("") == "welcome") {
        prefix = m.at("prefix").strOr("");
        break;
      }
    }
    if (prefix.empty()) {
      Sleep(5000);
      continue;
    }
    // Serve calls until the socket dies.
    for (;;) {
      std::string msg = ws.Receive();
      if (msg.empty()) break;
      bool ok = false;
      Json m = ParseJson(msg, ok);
      if (!ok || m.at("type").strOr("") != "call") continue;
      std::string id = m.at("id").strOr("");
      std::string tool = m.at("tool").strOr("");
      Json input = m.at("input");
      std::string err;
      Json result;
      if (tool == "find") {
        if (!UE::GObjects())
          err = "GObjects not resolved in this game build (pattern mismatch); "
                "structural tools unavailable, memory editing still works";
        else
          result = ToolFind(input);
      } else if (tool == "get") {
        result = ToolGet(input, err);
      } else if (tool == "set") {
        result = ToolSet(input, err);
      } else if (tool == "world") {
        result = ToolWorld(input, err);
      } else {
        err = std::string("unknown tool: ") + tool;
      }
      Json resp;
      resp.type = Json::Type::Obj;
      resp.obj["type"] = Json::string("result");
      resp.obj["id"] = Json::string(id);
      resp.obj["ok"] = Json::boolean(err.empty());
      if (err.empty())
        resp.obj["content"] = result;
      else
        resp.obj["error"] = Json::string(err);
      if (!ws.Send(Dump(resp))) break;
    }
    Sleep(5000);
  }
}

void Start(const char* hubUrl) {
  static bool started = false;
  if (started) return;
  started = true;
  std::string* url = new std::string(hubUrl ? hubUrl : HubUrl());
  CreateThread(nullptr, 0,
               [](void* p) -> DWORD {
                 std::string* u = static_cast<std::string*>(p);
                 Run(u->c_str());
                 delete u;
                 return 0;
               },
               url, 0, nullptr);
}

void Stop() { g_stop = true; }

}  // namespace adapter
