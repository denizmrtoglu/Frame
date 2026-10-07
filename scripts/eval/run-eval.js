#!/usr/bin/env node
/**
 * Orientation Eval Runner — measures whether Frame's context actually helps.
 *
 * For each task × arm, creates an ephemeral git worktree at the suite's
 * pinned commit, strips the Frame context in the `bare` arm, runs the agent
 * headless, and captures the transcript, the produced diff, and the
 * successCheck result under scripts/eval/results/. Scoring happens
 * separately in score.js — this file only produces raw artifacts.
 *
 * Usage:
 *   node scripts/eval/run-eval.js                     # all tasks, both arms
 *   node scripts/eval/run-eval.js --task <id>         # one task
 *   node scripts/eval/run-eval.js --arm frame|bare    # one arm
 *   node scripts/eval/run-eval.js --timeout 600       # seconds per run (default 600)
 *   node scripts/eval/run-eval.js --out <dir>         # results dir override
 *   node scripts/eval/run-eval.js --hooks             # frame arm runs with spec-knowledge hooks (injected-vs-not comparison)
 *   node scripts/eval/run-eval.js --retrieval-arms    # STR-03: tasks.json retrievalSuite × no-hint | legacy | v2
 *   node scripts/eval/run-eval.js --retrieval-arms --repeat 5 --seed 7   # repetitions, shuffled order
 *
 * Retrieval tasks have a `kind` (STR-03b): `navigation` and `natural` are
 * decided by their successCheck on the produced change; `question` tasks
 * edit nothing and pass when the agent's final answer names an expected
 * file (`answerCheck.contains`). Retrieval runs write their results outside
 * the repository by default, and every run compares `git status`, the
 * branch list and the worktree list before and after: any difference is
 * printed and fails the run.
 *
 * Retrieval arms share everything — worktree, pinned commit, the map built
 * by this checkout's update-structure.js, prompt, model, permissions — except
 * the search hook: none, or this checkout's module-hint.js with the legacy or
 * v2 engine. Each cell's hook activity goes to its own FRAME_ACTIVITY_HOME so
 * score.js can tell whether the hook ran as the arm intends.
 *
 * Agent CLI is configurable so other tools can slot in:
 *   FRAME_EVAL_AGENT       binary (default: claude)
 *   FRAME_EVAL_AGENT_ARGS  space-separated flags
 *     (default: --output-format stream-json --verbose --dangerously-skip-permissions)
 *   The prompt is always appended as: -p "<prompt>"
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..', '..');
const SUITE = JSON.parse(fs.readFileSync(path.join(__dirname, 'tasks.json'), 'utf-8'));

// Files whose absence defines the `bare` arm: everything Frame injects or
// instructs an agent to read, plus the lookup tool itself.
const FRAME_CONTEXT_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'STRUCTURE.json',
  'PROJECT_NOTES.md',
  'tasks.json',
  'scripts/find-module.js',
  '.frame/docs/REFERENCE.md'
];

const AGENT_CMD = process.env.FRAME_EVAL_AGENT || 'claude';
const AGENT_ARGS = (process.env.FRAME_EVAL_AGENT_ARGS ||
  '--output-format stream-json --verbose --dangerously-skip-permissions'
).split(' ').filter(Boolean);

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  return {
    task: get('--task'),
    arm: get('--arm'),
    timeoutSec: Number(get('--timeout')) || 600,
    out: get('--out'),
    // --hooks: frame-arm worktrees get the spec-knowledge hooks
    // (.claude/settings.json + freshly built index + hint scripts), so runs
    // measure injected vs non-injected agent behavior. Bare arm never hooks.
    hooks: args.includes('--hooks'),
    retrievalArms: args.includes('--retrieval-arms'),
    // STR-03b: choose arms and task kinds, e.g. --arms no-engine,v2 --kinds natural,question
    arms: get('--arms') ? get('--arms').split(',').map((a) => a.trim()).filter(Boolean) : null,
    kinds: get('--kinds') ? get('--kinds').split(',').map((k) => k.trim()).filter(Boolean) : null,
    repeat: Math.max(1, Number(get('--repeat')) || 1),
    seed: Number(get('--seed')) || Date.now() % 100000
  };
}

const RETRIEVAL_ARMS = ['no-hint', 'legacy', 'v2'];
// `no-engine` (STR-03b): Frame without its search engine — no search hint,
// no find-module, and no find-module lines in the instructions an agent is
// given. Everything else in the checkout stays.
const ALL_RETRIEVAL_ARMS = [...RETRIEVAL_ARMS, 'no-engine'];

// The engine files a v2 cell runs from this checkout (the pinned tree has older ones).
const ENGINE_FILES = ['find-module.js', 'module-hint.js', 'structure-retrieval.js', 'structure-read.js', 'intent-map.json', 'toolVocabulary.js', 'activity-log.js', 'redact.js'];
// Instruction files an agent reads or is given at session start.
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.frame/AGENTS.md', '.claude/rules/frame.md', '.frame/docs/REFERENCE.md'];

/** Instructions without the find-module route: the "Fast file lookup" block and any line naming it. */
function withoutFindModule(text) {
  return String(text)
    .replace(/\*\*Fast file lookup\*\*[^\n]*\n+```[a-z]*\n[\s\S]*?\n```\n?/g, '')
    .split('\n').filter((line) => !/find-module/.test(line)).join('\n');
}

/**
 * The project's hook settings with the search hint replaced: removed
 * (`command` null) or pointed at `command`. Every other hook stays.
 */
function withSearchHook(settings, command) {
  const out = JSON.parse(JSON.stringify(settings || {}));
  for (const [event, groups] of Object.entries(out.hooks || {})) {
    out.hooks[event] = groups.map((g) => ({
      ...g,
      hooks: (g.hooks || []).flatMap((h) => (/module-hint/.test(String(h.command || '')) ? (command ? [{ ...h, command }] : []) : [h]))
    })).filter((g) => g.hooks.length);
  }
  const present = Object.values(out.hooks || {}).some((groups) => groups.some((g) => (g.hooks || []).some((h) => h.command === command)));
  if (command && !present) {
    out.hooks = out.hooks || {};
    out.hooks.PreToolUse = [...(out.hooks.PreToolUse || []), { matcher: 'Grep|Glob|Bash', hooks: [{ type: 'command', command }] }];
  }
  return out;
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return null; }
}

/** Deterministic shuffle (mulberry32) so a run order can be reproduced. */
function shuffled(items, seed) {
  let t = seed >>> 0;
  const rand = () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Retrieval-arm setup: the same map for every arm (this checkout's
 * update-structure.js, which also publishes lookup.json), then the arm's
 * search hook and engine. Returns false when anything failed — the cell is
 * then recorded as invalid rather than silently degraded.
 */
function setupRetrievalArm(wt, arm, activityHome) {
  if (arm === 'no-engine') return setupNoEngine(wt);
  if (arm === 'v2') return setupV2(wt, activityHome);
  try {
    const built = spawnSync('node', [path.join(ROOT_DIR, 'scripts', 'update-structure.js'), '--full'], {
      cwd: wt, encoding: 'utf-8', timeout: 120000, env: { ...process.env, FRAME_PROJECT_ROOT: wt }
    });
    if (built.status !== 0) return false;
    if (arm === 'no-hint') return true;
    const configFile = path.join(wt, '.frame', 'config.json');
    let config = {};
    try { config = JSON.parse(fs.readFileSync(configFile, 'utf-8')); } catch (e) { /* none */ }
    config.project = { ...(config.project || {}), retrieval: { engine: arm } };
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    const hook = `FRAME_ACTIVITY_HOME=${JSON.stringify(activityHome)} node ${JSON.stringify(path.join(ROOT_DIR, 'scripts', 'module-hint.js'))} search`;
    fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Grep|Glob|Bash', hooks: [{ type: 'command', command: hook }] }] }
    }, null, 2) + '\n');
    return true;
  } catch (e) {
    console.warn(`  (retrieval arm setup failed: ${e.message})`);
    return false;
  }
}

/** The agent's final answer: the `result` text of the last result event. */
function finalAnswer(transcript) {
  let answer = '';
  for (const line of String(transcript || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'result' && typeof event.result === 'string') answer = event.result;
    } catch (e) { /* partial line */ }
  }
  return answer;
}

/** Whether a question task's answer names one of its accepted paths. */
function answerPasses(task, transcript) {
  const accepted = (task.answerCheck && task.answerCheck.contains) || task.expectedFiles || [];
  const answer = finalAnswer(transcript);
  return accepted.some((p) => answer.includes(p));
}

/** What a run must leave exactly as it found it. */
function repositorySnapshot(cwd = ROOT_DIR) {
  const run = (args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : `ERROR ${r.stderr}`;
  };
  return {
    status: run(['status', '--porcelain', '--untracked-files=all']),
    branches: run(['branch', '--list', '--format=%(refname:short) %(objectname)']),
    worktrees: run(['worktree', 'list', '--porcelain'])
  };
}

/** The differences between two snapshots, as readable lines ([] when clean). */
function snapshotDiff(before, after) {
  const out = [];
  for (const key of Object.keys(before)) {
    if (before[key] === after[key]) continue;
    const a = new Set(before[key].split('\n').filter(Boolean));
    const b = new Set(after[key].split('\n').filter(Boolean));
    for (const line of b) if (!a.has(line)) out.push(`${key} + ${line}`);
    for (const line of a) if (!b.has(line)) out.push(`${key} - ${line}`);
  }
  return out;
}

/** `no-engine`: no search hint, no find-module, no find-module instructions. */
function setupNoEngine(wt) {
  try {
    const settingsFile = path.join(wt, '.claude', 'settings.json');
    const settings = readJsonFile(settingsFile);
    if (settings) fs.writeFileSync(settingsFile, JSON.stringify(withSearchHook(settings, null), null, 2) + '\n');
    fs.rmSync(path.join(wt, 'scripts', 'find-module.js'), { force: true });
    fs.rmSync(path.join(wt, '.frame', 'bin', 'find-module.js'), { force: true });
    for (const rel of INSTRUCTION_FILES) {
      const file = path.join(wt, rel);
      if (fs.existsSync(file)) fs.writeFileSync(file, withoutFindModule(fs.readFileSync(file, 'utf-8')));
    }
    return !/module-hint/.test(fs.readFileSync(settingsFile, 'utf-8')) && !fs.existsSync(path.join(wt, 'scripts', 'find-module.js'));
  } catch (e) {
    console.warn(`  (no-engine setup failed: ${e.message})`);
    return false;
  }
}

/** `v2`: this checkout's engine files, a current map and index, engine v2, and its search hint. */
function setupV2(wt, activityHome) {
  try {
    for (const name of ENGINE_FILES) {
      const src = path.join(ROOT_DIR, 'scripts', name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(wt, 'scripts', name));
    }
    const built = spawnSync('node', [path.join(wt, 'scripts', 'update-structure.js'), '--full'], {
      cwd: wt, encoding: 'utf-8', timeout: 120000, env: { ...process.env, FRAME_PROJECT_ROOT: wt }
    });
    if (built.status !== 0) {
      // the pinned updater predates the lookup index: build with this checkout's
      const again = spawnSync('node', [path.join(ROOT_DIR, 'scripts', 'update-structure.js'), '--full'], {
        cwd: wt, encoding: 'utf-8', timeout: 120000, env: { ...process.env, FRAME_PROJECT_ROOT: wt }
      });
      if (again.status !== 0) return false;
    }
    const lookup = require(path.join(ROOT_DIR, 'scripts', 'structure-retrieval.js')).publishLookup(wt, { curationPath: path.join(wt, 'scripts', 'intent-map.json') });
    if (lookup.status === 'failed') return false;
    const configFile = path.join(wt, '.frame', 'config.json');
    const config = readJsonFile(configFile) || {};
    config.project = { ...(config.project || {}), retrieval: { engine: 'v2' } };
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    const command = `FRAME_ACTIVITY_HOME=${JSON.stringify(activityHome)} node scripts/module-hint.js search`;
    const settingsFile = path.join(wt, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(withSearchHook(readJsonFile(settingsFile) || {}, command), null, 2) + '\n');
    for (const rel of INSTRUCTION_FILES) {
      const file = path.join(wt, rel);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf-8');
      // the current wording (STR-03b T06) after the find-module block
      const next = text.replace(/(node \S*find-module\.js --list[^\n]*\n```\n)/, '$1\nIts answer is enough to open the file — a function answer comes with its\nline. Use grep to search inside a file, not to find it again.\n');
      if (next !== text) fs.writeFileSync(file, next);
    }
    return true;
  } catch (e) {
    console.warn(`  (v2 setup failed: ${e.message})`);
    return false;
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Start this checkout's lifecycle worker on a cell and wait until its first reconciliation settled. */
function startLifecycle(wt) {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [path.join(ROOT_DIR, 'scripts', 'structure-lifecycle.js'), '--watch'], {
    cwd: wt, stdio: 'ignore', env: { ...process.env, FRAME_PROJECT_ROOT: wt }
  });
  const endpoint = path.join(wt, '.frame', 'runtime', 'structure', 'lookup.endpoint');
  const lifecycleFile = path.join(wt, '.frame', 'runtime', 'structure', 'lifecycle.json');
  const deadline = Date.now() + 60000;
  const settled = () => {
    const lc = readJsonFile(lifecycleFile);
    return fs.existsSync(endpoint) && lc && lc.receipt && lc.epoch && lc.epoch.applied >= lc.epoch.requested;
  };
  while (!settled() && Date.now() < deadline) sleepMs(100);
  return child;
}

function stopLifecycle(child) {
  try { child.kill('SIGTERM'); } catch (e) { /* gone */ }
  sleepMs(300);
  try { child.kill('SIGKILL'); } catch (e) { /* gone */ }
}

/** Search-hook records a cell produced: { records, injected }. */
function hookActivity(activityHome) {
  const out = { records: 0, injected: 0 };
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const r = JSON.parse(line);
            if (r.mode !== 'search' || !/^hint\./.test(r.ev)) continue;
            out.records++;
            if (r.ev === 'hint.injected') out.injected++;
          } catch (err) { /* partial line */ }
        }
      }
    }
  };
  walk(activityHome);
  return out;
}

function git(cmd, cwd) {
  return execSync(cmd, { cwd: cwd || ROOT_DIR, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

// Frame-arm hook setup for --hooks runs: current hint scripts + a fresh
// index built inside the worktree (the pinned commit predates the layer),
// plus the hook registration. Best-effort — a failure degrades the run to
// un-hooked rather than aborting it.
const HOOK_SCRIPT_FILES = ['scripts/spec-index.js', 'scripts/spec-context.js', 'scripts/spec-hint.js'];

function setupHooks(wt) {
  try {
    for (const rel of HOOK_SCRIPT_FILES) {
      const dst = path.join(wt, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(ROOT_DIR, rel), dst);
    }
    const settingsDir = path.join(wt, '.claude');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node scripts/spec-hint.js pre-edit' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node scripts/spec-hint.js prompt' }] }]
      }
    }, null, 2) + '\n');
    const built = spawnSync('node', [path.join(wt, 'scripts', 'spec-index.js'), '--force'], {
      cwd: wt, encoding: 'utf-8', timeout: 60000
    });
    return built.status === 0;
  } catch (e) {
    console.warn(`  (hook setup failed, running un-hooked: ${e.message})`);
    return false;
  }
}

function runOne(task, arm, resultsDir, timeoutSec, hooks, suite = SUITE, repeat = 1) {
  const retrievalArm = ALL_RETRIEVAL_ARMS.includes(arm);
  const runDir = path.join(resultsDir, retrievalArm ? `${task.id}--${arm}--r${repeat}` : `${task.id}--${arm}`);
  fs.mkdirSync(runDir, { recursive: true });
  const activityHome = path.join(runDir, 'activity');

  const wt = fs.mkdtempSync(path.join(os.tmpdir(), `frame-eval-${task.id}-${arm}-`));
  console.log(`\n▶ ${task.id} [${arm}]${retrievalArm ? ` #${repeat}` : ''}`);

  try {
    git(`git worktree add --detach "${wt}" ${suite.pinnedCommit}`);

    let setupOk = null;
    if (retrievalArm) {
      setupOk = setupRetrievalArm(wt, arm, activityHome);
      git('git add -A', wt);
      git(`git -c user.email=eval@frame -c user.name=frame-eval commit -q --no-verify --allow-empty -m "retrieval arm setup (${arm})"`, wt);
    }

    if (arm === 'bare') {
      for (const file of FRAME_CONTEXT_FILES) {
        const p = path.join(wt, file);
        try { fs.rmSync(p, { force: true }); } catch (e) { /* symlink targets etc. */ }
      }
      // Commit the stripping so the captured diff is exactly what the agent
      // did — the removed context files must not show up as its changes.
      git('git add -A', wt);
      git('git -c user.email=eval@frame -c user.name=frame-eval commit -q --no-verify -m "strip frame context (bare arm)"', wt);
    }

    let hooksActive = false;
    if (hooks && arm === 'frame') {
      hooksActive = setupHooks(wt);
      // Commit the setup so it never shows up as agent-produced diff.
      git('git add -A', wt);
      git('git -c user.email=eval@frame -c user.name=frame-eval commit -q --no-verify -m "spec-knowledge hooks (frame arm)"', wt);
    }

    // Diff base: some agents commit their own work in the worktree, which
    // would make a HEAD-relative diff empty — always diff against the sha
    // the agent started from.
    const baseSha = git('git rev-parse HEAD', wt).trim();

    // v2 cells run as Frame users do: with the lifecycle worker keeping the
    // map fresh and answering the search hint over its socket (STR-03b).
    let lifecycleWorker = null;
    if (retrievalArm && arm === 'v2' && setupOk) lifecycleWorker = startLifecycle(wt);

    const started = Date.now();
    const result = spawnSync(AGENT_CMD, [...AGENT_ARGS, '-p', task.prompt], {
      cwd: wt,
      encoding: 'utf-8',
      timeout: timeoutSec * 1000,
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env }
    });
    const durationMs = Date.now() - started;
    if (lifecycleWorker) stopLifecycle(lifecycleWorker);
    const timedOut = result.error && result.error.code === 'ETIMEDOUT';

    fs.writeFileSync(path.join(runDir, 'transcript.jsonl'), result.stdout || '');
    fs.writeFileSync(path.join(runDir, 'stderr.log'), result.stderr || '');

    // Capture the produced diff BEFORE the successCheck runs — the check may
    // itself mutate the worktree (e.g. regenerating STRUCTURE.json).
    git('git add -A', wt);
    const diff = git(`git diff ${baseSha}`, wt);
    fs.writeFileSync(path.join(runDir, 'diff.patch'), diff);
    const changedFiles = git(`git diff ${baseSha} --name-only`, wt)
      .split('\n').filter(Boolean);

    let checkPassed = false;
    if (task.kind === 'question') {
      checkPassed = answerPasses(task, result.stdout);
    } else {
      try {
        execSync(task.successCheck, { cwd: wt, stdio: 'ignore', timeout: 60000 });
        checkPassed = true;
      } catch (e) {
        checkPassed = false;
      }
    }

    const activity = retrievalArm ? hookActivity(activityHome) : null;
    const meta = {
      task: task.id,
      arm,
      hooksActive,
      ...(retrievalArm ? { retrievalArm: true, kind: task.kind || 'navigation', repeat, setupOk, hookRecords: activity.records, hintsInjected: activity.injected, worktree: wt } : {}),
      pinnedCommit: suite.pinnedCommit,
      agent: `${AGENT_CMD} ${AGENT_ARGS.join(' ')}`,
      exitCode: result.status,
      timedOut: Boolean(timedOut),
      durationMs,
      changedFiles,
      expectedFiles: task.expectedFiles,
      checkPassed
    };
    fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

    console.log(`  ${checkPassed ? '✓ check passed' : '✗ check failed'} · ${changedFiles.length} file(s) changed · ${(durationMs / 1000).toFixed(0)}s${timedOut ? ' · TIMED OUT' : ''}`);
    return meta;
  } finally {
    try { git(`git worktree remove --force "${wt}"`); } catch (e) {
      console.warn(`  (worktree cleanup failed: ${wt})`);
    }
  }
}

function main() {
  const opts = parseArgs();
  const suite = opts.retrievalArms ? SUITE.retrievalSuite : SUITE;

  const tasks = (opts.task
    ? suite.tasks.filter(t => t.id === opts.task)
    : suite.tasks).filter((t) => !opts.kinds || opts.kinds.includes(t.kind || 'navigation'));
  if (tasks.length === 0) {
    console.error(`No task matches "${opts.task}". Available: ${suite.tasks.map(t => t.id).join(', ')}`);
    process.exit(1);
  }

  const arms = opts.arm ? [opts.arm] : (opts.arms || (opts.retrievalArms ? RETRIEVAL_ARMS : ['frame', 'bare']));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // Retrieval runs keep everything outside the repository (STR-03b).
  const resultsDir = opts.out || (opts.retrievalArms
    ? path.join(os.tmpdir(), `frame-eval-${stamp}`)
    : path.join(__dirname, 'results', `run-${stamp}`));
  const before = repositorySnapshot();
  fs.mkdirSync(resultsDir, { recursive: true });

  console.log(`Suite: ${tasks.length} task(s) × ${arms.length} arm(s)${opts.retrievalArms ? ` × ${opts.repeat} repeat(s), seed ${opts.seed}` : ''} @ ${suite.pinnedCommit.slice(0, 7)}`);
  console.log(`Agent: ${AGENT_CMD} ${AGENT_ARGS.join(' ')}`);
  console.log(`Results: ${path.relative(ROOT_DIR, resultsDir)}`);

  let cells = [];
  for (const task of tasks) {
    for (const arm of arms) {
      for (let r = 1; r <= (opts.retrievalArms ? opts.repeat : 1); r++) cells.push({ task, arm, repeat: r });
    }
  }
  if (opts.retrievalArms) cells = shuffled(cells, opts.seed);

  const all = [];
  for (const { task, arm, repeat } of cells) {
    try {
      all.push(runOne(task, arm, resultsDir, opts.timeoutSec, opts.hooks, suite, repeat));
    } catch (e) {
      console.error(`  ✗ ${task.id} [${arm}] crashed: ${e.message}`);
      all.push({ task: task.id, arm, repeat, crashed: true, error: e.message });
    }
  }

  fs.writeFileSync(path.join(resultsDir, 'runs.json'), JSON.stringify(all, null, 2) + '\n');
  try { git('git worktree prune'); } catch (e) { /* best effort */ }
  const changed = snapshotDiff(before, repositorySnapshot());
  if (changed.length) {
    console.error('\n✗ The repository changed during the run:');
    for (const line of changed) console.error(`  ${line}`);
    process.exitCode = 1;
  } else {
    console.log('\n✓ Repository unchanged: git status, branches and worktrees match the start.');
  }
  console.log(`Done. Score with: node scripts/eval/score.js ${resultsDir}`);
}

if (require.main === module) main();

module.exports = { shuffled, hookActivity, finalAnswer, answerPasses, repositorySnapshot, snapshotDiff, withoutFindModule, withSearchHook, RETRIEVAL_ARMS, ALL_RETRIEVAL_ARMS };
