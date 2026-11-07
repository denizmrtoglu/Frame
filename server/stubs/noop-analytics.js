/**
 * PoC — analytics are off on the server: Aptabase and PostHog become no-ops,
 * so nothing is transmitted from a headless instance.
 */
class PostHog {
  constructor() { return new Proxy(this, { get: (t, k) => (k in t ? t[k] : () => Promise.resolve()) }); }
}
module.exports = {
  PostHog,
  initialize() {},
  trackEvent() {}
};
