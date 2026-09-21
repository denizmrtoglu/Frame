/**
 * Telemetry
 *
 * Anonymous usage events via PostHog. Default opt-out: telemetry runs
 * unless the user disables it from Settings, and fails closed when the
 * settings file is unreadable. Every event must be declared in the
 * registry in telemetryEvents.js — event names plus low-cardinality enum
 * props only. No file paths, no project names, no code, no free-form
 * strings, no personally identifying information. The full event list is
 * documented in PRIVACY.md; keep the two in sync.
 *
 * Events carry a stable install id (a random UUID, see resolveInstallId)
 * so the dashboard can count unique users, follow the activation funnel
 * and read retention cohorts. It identifies an install, never a person:
 * nothing here can be joined to a name, an email or a machine.
 *
 * The PostHog project API key below is a public identifier (not a secret).
 * It is write-only — it cannot read the dashboard or delete data. Same
 * model as Google Analytics tracking IDs.
 */

const { PostHog } = require('posthog-node');
const { app } = require('electron');
const userSettings = require('./userSettings');
const telemetryEvents = require('./telemetryEvents');

// Replace with the project API key from PostHog → Settings → Project API key.
// Until it is a real `phc_…` key, init() leaves the client unbuilt and every
// track() call is a no-op — Frame works, nothing is sent.
const POSTHOG_API_KEY = 'phc_REPLACE_WITH_PROJECT_API_KEY';
// EU residency. PRIVACY.md promises the IP is not retained, so geo lookup is
// off globally rather than per call.
const POSTHOG_HOST = 'https://eu.i.posthog.com';

// Bounds the quit path: a dead network must not be able to hold the app
// open, so the flush gets this long and the quit proceeds regardless.
const SHUTDOWN_TIMEOUT_MS = 2000;

const ENABLED_KEY = 'telemetryEnabled';
const INSTALL_ID_KEY = 'telemetryInstallId';
// Opt-IN, unlike ENABLED_KEY. PRIVACY.md committed, before this existed,
// that any ability to *send* crash detail would be a separate opt-in
// setting; absent means off, and only an explicit true turns it on.
const ERROR_REPORTING_KEY = 'errorReportingEnabled';

let client = null;
let installId = null;
let identified = false;

// Bounds what one run can spend of the analytics quota; see the limiter's
// note in telemetryEvents.js for why an app that only sends user-driven
// events still needs a ceiling.
const rateLimiter = telemetryEvents.createRateLimiter();

/**
 * Build the PostHog client.
 *
 * Unlike Aptabase — which had to initialize before app.whenReady() because
 * it registered a privileged protocol scheme — posthog-node has no such
 * constraint. The call site is unchanged anyway: moving it buys nothing and
 * only risks the boot order.
 *
 * We always build (regardless of opt-out state) because construction has no
 * network side-effects — events only go out when capture runs, and that path
 * is gated by isEnabled(). Building eagerly avoids the chicken-and-egg with
 * userSettings, which loads after app.whenReady.
 */
function init() {
  if (client) return;
  if (!POSTHOG_API_KEY.startsWith('phc_') || POSTHOG_API_KEY.includes('REPLACE')) {
    console.warn('Telemetry: no PostHog project API key configured — nothing will be sent');
    return;
  }
  try {
    client = new PostHog(POSTHOG_API_KEY, { host: POSTHOG_HOST, disableGeoip: true });
  } catch (err) {
    console.error('Telemetry: PostHog init failed', err);
  }
}

/**
 * This install's distinct id, resolved on first use and cached for the run.
 *
 * Lazy because userSettings loads after init(): asking earlier would read an
 * empty cache and mint an id for a user who had opted out. Returns null when
 * telemetry is off, which is also the caller's signal to send nothing.
 */
function distinctId() {
  if (installId) return installId;
  const { id, write } = telemetryEvents.resolveInstallId({
    stored: userSettings.get(INSTALL_ID_KEY),
    enabled: isEnabled()
  });
  if (write === 'set') userSettings.set(INSTALL_ID_KEY, id);
  else if (write === 'delete') userSettings.set(INSTALL_ID_KEY, null);
  installId = id;
  return id;
}

/**
 * Person properties, sent once per run alongside the first event.
 *
 * Operating system and app version only — exactly the two fields Aptabase
 * attached automatically and that PRIVACY.md already discloses, so the
 * disclosure surface does not grow with the move.
 */
function personProperties() {
  if (identified) return undefined;
  identified = true;
  return { $set: { $os: process.platform, $app_version: app.getVersion() } };
}

/**
 * Send a registered anonymous event. No-op if disabled or not initialized.
 * The (name, props) pair is validated against the registry in
 * telemetryEvents.js — unregistered events are dropped entirely, unknown
 * props and out-of-enum values are stripped — so no call site (main or
 * renderer via IPC) can ship content past the allowlist.
 */
function track(name, props) {
  if (!isEnabled() || !client) return;
  const validated = telemetryEvents.validateEvent(name, props);
  if (validated === null) return;
  const gate = rateLimiter.check(Date.now());
  if (gate.notice) console.warn('Telemetry:', gate.notice);
  if (!gate.allowed) return;
  const id = distinctId();
  if (!id) return;
  try {
    client.capture({
      distinctId: id,
      event: name,
      properties: Object.assign({}, validated, personProperties())
    });
  } catch (err) {
    console.error('Telemetry: capture failed', err);
  }
}

/**
 * Whether exception detail may be sent.
 *
 * Two gates, both required: analytics must be on at all (so a telemetry
 * opt-out silences this too, and a corrupt settings file fails closed here
 * as well), and this setting must be explicitly true. Anything else —
 * absent, null, a stray string — reads as off.
 */
function isErrorReportingEnabled() {
  return isEnabled() && userSettings.get(ERROR_REPORTING_KEY) === true;
}

/**
 * Send one exception, sanitized. No-op unless error reporting is explicitly on.
 *
 * Deliberately not an event: this never touches the registry, so
 * validateEvent stays mechanically enum-only and a reviewer does not have
 * to trust a call site. It does share the event rate limiter, because an
 * exception repeating inside a render loop is exactly the shape of bug that
 * would otherwise spend a month's quota in an afternoon.
 *
 * The raw error is never handed to the SDK — a reconstructed one carries
 * only the sanitized fields, so there is no path by which the original
 * message or stack could be read off it later.
 */
function captureException(err) {
  if (!isErrorReportingEnabled() || !client) return;
  const gate = rateLimiter.check(Date.now());
  if (gate.notice) console.warn('Telemetry:', gate.notice);
  if (!gate.allowed) return;
  const id = distinctId();
  if (!id) return;
  const safe = telemetryEvents.sanitizeException(err);
  try {
    const scrubbed = new Error(safe.message);
    scrubbed.name = safe.name;
    scrubbed.stack = safe.stack;
    client.captureException(scrubbed, id);
  } catch (e) {
    console.error('Telemetry: captureException failed', e);
  }
}

/**
 * Anonymous event marking this launch.
 */
function trackAppStarted() {
  track('app_started');
}

/**
 * Toggle telemetry from Settings. Persists the new state, then re-resolves
 * the install id so the toggle takes effect on disk immediately.
 *
 * Turning telemetry off deletes the stored id rather than parking it: an
 * opt-out that leaves a resumable identifier behind is not an opt-out.
 * Turning it back on therefore mints a new one, and the returning user is
 * deliberately a new user to the dashboard — continuity is the thing the
 * opt-out was asked to break.
 */
function setEnabled(enabled) {
  const value = enabled === true;
  userSettings.set(ENABLED_KEY, value);
  installId = null;
  identified = false;
  distinctId();
  return value;
}

/**
 * Make a failed settings load's fail-closed state stick. Called right after
 * userSettings loads.
 *
 * The in-memory flag alone does not hold: any later setting write (dismissing
 * the telemetry notice, which reappears because its own flag was lost too)
 * rewrites the file from an empty cache and clears the flag, and the corrupt
 * file has already been moved aside, so the next launch reads "no file" as a
 * fresh install. Either way telemetry came back on for someone who may have
 * opted out. Writing the opt-out persists the only safe assumption; the user
 * can turn it back on in Settings.
 */
function enforceFailClosed() {
  if (!userSettings.loadFailed()) return;
  userSettings.set(ENABLED_KEY, false);
}

/**
 * Effective enabled state. Default ON when the setting has never been
 * touched (opt-out semantics) — but fails CLOSED when the settings file
 * could not be loaded at all, so corruption can never silently re-enable
 * telemetry for a user who opted out.
 */
function isEnabled() {
  return telemetryEvents.effectiveEnabled({
    value: userSettings.get(ENABLED_KEY),
    loadFailed: userSettings.loadFailed(),
  });
}

/**
 * Flush the batcher and close the client, for the quit path.
 *
 * posthog-node queues events and sends them on an interval, so a session's
 * last events would otherwise die with the process — the very events that
 * say what a user did just before leaving. Resolves either way: a flush
 * that cannot reach the network must not be able to hold the app open, so
 * the SDK's own timeout bounds it and a failure is logged, not thrown.
 */
async function shutdown() {
  if (!client) return;
  try {
    await client.shutdown(SHUTDOWN_TIMEOUT_MS);
  } catch (err) {
    console.error('Telemetry: shutdown failed', err);
  } finally {
    client = null;
  }
}

module.exports = {
  init,
  track,
  trackAppStarted,
  captureException,
  setEnabled,
  isEnabled,
  isErrorReportingEnabled,
  enforceFailClosed,
  shutdown
};
