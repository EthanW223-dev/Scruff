// Scruff Unreal bridge: DLL entry. Inject while the game is running; the worker thread
// finds GObjects and connects to the hub. Nothing runs on the game thread.
#include <windows.h>

namespace adapter {
void Start(const char* hubUrl);
void Stop();
}  // namespace adapter

static DWORD WINAPI InitThread(void*) {
  // Give the engine time to finish booting (GObjects isn't valid mid-load).
  Sleep(15000);
  adapter::Start("ws://127.0.0.1:7777/ws/adapter");
  return 0;
}

BOOL APIENTRY DllMain(HMODULE, DWORD reason, void*) {
  if (reason == DLL_PROCESS_ATTACH) {
    DisableThreadLibraryCalls(GetModuleHandleA("ScruffUnrealBridge.dll"));
    CreateThread(nullptr, 0, InitThread, nullptr, 0, nullptr);
  } else if (reason == DLL_PROCESS_DETACH) {
    adapter::Stop();
  }
  return TRUE;
}
