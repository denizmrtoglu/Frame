#!/usr/bin/env node
/**
 * Retrieval benchmark (STR-03) — how well do `find-module` and the search
 * hook find the right files, how often does the hook speak when it should
 * not, and what does it cost?
 *
 * Deterministic and local: no agent, no network. The pinned commit is
 * exported into a temp directory, its map is built with this checkout's
 * `update-structure.js --full`, and every case in `retrieval-cases.json` is
 * run through the real CLI and the real hook adapters (Claude Code payloads,
 * and Codex's Bash-only payloads with `search codex`). Synthetic 1k/10k-file
 * projects measure latency and index size at scale.
 *
 * Usage:
 *   node scripts/eval/run-retrieval.js                    # all splits, every available engine
 *   node scripts/eval/run-retrieval.js --split heldOut    # development | heldOut | all
 *   node scripts/eval/run-retrieval.js --engine legacy    # legacy | v2 | all
 *   node scripts/eval/run-retrieval.js --no-scale         # skip the synthetic projects
 *   node scripts/eval/run-retrieval.js --json             # one JSON report on stdout
 *
 * Gates are evaluated on the held-out split only (see README.md). Tests
 * exercise the metric and gate math through the exported functions; the
 * numbers themselves come from running this script.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(REPO_ROOT, 'scripts');
const CASES_FILE = path.join(__dirname, 'retrieval-cases.json');

const GATES = Object.freeze({
  exactRecall: 1.0,          // path / basename / symbol / curated / synonym cases (not Turkish-mixed)
  recallAt5: 0.9,            // and never below legacy
  precisionAt1: 0.9,
  emittedPrecision: 0.98,    // of the hook's emitted hints, every adapter
  falseHintRate: 0.02,       // on negative cases, every adapter
  hookP95Ms: 50,             // this repository and the 10k fixture
  cliP95Ms: 150,
  payloadChars: 1800
});

const EXACT_TAGS = ['path', 'basename', 'symbol', 'curated', 'synonym'];

/* ------------------------------- corpus ------------------------------- */

function digest(cases) {
  return crypto.createHash('sha256').update(JSON.stringify(cases)).digest('hex');
}

/** Load the corpus; a split whose hash does not match was edited after freezing. */
function loadCases(file = CASES_FILE) {
  const corpus = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [name, split] of Object.entries(corpus.splits)) {
    if (digest(split.cases) !== split.sha256) throw new Error(`split ${name} does not match its frozen hash`);
  }
  return corpus;
}

/* ------------------------------- parsing ------------------------------ */

const PATH_LINE = /^ {2}(\S+)/;

/** Candidate files from find-module output: the --json envelope, or the human listing. */
function parseCli(stdout) {
  const text = String(stdout || '');
  try {
    const env = JSON.parse(text);
    if (env && Array.isArray(env.candidates)) {
      return env.candidates.filter((c) => !c.missing).map((c) => c.path);
    }
  } catch { /* human output */ }
  const out = [];
  for (const line of text.split('\n')) {
    const m = PATH_LINE.exec(line);
    if (!m || m[1].endsWith(':') || m[1].startsWith('…') || /⚠ file missing|⚠ missing/.test(line)) continue;
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Hinted files and the raw context from a hook's stdout ('' = no hint). */
function parseHook(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return { files: [], context: '' };
  let context = '';
  try {
    context = JSON.parse(text).hookSpecificOutput.additionalContext || '';
  } catch {
    return { files: [], context: '', invalid: true };
  }
  const files = [];
  for (const line of context.split('\n')) {
    const m = PATH_LINE.exec(line);
    if (!m || m[1].endsWith(':') || m[1].startsWith('…')) continue;
    if (!files.includes(m[1])) files.push(m[1]);
  }
  return { files, context };
}

/* ------------------------------- metrics ------------------------------ */

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

const ratio = (n, d) => (d ? n / d : null);

/**
 * results: [{ case, cli: [files], cliMs, hooks: { claude: { files, context, ms }, codex: {…} } }]
 * Returns the summary for one engine over the given results.
 */
function summarize(results) {
  const answerable = results.filter((r) => r.case.expect.length > 0);
  const negatives = results.filter((r) => r.case.expect.length === 0);
  const hit = (files, r) => files.some((f) => r.case.expect.includes(f));

  const cliReturned = results.filter((r) => r.cli.length > 0);
  const exact = answerable.filter((r) => r.case.tags.some((t) => EXACT_TAGS.includes(t)) && !r.case.tags.includes('turkish'));
  const summary = {
    cases: results.length,
    answerable: answerable.length,
    negatives: negatives.length,
    recallAt5: ratio(answerable.filter((r) => hit(r.cli.slice(0, 5), r)).length, answerable.length),
    exactRecall: ratio(exact.filter((r) => hit(r.cli.slice(0, 5), r)).length, exact.length),
    exactCases: exact.length,
    precisionAt1: ratio(cliReturned.filter((r) => r.case.expect.includes(r.cli[0])).length, cliReturned.length),
    cliNegativeReturns: ratio(negatives.filter((r) => r.cli.length > 0).length, negatives.length),
    cliP50Ms: quantile(results.map((r) => r.cliMs), 0.5),
    cliP95Ms: quantile(results.map((r) => r.cliMs), 0.95),
    hooks: {},
    strata: {}
  };

  const adapters = new Set(results.flatMap((r) => Object.keys(r.hooks || {})));
  for (const adapter of adapters) {
    const runs = results.filter((r) => r.hooks[adapter]).map((r) => ({ r, h: r.hooks[adapter] }));
    const emitted = runs.filter(({ h }) => h.files.length > 0);
    const neg = runs.filter(({ r }) => r.case.expect.length === 0);
    const ans = runs.filter(({ r }) => r.case.expect.length > 0);
    const chars = runs.map(({ h }) => h.context.length);
    summary.hooks[adapter] = {
      runs: runs.length,
      emitted: emitted.length,
      emittedPrecision: ratio(emitted.filter(({ r, h }) => hit(h.files, r)).length, emitted.length),
      falseHintRate: ratio(neg.filter(({ h }) => h.files.length > 0).length, neg.length),
      hintRecall: ratio(ans.filter(({ r, h }) => hit(h.files, r)).length, ans.length),
      abstention: ratio(ans.filter(({ h }) => h.files.length === 0).length, ans.length),
      invalidOutputs: runs.filter(({ h }) => h.invalid).length,
      p50Ms: quantile(runs.map(({ h }) => h.ms), 0.5),
      p95Ms: quantile(runs.map(({ h }) => h.ms), 0.95),
      maxChars: chars.length ? Math.max(...chars) : 0,
      maxBytes: runs.length ? Math.max(...runs.map(({ h }) => Buffer.byteLength(h.context, 'utf8'))) : 0
    };
  }

  const tags = new Set(results.flatMap((r) => r.case.tags));
  for (const tag of [...tags].sort()) {
    const rs = results.filter((r) => r.case.tags.includes(tag));
    const ans = rs.filter((r) => r.case.expect.length > 0);
    const claude = rs.filter((r) => r.hooks && r.hooks.claude);
    summary.strata[tag] = {
      n: rs.length,
      recallAt5: ratio(ans.filter((r) => hit(r.cli.slice(0, 5), r)).length, ans.length),
      hintRecall: ratio(ans.filter((r) => r.hooks && r.hooks.claude && hit(r.hooks.claude.files, r)).length, ans.length),
      falseHints: claude.filter((r) => r.case.expect.length === 0 && r.hooks.claude.files.length > 0).length
    };
  }
  return summary;
}

/**
 * The A5 gates for one engine's held-out summary. `baseline` is legacy's
 * held-out summary (recall must not drop below it); `scale` the synthetic
 * latency results. Returns { pass, gates: [{ name, value, limit, pass }] }.
 */
function evaluateGates(summary, baseline = null, scale = null, gates = GATES) {
  const out = [];
  const check = (name, value, limit, ok) => out.push({ name, value, limit, pass: value !== null && value !== undefined && ok });
  check('exact-recall', summary.exactRecall, gates.exactRecall, summary.exactRecall >= gates.exactRecall);
  check('recall@5', summary.recallAt5, gates.recallAt5, summary.recallAt5 >= gates.recallAt5);
  if (baseline) {
    check('recall@5-vs-legacy', summary.recallAt5, baseline.recallAt5, summary.recallAt5 >= baseline.recallAt5);
  }
  check('precision@1', summary.precisionAt1, gates.precisionAt1, summary.precisionAt1 >= gates.precisionAt1);
  for (const [adapter, h] of Object.entries(summary.hooks)) {
    // a hook that never emitted has no precision to fail; false hints still count
    check(`emitted-precision:${adapter}`, h.emittedPrecision === null ? 1 : h.emittedPrecision, gates.emittedPrecision,
      (h.emittedPrecision === null ? 1 : h.emittedPrecision) >= gates.emittedPrecision);
    check(`false-hints:${adapter}`, h.falseHintRate, gates.falseHintRate, h.falseHintRate <= gates.falseHintRate);
    check(`hook-p95:${adapter}`, h.p95Ms, gates.hookP95Ms, h.p95Ms <= gates.hookP95Ms);
    check(`payload:${adapter}`, h.maxChars, gates.payloadChars, h.maxChars <= gates.payloadChars);
  }
  check('cli-p95', summary.cliP95Ms, gates.cliP95Ms, summary.cliP95Ms <= gates.cliP95Ms);
  if (scale) {
    for (const s of scale) check(`hook-p95:${s.files}-files`, s.hookP95Ms, gates.hookP95Ms, s.hookP95Ms <= gates.hookP95Ms);
  }
  return { pass: out.every((g) => g.pass), gates: out };
}

/* ------------------------------- running ------------------------------ */

function timed(args, options) {
  const start = process.hrtime.bigint();
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

function baseEnv(project, activityHome) {
  return { ...process.env, FRAME_PROJECT_ROOT: project, FRAME_ACTIVITY_HOME: activityHome };
}

function setEngine(project, engine) {
  const file = path.join(project, '.frame', 'config.json');
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* none yet */ }
  config.project = config.project || {};
  config.project.retrieval = { engine };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

/** Engines this checkout can run: legacy always; v2 once the shared engine exists. */
function availableEngines() {
  const engines = ['legacy'];
  if (fs.existsSync(path.join(SCRIPTS, 'structure-retrieval.js'))) engines.push('v2');
  return engines;
}

function cliSupportsJson(project, env) {
  const r = timed([path.join(SCRIPTS, 'find-module.js'), '--json', 'probe'], { cwd: project, env });
  try {
    return Boolean(JSON.parse(r.stdout).schema);
  } catch {
    return false;
  }
}

function hookPayloads(c, sessionId, project) {
  const claude = c.hook && c.hook.tool === 'Bash'
    ? { tool_name: 'Bash', tool_input: { command: c.hook.command } }
    : c.hook && c.hook.tool === 'Glob'
      ? { tool_name: 'Glob', tool_input: { pattern: c.hook.pattern } }
      : { tool_name: 'Grep', tool_input: { pattern: c.query } };
  const codexCommand = c.hook && c.hook.tool === 'Bash' ? c.hook.command : `rg -n ${JSON.stringify(c.query)}`;
  return {
    claude: { session_id: `${sessionId}-claude`, cwd: project, hook_event_name: 'PreToolUse', ...claude },
    codex: { session_id: `${sessionId}-codex`, cwd: project, turn_id: 'bench', model: 'bench', hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_input: { command: codexCommand } }
  };
}

function runCase(c, engine, project, env, json) {
  const args = [path.join(SCRIPTS, 'find-module.js')];
  if (json) args.push('--json', `--retrieval=${engine}`);
  args.push(c.query);
  const cli = timed(args, { cwd: project, env });
  const payloads = hookPayloads(c, `bench-${engine}-${c.id}`, project);
  const hooks = {};
  for (const [adapter, payload] of Object.entries(payloads)) {
    const hookArgs = [path.join(SCRIPTS, 'module-hint.js'), 'search'];
    if (adapter === 'codex') hookArgs.push('codex');
    const r = timed(hookArgs, { cwd: project, env, input: JSON.stringify(payload) });
    hooks[adapter] = { ...parseHook(r.stdout), ms: r.ms, status: r.status };
  }
  return { case: c, cli: parseCli(cli.stdout), cliMs: cli.ms, hooks };
}

function applyMutation(base, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-retrieval-mut-'));
  fs.cpSync(base, dir, { recursive: true });
  if (mutate.remove) fs.rmSync(path.join(dir, mutate.remove));
  if (mutate.rename) fs.renameSync(path.join(dir, mutate.rename[0]), path.join(dir, mutate.rename[1]));
  if (mutate.add) fs.writeFileSync(path.join(dir, mutate.add[0]), mutate.add[1]);
  return dir;
}

function buildMap(project, env) {
  const start = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'update-structure.js'), '--full'], { cwd: project, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`update-structure --full failed: ${r.stderr}`);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const size = (rel) => {
    try {
      return fs.statSync(path.join(project, rel)).size;
    } catch {
      return null;
    }
  };
  return {
    buildMs: ms,
    mapBytes: size('.frame/runtime/structure/working.json'),
    lookupBytes: size('.frame/runtime/structure/lookup.json')
  };
}

function exportPinned(commit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-retrieval-'));
  execSync(`git archive ${commit} | tar -x -C ${JSON.stringify(dir)}`, { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  return dir;
}

/** A synthetic project of `count` JavaScript files in nested packages. */
function syntheticProject(count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `frame-retrieval-${count}-`));
  for (let i = 0; i < count; i++) {
    const pkg = `pkg${String(Math.floor(i / 100)).padStart(3, '0')}`;
    const name = `module${String(i).padStart(5, '0')}`;
    const file = path.join(dir, 'src', pkg, `${name}.js`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `// ${name} in ${pkg}\nfunction handle${i}(input) { return input; }\nmodule.exports = { handle${i} };\n`);
  }
  fs.mkdirSync(path.join(dir, '.frame'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.frame', 'config.json'), JSON.stringify({ version: '1.0', name: `synthetic-${count}` }));
  return dir;
}

function runScale(engine, activityHome, sizes = [1000, 10000]) {
  const out = [];
  for (const count of sizes) {
    const dir = syntheticProject(count);
    try {
      const env = baseEnv(dir, activityHome);
      setEngine(dir, engine);
      const build = buildMap(dir, env);
      const queries = [];
      for (let i = 0; i < 20; i++) queries.push(`module${String(Math.floor((i * count) / 20)).padStart(5, '0')}`);
      for (let i = 0; i < 10; i++) queries.push(`absent${i}thing`);
      const hookMs = [];
      const cliMs = [];
      queries.forEach((q, i) => {
        const payload = { session_id: `scale-${engine}-${count}-${i}`, cwd: dir, tool_name: 'Grep', tool_input: { pattern: q } };
        hookMs.push(timed([path.join(SCRIPTS, 'module-hint.js'), 'search'], { cwd: dir, env, input: JSON.stringify(payload) }).ms);
        cliMs.push(timed([path.join(SCRIPTS, 'find-module.js'), q], { cwd: dir, env }).ms);
      });
      out.push({ files: count, ...build, hookP50Ms: quantile(hookMs, 0.5), hookP95Ms: quantile(hookMs, 0.95), cliP95Ms: quantile(cliMs, 0.95) });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return out;
}

function parseArgs(argv) {
  const get = (flag) => {
    const hit = argv.find((a) => a.startsWith(`${flag}=`));
    if (hit) return hit.slice(flag.length + 1);
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };
  return {
    split: get('--split') || 'all',
    engine: get('--engine') || 'all',
    scale: !argv.includes('--no-scale'),
    json: argv.includes('--json')
  };
}

const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
const ms = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(0)} ms`);

function printReport(report) {
  console.log(`Pinned ${report.pinnedCommit.slice(0, 7)} · ${report.machine}`);
  console.log(`Map: ${report.build.mapBytes} bytes · lookup: ${report.build.lookupBytes ?? '—'} bytes · built in ${ms(report.build.buildMs)}\n`);
  for (const [engine, splits] of Object.entries(report.engines)) {
    for (const [split, s] of Object.entries(splits)) {
      console.log(`[${engine} · ${split}] ${s.cases} cases (${s.answerable} answerable, ${s.negatives} negative)`);
      console.log(`  CLI   recall@5 ${pct(s.recallAt5)} · exact ${pct(s.exactRecall)} (${s.exactCases}) · P@1 ${pct(s.precisionAt1)} · p50/p95 ${ms(s.cliP50Ms)}/${ms(s.cliP95Ms)}`);
      for (const [adapter, h] of Object.entries(s.hooks)) {
        console.log(`  hook:${adapter.padEnd(6)} emitted ${h.emitted}/${h.runs} · precision ${pct(h.emittedPrecision)} · recall ${pct(h.hintRecall)} · false hints ${pct(h.falseHintRate)} · p50/p95 ${ms(h.p50Ms)}/${ms(h.p95Ms)} · max ${h.maxChars} chars`);
      }
    }
    const g = report.gates[engine];
    if (g) {
      console.log(`  Gates (held-out): ${g.pass ? 'PASS' : 'FAIL'}`);
      for (const x of g.gates) if (!x.pass) console.log(`    ✗ ${x.name}: ${typeof x.value === 'number' && x.value <= 1 && x.limit <= 1 ? pct(x.value) : x.value} (limit ${x.limit})`);
    }
    if (report.scale[engine]) {
      for (const s of report.scale[engine]) {
        console.log(`  scale ${s.files} files: build ${ms(s.buildMs)} · map ${s.mapBytes} B · lookup ${s.lookupBytes ?? '—'} B · hook p50/p95 ${ms(s.hookP50Ms)}/${ms(s.hookP95Ms)} · CLI p95 ${ms(s.cliP95Ms)}`);
      }
    }
    console.log('');
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const corpus = loadCases();
  const splits = opts.split === 'all' ? Object.keys(corpus.splits) : [opts.split];
  const engines = availableEngines().filter((e) => opts.engine === 'all' || e === opts.engine);
  const activityHome = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-retrieval-activity-'));
  const base = exportPinned(corpus.pinnedCommit);
  const cleanup = [base, activityHome];
  const report = {
    pinnedCommit: corpus.pinnedCommit,
    machine: `${os.cpus()[0] && os.cpus()[0].model} · ${os.platform()} ${os.release()} · node ${process.version}`,
    at: new Date().toISOString(),
    engines: {},
    gates: {},
    scale: {}
  };
  try {
    report.build = buildMap(base, baseEnv(base, activityHome));
    for (const engine of engines) {
      setEngine(base, engine);
      const json = cliSupportsJson(base, baseEnv(base, activityHome));
      report.engines[engine] = {};
      for (const split of splits) {
        const results = [];
        for (const c of corpus.splits[split].cases) {
          let project = base;
          if (c.mutate) {
            project = applyMutation(base, c.mutate);
            cleanup.push(project);
          }
          results.push(runCase(c, engine, project, baseEnv(project, activityHome), json));
        }
        report.engines[engine][split] = summarize(results);
      }
      if (opts.scale) report.scale[engine] = runScale(engine, activityHome);
    }
    const legacyHeld = report.engines.legacy && report.engines.legacy.heldOut;
    for (const engine of engines) {
      const held = report.engines[engine].heldOut;
      if (!held) continue;
      const scale = report.scale[engine] ? report.scale[engine].filter((s) => s.files === 10000) : null;
      report.gates[engine] = evaluateGates(held, engine === 'legacy' ? null : legacyHeld, scale);
    }
  } finally {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report);
}

if (require.main === module) main();

module.exports = { loadCases, digest, parseCli, parseHook, quantile, summarize, evaluateGates, GATES, EXACT_TAGS, CASES_FILE };
