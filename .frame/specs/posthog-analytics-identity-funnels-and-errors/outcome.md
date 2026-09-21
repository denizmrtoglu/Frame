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

## T04 — Opt-out destroys the install id

Made `setEnabled` re-resolve the install id so the toggle lands on disk at once — off deletes the stored id, on mints a new one. Added four composition tests over `effectiveEnabled` + `resolveInstallId`; the fail-closed cases now assert not just that nothing is sent but that nothing is kept, which is the stronger claim PRIVACY.md will make. A returning user who opted out and back in is deliberately a new user to the dashboard. Files touched: `src/main/telemetry.js`, `test/telemetry.test.js`.

_Captured: 2026-09-21 · 2 file change(s)_

---

## T05 — sanitizeException in the pure policy module

Added `sanitizeException` to the pure module: redact first, then strip absolute paths to basenames on both POSIX and Windows shapes. Two refinements the plan did not specify — the POSIX pattern requires two or more segments and a `(?<![:/])` lookbehind, so `https://eu.i.posthog.com/batch` in an error message survives intact instead of being rewritten to `batch`; and the function never throws and never returns undefined fields, because it runs on the error path where a second failure would lose the first. Files touched: `src/main/telemetryEvents.js`, `test/telemetry.test.js`.

_Captured: 2026-09-21 · 2 file change(s)_

---

## T06 — The opt-in error channel

Added `errorReportingEnabled` (opt-in, explicit `true` only), `captureException` and `isErrorReportingEnabled` to `telemetry.js`, and called the former from crashGuard's two existing handlers. Beyond the plan: the SDK receives a **reconstructed** Error carrying only the sanitized fields rather than the original, closing the path by which the raw message or stack could be read off the object downstream; and error reporting is gated on `isEnabled()` too, so one opt-out silences both channels. Files touched: `src/main/telemetry.js`, `src/main/crashGuard.js`.

_Captured: 2026-09-21 · 2 file change(s)_

---

## T07 — Renderer exceptions reach the same channel

Added the `TELEMETRY_EXCEPTION` channel, its main-process listener, and `error` / `unhandledrejection` hooks in the renderer entry point. Used `window.addEventListener('error')` rather than `window.onerror` as the plan's prose said, because the assignment form would silently replace any handler another module had installed. Sanitization deliberately stays in main, matching how `TELEMETRY_TRACK` revalidates there. Files touched: `src/shared/ipcChannels.js`, `src/main/index.js`, `src/renderer/index.js`.

_Captured: 2026-09-21 · 3 file change(s)_

---

## T08 — The error-reporting row in Settings

Added the opt-in "Send error reports" row and updated the usage-stats copy to name the random install ID, which is the disclosure D1 traded for keeping the default-on model. **Went one file outside plan.md's Files**: `src/renderer/styles/components/settings-modal.css` had a disabled state for selects and buttons but none for a switch, and without it the gated row would have looked operable while doing nothing — the two rules follow the file's existing 0.5-opacity convention. Files touched: `index.html`, `src/renderer/frameSettingsModal.js`, `src/renderer/styles/components/settings-modal.css`.

_Captured: 2026-09-21 · 3 file change(s)_

---

## T09 — The disclosure notice becomes versioned

Replaced the notice's `telemetryNoticeShown` boolean with a `telemetryNoticeVersion` number driven by `shouldShowNotice`, so the changed disclosure reaches the people who dismissed the old one — which is what D4 traded for keeping the default-on model. Corrected course mid-task: the first wiring had the renderer requiring `../main/telemetryEvents`, the only renderer→main require in the codebase, so the decision moved into `telemetry.noticeState()` behind a new `TELEMETRY_NOTICE_STATE` channel and the renderer now only draws and dismisses. Files touched: `src/main/telemetryEvents.js`, `src/main/telemetry.js`, `src/main/index.js`, `src/shared/ipcChannels.js`, `src/renderer/telemetryNotice.js`, `index.html`, `test/telemetry.test.js`.

_Captured: 2026-09-21 · 7 file change(s)_

---

