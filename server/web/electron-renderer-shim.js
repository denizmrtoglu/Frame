/**
 * PoC — stand-in for `electron` in the browser bundle.
 *
 * ipcRenderer speaks the hub's JSON protocol over one WebSocket (see
 * server/hub.js). Incoming events go through ipcRenderer.emit — the same
 * path Electron uses — so ipcWatchdog's wrapper still sees them.
 */

// ── Minimal EventEmitter (the browser has no `events`) ────────────────────
class Emitter {
  constructor() { this._l = new Map(); }
  on(ch, fn) { if (!this._l.has(ch)) this._l.set(ch, []); this._l.get(ch).push(fn); return this; }
  addListener(ch, fn) { return this.on(ch, fn); }
  once(ch, fn) { const w = (...a) => { this.removeListener(ch, w); fn(...a); }; w._orig = fn; return this.on(ch, w); }
  removeListener(ch, fn) {
    const arr = this._l.get(ch); if (!arr) return this;
    const i = arr.findIndex((f) => f === fn || f._orig === fn);
    if (i >= 0) arr.splice(i, 1);
    return this;
  }
  off(ch, fn) { return this.removeListener(ch, fn); }
  removeAllListeners(ch) { if (ch === undefined) this._l.clear(); else this._l.delete(ch); return this; }
  listenerCount(ch) { return (this._l.get(ch) || []).length; }
  emit(ch, ...args) {
    const arr = this._l.get(ch); if (!arr || arr.length === 0) return false;
    for (const fn of arr.slice()) {
      try { fn(...args); } catch (err) { console.error(`[ipc] listener for '${ch}' threw:`, err); }
    }
    return true;
  }
}

// ── Connection ────────────────────────────────────────────────────────────
// Resumable: this page is one session on the server. A dropped socket
// reconnects (backoff, forever) and the server replays what we missed, so
// the page — and every terminal in it — just continues. See server/hub.js.
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
let ws = null;
let open = false;
const queue = [];
let seq = 0;
const pending = new Map();
let lastSeq = 0;
let ackedSeq = 0;
let retry = 0;

const ipcRenderer = new Emitter();
const ipcEvent = { sender: ipcRenderer };

function connect() {
  ws = new WebSocket(`${proto}//${location.host}/ipc`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'hello', sessionId, lastSeq }));
  };
  ws.onclose = () => {
    const wasOpen = open;
    open = false;
    if (wasOpen || retry > 0) setBanner('Connection to Frame Server lost — reconnecting… (your terminals keep running)');
    const delay = Math.min(10000, 500 * 2 ** Math.min(retry, 5));
    retry++;
    setTimeout(connect, delay);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.t === 'welcome') {
      if (msg.reload) { location.reload(); return; } // gap not replayable → reload re-adopts terminals
      open = true;
      retry = 0;
      setBanner(null);
      while (queue.length) ws.send(queue.shift());
      return;
    }
    if (typeof msg.seq === 'number') {
      if (msg.seq <= lastSeq) return; // already handled before the drop
      lastSeq = msg.seq;
    }
    if (msg.t === 'res') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error));
    } else if (msg.t === 'evt') {
      if (msg.ch === '__frame:openExternal') return void window.open(msg.args[0], '_blank', 'noopener');
      if (msg.ch === '__frame:notice') return void console.info('[frame-server]', msg.args[0]);
      if (msg.ch === '__frame:reload') return void location.reload();
      ipcRenderer.emit(msg.ch, ipcEvent, ...(msg.args || []));
    } else if (msg.t === 'ask') {
      answerAsk(msg);
    }
  };
}

function post(obj) {
  const raw = JSON.stringify(obj);
  if (open) ws.send(raw); else queue.push(raw);
}

ipcRenderer.invoke = (ch, ...args) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  post({ t: 'invoke', id, ch, args });
});
ipcRenderer.send = (ch, ...args) => post({ t: 'send', ch, args });
ipcRenderer.sendSync = (ch) => { console.warn(`[ipc] sendSync('${ch}') is not supported over the network`); return undefined; };

// Native dialogs, answered in the page.
function answerAsk(msg) {
  let value = null;
  if (msg.kind === 'openDialog') {
    value = window.prompt(`${msg.payload.title}\n\nPath on the server:`, msg.payload.defaultPath) || null;
  } else if (msg.kind === 'messageBox') {
    const { message, detail, buttons } = msg.payload;
    value = window.confirm(`${message || ''}\n\n${detail || ''}`) ? 0 : Math.max(0, (buttons || []).length - 1);
  }
  post({ t: 'answer', id: msg.id, value });
}

let bannerEl = null;
function setBanner(text) {
  if (!text) { if (bannerEl) bannerEl.remove(); bannerEl = null; return; }
  if (!bannerEl) {
    bannerEl = document.createElement('div');
    bannerEl.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;padding:6px 12px;background:#b45309;color:#fff;font:12px Inter,sans-serif;text-align:center';
    document.body.appendChild(bannerEl);
  }
  bannerEl.textContent = text;
}

connect();

// Tell the server what we have, so it can drop it from the replay buffer.
setInterval(() => {
  if (open && lastSeq > ackedSeq) {
    ws.send(JSON.stringify({ t: 'ack', seq: lastSeq }));
    ackedSeq = lastSeq;
  }
}, 1000);

// ── shell / clipboard ─────────────────────────────────────────────────────
const shell = {
  openExternal: async (url) => { window.open(url, '_blank', 'noopener'); },
  openPath: async (p) => { console.info('[frame-server] server path:', p); return ''; },
  showItemInFolder: (p) => { console.info('[frame-server] server path:', p); }
};

// Electron's clipboard is synchronous; the browser's is not. Keep a cache.
let clipCache = '';
const refreshClip = () => navigator.clipboard?.readText?.().then((t) => { clipCache = t; }).catch(() => {});
window.addEventListener('focus', refreshClip);
document.addEventListener('copy', () => setTimeout(refreshClip, 0));
const clipboard = {
  readText: () => { refreshClip(); return clipCache; },
  writeText: (t) => { clipCache = String(t); navigator.clipboard?.writeText?.(clipCache).catch(() => {}); }
};

module.exports = { ipcRenderer, shell, clipboard, webFrame: { setZoomFactor() {}, getZoomFactor: () => 1 } };
