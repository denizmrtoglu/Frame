# Plan — PostHog analytics — identity, funnels and errors

## Architecture

### Resolved plan-time decisions

**Business**

- **Consent model (asked)** — Keep the default-on opt-out model; disclose the install ID prominently instead of switching to opt-in. Rationale: on a developer tool opt-in typically yields 5–15% participation, and none of the unique-user / funnel / retention questions this spec exists to answer survive that sample. The privacy cost is paid by disclosure, not by collecting less.
- **Identity depth (asked)** — Anonymous cohorts only. No self-identify field, no email, no handle. PRIVACY.md's "no email addresses or any personally identifiable information" line stays true as written.
- **Aptabase cutover (asked)** — Hard switch: Aptabase leaves, PostHog arrives, in one change. Rationale: the existing history is event counts only and is not comparable with user-level data, so dual-send would pay two SDKs, two quotas and a cleanup task to preserve something that cannot be joined anyway.
- **Re-notice (asked)** — Existing users see the notice once more. `telemetryNoticeShown` (boolean) is superseded by `telemetryNoticeVersion` (number); the release that introduces the install ID bumps the version, so everyone reads the new disclosure once. Rationale: people acknowledged a system with no identifier; the system is changing, and the consent model chosen above is only honest if the change is surfaced.

**Technical**

- **Error detail shape (asked)** — PostHog error tracking on a **separate, opt-in** channel (`errorReportingEnabled`, default `false`), not a `message` field inside the event registry. Rationale: a redacted free-form property would punch the first hole in the registry's enum-only guarantee, and once open there is no mechanical guard against the next contributor widening it. A physically separate channel leaves `validateEvent` absolute. The `error_occurred` enum stays for counts.
- **Person mode (asked)** — Identified events with person profiles, not `$process_person_profiles: false`. Rationale: retention cohorts and person-property filters are the point of the migration, and the free tier covers 1M identified events/month against Frame's tens-per-user-day volume.
- **Test posture (asked)** — Pure logic and data transforms only. Rationale: the project's convention already tests `telemetryEvents.js` and skips Electron-coupled `telemetry.js`, and CI runs **without `npm ci`** (`PROJECT_NOTES.md ## Testing`), so a test that reaches the PostHog SDK in `node_modules` passes locally and fails in CI. All new policy lands in the pure module.
- **Install ID storage (silent)** — `user-settings.json` via the existing `userSettings` module, alongside `telemetryEnabled`. It is already `fsSafe`-backed (atomic write, `.bak` recovery), and if that file is unreadable telemetry fails closed anyway, so a lost ID is moot rather than a second failure mode. No new state file.
- **Person properties (silent)** — `$set` carries operating system and app version only, set once per launch on the first capture. These are exactly the two fields `PRIVACY.md` already discloses Aptabase attaching, so the disclosure surface does not grow.
- **Error capture seam (silent)** — Main-process exceptions hook into `crashGuard.js`, which already owns `uncaughtException` / `unhandledRejection` and routes them through `logger`. Adding a second set of process handlers would double-report and fight the existing recovery flow.
- **Flush on quit (silent)** — `posthog-node` batches; `shutdown()` is called from the existing `before-quit` handler (`index.js:376`) so the last events of a session are not lost. Aptabase needed none of this.
- **Init ordering (silent)** — `telemetry.init()` stays at its current call site (`index.js:347`). The pre-`whenReady` requirement in the module header was an Aptabase constraint (`protocol.registerSchemesAsPrivileged`) and disappears with `posthog-node`, but moving the call buys nothing and risks the boot order; the header comment is corrected instead.
- **Autocapture (silent)** — Off. `posthog-node` has no autocapture or `$pageview` behavior by default; no call enables it, and the registry gate is unchanged, so nothing reaches PostHog that `validateEvent` did not pass.

### Shape

`telemetry.js` keeps its role as the single gate and swaps its transport. `track()` is unchanged in structure — `isEnabled()` → `validateEvent()` → rate limiter → send — with `aptabase.trackEvent(name, props)` becoming `posthog.capture({ distinctId, event, properties })`. Everything the registry guarantees is preserved because the gate itself is untouched.

Three new pieces of pure policy join `telemetryEvents.js` so they are testable under `node --test` without Electron or the SDK:

- `resolveInstallId({ stored, enabled })` → `{ id, write }` — mints a UUID when telemetry is on and none is stored, returns the stored one when valid, and returns `{ id: null, write: null }` when telemetry is off so the caller deletes it. `write` tells the caller whether `userSettings.set` is needed, keeping I/O out of the policy.
- `sanitizeException({ message, stack })` → the same shape, redacted — `scripts/redact.js` first, then absolute-path stripping (`/Users/<x>/…`, `C:\Users\<x>\…`, and any path outside the app bundle reduced to its basename).
- `shouldShowNotice({ storedVersion, currentVersion })` — the versioned replacement for the boolean, including the migration case where an old client stored `telemetryNoticeShown: true` and has no version.

The error channel is deliberately separate end to end: a different setting, a different function (`telemetry.captureException`), a different IPC channel, and a PostHog call that never passes through the event registry.

```
main exception  → crashGuard.js  ─┐
renderer error  → TELEMETRY_EXCEPTION ─┤→ telemetry.captureException()
                                       │   ↳ errorReportingEnabled? → sanitizeException() → posthog.captureException()
registry events → track() → validateEvent() → rateLimiter → posthog.capture({distinctId})
```

## Files

- `package.json` — **Modified** — drop `@aptabase/electron`, add `posthog-node`.
- `src/main/telemetry.js` — **Modified** — PostHog client (EU host, `disableGeoip`), install-ID resolution, `distinctId` on every capture, `captureException`, `shutdown`, corrected module header.
- `src/main/telemetryEvents.js` — **Modified** — adds `resolveInstallId`, `sanitizeException`, `shouldShowNotice`, `NOTICE_VERSION`. Registry, `validateEvent`, `effectiveEnabled` and the rate limiter are untouched.
- `src/main/crashGuard.js` — **Modified** — main-process `uncaughtException` / `unhandledRejection` also reach `telemetry.captureException`.
- `src/main/index.js` — **Modified** — `TELEMETRY_EXCEPTION` listener; `posthog.shutdown()` in the existing `before-quit` handler.
- `src/shared/ipcChannels.js` — **Modified** — `TELEMETRY_EXCEPTION` constant beside the existing telemetry channels.
- `src/renderer/index.js` — **Modified** — `window.onerror` / `unhandledrejection` hooks forwarding to the new channel.
- `src/renderer/telemetryNotice.js` — **Modified** — versioned notice key, new disclosure copy.
- `src/renderer/frameSettingsModal.js` — **Modified** — wire the error-reporting toggle.
- `index.html` — **Modified** — error-reporting row in Privacy & Analytics; notice copy.
- `PRIVACY.md` — **Modified** — PostHog, EU residency, the install ID and what it is not, the unchanged event table, the error-reporting opt-in.
- `test/telemetry.test.js` — **Modified** — install-ID lifecycle, exception sanitization, notice versioning; existing fail-closed and registry assertions stay.

## Footprint

- package.json
- src/main/telemetry.js
- src/main/telemetryEvents.js
- src/main/crashGuard.js
- src/main/index.js
- src/shared/ipcChannels.js
- src/renderer/index.js
- src/renderer/telemetryNotice.js
- src/renderer/frameSettingsModal.js
- index.html
- PRIVACY.md
- test/telemetry.test.js

## Dependencies

- **Add `posthog-node`** — the analytics transport. Main-process only; the renderer keeps reaching telemetry over IPC, so no renderer bundle growth.
- **Remove `@aptabase/electron`** — replaced outright (hard cutover decision).

## Sequencing

1. **Install-ID policy, pure.** Add `resolveInstallId` to `telemetryEvents.js` with its tests: mint-when-absent, reuse-when-stored, reject a malformed stored value, and return null with a delete instruction when telemetry is off.
2. **Swap the transport.** Replace `@aptabase/electron` with `posthog-node` in `package.json` and `telemetry.js`: client on `https://eu.i.posthog.com` with `disableGeoip: true`, `distinctId` from step 1 on every `capture`, `$set` of OS and app version on the first capture of a launch, corrected module header. `track()`'s gate order stays exactly as it is.
3. **Flush on exit.** Call `posthog.shutdown()` from the existing `before-quit` handler so a session's last events are not dropped by the batcher.
4. **Opt-out lifecycle.** `setEnabled(false)` deletes the stored install ID; re-enabling mints a fresh one. `enforceFailClosed()` is untouched. Extend the existing fail-closed tests to assert the ID is gone when telemetry is off.
5. **Exception sanitization, pure.** Add `sanitizeException` to `telemetryEvents.js` with its tests: secrets redacted via `scripts/redact.js`, absolute user paths reduced to basenames on both POSIX and Windows shapes, and an input carrying a prompt-like blob coming out with no absolute path.
6. **The error channel.** Add `errorReportingEnabled` (default `false`) and `telemetry.captureException`, gated on that setting *and* on `isEnabled()`, and passed through the **same rate limiter instance** `track()` uses — a repeating exception in a render loop must not be able to drain the quota. Wire `crashGuard.js`'s two handlers into it.
7. **Renderer exceptions.** Add `TELEMETRY_EXCEPTION` to `ipcChannels.js`, the `ipcMain.on` listener in `index.js` (sanitization happens in main, matching how `TELEMETRY_TRACK` revalidates), and the `window.onerror` / `unhandledrejection` hooks in `src/renderer/index.js`.
8. **Settings surface.** Error-reporting row in the Privacy & Analytics section of `index.html`, wired in `frameSettingsModal.js` next to the crash-dumps toggle.
9. **Notice re-version.** `shouldShowNotice` + `NOTICE_VERSION` in `telemetryEvents.js` with tests (fresh install, old boolean-only client, already-seen current version); `telemetryNotice.js` reads the versioned key and carries copy that names the install ID.
10. **Disclosure.** Rewrite `PRIVACY.md` — vendor, EU residency, the install ID and what it is not, the unchanged event table, the error-reporting opt-in — and record the reversal of `audit-q3-product-analytics`'s vendor decision in `PROJECT_NOTES.md` as a dated entry.
