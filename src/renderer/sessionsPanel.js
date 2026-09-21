/**
 * Sessions Panel
 *
 * The project's Claude Code transcripts, each one click from being resumed.
 * Reached from the sidebar's Context → Sessions row, the palette's "Go to
 * Sessions" and Home's Last Sessions card; hosted in the center by
 * `multiTerminalUI` the way the Claude panel used to be (`PANEL_REGISTRY`).
 *
 * This used to be the Sessions tab of the Claude panel, beside Plugins. The
 * two had nothing in common but the tool: a session list is *context* — what
 * the project knows about its own history, like Specs and Tasks — while
 * plugins are a Claude Code setting. So Sessions became a Context row of its
 * own and Plugins moved behind the sidebar rail's foot button for now
 * (feedbackPanel.js). Nothing about the data changed: the list still comes
 * from `LOAD_CLAUDE_SESSIONS` (sessions-from-transcripts spec).
 *
 * Host contract, the same as every center-hosted panel: `show()` adds
 * `.visible` and loads, `hide()` drops `.visible` — which is what the host's
 * MutationObserver watches to route back to the terminals view.
 */

const { ipcRenderer } = require('electron');
const { IPC } = require('../shared/ipcChannels');
const state = require('./state');
const { escapeHtml } = require('./htmlUtils');

let isVisible = false;
let sessionsData = [];
let sessionsReason = null;

let panelElement = null;
let contentElement = null;

function init() {
  panelElement = document.getElementById('sessions-panel');
  contentElement = document.getElementById('sessions-content');

  if (!panelElement) {
    console.error('sessionsPanel: #sessions-panel not found — Sessions will not open');
    return;
  }

  const refreshBtn = document.getElementById('sessions-refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshSessions);
}

/** Show the panel and (re)load the list — the host calls this on mount. */
function show() {
  if (!panelElement) return;
  panelElement.classList.add('visible');
  isVisible = true;
  loadSessions();
}

function hide() {
  if (!panelElement) return;
  panelElement.classList.remove('visible');
  isVisible = false;
}

/**
 * Load sessions from Claude data
 */
async function loadSessions() {
  const projectPath = state.getProjectPath();

  if (!projectPath) {
    sessionsData = [];
    renderSessionsEmpty('No project selected');
    return;
  }

  try {
    const result = await ipcRenderer.invoke(IPC.LOAD_CLAUDE_SESSIONS, projectPath);
    // Main returns { sessions, reason }; tolerate the legacy plain array too
    sessionsData = Array.isArray(result) ? result : (result.sessions || []);
    sessionsReason = Array.isArray(result) ? null : result.reason;
    renderSessions();
  } catch (err) {
    console.error('Error loading sessions:', err);
    sessionsData = [];
    sessionsReason = null;
    renderSessionsEmpty('Failed to load sessions');
  }
}

/**
 * Refresh sessions with spinner animation
 */
async function refreshSessions() {
  const refreshBtn = document.getElementById('sessions-refresh-btn');

  try {
    if (refreshBtn) {
      refreshBtn.classList.add('spinning');
      refreshBtn.disabled = true;
    }
    await loadSessions();
  } finally {
    if (refreshBtn) {
      refreshBtn.classList.remove('spinning');
      refreshBtn.disabled = false;
    }
  }
}

/**
 * Render sessions list
 */
function renderSessions() {
  if (!contentElement) return;

  // Update count
  const countEl = document.getElementById('sessions-count');
  if (countEl) {
    countEl.textContent = `${sessionsData.length} session${sessionsData.length !== 1 ? 's' : ''}`;
  }

  if (sessionsData.length === 0) {
    // Say WHY it's empty — an unexplained empty panel reads as broken
    const reasonMessages = {
      'no-claude-dir': 'Claude Code has no session history on this machine yet',
      'no-project-sessions': 'No Claude Code sessions recorded for this project yet',
      'read-error': 'Could not read Claude session data — check ~/.claude/projects'
    };
    renderSessionsEmpty(reasonMessages[sessionsReason] || 'No sessions found for this project');
    return;
  }

  contentElement.innerHTML = sessionsData.map(session => renderSessionItem(session)).join('');

  // Add click listeners
  contentElement.querySelectorAll('.session-item').forEach(el => {
    el.addEventListener('click', () => {
      const sessionId = el.dataset.sessionId;
      resumeSession(sessionId);
    });
  });
}

/**
 * Render a single session item
 */
function renderSessionItem(session) {
  const title = escapeHtml(session.summary || session.firstPrompt || 'Untitled session');
  const timeStr = formatRelativeTime(session.modified || session.created);
  const branch = session.gitBranch ? `<span class="session-branch">${escapeHtml(session.gitBranch)}</span>` : '';
  const msgCount = session.messageCount || 0;
  const sidechainClass = session.isSidechain ? ' sidechain' : '';

  return `
    <div class="session-item${sidechainClass}" data-session-id="${escapeHtml(session.sessionId)}">
      <div class="session-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <div class="session-content">
        <div class="session-title">${title}</div>
        <div class="session-meta">
          <span>${timeStr}</span>
          <span>${msgCount} msg${msgCount !== 1 ? 's' : ''}</span>
          ${branch}
        </div>
      </div>
    </div>
  `;
}

/**
 * Render sessions empty state
 */
function renderSessionsEmpty(message) {
  if (!contentElement) return;

  const countEl = document.getElementById('sessions-count');
  if (countEl) countEl.textContent = '';

  contentElement.innerHTML = `
    <div class="sessions-empty">
      <div class="plugins-empty-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <p>${escapeHtml(message)}</p>
      <span>Claude Code sessions will appear here</span>
    </div>
  `;
}

/**
 * Resume a session in a terminal of its own.
 *
 * Not window.terminalSendCommand: that types into whatever terminal has
 * focus, and when that terminal is already running Claude the command lands
 * in Claude's prompt as a message instead of starting anything
 * (sessions-from-transcripts spec). `hide()` drops `.visible`, which is how
 * the host routes back to the terminals view — so the new lane is on screen.
 */
function resumeSession(sessionId) {
  hide();
  // No session id, no transcript, nothing about the work — only that the
  // resume path was used at all, which is what says the feature earns its
  // place.
  ipcRenderer.send(IPC.ANALYTICS_TRACK, 'session_resumed');
  require('./agentDispatch').resumeClaudeSession(sessionId);
}

/**
 * Format a date string to relative time
 */
function formatRelativeTime(dateString) {
  if (!dateString) return '';

  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour !== 1 ? 's' : ''} ago`;
  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7) return `${diffDay} days ago`;
  if (diffDay < 30) return `${Math.floor(diffDay / 7)} week${Math.floor(diffDay / 7) !== 1 ? 's' : ''} ago`;

  return date.toLocaleDateString();
}

module.exports = {
  init,
  show,
  hide,
  isVisible: () => isVisible
};
