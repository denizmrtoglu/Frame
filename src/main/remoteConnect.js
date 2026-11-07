/**
 * Remote Connect — PoC (branch poc/frame-server).
 *
 * File › Connect to Server… asks for an SSH target (user@host), then:
 *   1. reads the Frame Server token over SSH (~/.frame-server/token),
 *   2. opens `ssh -N -L <free local port>:127.0.0.1:7777 <target>`,
 *   3. shows the remote Frame in its own window, titled "Remote: <target>".
 * A dropped tunnel is restarted on the same port; closing the window closes
 * it for good (the remote terminals keep running). Auth is the user's own SSH key —
 * Frame never sees a password (BatchMode=yes).
 */

const { BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const net = require('net');
const http = require('http');
const userSettings = require('./userSettings');
const logger = require('./logger');

const REMOTE_PORT = 7777;
const SUBMIT = 'remote-connect:submit';
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new'];

let promptWin = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function readRemoteToken(target) {
  return new Promise((resolve, reject) => {
    execFile('ssh', [...SSH_OPTS, target, 'cat ~/.frame-server/token'], { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      const token = stdout.trim();
      if (!token) return reject(new Error('No token found — is Frame Server running on that host?'));
      resolve(token);
    });
  });
}

/** Resolves once the tunnel answers HTTP (any status), rejects on timeout. */
function waitForTunnel(port, ms = 15000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('Tunnel opened but Frame Server did not answer on port 7777.'));
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

async function connect(target) {
  const token = await readRemoteToken(target);
  const port = await freePort();

  // The tunnel is restarted on the *same* local port whenever it drops
  // (sleep, Wi-Fi change, server reboot): the page keeps its origin and its
  // session, reconnects, and the server replays what it missed.
  let tunnel = null;
  let win = null;
  let restarts = 0;
  const startTunnel = () => {
    let stderr = '';
    const proc = spawn('ssh', [...SSH_OPTS, '-N', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-L', `${port}:127.0.0.1:${REMOTE_PORT}`, target]);
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.exited = new Promise((_, reject) => proc.on('exit', (code) =>
      reject(new Error(stderr.trim() || `ssh exited with code ${code}`))));
    proc.exited.catch((err) => {
      if (!win || win.isDestroyed()) return; // closed on purpose, or first attempt (reported below)
      const delay = Math.min(30000, 1000 * 2 ** Math.min(restarts++, 5));
      logger.warn('remote', `tunnel to ${target} dropped (${err.message}); retrying in ${delay}ms`);
      win.setTitle(`Frame — Remote: ${target} (reconnecting…)`);
      setTimeout(() => {
        if (win.isDestroyed()) return;
        tunnel = startTunnel();
        waitForTunnel(port, 20000).then(() => {
          restarts = 0;
          if (!win.isDestroyed()) win.setTitle(`Frame — Remote: ${target}`);
        }).catch(() => { /* the exit handler schedules the next try */ });
      }, delay);
    });
    return proc;
  };

  tunnel = startTunnel();
  await Promise.race([waitForTunnel(port), tunnel.exited]);

  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: `Frame — Remote: ${target}`,
    backgroundColor: '#0c0b09',
    // The remote page is a plain web app: no Node in this window.
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { if (tunnel) tunnel.kill(); });

  await win.loadURL(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  logger.info('remote', `connected to ${target} via local port ${port}`);
}

const PROMPT_HTML = (last) => `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;padding:20px;background:#1c1b19;color:#e8e6e3;font:13px -apple-system,Inter,sans-serif}
  h1{font-size:14px;margin:0 0 4px} p{margin:0 0 14px;color:#9a968f;font-size:12px}
  input{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid #3a3835;background:#121110;color:#e8e6e3;font:13px ui-monospace,monospace}
  .row{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
  button{padding:6px 14px;border-radius:6px;border:1px solid #3a3835;background:#2a2826;color:#e8e6e3;font-size:12px}
  button.primary{background:#4ade80;border-color:#4ade80;color:#0c0b09;font-weight:600}
  #err{color:#f87171;font-size:12px;margin-top:10px;white-space:pre-wrap}
</style></head><body>
  <h1>Connect to Frame Server</h1>
  <p>SSH target — your SSH key is used, no password prompt.</p>
  <form id="f"><input id="t" placeholder="root@your-server" value="${last.replace(/"/g, '&quot;')}" autofocus spellcheck="false">
  <div id="err"></div>
  <div class="row"><button type="button" onclick="window.close()">Cancel</button><button class="primary" id="go">Connect</button></div></form>
  <script>
    const { ipcRenderer } = require('electron');
    const go = document.getElementById('go'), err = document.getElementById('err');
    document.getElementById('f').onsubmit = (e) => {
      e.preventDefault();
      const t = document.getElementById('t').value.trim();
      if (!t) return;
      go.disabled = true; go.textContent = 'Connecting…'; err.textContent = '';
      ipcRenderer.send(${JSON.stringify(SUBMIT)}, t);
    };
    ipcRenderer.on('remote-connect:error', (_e, m) => { err.textContent = m; go.disabled = false; go.textContent = 'Connect'; });
  </script>
</body></html>`;

function openConnectDialog(parent) {
  if (promptWin && !promptWin.isDestroyed()) { promptWin.focus(); return; }
  promptWin = new BrowserWindow({
    width: 440,
    height: 230,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: parent || undefined,
    modal: Boolean(parent),
    title: 'Connect to Server',
    backgroundColor: '#1c1b19',
    // Local, static HTML written above — never remote content.
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  const last = String(userSettings.get('remoteConnectLastTarget') || '');
  promptWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PROMPT_HTML(last)));
  promptWin.on('closed', () => { promptWin = null; });
}

ipcMain.on(SUBMIT, async (event, target) => {
  try {
    userSettings.set('remoteConnectLastTarget', target);
    await connect(target);
    if (promptWin && !promptWin.isDestroyed()) promptWin.close();
  } catch (err) {
    logger.warn('remote', `connect to ${target} failed:`, err.message);
    if (!event.sender.isDestroyed()) event.sender.send('remote-connect:error', err.message);
    else dialog.showErrorBox('Connect to Server', err.message);
  }
});

module.exports = { openConnectDialog };
