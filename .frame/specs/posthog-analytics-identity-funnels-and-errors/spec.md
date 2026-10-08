---
keywords: posthog, analytics, funnels, retention, unique users, error tracking, telemetry, opt-out
related: audit-q3-product-analytics, audit-q3-reliability-recovery, audit-q3-ux-error-feedback
---

# PostHog analytics — identity, funnels and errors

## Problem

Frame's telemetry (Aptabase, 11-event registry) reports **event counts**, and
that is structurally all it can report: Aptabase attaches no user identifier,
so there is no way to ask how many distinct people use Frame, whether the same
people come back, what one person does across a session, or where they stop.

The founder's actual questions are all user-level and none are answerable
today:

- **How many unique users are there? Who is actively using Frame?** — `app_started`
  count conflates one user launching 40 times with 40 users launching once.
- **What do users do inside?** — per-event totals exist, but not "of the people
  who opened the orchestrator, how many ever ran one".
- **Where are we losing them?** — the install → `project_initialized` →
  `spec_created` → `agent_run_started` funnel has no drop-off view. The
  predecessor spec knowingly approximated activation as *unique users per plain
  event* (`audit-q3-product-analytics/plan.md:7`); that approximation is now the
  bottleneck.
- **What breaks in the wild?** — `error_occurred` carries a 9-value category and
  nothing else. It reports that something failed N times, never what failed.

`audit-q3-product-analytics` chose Aptabase deliberately and **rejected PostHog**
because "identity/funnels exceed the spec's out-of-scope line (no per-user
tracking)" (`plan.md:11`). This spec **reverses that decision**: the questions
the founder needs answered are user-level, so a pseudonymous per-install
identifier is now accepted — with its privacy cost paid explicitly in
`PRIVACY.md` rather than avoided.

## Goal

Product analytics on **PostHog EU cloud**, with a stable anonymous install ID,
so the dashboard answers: unique users, DAU/WAU/MAU, retention cohorts, the
activation funnel with per-step drop-off, and feature usage per user — plus a
separate, opt-in error-tracking path that carries redacted exception detail
instead of a bare category.

The registry allowlist, the fail-closed opt-out and PRIVACY.md accuracy survive
the move unchanged in spirit: PostHog replaces the transport and the dashboard,
not Frame's discipline about what may leave the machine.

## Constraints

- **Reverses a recorded decision.** `audit-q3-product-analytics` (`plan.md:11`)
  chose Aptabase and rejected PostHog. That reversal is deliberate and must be
  recorded in `PROJECT_NOTES.md`; the rest of that spec's machinery (registry,
  fail-closed opt-out, IPC revalidation) stays authoritative.
- **The registry allowlist is not negotiable.** `telemetryEvents.js` stays the
  single gate: enum-only props, `validateEvent` drops unregistered events, the
  renderer is revalidated in main over `TELEMETRY_TRACK`. **PostHog autocapture
  and `$pageview`-style automatic events stay off.**
- **Standing rule of record:** any registry addition lands in `PRIVACY.md` in the
  same change.
- **Fail-closed opt-out is preserved byte for byte.** `userSettings.loadFailed()`
  + `effectiveEnabled()` behavior and its regression test must still hold.
- **EU residency and no geo.** `eu.i.posthog.com`, geoip disabled — PRIVACY.md
  currently promises the IP is not retained.
- **The install ID is random.** A UUID generated locally and persisted through
  `fsSafe` (`audit-q3-reliability-recovery` rule: no state write bypasses it).
  Never a machine ID, hostname, username, email or anything derived from them.
  Removed on opt-out.
- **Content rules unchanged** (`PRIVACY.md`): no file paths, no code, no project
  names, no prompts or responses, no terminal I/O, no PII.
- **Error tracking must be opt-in.** `PRIVACY.md` already commits: if Frame ever
  gains the ability to *send* crash reports, it "will be a separate, **opt-in**
  setting and will be disclosed here first". Exception payloads route through
  `scripts/redact.js` and are stripped of absolute paths before send.
- **No new heavy dependency in the renderer** — analytics stays in main, reached
  over the existing `TELEMETRY_TRACK` IPC channel.

## Success Criteria

- When a user launches Frame with telemetry on, then every event carries a stable
  anonymous install ID, and the PostHog dashboard reports unique users and
  DAU/WAU/MAU rather than raw event counts.
- When users progress through install → `project_initialized` → `spec_created` →
  `agent_run_started`, then that funnel is queryable in PostHog with per-step
  conversion and drop-off.
- When a user returns days after first launch, then they appear in a retention
  cohort.
- When a user turns telemetry off, then no request reaches PostHog, the stored
  install ID is deleted, and a new ID is minted only if telemetry is turned back
  on.
- When `user-settings.json` is corrupt or unreadable, then telemetry stays off
  (the existing fail-closed test still passes unchanged).
- When a call site passes an event or property outside the registry, then it is
  dropped before the PostHog SDK is reached — asserted by tests, including the
  renderer-over-IPC path.
- When error tracking is off (the default), then no exception message, stack
  frame or path leaves the machine; when a user explicitly enables it, then the
  payload is redacted and contains no absolute path, no code and no prompt text.
- When `PRIVACY.md` is read, then it names PostHog, EU residency, the install ID
  and what it is not, every event in the registry, and the error-tracking opt-in
  — with nothing listed that Frame does not actually send.

## Out of Scope

- Session replay — an Electron dev tool's screen is the user's own code.
- PostHog feature flags and surveys (a later spec; the free tier includes them).
- The local activity record, `main.log` and crash minidumps — all stay local and
  untouched (`audit-q3-reliability-recovery`).
- Identifying users by name, email or GitHub account.
- Renderer error-feedback UX — owned by `audit-q3-ux-error-feedback`.

## Open Questions

1. **Does the default-on opt-out model survive the install ID?** Frame's
   telemetry is default-on because it was unidentifiable. A persistent
   pseudonymous ID changes that bargain. Options: (a) keep default-on opt-out and
   disclose the ID prominently in the one-time notice; (b) switch analytics to
   opt-in and accept far lower volume.
2. **"Who is actively using Frame" — how far does *who* go?** Options:
   (a) anonymous cohorts only, no way to ever contact or name a user;
   (b) an optional self-identify in Settings (a user volunteers an email/handle),
   default empty.
3. **Aptabase cutover.** Options: (a) hard switch, accept the history break;
   (b) dual-send for one release so counts can be reconciled.
4. **Error detail shape.** Options: (a) adopt PostHog's error-tracking product
   (real exceptions and stack traces, opt-in); (b) keep the category enum and add
   a single redacted `message` field, which stays inside the current registry
   model.
