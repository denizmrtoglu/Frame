/**
 * PoC — a stand-in for the `electron` module in the main process.
 *
 * src/main runs unchanged under plain Node: everything it asks of Electron is
 * answered here. IPC goes over the WebSocket hub in ./hub.js instead of
 * Electron's pipe; native UI (dialogs, shell) is either answered by asking
 * the browser, or is a no-op that a headless server cannot do.
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hub = require('./hub');

const DATA_DIR = process.env.FRAME_SERVER_DATA || path.join(os.homedir(), '.frame-server');

// ── ipcMain ────────────────────────────────────────────────────────────────
class IpcMain extends EventEmitter {
  constructor() {
    super();
    this.handlers = new Map();
  }
  handle(channel, fn) { this.handlers.set(channel, fn); }
  handleOnce(channel, fn) {
    this.handlers.set(channel, (...a) => { this.handlers.delete(channel); return fn(...a); });
  }
  removeHandler(channel) { this.handlers.delete(channel); }
}
const ipcMain = new IpcMain();

// ── BrowserWindow / webContents ────────────────────────────────────────────
// One "window" stands for every connected browser tab: send() broadcasts.
class WebContents extends EventEmitter {
  constructor() { super(); this.id = 1; }
  send(channel, ...args) { hub.broadcast(channel, args); }
  isDestroyed() { return false; }
  setZoomFactor() {}
  getZoomFactor() { return 1; }
  setZoomLevel() {}
  openDevTools() {}
  reload() { hub.broadcast('__frame:reload', []); }
  isLoading() { return false; }
}

const windows = [];
class BrowserWindow extends EventEmitter {
  constructor() {
    super();
    this.webContents = new WebContents();
    windows.push(this);
  }
  static getAllWindows() { return windows.slice(); }
  static getFocusedWindow() { return windows[0] || null; }
  loadFile() { setTimeout(() => this.webContents.emit('did-finish-load'), 0); }
  loadURL() { this.loadFile(); }
  isDestroyed() { return false; }
  // "Visible" = at least one browser is connected, so pollGate pauses
  // background polling while nobody is looking — same as a hidden window.
  isVisible() { return hub.clientCount() > 0; }
  isFocused() { return hub.clientCount() > 0; }
  isMinimized() { return false; }
  focus() {} show() {} restore() {} setTitle() {}
  getBounds() { return { x: 0, y: 0, width: 1400, height: 900 }; }
}

// ── app ────────────────────────────────────────────────────────────────────
const appEmitter = new EventEmitter();
const pkg = require('../package.json');
const app = Object.assign(appEmitter, {
  isPackaged: false,
  dock: null,
  whenReady: () => Promise.resolve(),
  isReady: () => true,
  getName: () => 'Frame',
  setName() {},
  getVersion: () => pkg.version,
  getAppPath: () => path.join(__dirname, '..'),
  getPath(name) {
    const map = {
      home: os.homedir(),
      temp: os.tmpdir(),
      userData: path.join(DATA_DIR, 'userData'),
      appData: path.join(DATA_DIR, 'appData'),
      logs: path.join(DATA_DIR, 'logs'),
      crashDumps: path.join(DATA_DIR, 'crashDumps'),
      documents: path.join(os.homedir(), 'Documents'),
      downloads: path.join(os.homedir(), 'Downloads'),
      desktop: os.homedir()
    };
    const p = map[name] || path.join(DATA_DIR, name);
    if (p.startsWith(DATA_DIR)) fs.mkdirSync(p, { recursive: true });
    return p;
  },
  quit() { process.exit(0); },
  exit(code) { process.exit(code || 0); },
  focus() {},
  setAboutPanelOptions() {},
  requestSingleInstanceLock: () => true
});

// ── dialog — answered by the browser (window.prompt / confirm) ────────────
const dialog = {
  async showOpenDialog(_win, opts = {}) {
    const answer = await hub.ask('openDialog', { title: opts.title || 'Select folder', defaultPath: os.homedir() });
    if (!answer) return { canceled: true, filePaths: [] };
    return { canceled: false, filePaths: [answer] };
  },
  async showSaveDialog(_win, opts = {}) {
    const answer = await hub.ask('openDialog', { title: opts.title || 'Save as', defaultPath: opts.defaultPath || os.homedir() });
    return answer ? { canceled: false, filePath: answer } : { canceled: true };
  },
  async showMessageBox(_win, opts = {}) {
    const response = await hub.ask('messageBox', { message: opts.message, detail: opts.detail, buttons: opts.buttons || ['OK'] });
    return { response: typeof response === 'number' ? response : (opts.cancelId ?? 0), checkboxChecked: false };
  },
  // Sync dialogs cannot wait on a browser; take the safe default.
  showMessageBoxSync(_win, opts = {}) { return opts.cancelId ?? opts.defaultId ?? 0; },
  showErrorBox(title, content) { console.error('[dialog]', title, content); }
};

// ── shell — links open in the browser; local-desktop actions are no-ops ───
const shell = {
  openExternal: async (url) => { hub.broadcast('__frame:openExternal', [url]); },
  openPath: async (p) => { hub.broadcast('__frame:notice', [`Server path (cannot open on your device): ${p}`]); return ''; },
  showItemInFolder: (p) => { hub.broadcast('__frame:notice', [`Server path: ${p}`]); },
  trashItem: async (p) => { await fs.promises.rm(p, { recursive: true, force: true }); },
  beep() {}
};

const Menu = {
  buildFromTemplate: (template) => ({ template, popup() {}, items: [] }),
  setApplicationMenu() {},
  getApplicationMenu: () => null
};

hub.onClientsChange((count, prev) => {
  if (count > 0 && prev === 0) windows.forEach((w) => w.emit('show'));
  if (count === 0 && prev > 0) windows.forEach((w) => w.emit('hide'));
});

const crashReporter = { start() {} };
const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: true, themeSource: 'system' });
const clipboard = { readText: () => '', writeText() {} };
const protocol = { registerSchemesAsPrivileged() {}, handle() {}, registerFileProtocol() {} };
const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1400, height: 900 } }) };
const powerMonitor = new EventEmitter();
const safeStorage = { isEncryptionAvailable: () => false };

module.exports = {
  app, BrowserWindow, ipcMain, dialog, shell, Menu, crashReporter, nativeTheme,
  clipboard, protocol, screen, powerMonitor, safeStorage,
  _internal: { ipcMain, windows }
};
