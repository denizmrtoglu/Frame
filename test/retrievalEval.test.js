/**
 * STR-03 retrieval benchmark: the frozen corpus and the metric/gate math.
 * The numbers themselves come from running scripts/eval/run-retrieval.js;
 * these tests make sure what it reports means what the README says.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const bench = require('../scripts/eval/run-retrieval');

const REPO_ROOT = path.join(__dirname, '..');

/* ------------------------------- corpus ------------------------------- */

test('each split matches its frozen hash', () => {
  const corpus = bench.loadCases();
  for (const split of Object.values(corpus.splits)) assert.equal(bench.digest(split.cases), split.sha256);
});

test('an edited split is refused', () => {
  const fs = require('fs');
  const os = require('os');
  const corpus = JSON.parse(fs.readFileSync(bench.CASES_FILE, 'utf8'));
  corpus.splits.heldOut.cases[0].expect = ['tuned.js'];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'frame-cases-')), 'cases.json');
  fs.writeFileSync(file, JSON.stringify(corpus));
  assert.throws(() => bench.loadCases(file), /heldOut does not match its frozen hash/);
});

test('the corpus has the planned size and coverage, with families disjoint across splits', () => {
  const { splits } = bench.loadCases();
  const dev = splits.development.cases;
  const held = splits.heldOut.cases;
  const all = [...dev, ...held];
  const count = (tag) => all.filter((c) => c.tags.includes(tag)).length;
  assert.ok(dev.length >= 60 && held.length >= 120 && all.length >= 180, `${dev.length}/${held.length}`);
  assert.ok(count('turkish') >= 30);
  assert.ok(count('negative') >= 30);
  assert.ok(count('singleton') >= 20);
  for (const tag of ['symbol', 'basename', 'path', 'curated', 'synonym', 'ambiguous', 'noise', 'removed', 'renamed', 'stale-map']) {
    assert.ok(count(tag) > 0, `a ${tag} case exists`);
  }
  const devFamilies = new Set(dev.map((c) => c.family).filter((f) => f !== 'negative'));
  assert.deepEqual(held.filter((c) => devFamilies.has(c.family)).map((c) => c.id), []);
  assert.equal(new Set(all.map((c) => c.id)).size, all.length, 'ids are unique');
  for (const c of all) {
    assert.equal(c.tags.includes('negative'), c.expect.length === 0, `${c.id}: negatives and only negatives expect nothing`);
  }
});

test('heldOut2 (STR-03b) is English only, frozen, sized as planned and disjoint from development and the spent split', () => {
  const { splits } = bench.loadCases();
  const held2 = splits.heldOut2.cases;
  assert.ok(held2.length >= 120, `${held2.length} cases`);
  assert.ok(held2.filter((c) => c.tags.includes('negative')).length >= 25);
  assert.ok(held2.filter((c) => c.tags.includes('natural')).length >= 10, 'natural phrasing without file names');
  for (const c of held2) {
    assert.ok(!/[^\x00-\x7F]/.test(c.query), `${c.id}: English only — ${c.query}`);
    assert.ok(!c.tags.includes('turkish'), c.id);
  }
  const devFamilies = new Set(splits.development.cases.map((c) => c.family).filter((f) => f !== 'negative'));
  assert.deepEqual(held2.filter((c) => devFamilies.has(c.family)).map((c) => c.id), []);
  const spent = new Set(splits.heldOut.cases.filter((c) => c.family !== 'negative').map((c) => c.query.toLowerCase()));
  assert.deepEqual(held2.filter((c) => c.family !== 'negative' && spent.has(c.query.toLowerCase())).map((c) => c.id), []);
  for (const c of held2) assert.equal(c.tags.includes('negative'), c.expect.length === 0, c.id);
});

test('every expected file exists at the pinned commit', (t) => {
  const corpus = bench.loadCases();
  const r = spawnSync('git', ['ls-tree', '-r', '--name-only', corpus.pinnedCommit], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return t.skip('pinned commit not available (shallow clone)');
  const files = new Set(r.stdout.split('\n'));
  for (const c of Object.values(corpus.splits).flatMap((split) => split.cases)) {
    for (const f of c.expect) assert.ok(files.has(f), `${c.id}: ${f}`);
    if (c.mutate && c.mutate.remove) assert.ok(files.has(c.mutate.remove));
    if (c.mutate && c.mutate.rename) assert.ok(files.has(c.mutate.rename[0]));
  }
});

/* ------------------------------- parsing ------------------------------ */

test('CLI output parses from the JSON envelope and from the human listing; missing files never count', () => {
  const env = { schema: 'frame.lookup/1', candidates: [{ path: 'a.js' }, { path: 'gone.js', missing: true }, { path: 'b.js' }] };
  assert.deepEqual(bench.parseCli(JSON.stringify(env)), ['a.js', 'b.js']);
  const human = [
    'Map: fresh · working tree', '', 'Feature: github',
    '  src/main/githubManager.js                  — GitHub Manager Module',
    '  src/renderer/gone.js                       — Gone  ⚠ file missing on disk — run: npm run structure',
    '  IPC: LOAD_GITHUB_ISSUES', ''
  ].join('\n');
  assert.deepEqual(bench.parseCli(human), ['src/main/githubManager.js']);
  assert.deepEqual(bench.parseCli('No modules found for "x"\n'), []);
});

test('hook output parses hinted files; silence and garbage are no hint', () => {
  const context = 'Frame\'s module map already answers "github":\nFeature: github\n  src/a.js — A\n  src/b.js\n  … +3 more\n  IPC: X, Y\nFull query: …';
  const out = bench.parseHook(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }));
  assert.deepEqual(out.files, ['src/a.js', 'src/b.js']);
  assert.equal(out.context, context);
  assert.deepEqual(bench.parseHook(''), { files: [], context: '' });
  assert.equal(bench.parseHook('{not json').invalid, true);
});

/* ------------------------------- metrics ------------------------------ */

const c = (id, expect, tags = []) => ({ id, expect, tags: expect.length ? tags : ['negative', ...tags] });
const hook = (files, ms = 10, context = files.join('\n')) => ({ files, ms, context });

test('summaries compute recall, precision, false hints, abstention and quantiles as documented', () => {
  const results = [
    { case: c('1', ['a.js'], ['basename']), cli: ['a.js', 'x.js'], cliMs: 10, hooks: { claude: hook(['a.js'], 10) } },
    { case: c('2', ['b.js'], ['symbol']), cli: ['x.js', 'y.js', 'z.js', 'w.js', 'b.js'], cliMs: 20, hooks: { claude: hook(['x.js'], 20) } },
    { case: c('3', ['c.js'], ['turkish', 'basename']), cli: [], cliMs: 30, hooks: { claude: hook([], 30) } },
    { case: c('4', []), cli: ['n.js'], cliMs: 40, hooks: { claude: hook(['n.js'], 40) } },
    { case: c('5', []), cli: [], cliMs: 50, hooks: { claude: hook([], 50) } }
  ];
  const s = bench.summarize(results);
  assert.equal(s.answerable, 3);
  assert.equal(s.negatives, 2);
  assert.equal(s.recallAt5, 2 / 3);
  assert.equal(s.exactRecall, 1, 'the Turkish-mixed case is not an exact case');
  assert.equal(s.exactCases, 2);
  assert.equal(s.precisionAt1, 1 / 3, 'top result right in 1 of the 3 cases that returned anything');
  assert.equal(s.cliNegativeReturns, 1 / 2);
  assert.equal(s.cliP50Ms, 30);
  assert.equal(s.cliP95Ms, 50);
  const h = s.hooks.claude;
  assert.equal(h.emitted, 3);
  assert.equal(h.emittedPrecision, 1 / 3);
  assert.equal(h.falseHintRate, 1 / 2);
  assert.equal(h.hintRecall, 1 / 3);
  assert.equal(h.abstention, 1 / 3);
  assert.equal(s.strata.basename.n, 2);
  assert.equal(s.strata.negative.falseHints, 1);
});

test('gates pass only when every limit holds, recall never drops below legacy, and scale latency counts', () => {
  const good = {
    exactRecall: 1, recallAt5: 0.93, precisionAt1: 0.95, cliP95Ms: 90,
    hooks: { claude: { emittedPrecision: 0.99, falseHintRate: 0, p95Ms: 40, maxChars: 900 }, codex: { emittedPrecision: null, falseHintRate: 0, p95Ms: 41, maxChars: 0 } }
  };
  assert.equal(bench.evaluateGates(good, { recallAt5: 0.6 }, [{ files: 10000, hookP95Ms: 45 }]).pass, true, 'a hook that never emitted has no precision to fail');

  const failed = (patch, baseline = null, scale = null) => bench.evaluateGates({ ...good, ...patch }, baseline, scale).gates.filter((g) => !g.pass).map((g) => g.name);
  assert.deepEqual(failed({ exactRecall: 0.99 }), ['exact-recall']);
  assert.deepEqual(failed({}, { recallAt5: 0.95 }), ['recall@5-vs-legacy']);
  assert.deepEqual(failed({ precisionAt1: 0.89 }), ['precision@1']);
  assert.deepEqual(failed({ hooks: { claude: { ...good.hooks.claude, falseHintRate: 0.03 } } }), ['false-hints:claude']);
  assert.deepEqual(failed({ hooks: { claude: { ...good.hooks.claude, maxChars: 1801 } } }), ['payload:claude']);
  assert.deepEqual(failed({}, null, [{ files: 10000, hookP95Ms: 51 }]), ['hook-p95:10000-files']);
  assert.deepEqual(failed({ cliP95Ms: 151 }), ['cli-p95']);
});

test('quantiles use the nearest-rank definition', () => {
  assert.equal(bench.quantile([], 0.5), null);
  assert.equal(bench.quantile([5], 0.95), 5);
  assert.equal(bench.quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(bench.quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5);
});

/* ------------------------- matched-agent instrument (S8) ------------------------- */

const fs = require('fs');
const os = require('os');
const score = require('../scripts/eval/score');
const runEval = require('../scripts/eval/run-eval');

function cell(t, { meta, events }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-cell-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
  return dir;
}
const tool = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }], usage: { input_tokens: 999999 } } });

test('scoring counts searches, reads and found files; tokens come from the final result only, cache included', (t) => {
  const wt = '/tmp/frame-eval-x';
  const dir = cell(t, {
    meta: { task: 'nav-a', arm: 'v2', retrievalArm: true, setupOk: true, hookRecords: 2, hintsInjected: 1, worktree: wt, expectedFiles: ['src/a.js', 'src/b.js'], changedFiles: ['src/b.js'], checkPassed: true, durationMs: 5000 },
    events: [
      tool('Grep', { pattern: 'alpha' }),
      tool('Bash', { command: 'rg -n beta src/' }),
      tool('Read', { file_path: `${wt}/src/a.js` }),
      tool('Bash', { command: 'cat src/c.js' }),
      tool('Edit', { file_path: `${wt}/src/b.js` }),
      tool('Glob', { pattern: '**/*.md' }),
      { type: 'result', usage: { input_tokens: 120, cache_creation_input_tokens: 3000, cache_read_input_tokens: 45000, output_tokens: 800 } }
    ]
  });
  const r = score.scoreRun(dir);
  assert.equal(r.searchCalls, 3);
  assert.equal(r.searchBeforeFirstEdit, 2);
  assert.equal(r.readCalls, 2);
  assert.deepEqual(r.filesRead, ['src/a.js']);
  assert.equal(r.filesFound, 2, 'read a.js, changed b.js');
  assert.equal(r.totalInputTokens, 48120, 'never the per-message usage');
  assert.equal(r.outputTokens, 800);
  assert.equal(r.valid, true);
});

test('missing token telemetry is unknown, not zero, and stays out of averages', (t) => {
  const known = score.scoreRun(cell(t, { meta: { task: 'x', arm: 'legacy', expectedFiles: [] }, events: [{ type: 'result', usage: { input_tokens: 100, output_tokens: 10 } }] }));
  const unknown = score.scoreRun(cell(t, { meta: { task: 'x', arm: 'legacy', expectedFiles: [] }, events: [tool('Grep', { pattern: 'x' })] }));
  assert.equal(unknown.totalInputTokens, null);
  assert.equal(unknown.outputTokens, null);
  const agg = score.aggregate([known, unknown]);
  assert.equal(agg.avgTotalInputTokens, 100);
  assert.equal(agg.tokensUnknown, 1);
});

test('a cell is invalid when its hook did not run as the arm intends', () => {
  const v = (meta, stats = { searchCalls: 1 }) => score.cellValidity({ retrievalArm: true, setupOk: true, ...meta }, stats);
  assert.deepEqual(v({ arm: 'v2', hookRecords: 0 }), { valid: false, reason: 'hook-never-ran' });
  assert.deepEqual(v({ arm: 'v2', hookRecords: 0 }, { searchCalls: 0 }), { valid: true }, 'no search, nothing to hint');
  assert.deepEqual(v({ arm: 'legacy', hookRecords: 3 }), { valid: true });
  assert.deepEqual(v({ arm: 'no-hint', hookRecords: 1 }), { valid: false, reason: 'hook-ran-in-no-hint-arm' });
  assert.deepEqual(v({ arm: 'no-hint', hookRecords: 0 }), { valid: true });
  assert.deepEqual(v({ arm: 'v2', setupOk: false, hookRecords: 5 }), { valid: false, reason: 'setup-failed' });
  assert.deepEqual(score.cellValidity({ arm: 'frame' }, { searchCalls: 9 }), { valid: true }, 'other suites are unaffected');
});

test('paired comparison averages repeats per task, uses valid cells only, and counts direction', () => {
  const run = (task, arm, totalInputTokens, valid = true) => ({ task, arm, totalInputTokens, valid });
  const runs = [
    run('a', 'legacy', 100), run('a', 'legacy', 140), run('a', 'v2', 90), run('a', 'v2', 110),
    run('b', 'legacy', 200), run('b', 'v2', 260),
    run('c', 'legacy', 50), run('c', 'v2', 10, false),
    run('d', 'legacy', null), run('d', 'v2', 70)
  ];
  const p = score.paired(runs, 'legacy', 'v2', 'totalInputTokens');
  assert.equal(p.tasks, 2, 'c has no valid v2 cell, d has no known legacy value');
  assert.equal(p.meanDiff, ((100 - 120) + (260 - 200)) / 2);
  assert.deepEqual([p.lower, p.higher, p.same], [1, 1, 0]);
});

test('the navigation suite: at least 12 tasks, files named only by behavior, checks bound to the expected file', (t) => {
  const suite = require('../scripts/eval/tasks.json').retrievalSuite;
  assert.ok(suite.tasks.length >= 12);
  const r = spawnSync('git', ['ls-tree', '-r', '--name-only', suite.pinnedCommit], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const files = r.status === 0 ? new Set(r.stdout.split('\n')) : null;
  for (const task of suite.tasks) {
    assert.equal(task.expectedFiles.length, 1);
    const file = task.expectedFiles[0];
    const stem = path.basename(file).replace(/\.[^.]+$/, '');
    assert.ok(!task.prompt.toLowerCase().includes(stem.toLowerCase()), `${task.id}: the prompt must not name ${stem}`);
    assert.ok(task.successCheck.includes(file) && task.successCheck.includes(`eval-nav: ${task.id}`), task.id);
    if (files) assert.ok(files.has(file), `${task.id}: ${file} at the pinned commit`);
  }
  if (!files) t.diagnostic('pinned commit unavailable; file existence not checked');
});

test('cell order is shuffled reproducibly from the seed', () => {
  const cells = Array.from({ length: 30 }, (_, i) => i);
  const a = runEval.shuffled(cells, 7);
  assert.deepEqual(runEval.shuffled(cells, 7), a);
  assert.notDeepEqual(a, cells);
  assert.deepEqual([...a].sort((x, y) => x - y), cells);
  assert.deepEqual(runEval.RETRIEVAL_ARMS, ['no-hint', 'legacy', 'v2']);
});

test('hook activity counts only search-hint records', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-act-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'p'), { recursive: true });
  fs.writeFileSync(path.join(home, 'p', 'a.jsonl'), [
    { ev: 'hint.injected', mode: 'search' }, { ev: 'hint.quiet', mode: 'search' },
    { ev: 'hint.injected', mode: 'pre-edit' }, { ev: 'watch.fired' }
  ].map((r) => JSON.stringify(r)).join('\n') + '\n{"partial');
  assert.deepEqual(runEval.hookActivity(home), { records: 2, injected: 1 });
});
