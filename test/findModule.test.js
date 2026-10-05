/**
 * find-module CLI (STR-03 T04): legacy-compatible output, the bounded
 * `--json` envelope, `unavailable` vs `no-match`, missing files, engine
 * selection, and lookups that never run Git.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FIND = path.join(__dirname, '..', 'scripts', 'find-module.js');

const STRUCTURE = {
  generation: { revision: 'r1' },
  modules: {
    'main/githubManager': {
      file: 'src/main/githubManager.js', description: 'GitHub Manager Module', exports: [], depends: [],
      functions: { checkGhAuth: { line: 1 } }, ipc: { listens: ['LOAD_GITHUB_ISSUES'], emits: [] }
    },
    'renderer/githubPanel': { file: 'src/renderer/githubPanel.js', description: 'GitHub Panel', exports: [], depends: [], functions: {} },
    'renderer/github/rowModels': { file: 'src/renderer/github/rowModels.js', description: 'Row models', exports: [], depends: [], functions: { issueBranchName: {} } },
    'main/a': { file: 'src/main/uiZoom.js', description: 'Main zoom', exports: [], depends: [], functions: {} },
    'shared/a': { file: 'src/shared/uiZoom.js', description: 'Shared zoom', exports: [], depends: [], functions: {} }
  },
  intentIndex: {
    github: [
      { module: 'main/githubManager', file: 'src/main/githubManager.js', description: 'GitHub Manager Module' },
      { module: 'renderer/githubPanel', file: 'src/renderer/githubPanel.js', description: 'GitHub Panel' }
    ]
  }
};

function project(t, { structure = STRUCTURE, engine } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-find-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.frame'), { recursive: true });
  if (structure) fs.writeFileSync(path.join(dir, '.frame', 'STRUCTURE.json'), JSON.stringify(structure));
  for (const m of Object.values((structure && structure.modules) || {})) {
    fs.mkdirSync(path.dirname(path.join(dir, m.file)), { recursive: true });
    fs.writeFileSync(path.join(dir, m.file), '// x\n');
  }
  if (engine) fs.writeFileSync(path.join(dir, '.frame', 'config.json'), JSON.stringify({ project: { retrieval: { engine } } }));
  return dir;
}

function find(dir, args, env = {}) {
  return spawnSync('node', [FIND, ...args], { encoding: 'utf8', env: { ...process.env, FRAME_PROJECT_ROOT: dir, ...env } });
}

const envelope = (r) => JSON.parse(r.stdout);

test('the legacy engine keeps the feature listing, IPC line and missing-file marker', (t) => {
  const dir = project(t);
  fs.rmSync(path.join(dir, 'src/renderer/githubPanel.js'));
  const r = find(dir, ['github', '--retrieval=legacy']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Feature: github\n {2}src\/main\/githubManager\.js +— GitHub Manager Module\n/);
  assert.match(r.stdout, /src\/renderer\/githubPanel\.js .*⚠ file missing on disk/);
  assert.match(r.stdout, /IPC: LOAD_GITHUB_ISSUES/);
  assert.match(find(dir, ['--list']).stdout, /github +→ src\/main\/githubManager\.js, src\/renderer\/githubPanel\.js/);
});

test('v2 finds files outside every concept and names the evidence', (t) => {
  const dir = project(t);
  const r = find(dir, ['issueBranchName', '--retrieval=v2']);
  assert.match(r.stdout, /Files for "issueBranchName":\n {2}src\/renderer\/github\/rowModels\.js .*\[symbol\]/);
  const amb = find(dir, ['uiZoom', '--retrieval=v2']);
  assert.match(amb.stdout, /Candidates for "uiZoom" \(several match equally — pick by path\)/);
  assert.match(find(dir, ['kubernetes', '--retrieval=v2']).stdout, /No modules found for "kubernetes"/);
});

test('--json is one bounded envelope; no-match exits 0, a missing or corrupt map is unavailable with exit 1', (t) => {
  const dir = project(t);
  const ok = find(dir, ['github', '--json', '--retrieval=v2']);
  assert.equal(ok.status, 0);
  const env = envelope(ok);
  assert.equal(env.schema, 'frame.lookup/1');
  assert.equal(env.status, 'resolved');
  assert.equal(env.engine, 'v2');
  assert.equal(env.freshness, 'unknown');
  assert.deepEqual(env.candidates.map((c) => [c.path, c.evidence]), [['src/main/githubManager.js', 'concept'], ['src/renderer/githubPanel.js', 'concept'], ['src/renderer/github/rowModels.js', 'path word']]);
  assert.equal(ok.stdout.trim().split('\n').length, 1, 'nothing else on stdout');

  const none = find(dir, ['kubernetes', '--json', '--retrieval=v2']);
  assert.equal(none.status, 0);
  assert.equal(envelope(none).status, 'no-match');

  const empty = project(t, { structure: null });
  const missing = find(empty, ['github', '--json']);
  assert.equal(missing.status, 1);
  assert.deepEqual([envelope(missing).status, envelope(missing).reason], ['unavailable', 'no-map']);
  fs.writeFileSync(path.join(empty, '.frame', 'STRUCTURE.json'), '{ not json');
  assert.equal(find(empty, ['github']).status, 1);
  assert.match(find(empty, ['github']).stderr, /Could not read STRUCTURE\.json/);
});

test('--limit bounds the candidates (max 20) and reports truncation', (t) => {
  const modules = {};
  const group = [];
  for (let i = 0; i < 30; i++) {
    modules[`m${i}`] = { file: `src/widget${i}.js`, description: `Widget ${i}`, exports: [], depends: [], functions: {} };
    group.push({ module: `m${i}`, file: `src/widget${i}.js` });
  }
  const dir = project(t, { structure: { modules, intentIndex: { widgets: group } } });
  const three = envelope(find(dir, ['widgets', '--json', '--limit', '3', '--retrieval=v2']));
  assert.equal(three.candidates.length, 3);
  assert.equal(three.truncated, true);
  assert.equal(envelope(find(dir, ['widgets', '--json', '--limit=50', '--retrieval=v2'])).candidates.length, 20);
  assert.equal(envelope(find(dir, ['widgets', '--json', '--retrieval=legacy'])).candidates.length, 8, 'the default limit applies to legacy JSON too');
  assert.equal(find(dir, ['widgets', '--limit', 'x']).status, 2);
});

test('missing files are flagged, never presented as present; paths outside the project never count', (t) => {
  const dir = project(t);
  fs.rmSync(path.join(dir, 'src/renderer/github/rowModels.js'));
  const env = envelope(find(dir, ['issueBranchName', '--json', '--retrieval=v2']));
  assert.deepEqual(env.candidates, [{ path: 'src/renderer/github/rowModels.js', evidence: 'symbol', tier: 5, description: 'Row models', missing: true }]);

  // a symlink that escapes the project is not "on disk" for it
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'rowModels.js'), '// outside\n');
  fs.symlinkSync(path.join(outside, 'rowModels.js'), path.join(dir, 'src/renderer/github/rowModels.js'));
  assert.equal(envelope(find(dir, ['issueBranchName', '--json', '--retrieval=v2'])).candidates[0].missing, true);
});

test('the engine comes from the flag, then project.retrieval.engine, then the default; bad values fall back with a note', (t) => {
  const dir = project(t, { engine: 'v2' });
  assert.equal(envelope(find(dir, ['github', '--json'])).engine, 'v2');
  assert.equal(envelope(find(dir, ['github', '--json', '--retrieval=legacy'])).engine, 'legacy');
  const bad = find(dir, ['github', '--json', '--retrieval=fancy']);
  assert.equal(envelope(bad).engine, require('../scripts/structure-retrieval').DEFAULT_ENGINE);
  assert.match(bad.stderr, /unknown engine "fancy"/);
  const badConfig = project(t, { engine: 'nope' });
  assert.match(find(badConfig, ['github', '--json']).stderr, /project\.retrieval\.engine "nope" is not an engine/);
});

test('v2 uses a fresh published index and falls back to the map when it is stale', (t) => {
  const dir = project(t);
  const retrieval = require('../scripts/structure-retrieval');
  assert.equal(retrieval.publishLookup(dir).status, 'published');
  // poison the published index: a fresh one would be used as-is
  const file = retrieval.lookupPath(dir);
  const index = JSON.parse(fs.readFileSync(file, 'utf8'));
  index.terms['5:onlyinindex'] = [0];
  fs.writeFileSync(file, JSON.stringify(index));
  assert.equal(envelope(find(dir, ['onlyInIndex', '--json', '--retrieval=v2'])).status, 'resolved');
  // the map changes: the index is stale and the map answers
  const map = path.join(dir, '.frame', 'STRUCTURE.json');
  fs.writeFileSync(map, fs.readFileSync(map, 'utf8') + ' ');
  assert.equal(envelope(find(dir, ['onlyInIndex', '--json', '--retrieval=v2'])).status, 'no-match');
});

test('a lookup never runs Git, even when the map predates the last commit', (t) => {
  const dir = project(t);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-no-git-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const marker = path.join(bin, 'called');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
  const r = find(dir, ['github'], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(marker), false);
  assert.match(r.stdout, /^⚠ Map: unverified \(no-working-view\) — run: node .*structure-lifecycle\.js --once/);
});
