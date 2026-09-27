// Scruff's in-game overlay: a transparent, click-through window pinned over the game.
//
//   npm start        starts the overlay (and the Scruff hub, if it isn't running yet)
//
// Hotkeys work while the game has focus: one opens the panel (chat, mods, undo), one is
// push-to-talk. The overlay follows the game window on Windows and hides when you alt-tab.
import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, screen, session, shell, Tray } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.SCRUFF_PORT ?? 7777);
const base = `http://127.0.0.1:${port}`;
const HOTKEYS = {
  panel: process.env.SCRUFF_HOTKEY_PANEL ?? "CommandOrControl+Shift+S",
  talk: process.env.SCRUFF_HOTKEY_TALK ?? "CommandOrControl+Shift+Space",
};
const TRACK_MS = 250;
const isWindows = process.platform === "win32";
const win32 = isWindows ? await import("./win32.mjs") : null;

let win = null;
let tray = null;
let hub = null;
let gamePid = null;
let gameHwnd = null;
let panelOpen = false;
let lastBounds = "";

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => setPanel(true));

async function hubRunning() {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    return (await res.json()).app === "scruff";
  } catch {
    return false;
  }
}

/** Uses a running hub (npm run hub, Claude Desktop...) or starts one next to the overlay. */
async function ensureHub() {
  if (await hubRunning()) return;
  const node = process.env.npm_node_execpath || "node";
  hub = spawn(node, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "src", "index.ts")], {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  hub.on("exit", (code) => {
    hub = null;
    if (code) console.error(`The Scruff hub stopped (exit code ${code}).`);
  });
  for (let i = 0; i < 80; i++) {
    if (await hubRunning()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`The Scruff hub didn't start on port ${port}.`);
}

function createWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    ...bounds,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    title: "Scruff",
    webPreferences: {
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  // Above borderless-fullscreen games; clicks pass through to the game.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });

  // Only Scruff's own pages load here; links open in the browser.
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(base)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("did-fail-load", () => setTimeout(() => win?.loadURL(`${base}/?overlay=1`), 1500));
  win.loadURL(`${base}/?overlay=1`);
  win.once("ready-to-show", () => win.showInactive());
}

function setPanel(open) {
  if (!win) return;
  panelOpen = open;
  win.webContents.send("panel", open);
  if (open) {
    win.setIgnoreMouseEvents(false);
    win.setFocusable(true);
    win.showInactive();
    win.focus();
  } else {
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setFocusable(false);
    win.blur();
    // Give the keyboard back to the game.
    if (win32 && gameHwnd) win32.focus(gameHwnd);
  }
}

/** Keeps the overlay on top of the game window, and out of the way when the game isn't in front. */
function followGame() {
  if (!win || win.isDestroyed()) return;
  let target = null;
  let visible = true;
  if (win32 && gamePid) {
    try {
      if (!win32.isAlive(gameHwnd)) gameHwnd = win32.findGameWindow(gamePid);
      if (gameHwnd) {
        const physical = win32.bounds(gameHwnd);
        if (physical && physical.width > 0) target = screen.screenToDipRect(win, physical);
        const fg = win32.foregroundId();
        const own = win.getNativeWindowHandle().readBigUInt64LE(0);
        visible = panelOpen || (!win32.isMinimized(gameHwnd) && (fg === win32.handleId(gameHwnd) || fg === own));
      }
    } catch (err) {
      console.error("Couldn't follow the game window:", err.message);
    }
  }
  target ??= screen.getPrimaryDisplay().bounds;
  const rounded = { x: Math.round(target.x), y: Math.round(target.y), width: Math.round(target.width), height: Math.round(target.height) };
  const key = JSON.stringify(rounded);
  if (key !== lastBounds) {
    lastBounds = key;
    win.setBounds(rounded);
  }
  if (visible && !win.isVisible()) win.showInactive();
  else if (!visible && win.isVisible()) win.hide();
}

/** A screenshot of just the game window (or the screen, before a game is attached). */
async function captureGame() {
  const size = { width: 1280, height: 720 };
  const sources = await desktopCapturer.getSources({ types: ["window", "screen"], thumbnailSize: size });
  const id = win32 && gameHwnd ? `window:${win32.handleId(gameHwnd)}:` : null;
  const source = (id && sources.find((s) => s.id.startsWith(id))) ?? sources.find((s) => s.id.startsWith("screen:"));
  if (!source || source.thumbnail.isEmpty()) return null;
  return source.thumbnail.toJPEG(80).toString("base64");
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(root, "dashboard", "icon.png")).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("Scruff");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open Scruff (${HOTKEYS.panel.replace("CommandOrControl", "Ctrl")})`, click: () => setPanel(true) },
      { label: "Open the dashboard in your browser", click: () => shell.openExternal(`http://localhost:${port}`) },
      { type: "separator" },
      { label: "Quit Scruff", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => setPanel(!panelOpen));
}

ipcMain.on("interactive", (_e, on) => {
  if (!panelOpen) win?.setIgnoreMouseEvents(!on, { forward: true });
});
ipcMain.on("panel", (_e, open) => setPanel(Boolean(open)));
ipcMain.on("track", (_e, pid) => {
  gamePid = Number.isInteger(pid) ? pid : null;
  gameHwnd = null;
});
ipcMain.handle("capture", () => captureGame());
ipcMain.handle("hotkeys", () => HOTKEYS);

app.whenReady().then(async () => {
  // Push-to-talk needs the microphone and the AI menu's copy buttons the clipboard; nothing else.
  const allowed = new Set(["media", "clipboard-sanitized-write"]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  try {
    await ensureHub();
  } catch (err) {
    console.error(err.message);
    app.quit();
    return;
  }
  createWindow();
  try {
    createTray();
  } catch (err) {
    console.error("No tray icon:", err.message); // e.g. desktops without a system tray
  }
  for (const [name, accelerator] of Object.entries(HOTKEYS)) {
    const ok = globalShortcut.register(accelerator, () =>
      name === "panel" ? setPanel(!panelOpen) : win?.webContents.send("talk"),
    );
    if (!ok) console.error(`Couldn't register ${accelerator}; another app is using it. Set SCRUFF_HOTKEY_${name.toUpperCase()} in .env.`);
  }
  setInterval(followGame, TRACK_MS);
  console.log(`Scruff overlay is up. ${HOTKEYS.panel} opens it, ${HOTKEYS.talk} is push-to-talk.`);
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  hub?.kill();
});
app.on("window-all-closed", () => app.quit());
