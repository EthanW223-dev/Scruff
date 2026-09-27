// The overlay page's only access to Electron: a few narrow calls, no Node.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("scruffOverlay", {
  setInteractive: (on) => ipcRenderer.send("interactive", Boolean(on)),
  setPanel: (open) => ipcRenderer.send("panel", Boolean(open)),
  trackGame: (pid) => ipcRenderer.send("track", pid),
  captureGame: () => ipcRenderer.invoke("capture"),
  hotkeys: () => ipcRenderer.invoke("hotkeys"),
  onPanel: (callback) => ipcRenderer.on("panel", (_e, open) => callback(open)),
  onTalk: (callback) => ipcRenderer.on("talk", () => callback()),
});
