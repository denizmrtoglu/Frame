# Outcome — PostHog analytics — identity, funnels and errors

## T01 — resolveInstallId in the pure policy module

Added `resolveInstallId({ stored, enabled }, mint)` to the pure policy module with six tests. Refined plan.md's `{ id, write }` contract: `write` is a three-state instruction (`'set'` | `'delete'` | `null`) rather than a boolean, because telemetry-off has to distinguish deleting a stored id from doing nothing when none exists — a boolean could not carry that. A malformed stored value is replaced rather than sent, since it can only come from a hand-edited or half-written settings file. Files touched: `src/main/telemetryEvents.js`, `test/telemetry.test.js`.

_Captured: 2026-09-21 · 2 file change(s)_

---

