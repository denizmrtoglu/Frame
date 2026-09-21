/**
 * Analytics Notice Banner
 *
 * Card in the bottom-right corner, above the status bar, carrying the
 * analytics disclosure. Independent of the onboarding screen so users who
 * never see that screen still get it.
 *
 * Versioned rather than once-and-done: people acknowledged a system that
 * carried no identifier, and it now sends a random install id. Bumping
 * NOTICE_VERSION (analyticsEvents.js) shows the changed text once to
 * everyone, including users who dismissed the previous one.
 *
 * This module draws and dismisses; whether the notice is due is main's call
 * (analytics.noticeState), so the policy sits with the settings it reads.
 */

const { ipcRenderer } = require('electron');
const { IPC } = require('../shared/ipcChannels');

const NOTICE_VERSION_KEY = 'analyticsNoticeVersion';

// The version main said was current when it decided the notice was due —
// stored on dismiss, so acknowledging records exactly what was read.
let noticeVersion = null;

let bannerEl = null;
let acknowledgeBtn = null;
let closeBtn = null;
let settingsLink = null;

async function init(openSettings) {
  bannerEl = document.getElementById('analytics-notice');
  acknowledgeBtn = document.getElementById('analytics-notice-ack');
  closeBtn = document.getElementById('analytics-notice-close');
  settingsLink = document.getElementById('analytics-notice-settings-link');

  if (!bannerEl) return;

  // Show only if this version of the disclosure hasn't been seen. Main
  // decides — see analytics.noticeState.
  const { show, version } = await ipcRenderer.invoke(IPC.ANALYTICS_NOTICE_STATE);
  if (!show) {
    bannerEl.remove();
    return;
  }
  noticeVersion = version;

  bannerEl.classList.add('visible');

  if (acknowledgeBtn) acknowledgeBtn.addEventListener('click', dismiss);
  if (closeBtn) closeBtn.addEventListener('click', dismiss);
  if (settingsLink && typeof openSettings === 'function') {
    settingsLink.addEventListener('click', (e) => {
      e.preventDefault();
      openSettings();
    });
  }
}

function dismiss() {
  if (!bannerEl) return;
  ipcRenderer
    .invoke(IPC.SET_USER_SETTING, NOTICE_VERSION_KEY, noticeVersion)
    .catch((err) =>
      console.error('Analytics notice: failed to persist dismiss', err)
    );
  bannerEl.classList.remove('visible');
  // Remove from DOM after fade so layout reflows
  setTimeout(() => {
    if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl);
    bannerEl = null;
  }, 220);
}

module.exports = { init };
