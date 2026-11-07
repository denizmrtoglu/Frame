# Frame Server — PoC

Runs Frame's **unchanged** main process (`src/main`) under plain Node on a
server, and serves Frame's **unchanged** renderer (`src/renderer`) to a
browser. Nothing under `src/` is modified; two stand-ins do the work:

| Side | Stand-in | What it replaces |
|---|---|---|
| server | `electron-main-shim.js` | `ipcMain`, `BrowserWindow.webContents.send`, `app.getPath`, dialogs, shell |
| server | `hub.js` | Electron's IPC pipe → one WebSocket (`/ipc`) |
| browser | `web/electron-renderer-shim.js` | `ipcRenderer` (invoke / send / on) over that WebSocket |
| browser | `build-web.js` | bundles the renderer with the stand-ins → `dist/renderer.web.js` |

## Run locally

```bash
node server/build-web.js
(cd server && npm install && find node_modules/node-pty -name spawn-helper -exec chmod +x {} \;)
FRAME_SERVER_TOKEN=dev node server/index.js
open "http://localhost:7777/?token=dev"
```

Use `FRAME_SERVER_DATA=<dir>` to keep the server's settings apart from the
desktop app's (default `~/.frame-server`).

## Run on a server

```bash
./server/deploy.sh root@your-hetzner-host
```

The server binds to `127.0.0.1` only; reach it through `ssh -L`. The token is
a second lock, not the security boundary — SSH is. It is written to
`~/.frame-server/token` (0600) on first start.

### From Frame Desktop

**File › Connect to Server…** → `user@host`. Frame reads the token over SSH,
opens the tunnel on a free local port, and shows the remote Frame in its own
window ("Frame — Remote: user@host"). Closing the window closes the tunnel.
Needs key-based SSH (no password prompt) — `ssh user@host true` must work.

### From a browser

```bash
ssh -N -L 7777:127.0.0.1:7777 user@host
ssh user@host cat ~/.frame-server/token
open "http://localhost:7777/?token=<token>"
```

## Known PoC limits

- Native dialogs become `window.prompt` / `confirm` (folder picker = type a server path).
- "Open in Finder" / open-with-OS actions only log the server path.
- One shared "window": every connected tab sees the same terminals.
- On disconnect the page reloads; Frame's existing reload reconcile then
  kills PTYs the new page does not know about — terminals do **not** survive
  a reconnect yet (needs a server-side output buffer).
- No multi-user; the server runs as whichever Linux user started it.
- Analytics are stubbed out on the server.
