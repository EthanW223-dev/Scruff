// Scruff's in-game overlay: a transparent, click-through window pinned over the game.
//
//   npm start        starts the overlay (and the Scruff hub, if it isn't running yet)
//
// Hotkeys work while the game has focus: one opens the panel (chat, mods, undo), one is
// push-to-talk. The overlay follows the game window on Windows and hides when you alt-tab.
import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, screen, session, shell, Tray } from "electron";
import { execSync, spawn } from "node:child_process";
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
let hudWin = null;
let tray = null;
let hub = null;
let gamePid = null;
let gameHwnd = null;
let panelOpen = false;
let lastBounds = "";

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => setPanel(true));

async function hubHealth() {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    return await res.json();
  } catch {
    return null;
  }
}

/** Short git commit of the code on disk; "unknown" when git isn't available. */
function codeVersion() {
  try {
    return (
      execSync("git rev-parse --short HEAD", {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      })
        .toString()
        .trim() || "unknown"
    );
  } catch {
    return "unknown";
  }
}

/** Uses a running hub (npm run hub, Claude Desktop...) or starts one next to the overlay. */
async function ensureHub() {
  const health = await hubHealth();
  if (health?.app === "scruff") {
    // A hub is already on the port. Reuse it only if it's running this same
    // code — after a git pull, a stale hub would silently swallow messages the
    // new dashboard sends (e.g. voice selection) instead of handling them.
    // When either side can't report a version, keep the old reuse behavior.
    const mine = codeVersion();
    if (!health.version || health.version === "unknown" || mine === "unknown" || health.version === mine) return;
    try {
      const pid = Number(fs.readFileSync(path.join(root, ".scruff", "hub.pid"), "utf8").trim());
      if (pid) process.kill(pid);
    } catch {
      // No pidfile (hub predates it): can't safely retire it; fall through and
      // let the spawn below fail loudly on the busy port instead of running stale.
    }
    for (let i = 0; i < 40 && (await hubHealth()); i++) await new Promise((r) => setTimeout(r, 250));
    if (await hubHealth()) {
      throw new Error(
        `A stale Telos hub is still on port ${port} and couldn't be retired automatically. ` +
          `Kill the node.exe running src/index.ts in Task Manager, then relaunch Telos.`,
      );
    }
  }
  const node = process.env.npm_node_execpath || "node";
  // SCRUFF_LAN=1 exposes the hub on the LAN/tailnet for phone access (the hub
  // prints a tokenized "From your phone" URL). The hub must stay a child of the
  // overlay: only the interactive session can see game window titles, so a hub
  // started anywhere else (SSH, WMI, session 0) shows an empty game list.
  const hubArgs = [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "src", "index.ts")];
  if (process.env.SCRUFF_LAN === "1") hubArgs.push("--lan");
  hub = spawn(node, hubArgs, {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  hub.on("exit", (code) => {
    hub = null;
    if (code) console.error(`The Scruff hub stopped (exit code ${code}).`);
  });
  for (let i = 0; i < 80; i++) {
    if (await hubHealth()) return;
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
    title: "Telos",
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

/** Where the standalone HUD window sits; the page never writes this directly. */
function hudPosFile() {
  return path.join(root, ".scruff", "hud-pos.json");
}
function loadHudPos() {
  try {
    const p = JSON.parse(fs.readFileSync(hudPosFile(), "utf8"));
    if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) return { x: Math.round(p.x), y: Math.round(p.y) };
  } catch {}
  return null;
}
function saveHudPos(p) {
  try {
    fs.mkdirSync(path.join(root, ".scruff"), { recursive: true });
    fs.writeFileSync(hudPosFile(), JSON.stringify({ x: Math.round(p.x), y: Math.round(p.y) }));
  } catch {}
}

/**
 * The HUD as its own separate thing: a small transparent always-on-top window
 * holding the tray (the orb unit). It never follows the game window. Until the
 * player drags it, it sits in the corner the game's theme leaves free (hud-corner);
 * once dragged, it stays exactly where it was put.
 */
const HUD_W = 520;
// Tall enough for the tray opened on a reply or the mod builder's steps; the window is
// click-through everywhere but the tray itself.
const HUD_H = 400;
/** Keep the whole HUD window on the primary display — it must never end up
 *  half off-screen (a migrated pre-window orb spot is a unit position, not a
 *  window corner, and would otherwise shove the window off the edge). */
function clampHudPos(x, y) {
  const { bounds } = screen.getPrimaryDisplay();
  return {
    x: Math.round(Math.min(Math.max(x, bounds.x), bounds.x + bounds.width - HUD_W)),
    y: Math.round(Math.min(Math.max(y, bounds.y), bounds.y + bounds.height - HUD_H)),
  };
}
function createHudWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  const saved = loadHudPos();
  const w = HUD_W;
  const h = HUD_H;
  const pos = clampHudPos(saved?.x ?? bounds.x + bounds.width - w - 40, saved?.y ?? bounds.y + 110);
  hudWin = new BrowserWindow({
    width: w,
    height: h,
    x: pos.x,
    y: pos.y,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    resizable: false,
    movable: false, // the page moves it via hud-move while dragging the unit
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    title: "Telos HUD",
    webPreferences: {
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  hudWin.setAlwaysOnTop(true, "screen-saver");
  hudWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hudWin.setIgnoreMouseEvents(true, { forward: true });
  hudWin.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(base)) e.preventDefault();
  });
  hudWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  hudWin.webContents.on("did-fail-load", () => setTimeout(() => hudWin?.loadURL(`${base}/?overlay=1&hud=1`), 1500));
  hudWin.loadURL(`${base}/?overlay=1&hud=1`);
  hudWin.once("ready-to-show", () => hudWin.showInactive());
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
    // The HUD button's spot is the user's, kept in screen coordinates by the page.
    // Tell the page the window moved so it can keep the button visually put.
    win.webContents.send("window-bounds", rounded);
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
  tray.setToolTip("Telos");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open Telos (${HOTKEYS.panel.replace(/CommandOrControl|CmdOrCtrl|Control/i, "Ctrl")})`, click: () => setPanel(true) },
      { label: "Open the dashboard in your browser", click: () => shell.openExternal(`http://localhost:${port}`) },
      { type: "separator" },
      { label: "Quit Telos", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => setPanel(!panelOpen));
}

ipcMain.on("interactive", (_e, msg) => {
  const on = Boolean(msg?.on ?? msg);
  if (msg?.hud) {
    // The HUD window: only its orb unit is ever clickable.
    hudWin?.setIgnoreMouseEvents(!on, { forward: true });
  } else if (!panelOpen) {
    win?.setIgnoreMouseEvents(!on, { forward: true });
  }
});
ipcMain.on("panel", (_e, open) => setPanel(Boolean(open)));
// Recording started/stopped in one window: the HUD window always shows it.
ipcMain.on("listening", (_e, on) => {
  if (hudWin && !hudWin.isDestroyed()) hudWin.webContents.send("listening", Boolean(on));
});
// Dragging the orb unit moves the standalone HUD window; the spot is saved.
ipcMain.on("hud-move", (_e, p) => {
  if (hudWin && !hudWin.isDestroyed() && Number.isFinite(p?.x) && Number.isFinite(p?.y)) {
    const { x, y } = clampHudPos(p.x, p.y);
    hudWin.setPosition(x, y);
    saveHudPos({ x, y });
  }
});
ipcMain.handle("hud-bounds", () => (hudWin && !hudWin.isDestroyed() ? hudWin.getBounds() : null));
// A game's theme picks the corner its HUD leaves free: until the player drags the tray
// somewhere, it sits in that corner (once dragged, it stays where it was put).
ipcMain.on("hud-corner", (_e, corner) => {
  if (!hudWin || hudWin.isDestroyed() || loadHudPos() || typeof corner !== "string") return;
  const { bounds } = screen.getPrimaryDisplay();
  const margin = 24;
  const x = corner.endsWith("left") ? bounds.x + margin : bounds.x + bounds.width - HUD_W - margin;
  const y = corner.startsWith("bottom") ? bounds.y + bounds.height - HUD_H - margin : bounds.y + margin;
  hudWin.setPosition(Math.round(x), Math.round(y));
});
ipcMain.on("track", (_e, pid) => {
  gamePid = Number.isInteger(pid) ? pid : null;
  gameHwnd = null;
});
ipcMain.handle("capture", () => captureGame());
ipcMain.handle("hotkeys", () => HOTKEYS);
// The page positions the HUD button in screen coordinates; it needs the window's
// screen offset to translate them into viewport coordinates.
ipcMain.handle("window-bounds", () => (win && !win.isDestroyed() ? win.getBounds() : null));

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
  createHudWindow();
  try {
    createTray();
  } catch (err) {
    console.error("No tray icon:", err.message); // e.g. desktops without a system tray
  }
  for (const [name, accelerator] of Object.entries(HOTKEYS)) {
    const ok = globalShortcut.register(accelerator, () =>
      // The panel lives in the main overlay window; push-to-talk records in
      // the HUD window, where the orb (and its listening state) lives.
      name === "panel" ? setPanel(!panelOpen) : hudWin?.webContents.send("talk"),
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
