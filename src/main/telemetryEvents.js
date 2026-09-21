/**
 * Telemetry events — pure policy module
 *
 * Every decision telemetry makes without touching Electron lives here so it
 * can be unit-tested under `node --test`: the effective enabled/fail-closed
 * decision, and (as of the event-registry work) the allowlist of events and
 * property values that may ever leave the machine.
 */

const { randomUUID } = require('node:crypto');
const { redact } = require('../../scripts/redact');

/**
 * The registry: every event Frame may ever send, with every allowed property
 * and every allowed value. Properties are enums only — no free-form strings,
 * so nothing sourced from user data (paths, names, prompts, messages) can
 * pass through. Adding an event or a value here REQUIRES a matching
 * PRIVACY.md update in the same change.
 */
const EVENTS = {
  app_started: {},
  project_initialized: {},
  // origin: how the spec was started. `button` is set only when Frame itself
  // staged the spec.new prompt, so it can undercount but never overcount;
  // `conductor` reads Frame's own orchestration state. Ambiguity resolves
  // down to `agent`, or to no property at all.
  spec_created: { origin: ['button', 'agent', 'conductor'] },
  spec_phase_advanced: {
    phase: ['draft', 'specified', 'planned', 'tasks_generated', 'implementing', 'done'],
  },
  agent_run_started: { tool: ['claude', 'codex', 'gemini', 'custom'] },
  orchestrator_opened: {},
  orchestration_run_started: {},
  plugin_toggled: { action: ['enabled', 'disabled'] },
  ai_tool_selected: { tool: ['claude', 'codex', 'gemini', 'custom'] },
  // Which channel actually carried a feedback report — the gh CLI, the
  // prefilled browser page, or a mail draft. The channel is the whole event:
  // no title, no description, no diagnostic value, and validateEvent strips
  // anything outside the enum even if a call site tried.
  feedback_submitted: { channel: ['github_issue', 'github_discussion', 'email'] },
  error_occurred: {
    category: [
      'agent_cli_not_found',
      'agent_cli_timeout',
      'agent_spawn_error',
      'terminal_create_failed',
      'orch_worktree_failed',
      'orch_merge_failed',
      'orch_worker_failed',
      'plugin_marketplace_failed',
      'settings_corrupt_recovered',
    ],
  },
};

const BUILTIN_TOOLS = ['claude', 'codex', 'gemini'];
// Spec/orchestration code identifies Claude as 'claude-code'; the dashboard
// enum uses the tool manager's 'claude'.
const TOOL_ALIASES = { 'claude-code': 'claude' };

/**
 * Collapse a tool id to the fixed dashboard enum. User-defined custom tool
 * ids are user content and must never be sent — anything that isn't a
 * built-in id (after aliasing) reads as 'custom'.
 */
function normalizeTool(id) {
  if (typeof id !== 'string') return 'custom';
  const mapped = TOOL_ALIASES[id] || id;
  return BUILTIN_TOOLS.includes(mapped) ? mapped : 'custom';
}

/**
 * Validate an (event, props) pair against the registry.
 *
 * Returns null for an unregistered event (caller must drop it), otherwise
 * the subset of props that are registered for the event and carry an allowed
 * enum value — unknown keys and out-of-enum values are silently stripped.
 * `tool` props are normalized before the enum check so raw ids from call
 * sites (including the renderer) can never pass through.
 */
function validateEvent(name, props) {
  const schema = EVENTS[name];
  if (!schema) return null;
  const out = {};
  for (const key of Object.keys(schema)) {
    let value = props ? props[key] : undefined;
    if (value === undefined) continue;
    if (key === 'tool') value = normalizeTool(value);
    if (schema[key].includes(value)) out[key] = value;
  }
  return out;
}

/**
 * Effective telemetry state from the persisted setting plus settings-load
 * health. Default ON when the setting was never touched (opt-out semantics),
 * but a failed settings load fails CLOSED: we can no longer know whether the
 * user opted out, so we must assume they did.
 *
 * @param {{ value: any, loadFailed: boolean }} state
 *   value      — userSettings.get('telemetryEnabled') (null when never set)
 *   loadFailed — userSettings.loadFailed()
 * @returns {boolean}
 */
function effectiveEnabled({ value, loadFailed }) {
  if (loadFailed) return false;
  return value !== false;
}

// ─── Exception sanitization ───────────────────────────────
//
// Exception detail travels a channel of its own — a separate opt-in
// setting, never the event registry — because the registry's whole value
// is that it is mechanically enum-only. This function is what makes that
// channel safe to open.
//
// The stack is the tame half: its frames point at Frame's own bundle. The
// message is where a user's tree leaks, because Node writes the offending
// path straight into it — `ENOENT: no such file or directory, open
// '/Users/someone/their-project/src/thing.js'`. So both halves are
// redacted for secret shapes and then stripped of absolute paths, keeping
// the basename: `thing.js` still says which file, and says nothing about
// who owns it or what they were working on.

// Two or more segments, so a lone "/tmp" or a URL's "/batch" is left
// alone; the lookbehind keeps "https://host/path" from being rewritten.
const POSIX_PATH_RE = /(?<![:/])(?:\/[^\s/\\:;,()'"<>|]+){2,}/g;
const WINDOWS_PATH_RE = /[A-Za-z]:\\(?:[^\s\\:;,()'"<>|]+\\)*[^\s\\:;,()'"<>|]*/g;

function stripAbsolutePaths(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text
    .replace(POSIX_PATH_RE, (m) => m.slice(m.lastIndexOf('/') + 1) || m)
    .replace(WINDOWS_PATH_RE, (m) => m.slice(m.lastIndexOf('\\') + 1) || m);
}

/**
 * Make an exception safe to send.
 *
 * @param {{ message?: string, stack?: string, name?: string }} err
 * @returns {{ name: string, message: string, stack: string }}
 *
 * Never throws and never returns undefined fields: this runs on the error
 * path, where a second failure would lose the first one.
 */
function sanitizeException(err) {
  const src = err || {};
  const clean = (v) => stripAbsolutePaths(redact(typeof v === 'string' ? v : ''));
  return {
    name: clean(src.name) || 'Error',
    message: clean(src.message),
    stack: clean(src.stack)
  };
}

// ─── The install identifier ───────────────────────────────
//
// Frame's analytics became user-level when it moved to PostHog: counting
// unique users, following an activation funnel and reading a retention
// cohort all need one stable id per install. It is a random UUID and
// nothing else — never a machine id, hostname or username, all of which
// are stable across reinstalls and shared with every other program on the
// box, which is exactly the linkage this avoids.
//
// The decision is pure so it can be tested; `telemetry.js` performs the
// write or the delete the returned `write` asks for.

const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decide this launch's install id from what is stored and whether telemetry
 * is on.
 *
 * @param {{ stored: any, enabled: boolean }} state
 * @param {() => string} [mint]  id source; injectable so tests stay deterministic
 * @returns {{ id: string|null, write: 'set'|'delete'|null }}
 *   id    — the distinct id to send with, or null when nothing may be sent
 *   write — what the caller must persist: store `id`, delete the stored
 *           value, or nothing
 *
 * Telemetry off deletes the stored id rather than parking it: an opt-out
 * that leaves a resumable identifier behind is not an opt-out, and turning
 * telemetry back on deliberately mints a new one. A malformed stored value
 * is replaced rather than sent — it can only come from a hand-edited or
 * half-written settings file, and neither is an identity worth keeping.
 */
function resolveInstallId({ stored, enabled }, mint) {
  const valid = typeof stored === 'string' && INSTALL_ID_RE.test(stored);

  if (!enabled) {
    return { id: null, write: stored === undefined || stored === null ? null : 'delete' };
  }
  if (valid) return { id: stored, write: null };
  return { id: (mint || randomUUID)(), write: 'set' };
}

/**
 * How much of the analytics quota any single run may spend.
 *
 * Every event here is user-driven, so a busy day is tens of events, not
 * hundreds. These ceilings sit far above real use and exist for the case
 * where something loops: two Frames open on one project — an older build
 * walking spec phases backwards while this one reconciles them forward —
 * sent hundreds of events in minutes, and a repeating `error_occurred`
 * could do the same. The quota is finite; a bug must not be able to spend
 * it.
 */
const DEFAULT_RATE_LIMIT = { perWindow: 30, perSession: 500, windowMs: 60 * 1000 };

/**
 * A rolling-window limiter. `check(now)` decides one event and returns
 * `{ allowed, notice }`; `notice` is a message worth logging and arrives at
 * most once per window, because one line per dropped event is its own flood.
 *
 * The clock is a parameter rather than `Date.now()` so the decision stays
 * pure and testable.
 */
function createRateLimiter(options) {
  const cfg = Object.assign({}, DEFAULT_RATE_LIMIT, options || {});
  const window = [];
  let sessionCount = 0;
  let suppressed = 0;
  let lastNoticeAt = null;

  return {
    check(now) {
      while (window.length > 0 && now - window[0] >= cfg.windowMs) window.shift();

      const overSession = sessionCount >= cfg.perSession;
      const overWindow = window.length >= cfg.perWindow;
      if (!overSession && !overWindow) {
        window.push(now);
        sessionCount += 1;
        return { allowed: true, notice: null };
      }

      suppressed += 1;
      if (lastNoticeAt !== null && now - lastNoticeAt < cfg.windowMs) {
        return { allowed: false, notice: null };
      }
      lastNoticeAt = now;
      const cause = overSession
        ? `this run has sent ${cfg.perSession} events`
        : `more than ${cfg.perWindow} events in a minute`;
      return {
        allowed: false,
        notice: `rate limit reached (${cause}) — dropping events; ${suppressed} dropped so far`
      };
    },
    stats() {
      return { sessionCount, suppressed };
    }
  };
}

// ─── Spec lifecycle ───────────────────────────────────────
//
// `spec_created` and `spec_phase_advanced` are read off the specs watcher's
// pushes rather than off the code paths that write status.json: agents write
// that file themselves and Frame's reconcile rewrites it on its own, so no
// single write path sees a spec being carried through the workflow.
//
// A push can show a spec.md or a later phase that nobody produced just now —
// a git checkout or pull, a rename, a project the user was away from. Two
// rules keep those out:
//   • a slug is judged against every look this run has had at the project, so
//     a spec that leaves and comes back (branch flip-flop, delete + rewrite)
//     is not counted again, and a phase only counts past the furthest one seen;
//   • a slug that arrives already authored, or a phase that arrives with no
//     earlier look at it, only counts when its own timestamp says it happened
//     since the previous look. A timestamp Frame cannot read counts — the
//     event is then as good as the file, which is the most it can be.

const SPEC_PHASES = EVENTS.spec_phase_advanced.phase;
// Agents stamp these fields themselves, a little before the file lands.
const SPEC_STAMP_SKEW_MS = 10 * 60 * 1000;

function stampedSince(stamp, since) {
  // A date without a time ("2026-09-14") parses as midnight and would read as
  // old; it says nothing about when, so it is treated as unreadable.
  if (typeof stamp !== 'string' || !stamp.includes('T')) return true;
  const at = Date.parse(stamp);
  return Number.isNaN(at) || at >= since;
}

/**
 * Compare one push of a project's specs with this run's earlier looks at it.
 *
 * @param {null|{seen: Map<string, number>, authored: Set<string>, at: number}} previous
 *   the state this function returned last time for the same project, or null
 *   on the first look (which only seeds: nothing on disk is backfilled)
 * @param {Array<{slug: string, phase: string|null, authored: boolean,
 *   created_at?: string|null, last_phase_at?: string|null}>} specs
 * @param {number} now
 * @returns {{ state: object, created: string[], advanced: Array<{slug: string, phase: string}> }}
 */
function diffSpecLifecycle(previous, specs, now) {
  const state = {
    seen: new Map(previous ? previous.seen : []),
    authored: new Set(previous ? previous.authored : []),
    at: now
  };
  const created = [];
  const advanced = [];
  const since = previous ? previous.at - SPEC_STAMP_SKEW_MS : null;

  for (const spec of specs) {
    const phaseIdx = SPEC_PHASES.indexOf(spec.phase);
    const known = state.seen.has(spec.slug);

    if (spec.authored && !state.authored.has(spec.slug)) {
      state.authored.add(spec.slug);
      // A slug already seen without its spec.md is being authored right now.
      if (previous && (known || stampedSince(spec.created_at, since))) created.push(spec.slug);
    }

    if (!known) {
      state.seen.set(spec.slug, phaseIdx);
      continue;
    }
    const furthest = state.seen.get(spec.slug);
    if (phaseIdx <= furthest) continue;
    state.seen.set(spec.slug, phaseIdx);
    // A spec that never had a readable phase is not advancing out of one.
    if (furthest >= 0 && stampedSince(spec.last_phase_at, since)) {
      advanced.push({ slug: spec.slug, phase: spec.phase });
    }
  }
  return { state, created, advanced };
}

/**
 * Carry a renamed spec's history to its new slug, so the rename does not read
 * as a spec appearing. Returns the state unchanged when it holds neither.
 */
function renameSpecLifecycle(state, oldSlug, newSlug) {
  if (!state || oldSlug === newSlug) return state;
  if (state.seen.has(oldSlug)) {
    state.seen.set(newSlug, state.seen.get(oldSlug));
    state.seen.delete(oldSlug);
  }
  if (state.authored.delete(oldSlug)) state.authored.add(newSlug);
  return state;
}

module.exports = {
  EVENTS,
  normalizeTool,
  validateEvent,
  effectiveEnabled,
  resolveInstallId,
  sanitizeException,
  createRateLimiter,
  DEFAULT_RATE_LIMIT,
  diffSpecLifecycle,
  renameSpecLifecycle
};
