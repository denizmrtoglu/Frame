/**
 * Module map hook script tests.
 * Runs with Node's built-in runner: `npm test` (node --test test/).
 *
 * Exercised the way Claude Code runs it: a child process with hook JSON on
 * stdin. The never-break contract is the core assertion set — any failure
 * must be exit 0 with empty stdout, because the host is a tool call.
 *
 * The precision cases are not hypothetical. They were derived by replaying
 * 1011 real search commands from this repo's own transcripts through the
 * hook: matching a search verb anywhere in a command pulled patterns out of
 * `node -e '…'` bodies and heredoc payloads, and the deep tier fired on
 * words like "kill" and "process". Both are now asserted to stay silent.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'scripts', 'module-hint.js');

function runHook(input, { raw = null } = {}) {
  const stdout = execFileSync('node', [HOOK, 'search'], {
    input: raw !== null ? raw : JSON.stringify(input),
    encoding: 'utf8'
  }); // execFileSync throws on non-zero exit — reaching here asserts exit 0
  return stdout.trim() ? JSON.parse(stdout) : null;
}

const STRUCTURE = {
  lastUpdated: '2026-08-27',
  intentIndex: {
    github: [{ module: 'main/githubManager', file: 'src/main/githubManager.js' }],
    'claude-sessions': [{ module: 'main/sessions', file: 'src/main/sessions.js' }]
  },
  modules: {
    'main/githubManager': {
      file: 'src/main/githubManager.js',
      description: 'GitHub Manager',
      ipc: { listens: ['LOAD_GITHUB_ISSUES'], emits: [] }
    },
    'main/sessions': { file: 'src/main/sessions.js', description: 'Sessions' }
  }
};

function mkProject(structure = STRUCTURE) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-modhint-'));
  fs.mkdirSync(path.join(root, '.frame'), { recursive: true });
  if (structure) {
    fs.writeFileSync(path.join(root, '.frame', 'STRUCTURE.json'), JSON.stringify(structure));
  }
  return root;
}

const bash = (root, command, session = 's1') =>
  ({ session_id: session, cwd: root, tool_name: 'Bash', tool_input: { command } });

// ─── it answers ───────────────────────────────────────────

test('a Grep on a curated concept gets the module map', () => {
  const root = mkProject();
  const out = runHook({ session_id: 'a', cwd: root, tool_name: 'Grep', tool_input: { pattern: 'github' } });
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /src\/main\/githubManager\.js/);
  assert.match(ctx, /LOAD_GITHUB_ISSUES/);
});

test('a shell grep is answered too — the matcher sees Bash, the pattern is in the command', () => {
  const root = mkProject();
  const out = runHook(bash(root, 'grep -rn "github" src/'));
  assert.match(out.hookSpecificOutput.additionalContext, /githubManager/);
});

test('an alternation is split — the first concept that matches wins', () => {
  const root = mkProject();
  const out = runHook(bash(root, "grep -nE 'zzzz|github' src/"));
  assert.match(out.hookSpecificOutput.additionalContext, /githubManager/);
});

test('a partial key matches (claude → claude-sessions)', () => {
  const root = mkProject();
  const out = runHook(bash(root, 'grep -rn "claude" src/'));
  assert.match(out.hookSpecificOutput.additionalContext, /src\/main\/sessions\.js/);
});

// ─── it stays silent ──────────────────────────────────────

test('a Bash call that is not a search costs nothing and says nothing', () => {
  const root = mkProject();
  assert.equal(runHook(bash(root, 'ls -la src/')), null);
});

test('a search verb inside a node -e body is not a search', () => {
  const root = mkProject();
  const cmd = `node -e ' const x = 1; /* grep "github" */ console.log(x) '`;
  assert.equal(runHook(bash(root, cmd)), null);
});

test('a heredoc payload is data, never a search', () => {
  const root = mkProject();
  const cmd = "cat >> test/x.test.js <<'EOF'\ngrep -rn \"github\" src/\nEOF";
  assert.equal(runHook(bash(root, cmd)), null);
});

test('a concept that is not in the intentIndex is silent — no deep scan', () => {
  const root = mkProject();
  // "manager" appears in a module description, which find-module's fourth
  // tier would match. The hook must not: that tier is CLI-only by design.
  assert.equal(runHook(bash(root, 'grep -rn "manager" src/')), null);
});

test('no STRUCTURE.json at all is silent, not an error', () => {
  const root = mkProject(null);
  assert.equal(runHook(bash(root, 'grep -rn "github" src/')), null);
});

test('a STRUCTURE.json with no intentIndex is silent', () => {
  const root = mkProject({ modules: {} });
  assert.equal(runHook(bash(root, 'grep -rn "github" src/')), null);
});

test('the same concept is answered once per session', () => {
  const root = mkProject();
  assert.ok(runHook(bash(root, 'grep -rn "github" src/', 'dedup')));
  assert.equal(runHook(bash(root, 'grep -rln "github" test/', 'dedup')), null);
});

// ─── it never breaks ──────────────────────────────────────

test('unparseable stdin exits 0 with no output', () => {
  assert.equal(runHook(null, { raw: 'not json at all' }), null);
});

test('empty stdin exits 0 with no output', () => {
  assert.equal(runHook(null, { raw: '' }), null);
});

test('a corrupt STRUCTURE.json exits 0 with no output', () => {
  const root = mkProject(null);
  fs.writeFileSync(path.join(root, '.frame', 'STRUCTURE.json'), '{ not json');
  assert.equal(runHook(bash(root, 'grep -rn "github" src/')), null);
});

test('a payload with no tool_input exits 0 with no output', () => {
  const root = mkProject();
  assert.equal(runHook({ session_id: 'x', cwd: root, tool_name: 'Bash' }), null);
});

// ─── Codex ────────────────────────────────────────────────

test('a Codex shell search is answered — its shell tool is called Bash too', () => {
  // T01: Codex sends tool_name "Bash" with tool_input.command, exactly as
  // Claude Code does, so this path is shared rather than ported.
  const root = mkProject();
  const out = runHook({
    session_id: 'cx', cwd: root, tool_name: 'Bash', turn_id: 't', permission_mode: 'default',
    tool_input: { command: 'grep -rn "github" src/' }
  });
  assert.match(out.hookSpecificOutput.additionalContext, /githubManager/);
});

test('a Codex apply_patch is an edit, never a search', () => {
  const root = mkProject();
  const command = ['*** Begin Patch', '*** Add File: github.js', '+x', '*** End Patch'].join('\n');
  assert.equal(runHook({ session_id: 'cx', cwd: root, tool_name: 'apply_patch', tool_input: { command } }), null);
});

// ─── STR-01: version 1.1 maps and STRUCTURE ownership ─────

test('a version 1.1 map answers with the same shape and limits', () => {
  const v11 = {
    version: '1.1',
    lastUpdated: '2026-09-26',
    modules: {
      ...STRUCTURE.modules,
      '@file:src/main/github.ts': { file: 'src/main/github.ts', description: '', sizeBytes: 10, extraction: { status: 'parsed' } }
    },
    legacyModuleGroups: { api: { path: 'apps/api', purpose: 'REST API' } },
    curatedKeyOwners: { 'main/removed': 'src/main/removed.js' },
    intentIndex: {
      github: [
        { module: 'main/githubManager', file: 'src/main/githubManager.js', description: 'GitHub Manager' },
        { module: '@file:src/main/github.ts', file: 'src/main/github.ts', description: '' }
      ]
    },
    generation: { schema: 1, mode: 'full', inventory: { coverage: 'complete', reasons: [] } }
  };
  const root = mkProject(v11);
  const out = runHook(bash(root, 'grep -rn github src/'));
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /src\/main\/githubManager\.js — GitHub Manager/);
  assert.match(ctx, /src\/main\/github\.ts/);
  assert.match(ctx, /IPC: LOAD_GITHUB_ISSUES/);
});

test('an unowned root STRUCTURE.json is never read as Frame\'s map', () => {
  const root = mkProject(null);
  fs.writeFileSync(path.join(root, 'STRUCTURE.json'), JSON.stringify(STRUCTURE));
  assert.equal(runHook(bash(root, 'grep -rn github src/')), null);

  // the legacy init record makes it Frame's
  fs.writeFileSync(path.join(root, '.frame', 'config.json'), JSON.stringify({ files: { structure: 'STRUCTURE.json' } }));
  assert.match(runHook(bash(root, 'grep -rn github src/', 's2')).hookSpecificOutput.additionalContext, /githubManager/);
});

test('the hook never loads builder or state code, directly or through a helper', () => {
  // Walk the whole local import closure: the record/vocabulary helpers, the
  // read-only freshness contract (STR-02 D10) and the shared retrieval engine
  // (STR-03) — never a builder, the state writer, a process or the network.
  const seen = new Set();
  const builtins = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    // comments may quote require() examples; only code counts
    const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (m[1].startsWith('.')) walk(require.resolve(path.join(path.dirname(file), m[1])));
      else builtins.add(m[1]);
    }
  };
  walk(HOOK);
  const local = [...seen].map((f) => path.basename(f)).sort();
  assert.deepEqual(local, ['activity-log.js', 'module-hint.js', 'redact.js', 'structure-read.js', 'structure-retrieval.js', 'toolVocabulary.js']);
  assert.ok(!local.some((f) => /structure-(discovery|generation|state|snapshot|lifecycle|commit)|update-structure/.test(f)), local.join(', '));
  for (const banned of ['child_process', 'net', 'http', 'https', 'dgram', 'worker_threads']) {
    assert.ok(!builtins.has(banned), `${banned} in the closure`);
  }
});

// ─── STR-02: freshness ────────────────────────────────────

const crypto = require('crypto');

function withReceipt(root, { dirty = [], epoch = { requested: 1, applied: 1 } } = {}) {
  const map = path.join(root, '.frame', 'STRUCTURE.json');
  const bytes = fs.readFileSync(map);
  const stat = fs.lstatSync(map);
  fs.mkdirSync(path.join(root, '.frame', 'runtime', 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, '.frame', 'runtime', 'structure', 'lifecycle.json'), JSON.stringify({
    version: 1, epoch, dirty,
    receipt: {
      view: 'working-tree', revision: 'r', artifactDigest: crypto.createHash('sha256').update(bytes).digest('hex'),
      artifactStat: { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs },
      observedAt: new Date().toISOString(), leaseMs: 90000, coverage: 'complete', extraction: 'complete'
    }
  }));
}

test('a map with changes still being applied gets no hint', () => {
  const root = mkProject();
  withReceipt(root, { dirty: ['file-event'], epoch: { requested: 2, applied: 1 } });
  assert.equal(runHook(bash(root, 'grep -rn github src/')), null);
});

test('a fresh map, and a map with no receipt yet, still answer', () => {
  const fresh = mkProject();
  withReceipt(fresh);
  assert.match(runHook(bash(fresh, 'grep -rn github src/')).hookSpecificOutput.additionalContext, /githubManager/);
  const unknown = mkProject();
  assert.match(runHook(bash(unknown, 'grep -rn github src/')).hookSpecificOutput.additionalContext, /githubManager/);
});

test('a hook copied without the read contract stays quiet instead of failing', () => {
  const root = mkProject();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-hint-bin-'));
  fs.copyFileSync(HOOK, path.join(bin, 'module-hint.js'));
  const out = execFileSync('node', [path.join(bin, 'module-hint.js'), 'search'], {
    input: JSON.stringify(bash(root, 'grep -rn github src/')), encoding: 'utf8'
  });
  assert.equal(out.trim(), '');
  fs.rmSync(bin, { recursive: true, force: true });
});

// ─── STR-02c: the live working-tree view first ────────────

test('the working view answers before the tracked map', () => {
  const root = mkProject();
  const live = JSON.parse(JSON.stringify(STRUCTURE));
  live.intentIndex.github = [{ module: 'main/githubLive', file: 'src/main/githubLive.js' }];
  live.modules['main/githubLive'] = { file: 'src/main/githubLive.js', description: 'Uncommitted GitHub work' };
  fs.mkdirSync(path.join(root, '.frame', 'runtime', 'structure'), { recursive: true });
  fs.writeFileSync(path.join(root, '.frame', 'runtime', 'structure', 'working.json'), JSON.stringify(live));
  const ctx = runHook({ session_id: 'w', cwd: root, tool_name: 'Grep', tool_input: { pattern: 'github' } }).hookSpecificOutput.additionalContext;
  assert.match(ctx, /githubLive\.js/);
  assert.ok(!/githubManager/.test(ctx));
});

// ─── STR-03: the v2 engine ────────────────────────────────

const retrieval = require('../scripts/structure-retrieval');

const V2_STRUCTURE = {
  generation: { revision: 'rev-a' },
  intentIndex: STRUCTURE.intentIndex,
  modules: {
    ...STRUCTURE.modules,
    'renderer/github/rowModels': { file: 'src/renderer/github/rowModels.js', description: 'Row view-models', functions: { issueBranchName: {} } },
    'main/fsSafe': { file: 'src/main/fsSafe.js', description: 'Durable state-file primitives', functions: { writeFileAtomic: {} } }
  }
};

function v2Project(structure = V2_STRUCTURE) {
  const root = mkProject(structure);
  fs.writeFileSync(path.join(root, '.frame', 'config.json'), JSON.stringify({ project: { retrieval: { engine: 'v2' } } }));
  for (const m of Object.values(structure.modules)) {
    fs.mkdirSync(path.dirname(path.join(root, m.file)), { recursive: true });
    fs.writeFileSync(path.join(root, m.file), '// x\n');
  }
  return root;
}

function runCodex(input) {
  const stdout = execFileSync('node', [HOOK, 'search', 'codex'], { input: JSON.stringify(input), encoding: 'utf8' });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

const ctxOf = (out) => out && out.hookSpecificOutput.additionalContext;

test('v2: a file outside every concept is hinted by symbol and by file name, with the evidence named', () => {
  const root = v2Project();
  const bySymbol = ctxOf(runHook({ session_id: 'v1', cwd: root, tool_name: 'Grep', tool_input: { pattern: 'issueBranchName' } }));
  assert.match(bySymbol, /for "issueBranchName" \(symbol\)/);
  assert.match(bySymbol, /^ {2}src\/renderer\/github\/rowModels\.js — Row view-models$/m);
  const byName = ctxOf(runHook({ session_id: 'v2', cwd: root, tool_name: 'Glob', tool_input: { pattern: '**/fsSafe.js' } }));
  assert.match(byName, /\(file name\)/);
  assert.match(byName, /src\/main\/fsSafe\.js/);
  assert.match(ctxOf(runHook(bash(root, 'find . -path "*/fsSafe.js"', 'v3'))), /src\/main\/fsSafe\.js/);
  assert.match(byName, /Full query: node \S+ '\*\*\/fsSafe\.js'$/, 'the query is shell-quoted');
});

test('v2: the Codex adapter (Bash only, `search codex`) gets the same answer in the same output shape', () => {
  const root = v2Project();
  const out = runCodex({ session_id: 'cx', cwd: root, turn_id: 't', model: 'm', tool_name: 'Bash', tool_input: { command: 'rg -n "writeFileAtomic" src/' } });
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(ctxOf(out), /src\/main\/fsSafe\.js/);
});

test('v2: unexplained words, weak matches and comment markers stay silent', () => {
  const root = v2Project();
  assert.equal(runHook(bash(root, 'grep -rn "webpack config" .', 'q1')), null);
  assert.equal(runHook(bash(root, 'grep -rn "primitives" src/', 'q2')), null, 'a description word is CLI evidence');
  assert.equal(runHook(bash(root, 'grep -rn "TODO" src/', 'q3')), null);
  assert.equal(runHook(bash(root, 'grep -rn "console.log" src/', 'q4')), null);
});

test('v2: an unverified map hints as candidates; a dirty or incomplete map stays quiet', () => {
  const root = v2Project();
  assert.match(ctxOf(runHook({ session_id: 'f1', cwd: root, tool_name: 'Grep', tool_input: { pattern: 'github' } })),
    /has candidates for "github" \(concept\) — map not verified recently \(unknown\)/);

  withReceipt(root);
  assert.match(ctxOf(runHook({ session_id: 'f2', cwd: root, tool_name: 'Grep', tool_input: { pattern: 'github' } })),
    /^Frame's module map points to these files for "github" \(concept\):/);

  withReceipt(root, { dirty: ['file-event'], epoch: { requested: 2, applied: 1 } });
  assert.equal(runHook({ session_id: 'f3', cwd: root, tool_name: 'Grep', tool_input: { pattern: 'github' } }), null);

  withReceipt(root);
  const lc = path.join(root, '.frame', 'runtime', 'structure', 'lifecycle.json');
  const state = JSON.parse(fs.readFileSync(lc, 'utf8'));
  state.receipt.coverage = 'partial';
  fs.writeFileSync(lc, JSON.stringify(state));
  assert.equal(runHook({ session_id: 'f4', cwd: root, tool_name: 'Grep', tool_input: { pattern: 'github' } }), null);
});

test('v2: a file missing on disk is never hinted', () => {
  const root = v2Project();
  fs.rmSync(path.join(root, 'src/renderer/github/rowModels.js'));
  assert.equal(runHook({ session_id: 'm1', cwd: root, tool_name: 'Grep', tool_input: { pattern: 'issueBranchName' } }), null);
});

test('v2: dedup is per answer and per map revision, and nothing is remembered without a session id', () => {
  const root = v2Project();
  const ask = (session, pattern = 'github') => runHook({ session_id: session, cwd: root, tool_name: 'Grep', tool_input: { pattern } });
  assert.ok(ask('d1'));
  assert.equal(ask('d1'), null, 'same answer, same revision');
  assert.ok(ask('d1', 'issueBranchName'), 'a different answer');

  const map = path.join(root, '.frame', 'STRUCTURE.json');
  const next = JSON.parse(fs.readFileSync(map, 'utf8'));
  next.generation.revision = 'rev-b';
  fs.writeFileSync(map, JSON.stringify(next));
  assert.ok(ask('d1'), 'a new revision may hint again in the same session');

  assert.ok(runHook({ cwd: root, tool_name: 'Grep', tool_input: { pattern: 'github' } }));
  assert.ok(runHook({ cwd: root, tool_name: 'Grep', tool_input: { pattern: 'github' } }), 'no session: no shared bucket');
});

test('v2: a published lookup.json is used while current; a stale one is never trusted', () => {
  const root = v2Project();
  assert.equal(retrieval.publishLookup(root, { curationPath: path.join(__dirname, '..', 'scripts', 'intent-map.json') }).status, 'published');
  const file = retrieval.lookupPath(root);
  const index = JSON.parse(fs.readFileSync(file, 'utf8'));
  index.terms['5:onlyinindex'] = [index.files.findIndex(([p]) => p === 'src/main/fsSafe.js')];
  fs.writeFileSync(file, JSON.stringify(index));
  assert.match(ctxOf(runHook({ session_id: 'l1', cwd: root, tool_name: 'Grep', tool_input: { pattern: 'onlyInIndex' } })), /fsSafe/);
  const map = path.join(root, '.frame', 'STRUCTURE.json');
  fs.writeFileSync(map, fs.readFileSync(map, 'utf8') + ' ');
  assert.equal(runHook({ session_id: 'l2', cwd: root, tool_name: 'Grep', tool_input: { pattern: 'onlyInIndex' } }), null);
});

test('v2: an index or map above the 2 MiB cap keeps the hook quiet', () => {
  const root = v2Project();
  fs.mkdirSync(path.join(root, '.frame', 'runtime', 'structure'), { recursive: true });
  fs.writeFileSync(retrieval.lookupPath(root), JSON.stringify({ version: 1, pad: 'x'.repeat(retrieval.LIMITS.hookIndexBytes + 10) }));
  assert.equal(runHook({ session_id: 'o1', cwd: root, tool_name: 'Grep', tool_input: { pattern: 'github' } }), null);
  fs.rmSync(retrieval.lookupPath(root));
  const map = path.join(root, '.frame', 'STRUCTURE.json');
  const big = JSON.parse(fs.readFileSync(map, 'utf8'));
  big.pad = 'x'.repeat(retrieval.LIMITS.hookIndexBytes + 10);
  fs.writeFileSync(map, JSON.stringify(big));
  assert.equal(runHook({ session_id: 'o2', cwd: root, tool_name: 'Grep', tool_input: { pattern: 'github' } }), null);
});

test('v2: the payload stays within 1,800 characters and 8 files, cut on whole candidates', () => {
  const modules = {};
  const group = [];
  for (let i = 0; i < 20; i++) {
    const file = `src/components/deeply/nested/folder/widgetComponentNumber${i}.js`;
    modules[`w${i}`] = { file, description: `Widget component ${i} ${'with a very long description '.repeat(8)}` };
    group.push({ module: `w${i}`, file });
  }
  const root = v2Project({ generation: { revision: 'r' }, modules, intentIndex: { widgets: group } });
  const ctx = ctxOf(runHook({ session_id: 'p1', cwd: root, tool_name: 'Grep', tool_input: { pattern: 'widgets' } }));
  assert.ok(ctx.length <= 1800, `${ctx.length} characters`);
  const listed = ctx.split('\n').filter((l) => /^ {2}src\//.test(l));
  assert.ok(listed.length >= 1 && listed.length <= 8);
  for (const line of listed) assert.match(line, /^ {2}src\/components\/deeply\/nested\/folder\/widgetComponentNumber\d+\.js( — .+)?$/);
  assert.match(ctx, /… more — /);
});

test('the default engine (legacy) keeps today\'s output until the gates promote v2', () => {
  if (retrieval.DEFAULT_ENGINE !== 'legacy') return;
  const root = mkProject();
  assert.match(ctxOf(runHook(bash(root, 'grep -rn "github" src/', 'lg'))), /already answers "github" \(STRUCTURE\.json intentIndex\)/);
});
