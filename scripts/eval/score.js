#!/usr/bin/env node
/**
 * Orientation Eval Scorer — deterministic scoring of run-eval.js artifacts.
 * No LLM judging: everything is computed from meta.json + transcript.jsonl.
 *
 * Metrics per task×arm, aggregated per arm:
 *   - first-try success  — the task's successCheck passed on the produced diff
 *   - wrong-file edits   — changed files outside expectedFiles (meta files
 *                          like STRUCTURE.json excluded: agents legitimately
 *                          regenerate them alongside a change)
 *   - search effort      — Grep/Glob/grep-ish-Bash tool calls before the
 *                          first Edit/Write
 *   - turns, tokens, duration — from the transcript
 *
 * Retrieval arms (STR-03, `run-eval.js --retrieval-arms`) add:
 *   - search and read calls in total, the files read, and which expected
 *     files were found (read or changed)
 *   - input tokens including cache creation and cache reads, output tokens
 *     separately — taken from the final `result` event only, never summed
 *     per message (that would count the context again on every turn);
 *     a transcript without one reports `null` (unknown), never 0
 *   - cell validity: a hooked arm whose hook never ran although the agent
 *     searched, or a no-hint arm that recorded hook activity, is invalid
 *   - paired per-task differences between arms
 *
 * Usage:
 *   node scripts/eval/score.js <resultsDir>           # summary table
 *   node scripts/eval/score.js <resultsDir> --json    # machine-readable
 */

const fs = require('fs');
const path = require('path');

const META_FILES = new Set(['STRUCTURE.json', 'tasks.json', 'PROJECT_NOTES.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const SEARCHY_BASH = /\b(grep|rg|find|fd|ag)\b/;

const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const READY_BASH = /^\s*(?:cat|head|tail|less|sed\s+-n)\b/;

function scoreTranscript(file, options = {}) {
  const stats = {
    searchBeforeFirstEdit: 0, toolCalls: 0, turns: 0, searchCalls: 0, readCalls: 0, filesRead: [],
    inputTokens: null, cacheCreationTokens: null, cacheReadTokens: null, totalInputTokens: null, outputTokens: null
  };
  if (!fs.existsSync(file)) return stats;
  const rel = (p) => {
    const text = String(p || '');
    if (options.worktree && text.startsWith(options.worktree + path.sep)) return text.slice(options.worktree.length + 1).split(path.sep).join('/');
    return text.replace(/^\.\//, '');
  };

  let sawEdit = false;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch (e) { continue; }

    if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
      stats.turns++;
      for (const block of event.message.content) {
        if (block.type !== 'tool_use') continue;
        stats.toolCalls++;

        const isEdit = EDIT_TOOLS.has(block.name);
        const isSearch = SEARCH_TOOLS.has(block.name) ||
          (block.name === 'Bash' && block.input && SEARCHY_BASH.test(String(block.input.command || '')));

        if (isEdit) sawEdit = true;
        if (isSearch && !sawEdit) stats.searchBeforeFirstEdit++;
        if (isSearch) stats.searchCalls++;
        const isRead = READ_TOOLS.has(block.name) ||
          (block.name === 'Bash' && block.input && READY_BASH.test(String(block.input.command || '')));
        if (isRead) {
          stats.readCalls++;
          const target = block.input && (block.input.file_path || block.input.notebook_path);
          if (target && !stats.filesRead.includes(rel(target))) stats.filesRead.push(rel(target));
        }
      }
    }

    // The final result carries the run's cumulative usage; per-message usage
    // repeats the context every turn and is deliberately not summed.
    if (event.type === 'result' && event.usage) {
      const u = event.usage;
      const num = (v) => (typeof v === 'number' ? v : null);
      stats.inputTokens = num(u.input_tokens);
      stats.cacheCreationTokens = num(u.cache_creation_input_tokens);
      stats.cacheReadTokens = num(u.cache_read_input_tokens);
      stats.outputTokens = num(u.output_tokens);
      const parts = [stats.inputTokens, stats.cacheCreationTokens, stats.cacheReadTokens].filter((v) => v !== null);
      stats.totalInputTokens = parts.length ? parts.reduce((a, b) => a + b, 0) : null;
    }
  }
  return stats;
}

/**
 * Whether a retrieval-arm cell measured what its arm intends. Returns
 * { valid, reason? }. Cells of other suites are always valid.
 */
function cellValidity(meta, stats) {
  if (!meta.retrievalArm) return { valid: true };
  if (meta.setupOk === false) return { valid: false, reason: 'setup-failed' };
  const records = meta.hookRecords || 0;
  if (meta.arm === 'no-hint') return records === 0 ? { valid: true } : { valid: false, reason: 'hook-ran-in-no-hint-arm' };
  if (stats.searchCalls > 0 && records === 0) return { valid: false, reason: 'hook-never-ran' };
  return { valid: true };
}

function scoreRun(runDir) {
  const metaPath = path.join(runDir, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

  const expected = new Set(meta.expectedFiles || []);
  const wrongFiles = (meta.changedFiles || [])
    .filter(f => !expected.has(f) && !META_FILES.has(f));

  const stats = scoreTranscript(path.join(runDir, 'transcript.jsonl'), { worktree: meta.worktree });
  const touched = new Set([...stats.filesRead, ...(meta.changedFiles || [])]);
  return {
    task: meta.task,
    arm: meta.arm,
    repeat: meta.repeat || 1,
    pass: Boolean(meta.checkPassed) && !meta.timedOut,
    timedOut: Boolean(meta.timedOut),
    crashed: Boolean(meta.crashed),
    wrongFiles,
    changedCount: (meta.changedFiles || []).length,
    durationMs: meta.durationMs || 0,
    filesFound: (meta.expectedFiles || []).filter((f) => touched.has(f)).length,
    expectedCount: (meta.expectedFiles || []).length,
    hintsInjected: meta.hintsInjected || 0,
    ...cellValidity(meta, stats),
    ...stats
  };
}

/**
 * Paired per-task comparison of arm `b` against arm `a` on valid cells:
 * mean of the per-task mean differences (b − a), and how many tasks went
 * down / up / unchanged. A metric unknown in either arm drops that task.
 */
function paired(runs, a, b, metric) {
  const byTask = new Map();
  for (const r of runs) {
    if (!r.valid || (r.arm !== a && r.arm !== b)) continue;
    const t = byTask.get(r.task) || { [a]: [], [b]: [] };
    if (r[metric] !== null && r[metric] !== undefined) t[r.arm].push(r[metric]);
    byTask.set(r.task, t);
  }
  const diffs = [];
  for (const t of byTask.values()) {
    if (!t[a].length || !t[b].length) continue;
    const mean = (xs) => xs.reduce((x, y) => x + y, 0) / xs.length;
    diffs.push(mean(t[b]) - mean(t[a]));
  }
  return {
    tasks: diffs.length,
    meanDiff: diffs.length ? diffs.reduce((x, y) => x + y, 0) / diffs.length : null,
    lower: diffs.filter((d) => d < 0).length,
    higher: diffs.filter((d) => d > 0).length,
    same: diffs.filter((d) => d === 0).length
  };
}

function aggregate(runs) {
  const n = runs.length;
  const sum = (fn) => runs.reduce((a, r) => a + fn(r), 0);
  const avg = (fn) => n ? sum(fn) / n : 0;
  const known = (key) => runs.filter((r) => r[key] !== null && r[key] !== undefined);
  const avgKnown = (key) => {
    const k = known(key);
    return k.length ? k.reduce((a, r) => a + r[key], 0) / k.length : null;
  };
  return {
    invalid: runs.filter((r) => r.valid === false).length,
    avgSearchCalls: avg((r) => r.searchCalls || 0),
    avgReadCalls: avg((r) => r.readCalls || 0),
    filesFound: sum((r) => r.filesFound || 0),
    filesExpected: sum((r) => r.expectedCount || 0),
    avgTotalInputTokens: avgKnown('totalInputTokens'),
    avgOutputTokens: avgKnown('outputTokens'),
    tokensUnknown: n - known('totalInputTokens').length,
    tasks: n,
    passed: runs.filter(r => r.pass).length,
    passRate: n ? runs.filter(r => r.pass).length / n : 0,
    tasksWithWrongFileEdits: runs.filter(r => r.wrongFiles.length > 0).length,
    totalWrongFileEdits: sum(r => r.wrongFiles.length),
    avgSearchBeforeFirstEdit: avg(r => r.searchBeforeFirstEdit),
    avgToolCalls: avg(r => r.toolCalls),
    avgTurns: avg(r => r.turns),
    avgDurationSec: avg(r => r.durationMs / 1000),
    totalOutputTokens: sum(r => r.outputTokens || 0)
  };
}

function main() {
  const args = process.argv.slice(2);
  const resultsDir = args.find(a => !a.startsWith('--'));
  if (!resultsDir || !fs.existsSync(resultsDir)) {
    console.error('Usage: node scripts/eval/score.js <resultsDir> [--json]');
    process.exit(1);
  }

  const runs = fs.readdirSync(resultsDir)
    .filter(d => fs.existsSync(path.join(resultsDir, d, 'meta.json')))
    .map(d => scoreRun(path.join(resultsDir, d)))
    .filter(Boolean);

  if (runs.length === 0) {
    console.error(`No scored runs found in ${resultsDir}`);
    process.exit(1);
  }

  const byArm = {};
  for (const run of runs) {
    (byArm[run.arm] = byArm[run.arm] || []).push(run);
  }
  const summary = {};
  for (const [arm, armRuns] of Object.entries(byArm)) {
    summary[arm] = aggregate(armRuns);
  }

  const retrievalArms = runs.some((r) => ['no-hint', 'legacy', 'v2'].includes(r.arm));
  const comparisons = {};
  if (retrievalArms) {
    for (const [a, b] of [['no-hint', 'legacy'], ['no-hint', 'v2'], ['legacy', 'v2']]) {
      comparisons[`${b} vs ${a}`] = Object.fromEntries(['totalInputTokens', 'searchCalls', 'readCalls', 'durationMs', 'filesFound']
        .map((m) => [m, paired(runs, a, b, m)]));
    }
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify({ summary, comparisons, runs }, null, 2));
    return;
  }

  const arms = Object.keys(summary).sort(); // bare, frame
  const rows = [
    ['metric', ...arms],
    ['tasks', ...arms.map(a => summary[a].tasks)],
    ['first-try success', ...arms.map(a => `${summary[a].passed}/${summary[a].tasks} (${(summary[a].passRate * 100).toFixed(0)}%)`)],
    ['tasks w/ wrong-file edits', ...arms.map(a => summary[a].tasksWithWrongFileEdits)],
    ['total wrong-file edits', ...arms.map(a => summary[a].totalWrongFileEdits)],
    ['avg searches before 1st edit', ...arms.map(a => summary[a].avgSearchBeforeFirstEdit.toFixed(1))],
    ['avg tool calls', ...arms.map(a => summary[a].avgToolCalls.toFixed(1))],
    ['avg turns', ...arms.map(a => summary[a].avgTurns.toFixed(1))],
    ['avg duration (s)', ...arms.map(a => summary[a].avgDurationSec.toFixed(0))],
    ['total output tokens', ...arms.map(a => summary[a].totalOutputTokens)],
    ['avg input tokens (incl. cache)', ...arms.map(a => summary[a].avgTotalInputTokens === null ? 'unknown' : summary[a].avgTotalInputTokens.toFixed(0))],
    ['avg search / read calls', ...arms.map(a => `${summary[a].avgSearchCalls.toFixed(1)} / ${summary[a].avgReadCalls.toFixed(1)}`)],
    ['expected files found', ...arms.map(a => `${summary[a].filesFound}/${summary[a].filesExpected}`)],
    ['invalid cells', ...arms.map(a => summary[a].invalid)]
  ];

  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => String(r[i]).length)));
  for (const [ri, row] of rows.entries()) {
    console.log(row.map((cell, i) => String(cell).padEnd(widths[i] + 2)).join(''));
    if (ri === 0) console.log(widths.map(w => '-'.repeat(w + 2)).join(''));
  }

  for (const [name, metrics] of Object.entries(comparisons)) {
    console.log(`\nPaired ${name} (per task, valid cells):`);
    for (const [metric, p] of Object.entries(metrics)) {
      if (!p.tasks) continue;
      console.log(`  ${metric.padEnd(18)} mean diff ${p.meanDiff.toFixed(1)} · lower ${p.lower} / higher ${p.higher} / same ${p.same} (n=${p.tasks})`);
    }
  }

  // Per-task detail for anything that failed or edited wrong files
  const problems = runs.filter(r => !r.pass || r.wrongFiles.length > 0);
  if (problems.length > 0) {
    console.log('\nDetails (failed or wrong-file):');
    for (const r of problems) {
      const parts = [];
      if (!r.pass) parts.push(r.timedOut ? 'TIMEOUT' : 'check failed');
      if (r.wrongFiles.length) parts.push(`wrong: ${r.wrongFiles.join(', ')}`);
      console.log(`  ${r.task} [${r.arm}] — ${parts.join(' · ')}`);
    }
  }
}

if (require.main === module) main();

module.exports = { scoreTranscript, scoreRun, cellValidity, paired, aggregate };
