# Outcome — PostHog analytics — identity, funnels and errors

## T01 — resolveInstallId in the pure policy module

Added `resolveInstallId({ stored, enabled }, mint)` to the pure policy module with six tests. Refined plan.md's `{ id, write }` contract: `write` is a three-state instruction (`'set'` | `'delete'` | `null`) rather than a boolean, because telemetry-off has to distinguish deleting a stored id from doing nothing when none exists — a boolean could not carry that. A malformed stored value is replaced rather than sent, since it can only come from a hand-edited or half-written settings file. Files touched: `src/main/telemetryEvents.js`, `test/telemetry.test.js`.

_Captured: 2026-09-21 · 2 file change(s)_

---

## T02 — Replace Aptabase with posthog-node as the transport

Replaced `@aptabase/electron` with `posthog-node` (v5.52.5) and rewrote `telemetry.js` around `client.capture({ distinctId, event, properties })` on the EU host with geoip disabled; `track()`'s gate order is unchanged. Two things the plan did not spell out: the install id is resolved **lazily** on first send rather than in `init()`, because `userSettings` loads after `init()` and an early read would mint an id for someone who had opted out; and `init()` now refuses to build a client while the API key is still the placeholder, so the app runs and sends nothing instead of throwing. Person properties are `$os` and `$app_version` only, sent once per run. Files touched: `src/main/telemetry.js`, `package.json`, `package-lock.json`.

Followup: the PostHog project API key is still `phc_REPLACE_WITH_PROJECT_API_KEY` — nothing is sent until it is filled in.

_Captured: 2026-09-21 · 3 file change(s)_

---

## T03 — Flush the batcher on the quit path

Added `telemetry.shutdown()` (awaited `client.shutdown(2000)`, never throwing) and wired it into the existing `before-quit` handler. Went beyond plan.md's one line deliberately: a fire-and-forget call there does not flush, because Electron continues quitting and the process dies mid-request — so the handler now preventDefaults once, flushes, then re-quits, reusing the shape the live-agent confirmation already established. A `telemetryFlushed` latch keeps the second pass from looping. Files touched: `src/main/telemetry.js`, `src/main/index.js`.

_Captured: 2026-09-21 · 2 file change(s)_

---

