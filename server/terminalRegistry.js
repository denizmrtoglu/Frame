/**
 * PoC — terminals outlive the page.
 *
 * In the desktop app a reload kills every PTY the fresh renderer does not
 * know about (RECONCILE_TERMINALS). On a server that is exactly wrong: the
 * page goes away all the time (laptop closed, tab closed, phone locked)
 * while a long agent run must keep going. So on the server:
 *   - every PTY's recent output is kept here (ring, per terminal),
 *   - RECONCILE_TERMINALS kills nothing and instead returns the live
 *     terminals, with that output, for the page to adopt.
 * Observed purely from the IPC traffic — ptyManager is not changed.
 */

const hub = require('./hub');

const SCROLLBACK_BYTES = 1024 * 1024; // per terminal
const terminals = new Map(); // terminalId → { terminalId, cwd, projectPath, chunks: [], bytes }

hub.observeOutgoing((ch, args, meta) => {
  const p = args[0] || {};
  if (ch === 'terminal-created' && p.success && p.terminalId) {
    const req = meta.pendingCreate || {};
    terminals.set(p.terminalId, {
      terminalId: p.terminalId,
      cwd: req.cwd || null,
      projectPath: req.projectPath !== undefined ? req.projectPath : null,
      chunks: [],
      bytes: 0
    });
  } else if (ch === 'terminal-output-id' && p.terminalId) {
    const t = terminals.get(p.terminalId);
    if (!t || typeof p.data !== 'string') return;
    t.chunks.push(p.data);
    t.bytes += p.data.length;
    while (t.bytes > SCROLLBACK_BYTES && t.chunks.length > 1) t.bytes -= t.chunks.shift().length;
  } else if (ch === 'terminal-destroyed' && p.terminalId) {
    terminals.delete(p.terminalId);
  }
});

hub.overrideInvoke('reconcile-terminals', (_event, knownIds) => {
  const known = new Set(Array.isArray(knownIds) ? knownIds : []);
  const alive = [...terminals.values()]
    .filter((t) => !known.has(t.terminalId))
    .map((t) => ({ terminalId: t.terminalId, cwd: t.cwd, projectPath: t.projectPath, scrollback: t.chunks.join('') }));
  return { destroyed: [], alive };
});

module.exports = { count: () => terminals.size };
