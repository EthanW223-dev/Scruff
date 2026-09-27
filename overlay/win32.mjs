// Finding and following a game's window on Windows (user32 / dwmapi via koffi).
import koffi from "koffi";

const GW_OWNER = 4;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;

let api = null;
function load() {
  if (api) return api;
  const user32 = koffi.load("user32.dll");
  const dwmapi = koffi.load("dwmapi.dll");
  koffi.pointer("HWND", koffi.opaque());
  koffi.struct("RECT", { left: "int32_t", top: "int32_t", right: "int32_t", bottom: "int32_t" });
  koffi.proto("int __stdcall EnumWindowsProc(HWND hwnd, intptr_t lParam)");
  api = {
    EnumWindows: user32.func("int __stdcall EnumWindows(EnumWindowsProc *lpEnumFunc, intptr_t lParam)"),
    GetWindowThreadProcessId: user32.func("uint32_t __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ uint32_t *lpdwProcessId)"),
    IsWindowVisible: user32.func("int __stdcall IsWindowVisible(HWND hWnd)"),
    IsWindow: user32.func("int __stdcall IsWindow(HWND hWnd)"),
    IsIconic: user32.func("int __stdcall IsIconic(HWND hWnd)"),
    GetWindow: user32.func("HWND __stdcall GetWindow(HWND hWnd, uint32_t uCmd)"),
    GetWindowRect: user32.func("int __stdcall GetWindowRect(HWND hWnd, _Out_ RECT *lpRect)"),
    GetForegroundWindow: user32.func("HWND __stdcall GetForegroundWindow()"),
    SetForegroundWindow: user32.func("int __stdcall SetForegroundWindow(HWND hWnd)"),
    DwmGetWindowAttribute: dwmapi.func(
      "long __stdcall DwmGetWindowAttribute(HWND hwnd, uint32_t dwAttribute, _Out_ RECT *pvAttribute, uint32_t cbAttribute)",
    ),
  };
  return api;
}

/** A window handle as a plain number-like key (BigInt), comparable across calls. */
export function handleId(hwnd) {
  return hwnd ? koffi.address(hwnd) : 0n;
}

/** The game's main window: its largest visible, unowned top-level window. */
export function findGameWindow(pid) {
  const a = load();
  let best = null;
  let bestArea = 0;
  a.EnumWindows((hwnd) => {
    const owner = [0];
    a.GetWindowThreadProcessId(hwnd, owner);
    if (owner[0] === pid && a.IsWindowVisible(hwnd) && !a.GetWindow(hwnd, GW_OWNER)) {
      const r = bounds(hwnd);
      const area = r ? r.width * r.height : 0;
      if (area > bestArea) {
        best = hwnd;
        bestArea = area;
      }
    }
    return 1;
  }, 0);
  return best;
}

/** Window bounds in physical pixels, without the invisible resize border DWM adds. */
export function bounds(hwnd) {
  const a = load();
  const rect = {};
  const ok = a.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, 16) === 0 || a.GetWindowRect(hwnd, rect);
  if (!ok) return null;
  return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
}

export function isAlive(hwnd) {
  return Boolean(hwnd) && Boolean(load().IsWindow(hwnd));
}

export function isMinimized(hwnd) {
  return Boolean(load().IsIconic(hwnd));
}

export function foregroundId() {
  return handleId(load().GetForegroundWindow());
}

export function focus(hwnd) {
  if (hwnd) load().SetForegroundWindow(hwnd);
}
