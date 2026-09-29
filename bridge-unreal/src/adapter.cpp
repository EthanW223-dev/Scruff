// Scruff Unreal bridge: WinHTTP WebSocket client + tool implementations.
//
// Speaks the adapter protocol from docs/ADAPTERS.md:
//   hello {name, game, description, tools[]} -> welcome {id, prefix}
//   call {id, tool, input} -> result {id, ok, content|error}
// Calls run on the worker thread; UE object access is read-mostly here. A production
// bridge must marshal game-thread work (spawning, UFunction calls) onto the game thread
// via the engine's task graph — marked TODO below.
#define _WINSOCKAPI_
#include <windows.h>
#include <winhttp.h>
#include <string>
#include <vector>
#include <map>
#include "ue.h"

#pragma comment(lib, "winhttp.lib")

namespace adapter {

static HINTERNET g_ws = nullptr;
static volatile bool g_running = false;

// --- tiny JSON writer (enough for the protocol) ---
static std::string JsonEscape(const std::string& s) {
  std::string o;
  for (char c : s) {
    if (c == '"') o += "\\\"";
    else if (c == '\\') o += "\\\\";
    else if (c == '\n') o += "\\n";
    else o += c;
  }
  return o;
}

// --- tools this bridge exposes (mirrors the Unity bridge's surface) ---
static const char* kToolsJson = R"([
 {"name":"find","description":"Find live objects by part of their name or class. Returns ids for the other tools.","input_schema":{"name":"string?","class":"string?","limit":"integer?"}},
 {"name":"get","description":"Read a property (e.g. Health) on an object id.","input_schema":{"id":"integer","property":"string"}},
 {"name":"set","description":"Write a property (numbers, true/false) on an object id. Returns before/after.","input_schema":{"id":"integer","property":"string","value":"any"}},
 {"name":"world","description":"Game-wide: time_dilation (1 normal, 0.5 slow-mo, 2 fast), gravity scale.","input_schema":{"time_dilation":"number?","gravity":"number?"}},
 {"name":"spawn","description":"Spawn copies of an actor near the player. NOT YET IMPLEMENTED: needs game-thread marshaling.","input_schema":{"id":"integer","count":"integer?"}}
])";

// id -> UObject* for this session. GObjects entries are stable pointers while live;
// the map is rebuilt on "find" (level changes invalidate old ids).
static std::map<int, UE::UObject*> g_known;
static int g_nextId = 1;

static std::string Find(const std::string& name, const std::string& cls, int limit) {
  g_known.clear();
  std::string out = "[";
  int n = 0;
  UE::ForEachObject([&](UE::UObject* o) {
    std::string full = o->GetFullName();
    std::string low = full;
    for (auto& c : low) c = tolower(c);
    std::string wn = name, wc = cls;
    for (auto& c : wn) c = tolower(c);
    for (auto& c : wc) c = tolower(c);
    if (!wn.empty() && low.find(wn) == std::string::npos) return true;
    if (!wc.empty()) {
      std::string cn = o->GetClass()->GetName();
      for (auto& c : cn) c = tolower(c);
      if (cn.find(wc) == std::string::npos) return true;
    }
    int id = g_nextId++;
    g_known[id] = o;
    if (n++) out += ",";
    out += "{\"id\":" + std::to_string(id) + ",\"name\":\"" + JsonEscape(full) + "\"}";
    return n < limit;
  });
  return out + "]";
}

// Minimal flat-JSON field grabber for the call envelope: {"type":"call","id":"7","tool":"get","input":{...}}
static std::string Field(const std::string& json, const std::string& key) {
  std::string k = "\"" + key + "\"";
  size_t i = json.find(k);
  if (i == std::string::npos) return "";
  i = json.find(':', i + k.size());
  if (i == std::string::npos) return "";
  i++;
  while (i < json.size() && (json[i] == ' ' || json[i] == '"')) i++;
  size_t j = i;
  while (j < json.size() && json[j] != '"' && json[j] != ',' && json[j] != '}') j++;
  return json.substr(i, j - i);
}

static void Send(const std::string& text) {
  if (!g_ws) return;
  WinHttpWebSocketSend(g_ws, WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
                       (void*)text.data(), (DWORD)text.size());
}

static void SendResult(const std::string& id, bool ok, const std::string& content) {
  std::string msg = "{\"type\":\"result\",\"id\":\"" + JsonEscape(id) + "\",\"ok\":" +
                    (ok ? "true" : "false") + "," + (ok ? "\"content\":" : "\"error\":") + "\"" +
                    JsonEscape(content) + "\"}";
  Send(msg);
}

static void HandleCall(const std::string& msg) {
  std::string id = Field(msg, "id");
  std::string tool = Field(msg, "tool");
  std::string input = msg.substr(msg.find("\"input\""));
  if (tool == "find") {
    SendResult(id, true, Find(Field(input, "name"), Field(input, "class"), 30));
    return;
  }
  int objId = atoi(Field(input, "id").c_str());
  auto it = g_known.find(objId);
  if (tool != "world" && it == g_known.end()) {
    SendResult(id, false, "Unknown object id. Call find first (ids reset on level change).");
    return;
  }
  UE::UObject* obj = tool == "world" ? nullptr : it->second;
  if (tool == "get") {
    float f; UE::int32 n; bool b;
    std::string prop = Field(input, "property");
    if (UE::GetPropertyFloat(obj, prop, f)) SendResult(id, true, std::to_string(f));
    else if (UE::GetPropertyInt(obj, prop, n)) SendResult(id, true, std::to_string(n));
    else if (UE::GetPropertyBool(obj, prop, b)) SendResult(id, true, b ? "true" : "false");
    else SendResult(id, false, "No readable float/int/bool property '" + prop + "'.");
  } else if (tool == "set") {
    std::string prop = Field(input, "property"), val = Field(input, "value");
    float f; UE::int32 n;
    bool done = false, ok = false;
    if (UE::GetPropertyFloat(obj, prop, f)) {
      done = true; ok = UE::SetPropertyFloat(obj, prop, (float)atof(val.c_str()));
    } else if (UE::GetPropertyInt(obj, prop, n)) {
      done = true; ok = UE::SetPropertyInt(obj, prop, atoi(val.c_str()));
    } else if (UE::GetPropertyBool(obj, prop, f > 0)) {
      done = true; ok = UE::SetPropertyBool(obj, prop, val == "true" || val == "1");
    }
    SendResult(id, ok && done, done ? (ok ? "Set." : "Write failed.") : "No writable property '" + prop + "'.");
  } else if (tool == "world") {
    // TODO: resolve UWorld/GameState and set TimeDilation via the game thread.
    SendResult(id, false, "world: not yet implemented (needs game-thread marshaling).");
  } else if (tool == "spawn") {
    SendResult(id, false, "spawn: not yet implemented (needs game-thread marshaling).");
  } else {
    SendResult(id, false, "Unknown tool '" + tool + "'.");
  }
}

static std::wstring ToWide(const std::string& s) {
  std::wstring o(s.size(), 0);
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, o.data(), (int)o.size());
  return o;
}

static DWORD WINAPI Worker(void*) {
  const std::string url = "ws://127.0.0.1:7777/ws/adapter";
  while (g_running) {
    HINTERNET sess = WinHttpOpen(L"ScruffUnrealBridge", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                 WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    HINTERNET conn = sess ? WinHttpConnect(sess, L"127.0.0.1", 7777, 0) : nullptr;
    HINTERNET req = nullptr;
    if (conn) {
      req = WinHttpOpenRequest(conn, L"GET", L"/ws/adapter", nullptr, WINHTTP_NO_REFERER,
                               WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
    }
    bool up = false;
    if (req && WinHttpSetOption(req, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0) &&
        WinHttpSendRequest(req, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
        WinHttpReceiveResponse(req, nullptr)) {
      g_ws = WinHttpWebSocketCompleteUpgrade(req, 0);
      up = g_ws != nullptr;
    }
    if (up) {
      std::string hello = std::string("{\"type\":\"hello\",\"name\":\"Scruff Unreal bridge\",") +
                          "\"game\":\"Unreal game\",\"description\":\"Live UObject access (experimental).\","
                          "\"tools\":" + kToolsJson + "}";
      Send(hello);
      char buf[65536];
      while (g_running) {
        DWORD read = 0;
        WINHTTP_WEB_SOCKET_BUFFER_TYPE type;
        DWORD err = WinHttpWebSocketReceive(g_ws, buf, sizeof(buf) - 1, &read, &type);
        if (err != ERROR_SUCCESS || read == 0) break;
        buf[read] = 0;
        std::string msg(buf);
        if (msg.find("\"type\":\"call\"") != std::string::npos ||
            msg.find("\"type\": \"call\"") != std::string::npos) {
          HandleCall(msg);
        }
      }
      WinHttpWebSocketClose(g_ws, 1000, nullptr, 0);
      g_ws = nullptr;
    }
    if (req) WinHttpCloseHandle(req);
    if (conn) WinHttpCloseHandle(conn);
    if (sess) WinHttpCloseHandle(sess);
    for (int i = 0; i < 20 && g_running; i++) Sleep(100);
  }
  return 0;
}

void Start(const char* /*hubUrl*/) {
  if (g_running) return;
  g_running = true;
  CreateThread(nullptr, 0, Worker, nullptr, 0, nullptr);
}

void Stop() { g_running = false; }

}  // namespace adapter
