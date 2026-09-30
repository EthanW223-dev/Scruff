// Telos Unreal bridge: DLL entry. Inject while the game is running; the worker thread
// finds GObjects/GNames and connects to the hub. Data-property reads/writes are direct
// memory operations through engine reflection; nothing calls game code.
#include <windows.h>

namespace adapter {
void Start(const char* hubUrl);  // nullptr -> hub.txt next to the DLL, else the default
void Stop();
}  // namespace adapter

static DWORD WINAPI InitThread(void*) {
  // Give the engine time to finish booting (GObjects isn't valid mid-load).
  Sleep(15000);
  adapter::Start(nullptr);
  return 0;
}

BOOL APIENTRY DllMain(HMODULE, DWORD reason, void*) {
  if (reason == DLL_PROCESS_ATTACH) {
    DisableThreadLibraryCalls(GetModuleHandleA("TelosBridgeUE.dll"));
    CreateThread(nullptr, 0, InitThread, nullptr, 0, nullptr);
  } else if (reason == DLL_PROCESS_DETACH) {
    adapter::Stop();
  }
  return TRUE;
}
