/**
 * Guided tour — the DOM host (first-run-guided-tour spec).
 *
 * A light layer over the live app: one step at a time, the step's target sits
 * in a clear cutout while the rest of the window dims a little, and a small
 * card beside it says what it is. The steps, their copy and every rule about
 * which one comes next live in tour/tourSteps.js, which is pure and tested;
 * this module only finds targets, measures them and paints.
 *
 * It never blocks the app. The overlay takes no clicks except on the card, so
 * a highlighted button still works and nothing else is locked while the tour
 * is open. It never navigates either: every target lives in the header, the
 * rail or the sidebar nav.
 *
 * Targets are looked up again on every reposition rather than held: the top
 * bar rewrites its chips on each render, so an element kept from the start of
 * a step can be detached a moment later.
 *
 * Listeners that follow layout (resize, sidebar, scroll, ResizeObserver) are
 * bound only while the tour is open, so a closed tour costs nothing.
 *
 * It starts by itself once per user, the first time the boot surface gets
 * out of the way (appLoader.onBootLeave): with a project open at step 2, with
 * none at step 1. The palette's Take the Frame Tour starts it any time.
 *
 * Skip tour, Escape and Done record `guidedTourDone` so the tour does not come
 * back by itself; quitting mid-tour records nothing. The keys answer only while
 * focus is inside the card — Frame is terminal-first, and Escape typed into an
 * agent's terminal belongs to the agent.
 */

const { ipcRenderer } = require('electron');
const { IPC } = require('../shared/ipcChannels');
const state = require('./state');
const notify = require('./notify');
const commandRegistry = require('./commandRegistry');
const sidebarResize = require('./sidebarResize');
const projectListUI = require('./projectListUI');
const appLoader = require('./appLoader');
const tourSteps = require('./tour/tourSteps');

const { STEPS } = tourSteps;

/** Space between a target's edge and the cutout's. */
const HOLE_PADDING = 6;

let initialized = false;
let hooks = {};
let rootEl = null;
let holeEl = null;
let cardEl = null;

let isOpen = false;
let index = -1;
let startedWithoutProject = false;
let unbindWhileOpen = [];
let targetObserver = null;
let observedTarget = null;
let repositionQueued = false;
let loggedMissing = new Set();

/**
 * @param {object} [opts]
 * @param {Function} [opts.revealProjectsTab]  open the sidebar on its Projects
 *   tab (index.js's revealSidebarTab), so a nav row can be measured
 */
function init(opts = {}) {
  // Init-once, like every other surface in the renderer: a reload must not
  // stack a second set of listeners (audit-q3-performance-resources T06).
  if (initialized) return;
  initialized = true;
  hooks = opts;

  // Step 1 has no Next: it waits for a project, by whichever route arrives —
  // the highlighted boxes, the header switcher, the palette. Two frames later
  // the header and the sidebar nav have rendered the project, so step 2's
  // target is there to measure.
  state.onProjectChange((path) => {
    if (!isOpen || !path || index === -1) return;
    if (STEPS[index].advance !== 'project') return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (isOpen && index !== -1 && STEPS[index].advance === 'project') next();
    }));
  });

  appLoader.onBootLeave(autoStart);
}

/**
 * The once-per-user start. The setting is read here rather than at init so
 * the answer is current when the app appears; a read that fails does not
 * start the tour (tourSteps.shouldAutoStart).
 */
async function autoStart() {
  let done = null;
  let readFailed = false;
  try {
    done = await ipcRenderer.invoke(IPC.GET_USER_SETTING, tourSteps.SETTING_KEY);
  } catch (err) {
    readFailed = true;
    console.error('guidedTour: could not read whether the tour was already seen — not starting it', err);
  }
  if (!tourSteps.shouldAutoStart({ done, readFailed })) return;
  await noticesGone();
  // The app has only just been uncovered: give the header, the nav and Home
  // two frames to lay out before the first target is measured.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!isOpen) start();
  }));
}

/*
 * One-time notices a first launch can show. They sit above the tour by
 * design (the tour never dims a notice), so rather than put two first-run
 * layers on screen at once, the automatic start waits until the user has
 * dismissed them. A manual start does not wait.
 */
const FIRST_RUN_NOTICES = ['#telemetry-notice.visible'];

function noticesGone() {
  const showing = () => FIRST_RUN_NOTICES.some((selector) => document.querySelector(selector));
  if (!showing()) return Promise.resolve();
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (showing()) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
}

/**
 * End the tour and remember it. `outcome` is 'finished' or 'skipped'. A write
 * that fails is told to the user: the tour may show again on the next launch.
 */
async function finish(outcome) {
  if (!isOpen) return;
  close();
  // Finished vs skipped is the first honest activation signal Frame has:
  // both mean the tour was reached, only one means it landed.
  ipcRenderer.send(IPC.TELEMETRY_TRACK, 'tour_finished', { outcome });
  try {
    const ok = await ipcRenderer.invoke(IPC.SET_USER_SETTING, tourSteps.SETTING_KEY, {
      outcome,
      at: new Date().toISOString()
    });
    if (ok === false) throw new Error('userSettings.set returned false');
  } catch (err) {
    console.error('guidedTour: failed to record the tour as done', err);
    notify.error('Could not save that the tour is done. It may show again next time Frame opens.');
  }
}

function hasProject() {
  return !!state.getProjectPath();
}

/**
 * Start (or restart) the tour from the first step that applies: step 1 with
 * no project open, the project switcher with one.
 */
function start() {
  if (isOpen) close();
  if (!ensureNodes()) return;

  startedWithoutProject = !hasProject();
  loggedMissing = new Set();
  const first = tourSteps.firstStepIndex({ hasProject: hasProject(), isAvailable });
  if (first === -1) {
    console.error('guidedTour: no step has a target on screen — the tour did not start');
    return;
  }

  isOpen = true;
  rootEl.hidden = false;
  bindWhileOpen();
  show(first);
}

/** Leave the tour: remove the layer and every listener it bound. */
function close() {
  if (!isOpen) return;
  isOpen = false;
  index = -1;
  unbindWhileOpen.forEach((unbind) => unbind());
  unbindWhileOpen = [];
  observeTarget(null);
  if (rootEl) rootEl.hidden = true;
}

function next() {
  if (!isOpen) return;
  const following = tourSteps.nextStepIndex(index, { hasProject: hasProject(), isAvailable });
  // Nothing left on screen to show counts as reaching the end.
  if (following === -1) {
    finish('finished');
    return;
  }
  show(following);
}

function ensureNodes() {
  if (rootEl && rootEl.isConnected) return true;
  if (!document.body) {
    console.error('guidedTour: document.body is not ready — the tour cannot open');
    return false;
  }
  rootEl = document.createElement('div');
  rootEl.id = 'guided-tour';
  rootEl.hidden = true;

  holeEl = document.createElement('div');
  holeEl.className = 'tour-hole';

  cardEl = document.createElement('div');
  cardEl.className = 'tour-card';
  cardEl.setAttribute('role', 'dialog');
  cardEl.setAttribute('aria-live', 'polite');
  cardEl.tabIndex = -1;
  cardEl.addEventListener('click', onCardClick);
  cardEl.addEventListener('keydown', onCardKeydown);

  rootEl.append(holeEl, cardEl);
  document.body.appendChild(rootEl);
  return true;
}

// ─── targets ──────────────────────────────────────────────

function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * The step's first usable target, with its entry.
 *
 * A target on screen always wins. A nav-row target that exists but is hidden
 * — sidebar collapsed, another rail tab showing, its group collapsed — counts
 * as usable too: with `reveal` the nav is opened and the row measured again;
 * without it (the availability check) it is reported without touching the UI.
 */
function resolveTarget(step, { reveal = false } = {}) {
  for (const target of step.targets) {
    const el = document.querySelector(target.selector);
    if (isVisible(el)) return { el, target };
    if (!target.needsNav || !el) continue;
    if (!reveal) return { el, target };
    revealNav(target.needsNav);
    const revealed = document.querySelector(target.selector);
    if (isVisible(revealed)) return { el: revealed, target };
  }
  return null;
}

function isAvailable(step) {
  return !!resolveTarget(step);
}

function revealNav(view) {
  if (typeof hooks.revealProjectsTab === 'function') {
    try {
      hooks.revealProjectsTab();
    } catch (err) {
      console.error('guidedTour: revealing the Projects tab failed', err);
    }
  }
  projectListUI.revealNavItem(view);
}

// ─── painting ─────────────────────────────────────────────

function show(i) {
  const step = STEPS[i];
  const resolved = step && resolveTarget(step, { reveal: true });
  if (!resolved) {
    skipMissing(i);
    return;
  }
  index = i;
  renderCard(step, i);
  cardEl.classList.add('tour-card-measuring');
  position();
  // One frame measured and placed, then let it be seen (and animate from
  // here on).
  requestAnimationFrame(() => {
    if (!cardEl) return;
    cardEl.classList.remove('tour-card-measuring');
    focusCard();
  });
}

/** A step whose target is gone: log it once, move on, never end the tour on it. */
function skipMissing(i) {
  const step = STEPS[i];
  // Step 1's target leaving because a project arrived is its success, not a
  // missing target — the project-change handler and this path both land on
  // step 2.
  const done = step && step.advance === 'project' && hasProject();
  if (step && !done && !loggedMissing.has(step.id)) {
    loggedMissing.add(step.id);
    console.error(`guidedTour: step "${step.id}" has no target on screen — skipped`);
  }
  const following = tourSteps.nextStepIndex(i, { hasProject: hasProject(), isAvailable });
  if (following === -1) {
    finish('finished');
    return;
  }
  show(following);
}

/** The steps this run of the tour counts: step 1 only if it began without a project. */
function countedSteps() {
  return STEPS.filter((s) => startedWithoutProject || !s.requiresNoProject);
}

function renderCard(step, i) {
  const counted = countedSteps();
  const position = counted.indexOf(step) + 1;
  // Last in this run's order, not "nothing follows right now": without a
  // project nothing follows step 1 either, and it is not the end.
  const last = counted[counted.length - 1] === step;

  cardEl.replaceChildren();
  cardEl.setAttribute('aria-label', step.title);

  const head = el('div', 'tour-card-head');
  head.append(
    el('h4', 'tour-card-title', step.title),
    el('span', 'tour-card-counter', `${position} of ${counted.length}`)
  );
  cardEl.append(head, el('p', 'tour-card-body', step.body));
  if (step.closing) cardEl.append(el('p', 'tour-card-closing', step.closing));

  const foot = el('div', 'tour-card-foot');
  if (!last) {
    const skip = el('button', 'tour-card-skip', 'Skip tour');
    skip.type = 'button';
    skip.dataset.tourAction = 'skip';
    foot.append(skip);
  } else {
    // The details live in the guide; the tour only points at it.
    const guide = el('button', 'tour-card-link', 'How to Use Frame');
    guide.type = 'button';
    guide.dataset.tourAction = 'guide';
    foot.append(guide);
  }
  foot.append(el('span', 'tour-card-spacer'));

  if (step.advance === 'project') {
    // The boxes in the cutout are the way forward, not a button here.
    foot.append(el('span', 'tour-card-hint', 'Add a project to continue'));
  } else {
    const primary = el('button', 'primary-btn tour-card-next', last ? 'Done' : 'Next');
    primary.type = 'button';
    primary.dataset.tourAction = last ? 'done' : 'next';
    foot.append(primary);
  }

  cardEl.append(foot);
}

/** Put focus on the card's primary control so Enter, → and Escape reach it. */
function focusCard() {
  if (!cardEl) return;
  const primary = cardEl.querySelector('.tour-card-next') || cardEl;
  primary.focus({ preventScroll: true });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function onCardClick(e) {
  const btn = e.target.closest('[data-tour-action]');
  if (!btn) return;
  const action = btn.dataset.tourAction;
  if (action === 'next') next();
  else if (action === 'done') finish('finished');
  else if (action === 'skip') finish('skipped');
  else if (action === 'guide') {
    finish('finished');
    if (!commandRegistry.runById('help.guide')) {
      console.error('guidedTour: help.guide did not run');
    }
  }
}

/*
 * Bound on the card, not the document: the keys answer only while focus is in
 * the tour, never while the user types into a terminal or a form.
 */
function onCardKeydown(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    finish('skipped');
    return;
  }
  if (e.key === 'ArrowRight' || (e.key === 'Enter' && !e.target.closest('button'))) {
    const primary = cardEl.querySelector('.tour-card-next');
    if (!primary) return;
    e.preventDefault();
    primary.click();
  }
}

/** Measure the current target and move the cutout and the card to it. */
function position() {
  if (!isOpen || index === -1) return;
  const step = STEPS[index];
  const resolved = resolveTarget(step);
  if (!resolved || !isVisible(resolved.el)) {
    // It was there when the step opened and has gone since (a project
    // removed, the sidebar collapsed, a view re-rendered away): treat it like
    // any missing target rather than re-opening what the user just closed.
    skipMissing(index);
    return;
  }
  observeTarget(resolved.el);

  const rect = resolved.el.getBoundingClientRect();
  const hole = {
    top: rect.top - HOLE_PADDING,
    left: rect.left - HOLE_PADDING,
    width: rect.width + HOLE_PADDING * 2,
    height: rect.height + HOLE_PADDING * 2
  };
  holeEl.style.top = `${hole.top}px`;
  holeEl.style.left = `${hole.left}px`;
  holeEl.style.width = `${hole.width}px`;
  holeEl.style.height = `${hole.height}px`;

  const placed = tourSteps.placeCard(
    hole,
    { width: cardEl.offsetWidth, height: cardEl.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight },
    resolved.target.placement
  );
  cardEl.style.top = `${placed.top}px`;
  cardEl.style.left = `${placed.left}px`;
  cardEl.dataset.placement = placed.placement;
}

/** Coalesce bursts (a sidebar drag, a scroll) into one measurement per frame. */
function queueReposition() {
  if (repositionQueued) return;
  repositionQueued = true;
  requestAnimationFrame(() => {
    repositionQueued = false;
    position();
  });
}

function observeTarget(target) {
  if (observedTarget === target) return;
  if (targetObserver && observedTarget) targetObserver.unobserve(observedTarget);
  observedTarget = target;
  if (targetObserver && target) targetObserver.observe(target);
}

function bindWhileOpen() {
  const onResize = () => queueReposition();
  window.addEventListener('resize', onResize);
  unbindWhileOpen.push(() => window.removeEventListener('resize', onResize));

  // Scrolls anywhere (the sidebar nav, a panel) move targets without resizing
  // anything — capture catches the ones that do not bubble.
  const onScroll = () => queueReposition();
  document.addEventListener('scroll', onScroll, true);
  unbindWhileOpen.push(() => document.removeEventListener('scroll', onScroll, true));

  unbindWhileOpen.push(sidebarResize.onChange(() => queueReposition()));

  if (typeof ResizeObserver === 'function') {
    const layoutObserver = new ResizeObserver(() => queueReposition());
    const container = document.getElementById('terminal-container');
    if (container) layoutObserver.observe(container);
    targetObserver = new ResizeObserver(() => queueReposition());
    unbindWhileOpen.push(() => {
      layoutObserver.disconnect();
      targetObserver.disconnect();
      targetObserver = null;
      observedTarget = null;
    });
  }
}

module.exports = { init, start, close, finish, isOpen: () => isOpen };
