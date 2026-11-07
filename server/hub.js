/**
 * PoC — the WebSocket hub that replaces Electron's IPC pipe.
 *
 * Built to survive a flaky connection: every page load is a *session*, and
 * everything the server sends a session is numbered and kept until the page
 * acknowledges it. A dropped socket just reconnects with {hello, lastSeq}
 * and the gap is replayed — no reload, no lost terminal output. If the gap
 * can no longer be replayed (session expired or overflowed), the page is
 * told to reload, and the reload re-adopts the live terminals instead
 * (see terminalRegistry.js).
 *
 * Wire protocol (JSON, one message per frame):
 *   browser → server  {t:'hello', sessionId, lastSeq}   first frame on every socket
 *                     {t:'ack', seq}                    outbox up to seq may be dropped
 *                     {t:'invoke', id, ch, args}        ipcRenderer.invoke
 *                     {t:'send', ch, args}              ipcRenderer.send
 *                     {t:'answer', id, value}           reply to an 'ask'
 *   server → browser  {t:'welcome', resumed, reload?}
 *                     {seq, t:'res', id, ok, value|error}
 *                     {seq, t:'evt', ch, args}
 *                     {seq, t:'ask', id, kind, payload}
 */

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;   // a closed laptop overnight
const OUTBOX_MAX_BYTES = 32 * 1024 * 1024;    // past this, reload + re-adopt instead

const sessions = new Map(); // sessionId → { ws, seq, outbox: [{seq, raw}], bytes, lastSeen, broken }
let ipcMain = null;
let askSeq = 0;
const pendingAsks = new Map();
const outgoingObservers = [];
const invokeOverrides = new Map();
const clientListeners = [];
let pendingCreate = null;

function attach(ipc) { ipcMain = ipc; }
function observeOutgoing(fn) { outgoingObservers.push(fn); }
function overrideInvoke(ch, fn) { invokeOverrides.set(ch, fn); }
function onClientsChange(fn) { clientListeners.push(fn); }
function connectedCount() { let n = 0; for (const s of sessions.values()) if (s.ws) n++; return n; }

function notifyClients(prev) {
  const now = connectedCount();
  if (now !== prev) for (const fn of clientListeners) fn(now, prev);
}

function pushTo(session, msg) {
  if (session.broken) return;
  msg.seq = ++session.seq;
  const raw = JSON.stringify(msg);
  session.outbox.push({ seq: msg.seq, raw });
  session.bytes += raw.length;
  if (session.bytes > OUTBOX_MAX_BYTES) {
    // Too far behind to replay: drop the backlog; on resume the page reloads.
    session.broken = true;
    session.outbox = [];
    session.bytes = 0;
    return;
  }
  if (session.ws && session.ws.readyState === 1) session.ws.send(raw);
}

function emitOutgoing(ch, args, meta) {
  for (const fn of outgoingObservers) {
    try { fn(ch, args, meta); } catch (err) { console.error('[hub] observer threw:', err); }
  }
}

function broadcast(ch, args) {
  emitOutgoing(ch, args, {});
  for (const s of sessions.values()) pushTo(s, { t: 'evt', ch, args });
}

/** Ask the most recently active connected page to stand in for a native dialog. */
function ask(kind, payload) {
  const live = [...sessions.values()].filter((s) => s.ws).sort((a, b) => b.lastSeen - a.lastSeen)[0];
  if (!live) return Promise.resolve(null);
  const id = ++askSeq;
  return new Promise((resolve) => {
    pendingAsks.set(id, resolve);
    pushTo(live, { t: 'ask', id, kind, payload });
  });
}

function makeEvent(session) {
  const sender = {
    id: 1,
    send: (ch, ...args) => {
      emitOutgoing(ch, args, { pendingCreate });
      pushTo(session, { t: 'evt', ch, args });
    },
    isDestroyed: () => session.broken
  };
  return { sender, reply: sender.send, returnValue: undefined, preventDefault() {} };
}

function ackTo(session, seq) {
  let dropped = 0;
  while (session.outbox.length && session.outbox[0].seq <= seq) {
    session.bytes -= session.outbox[0].raw.length;
    session.outbox.shift();
    dropped++;
  }
  return dropped;
}

function handleHello(ws, msg) {
  const prev = connectedCount();
  const id = String(msg.sessionId || '');
  const lastSeq = Number(msg.lastSeq) || 0;
  let session = sessions.get(id);
  let resumed = false;
  let reload = false;

  if (session && !session.broken) {
    ackTo(session, lastSeq);
    const contiguous = session.outbox.length === 0 ? session.seq === lastSeq : session.outbox[0].seq === lastSeq + 1;
    if (contiguous) resumed = true; else reload = true;
  } else if (session && session.broken) {
    reload = true;
  } else if (lastSeq > 0) {
    reload = true; // server restarted, or the session expired
  }

  if (reload) {
    ws.send(JSON.stringify({ t: 'welcome', resumed: false, reload: true }));
    ws.close();
    return null;
  }
  if (!session) {
    session = { ws: null, seq: 0, outbox: [], bytes: 0, lastSeen: Date.now(), broken: false };
    sessions.set(id, session);
  }
  if (session.ws && session.ws !== ws) try { session.ws.close(); } catch { /* already gone */ }
  session.ws = ws;
  session.lastSeen = Date.now();
  ws.send(JSON.stringify({ t: 'welcome', resumed }));
  for (const item of session.outbox) ws.send(item.raw); // the gap, in order
  notifyClients(prev);
  return session;
}

function onConnection(ws) {
  let session = null;
  ws.on('close', () => {
    if (session && session.ws === ws) {
      const prev = connectedCount();
      session.ws = null;
      session.lastSeen = Date.now();
      notifyClients(prev);
    }
  });
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'hello') { session = handleHello(ws, msg); return; }
    if (!session) return;
    session.lastSeen = Date.now();
    const args = Array.isArray(msg.args) ? msg.args : [];

    if (msg.t === 'ack') {
      ackTo(session, Number(msg.seq) || 0);
    } else if (msg.t === 'invoke') {
      const fn = invokeOverrides.get(msg.ch) || ipcMain.handlers.get(msg.ch);
      if (!fn) {
        pushTo(session, { t: 'res', id: msg.id, ok: false, error: `No handler registered for '${msg.ch}'` });
        return;
      }
      try {
        const value = await fn(makeEvent(session), ...args);
        pushTo(session, { t: 'res', id: msg.id, ok: true, value });
      } catch (err) {
        pushTo(session, { t: 'res', id: msg.id, ok: false, error: err && err.message ? err.message : String(err) });
      }
    } else if (msg.t === 'send') {
      // Listeners run synchronously; a create's reply is matched to its request.
      pendingCreate = msg.ch === 'terminal-create' ? (args[0] || {}) : null;
      try {
        ipcMain.emit(msg.ch, makeEvent(session), ...args);
      } catch (err) {
        console.error(`[hub] '${msg.ch}' listener threw:`, err);
      } finally {
        pendingCreate = null;
      }
    } else if (msg.t === 'answer') {
      const resolve = pendingAsks.get(msg.id);
      pendingAsks.delete(msg.id);
      if (resolve) resolve(msg.value);
    }
  });
}

// Forget sessions nobody came back to.
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) if (!s.ws && s.lastSeen < cutoff) sessions.delete(id);
}, 60 * 1000).unref();

module.exports = {
  attach, broadcast, ask, onConnection, onClientsChange, observeOutgoing, overrideInvoke,
  clientCount: connectedCount
};
