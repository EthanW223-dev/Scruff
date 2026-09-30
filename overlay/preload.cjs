// The overlay page's only access to Electron: a few narrow calls, no Node.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("scruffOverlay", {
  setInteractive: (on, hud) => ipcRenderer.send("interactive", { on: Boolean(on), hud: Boolean(hud) }),
  setPanel: (open) => ipcRenderer.send("panel", Boolean(open)),
  trackGame: (pid) => ipcRenderer.send("track", pid),
  captureGame: () => ipcRenderer.invoke("capture"),
  hotkeys: () => ipcRenderer.invoke("hotkeys"),
  onPanel: (callback) => ipcRenderer.on("panel", (_e, open) => callback(open)),
  onTalk: (callback) => ipcRenderer.on("talk", () => callback()),
  // Recording state crosses windows: the orb lives in the HUD window now.
  setListening: (on) => ipcRenderer.send("listening", Boolean(on)),
  onListening: (callback) => ipcRenderer.on("listening", (_e, on) => callback(on)),
  // The standalone HUD window moves when its orb unit is dragged.
  moveHud: (x, y) => ipcRenderer.send("hud-move", { x, y }),
  getHudBounds: () => ipcRenderer.invoke("hud-bounds"),
  // Where the overlay window sits on screen; the HUD button's spot is stored in
  // screen coordinates so the game window moving never moves the button.
  getWindowBounds: () => ipcRenderer.invoke("window-bounds"),
  onWindowBounds: (callback) => ipcRenderer.on("window-bounds", (_e, bounds) => callback(bounds)),
});
