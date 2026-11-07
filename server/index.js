#!/usr/bin/env node
/**
 * Frame Server — PoC.
 *
 * Runs Frame's real main process (src/main/index.js) under plain Node with a
 * stand-in `electron` module, and serves Frame's real renderer to a browser.
 * The browser bundle's `electron` is a stand-in too, so IPC travels over one
 * WebSocket. No file under src/ is changed.
 *
 *   FRAME_SERVER_PORT   default 7777
 *   FRAME_SERVER_HOST   default 127.0.0.1 (reach it through `ssh -L`)
 *   FRAME_SERVER_TOKEN  default: random, printed at start
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.FRAME_SERVER_PORT || 7777);
const HOST = process.env.FRAME_SERVER_HOST || '127.0.0.1';
const DATA_DIR = process.env.FRAME_SERVER_DATA || path.join(os.homedir(), '.frame-server');

// The token lives in <data>/token (0600) so Frame Desktop can read it over
// the same SSH connection it tunnels through — nothing to copy by hand.
function loadToken() {
  if (process.env.FRAME_SERVER_TOKEN) return process.env.FRAME_SERVER_TOKEN;
  const file = path.join(DATA_DIR, 'token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch { /* first start */ }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const fresh = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(file, fresh + '\n', { mode: 0o600 });
  return fresh;
}
const TOKEN = loadToken();

// ── 1. Route Electron-only modules to stand-ins ───────────────────────────
const stubDir = path.join(__dirname, 'stubs');
const redirects = {
  'electron': path.join(__dirname, 'electron-main-shim.js'),
  'electron-log/main': path.join(__dirname, 'electron-log-shim.js'),
  '@aptabase/electron/main': path.join(stubDir, 'noop-analytics.js'),
  'posthog-node': path.join(stubDir, 'noop-analytics.js'),
  // The repo's node-pty is rebuilt for Electron's ABI; use one built for Node.
  'node-pty': require.resolve('node-pty', { paths: [__dirname] })
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (Object.prototype.hasOwnProperty.call(redirects, request)) return redirects[request];
  return origResolve.call(this, request, ...rest);
};

// ── 2. HTTP: the renderer's static files, behind the token ────────────────
const hub = require('./hub');
const shim = require('./electron-main-shim');
hub.attach(shim.ipcMain);
require('./terminalRegistry');

const ALLOWED = ['dist/', 'node_modules/', 'src/renderer/styles/', 'assets/'];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf'
};

function authed(req) {
  const cookie = req.headers.cookie || '';
  return cookie.split(/;\s*/).includes(`frame_token=${TOKEN}`);
}

function indexHtml() {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const boot = `<script>window.process={platform:${JSON.stringify(process.platform)},env:{},versions:{},cwd:function(){return '/'}};</script>`;
  html = html.replace('<head>', `<head>\n  ${boot}`);
  html = html.replace('src="dist/renderer.js"', 'src="dist/renderer.web.js"');
  return html;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('token') === TOKEN) {
    res.writeHead(302, { 'Set-Cookie': `frame_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' });
    return res.end();
  }
  if (!authed(req)) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    return res.end('Frame Server: open the URL with ?token=… printed at server start.');
  }
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (rel === '' || rel === 'index.html') {
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
    return res.end(indexHtml());
  }
  const abs = path.normalize(path.join(ROOT, rel));
  if (!abs.startsWith(ROOT + path.sep) || !ALLOWED.some((p) => rel.startsWith(p))) {
    res.writeHead(404); return res.end();
  }
  fs.readFile(abs, (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  });
});

// ── 3. WebSocket: the IPC pipe ────────────────────────────────────────────
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!authed(req) || !req.url.startsWith('/ipc')) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => hub.onConnection(ws));
});

// ── 4. Boot Frame's real main process ─────────────────────────────────────
process.on('uncaughtException', (err) => console.error('[frame-server] uncaught:', err));
process.on('unhandledRejection', (err) => console.error('[frame-server] unhandled rejection:', err));
require(path.join(ROOT, 'src/main/index.js'));

server.listen(PORT, HOST, () => {
  console.log(`\nFrame Server (PoC) listening on http://${HOST}:${PORT}`);
  console.log(`Open: http://localhost:${PORT}/?token=${TOKEN}\n`);
});
