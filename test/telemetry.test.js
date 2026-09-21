/**
 * Telemetry policy tests — fail-closed opt-out decision.
 * Runs with Node's built-in runner: `npm test` (node --test test/).
 *
 * Targets the pure policy module (src/main/telemetryEvents.js); the Electron
 * side of telemetry.js is a thin wrapper over it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { EVENTS, normalizeTool, validateEvent, effectiveEnabled, resolveInstallId, createRateLimiter, DEFAULT_RATE_LIMIT } = require('../src/main/telemetryEvents');

// ─── effectiveEnabled — the re-opt-in regression ──────────

test('never-set value on a healthy load defaults ON (opt-out semantics)', () => {
  assert.equal(effectiveEnabled({ value: null, loadFailed: false }), true);
});

test('explicit opt-out on a healthy load stays off', () => {
  assert.equal(effectiveEnabled({ value: false, loadFailed: false }), false);
});

test('explicit opt-in on a healthy load stays on', () => {
  assert.equal(effectiveEnabled({ value: true, loadFailed: false }), true);
});

test('failed settings load fails CLOSED regardless of the cached value', () => {
  // The re-opt-in bug: an unrecoverable user-settings.json used to reset the
  // cache to {} so `null !== false` re-enabled telemetry for opted-out users.
  assert.equal(effectiveEnabled({ value: null, loadFailed: true }), false);
  assert.equal(effectiveEnabled({ value: true, loadFailed: true }), false);
  assert.equal(effectiveEnabled({ value: false, loadFailed: true }), false);
});

// ─── resolveInstallId — one stable id, and no id at all ───

const UUID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const mintB = () => '9f8e7d6c-5b4a-4938-8271-615243342516';

test('no stored id mints one and asks for it to be written', () => {
  const r = resolveInstallId({ stored: null, enabled: true }, mintB);
  assert.equal(r.id, mintB());
  assert.equal(r.write, 'set');
});

test('a stored id is reused and needs no write', () => {
  const r = resolveInstallId({ stored: UUID_A, enabled: true }, mintB);
  assert.equal(r.id, UUID_A);
  assert.equal(r.write, null);
});

test('a malformed stored id is replaced rather than sent', () => {
  for (const bad of ['', 'not-a-uuid', 42, {}, 'hostname-of-this-mac']) {
    const r = resolveInstallId({ stored: bad, enabled: true }, mintB);
    assert.equal(r.id, mintB(), `${JSON.stringify(bad)} should be replaced`);
    assert.equal(r.write, 'set');
  }
});

test('telemetry off yields no id and asks for the stored one to be deleted', () => {
  const r = resolveInstallId({ stored: UUID_A, enabled: false }, mintB);
  assert.equal(r.id, null);
  assert.equal(r.write, 'delete');
});

test('telemetry off with nothing stored writes nothing', () => {
  const r = resolveInstallId({ stored: null, enabled: false }, mintB);
  assert.equal(r.id, null);
  assert.equal(r.write, null);
});

test('a minted id is a random UUID, not derived from the machine', () => {
  const a = resolveInstallId({ stored: null, enabled: true });
  const b = resolveInstallId({ stored: null, enabled: true });
  assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a.id, b.id);
});

// ─── The registry is enum-only ────────────────────────────

test('registry props are arrays of fixed strings — no free-form values possible', () => {
  for (const [event, schema] of Object.entries(EVENTS)) {
    for (const [prop, allowed] of Object.entries(schema)) {
      assert.ok(Array.isArray(allowed), `${event}.${prop} must be an enum array`);
      assert.ok(allowed.length > 0, `${event}.${prop} enum must not be empty`);
      for (const v of allowed) {
        assert.equal(typeof v, 'string', `${event}.${prop} values must be strings`);
      }
    }
  }
});

// ─── validateEvent ────────────────────────────────────────

test('unregistered event returns null', () => {
  assert.equal(validateEvent('made_up_event', {}), null);
});

test('registered event with no props passes with empty props', () => {
  assert.deepEqual(validateEvent('spec_created', undefined), {});
});

test('unknown props are stripped', () => {
  assert.deepEqual(
    validateEvent('spec_phase_advanced', { phase: 'planned', projectPath: '/Users/x/secret' }),
    { phase: 'planned' }
  );
});

test('out-of-enum values are stripped', () => {
  assert.deepEqual(validateEvent('spec_phase_advanced', { phase: 'not-a-phase' }), {});
  assert.deepEqual(validateEvent('error_occurred', { category: 'stack: at foo()' }), {});
});

// ─── spec_created origin (new-spec-agent-handoff T07) ─────
//
// The property is the difference between "specs are being created" and "the
// New Spec launcher is being used". It degrades in one direction only: a
// failed attribution must land on today's bare event, never on a wrong value.

test('every spec_created origin the code can send is accepted', () => {
  for (const origin of ['button', 'agent', 'conductor']) {
    assert.deepEqual(validateEvent('spec_created', { origin }), { origin });
  }
});

test('an unknown origin is dropped, leaving the bare event', () => {
  assert.deepEqual(validateEvent('spec_created', { origin: 'modal' }), {});
  assert.deepEqual(validateEvent('spec_created', { origin: '/Users/x/specs/secret' }), {});
});

test('an absent origin is still a valid spec_created', () => {
  assert.deepEqual(validateEvent('spec_created', {}), {});
  assert.deepEqual(validateEvent('spec_created', undefined), {});
  assert.deepEqual(validateEvent('spec_created', { origin: undefined }), {});
});

test('the origin enum matches PRIVACY.md', () => {
  const fs = require('fs');
  const path = require('path');
  const row = fs.readFileSync(path.join(__dirname, '..', 'PRIVACY.md'), 'utf8')
    .split('\n')
    .find((line) => line.startsWith('| `spec_created`'));
  assert.ok(row, 'PRIVACY.md must carry a spec_created row');
  for (const origin of EVENTS.spec_created.origin) {
    assert.ok(row.includes(`\`${origin}\``), `PRIVACY.md must document origin ${origin}`);
  }
});

test('tool props are normalized before the enum check', () => {
  assert.deepEqual(validateEvent('agent_run_started', { tool: 'claude-code' }), { tool: 'claude' });
  assert.deepEqual(validateEvent('ai_tool_selected', { tool: 'my-secret-tool' }), { tool: 'custom' });
});

// ─── normalizeTool ────────────────────────────────────────

test('normalizeTool collapses everything outside the built-ins to custom', () => {
  assert.equal(normalizeTool('claude'), 'claude');
  assert.equal(normalizeTool('codex'), 'codex');
  assert.equal(normalizeTool('gemini'), 'gemini');
  assert.equal(normalizeTool('claude-code'), 'claude');
  assert.equal(normalizeTool('aider'), 'custom');
  assert.equal(normalizeTool(''), 'custom');
  assert.equal(normalizeTool(undefined), 'custom');
  assert.equal(normalizeTool(null), 'custom');
});

// ─── Rate limiting — the quota is finite ──────────────────

test('normal use is never rate limited', () => {
  const limiter = createRateLimiter();
  // A busy minute of real user activity: every event goes out.
  for (let i = 0; i < DEFAULT_RATE_LIMIT.perWindow; i++) {
    assert.equal(limiter.check(1000 + i * 100).allowed, true, `event ${i} sent`);
  }
  assert.equal(limiter.stats().suppressed, 0);
});

test('a burst past the window cap is dropped, and says so once', () => {
  // Two Frames on one project: the older build walks spec phases back, this
  // one reconciles them forward, and the loop bills the analytics quota.
  const limiter = createRateLimiter();
  for (let i = 0; i < DEFAULT_RATE_LIMIT.perWindow; i++) limiter.check(1000);

  const first = limiter.check(1000);
  assert.equal(first.allowed, false, 'over the cap');
  assert.match(first.notice, /rate limit reached/, 'and it is reported');

  const next = limiter.check(1001);
  assert.equal(next.allowed, false);
  assert.equal(next.notice, null, 'but not reported per dropped event');

  assert.equal(limiter.stats().suppressed, 2);
});

test('the window rolls: a quiet minute restores the budget', () => {
  const limiter = createRateLimiter();
  for (let i = 0; i < DEFAULT_RATE_LIMIT.perWindow; i++) limiter.check(1000);
  assert.equal(limiter.check(1000).allowed, false);

  const later = 1000 + DEFAULT_RATE_LIMIT.windowMs;
  assert.equal(limiter.check(later).allowed, true, 'the old window has expired');
});

test('the session ceiling holds even when every window is under the cap', () => {
  // A slow loop — one event every few seconds, forever — stays under the
  // per-minute cap, so the session ceiling is what bounds it.
  const limiter = createRateLimiter({ perWindow: 1000, perSession: 5 });
  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.check(i * 10_000).allowed, true);
  }
  const over = limiter.check(6 * 10_000);
  assert.equal(over.allowed, false);
  assert.match(over.notice, /this run has sent 5 events/);
});

// ─── diffSpecLifecycle — spec_created / spec_phase_advanced ─

const { diffSpecLifecycle, renameSpecLifecycle } = require('../src/main/telemetryEvents');

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-09-14T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const spec = (slug, phase, extra) => Object.assign(
  { slug, phase, authored: true, created_at: iso(T0 - 24 * HOUR), last_phase_at: iso(T0 - 24 * HOUR) },
  extra
);

function seed(specs) {
  return diffSpecLifecycle(null, specs, T0).state;
}

test('the first look seeds without counting anything already on disk', () => {
  const r = diffSpecLifecycle(null, [spec('a', 'done'), spec('b', 'planned')], T0);
  assert.deepEqual(r.created, []);
  assert.deepEqual(r.advanced, []);
});

test('a spec authored now counts once, and not again after leaving and returning', () => {
  let state = seed([]);
  const now = T0 + 60_000;
  const fresh = spec('a', 'specified', { created_at: iso(now) });
  let r = diffSpecLifecycle(state, [fresh], now);
  assert.deepEqual(r.created, ['a']);
  state = r.state;
  // branch switched away (spec gone), then back
  state = diffSpecLifecycle(state, [], now + 1000).state;
  r = diffSpecLifecycle(state, [fresh], now + 2000);
  assert.deepEqual(r.created, [], 'a returning spec is not a new one');
});

test('a spec.md added to a slug already seen counts regardless of its created_at', () => {
  let state = seed([spec('a', 'draft', { authored: false })]);
  const r = diffSpecLifecycle(state, [spec('a', 'draft')], T0 + 60_000);
  assert.deepEqual(r.created, ['a']);
});

test('a checked-out or pulled spec stamped before the last look does not count', () => {
  const state = seed([]);
  const r = diffSpecLifecycle(state, [spec('old', 'done')], T0 + 60_000);
  assert.deepEqual(r.created, []);
  assert.deepEqual(r.advanced, []);
});

test('an unreadable or date-only created_at counts — Frame cannot tell it is old', () => {
  const state = seed([]);
  const r = diffSpecLifecycle(state, [
    spec('x', 'draft', { created_at: null }),
    spec('y', 'draft', { created_at: '2026-01-01' })
  ], T0 + 60_000);
  assert.deepEqual(r.created, ['x', 'y']);
});

test('a phase counts only past the furthest one seen — regressions and ping-pong do not', () => {
  let state = seed([spec('a', 'planned')]);
  const now = T0 + 60_000;
  let r = diffSpecLifecycle(state, [spec('a', 'tasks_generated', { last_phase_at: iso(now) })], now);
  assert.deepEqual(r.advanced, [{ slug: 'a', phase: 'tasks_generated' }]);
  r = diffSpecLifecycle(r.state, [spec('a', 'planned', { last_phase_at: iso(now) })], now + 1000);
  assert.deepEqual(r.advanced, []);
  r = diffSpecLifecycle(r.state, [spec('a', 'tasks_generated', { last_phase_at: iso(now + 2000) })], now + 2000);
  assert.deepEqual(r.advanced, [], 'returning to a phase already counted');
});

test('a phase jump stamped before the last look (checkout) does not count', () => {
  const state = seed([spec('a', 'planned')]);
  const r = diffSpecLifecycle(state, [spec('a', 'done')], T0 + 60_000);
  assert.deepEqual(r.advanced, []);
});

test('a spec that never had a readable phase is not advancing when it gets one', () => {
  const state = seed([spec('a', null)]);
  const r = diffSpecLifecycle(state, [spec('a', 'draft', { last_phase_at: iso(T0 + 1000) })], T0 + 1000);
  assert.deepEqual(r.advanced, []);
});

test('a rename carries history — the new slug is not a created spec', () => {
  const state = renameSpecLifecycle(seed([spec('old-name', 'planned', { created_at: iso(T0) })]), 'old-name', 'new-name');
  const r = diffSpecLifecycle(state, [spec('new-name', 'planned', { created_at: iso(T0) })], T0 + 1000);
  assert.deepEqual(r.created, []);
  assert.deepEqual(r.advanced, []);
});
