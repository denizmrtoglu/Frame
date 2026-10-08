---
keywords: posthog, analytics, install id, funnels, retention, error tracking, telemetry, opt-out, notice version
related: audit-q3-product-analytics, audit-q3-reliability-recovery
---
Moved analytics off Aptabase onto PostHog EU (`posthog-node`, geoip disabled),
explicitly reversing audit-q3-product-analytics's vendor decision: Aptabase
attaches no identifier, so unique users, funnels and retention were structurally
unanswerable. No event was added — the user-level views come from attaching a
random per-install UUID to the eleven events that already existed; `track()`'s
gate order and `validateEvent` are untouched. Opting out deletes the id
(re-enable mints a new one). Rejected: opt-in analytics (5-15% sample kills the
questions), self-identify (keeps PII out), personless mode, dual-send, and a
redacted `message` prop on `error_occurred` — that last one would have ended the
registry's enum-only guarantee, so exception detail got a separate opt-in channel
(`errorReportingEnabled`, default off) that sanitizes via redact.js plus absolute
path→basename and never touches the registry. Notice became versioned so the
changed disclosure reaches people who dismissed the old one. Rules: the error
channel never becomes an event; `NOTICE_VERSION` bumps only when the disclosure
changes; new policy goes in the pure module (CI runs without `npm ci`).

Chain: spec.md → plan.md → tasks.md → outcome.md
