/**
 * structure-retrieval tests (STR-03): evidence tiers, curated precedence,
 * files outside every concept, ambiguity, query normalization (Turkish,
 * camelCase, regex/glob syntax), limits, and parity of the legacy engine
 * with today's find-module / module-hint behavior.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const R = require('../scripts/structure-retrieval');

const SCRIPTS = path.join(__dirname, '..', 'scripts');

function mod(file, description, extra = {}) {
  return { file, description, exports: [], depends: [], functions: {}, ...extra };
}

const STRUCTURE = {
  generation: { revision: 'rev-1' },
  modules: {
    'main/githubManager': mod('src/main/githubManager.js', 'GitHub Manager Module', {
      functions: { checkGhAuth: { line: 1 } }, ipc: { listens: ['LOAD_GITHUB_ISSUES'], emits: [] }
    }),
    'renderer/githubPanel': mod('src/renderer/githubPanel.js', 'GitHub Panel — the sidebar tab'),
    'renderer/github/rowModels': mod('src/renderer/github/rowModels.js', 'Row view-models — pure', {
      functions: { issueBranchName: { line: 3 } }
    }),
    'main/frameStore': mod('src/main/frameStore.js', 'frameStore — the one module that knows where meta files live'),
    'main/fsSafe': mod('src/main/fsSafe.js', 'Durable state-file primitives', { functions: { writeFileAtomic: { line: 1 } } }),
    'main/uiZoom': mod('src/main/uiZoom.js', 'UI zoom — main-process owner'),
    'shared/uiZoom': mod('src/shared/uiZoom.js', 'UI zoom ladder', { functions: { factorFor: { line: 2 } } }),
    'main/settings': mod('src/main/userSettings.js', 'User Settings'),
    'renderer/settingsOverlay': mod('src/renderer/settingsOverlay.js', 'Settings overlay plumbing'),
    'lang/rust': mod('scripts/lang/rust.js', 'Rust extractor', { functions: { extractFunctions: { line: 1 } } }),
    'lang/go': mod('scripts/lang/go.js', 'Go extractor', { functions: { extractFunctions: { line: 1 } } }),
    'renderer/statusBar': mod('src/renderer/statusBar.js', 'Status bar'),
    'renderer/sidebarResize': mod('src/renderer/sidebarResize.js', 'Sidebar resize'),
    'main/A': mod('src/main/Case.js', 'Upper'),
    'main/a': mod('src/main/case.js', 'Lower')
  },
  intentIndex: {
    github: [{ module: 'main/githubManager', file: 'src/main/githubManager.js' }, { module: 'renderer/githubPanel', file: 'src/renderer/githubPanel.js' }],
    settings: [{ module: 'main/settings', file: 'src/main/userSettings.js' }, { module: 'renderer/settingsOverlay', file: 'src/renderer/settingsOverlay.js' }],
    sidebar: [{ module: 'renderer/sidebarResize', file: 'src/renderer/sidebarResize.js' }],
    zoom: [{ module: 'main/uiZoom', file: 'src/main/uiZoom.js' }, { module: 'shared/uiZoom', file: 'src/shared/uiZoom.js' }]
  }
};
const CURATION = {
  _comment: 'test',
  github: { synonyms: ['issues', 'pull-requests'] },
  settings: { synonyms: ['preferences', 'config'] },
  tasks: { synonyms: ['todo'] }
};

const index = R.compileIndex(STRUCTURE, CURATION);
const paths = (result) => result.candidates.map((c) => c.path);
const cli = (q, opts = {}) => R.retrieve(index, q, { mode: 'cli', ...opts });
const hook = (q, opts = {}) => R.retrieve(index, q, { mode: 'hook', ...opts });

/* --------------------------------- tiers --------------------------------- */

test('a file outside every concept is found by path, file name and symbol', () => {
  assert.deepEqual(paths(cli('src/renderer/github/rowModels.js')), ['src/renderer/github/rowModels.js']);
  assert.equal(cli('github/rowModels.js').candidates[0].evidence, 'path', 'a path suffix at a directory boundary');
  assert.deepEqual(paths(hook('rowModels')), ['src/renderer/github/rowModels.js']);
  assert.deepEqual(paths(hook('rowModels.js')), ['src/renderer/github/rowModels.js']);
  const bySymbol = hook('issueBranchName');
  assert.deepEqual(paths(bySymbol), ['src/renderer/github/rowModels.js']);
  assert.equal(bySymbol.candidates[0].evidence, 'symbol');
  assert.equal(bySymbol.status, 'resolved');
  assert.deepEqual(paths(hook('LOAD_GITHUB_ISSUES')), ['src/main/githubManager.js'], 'IPC channels are symbols');
});

test('curated concepts and synonyms answer with the whole group, in curated order', () => {
  const concept = hook('github');
  assert.deepEqual(paths(concept), ['src/main/githubManager.js', 'src/renderer/githubPanel.js']);
  assert.equal(concept.status, 'resolved', 'one concept group is one answer');
  assert.equal(concept.candidates[0].evidence, 'concept');
  assert.deepEqual(paths(hook('pull-requests')), ['src/main/githubManager.js', 'src/renderer/githubPanel.js']);
  assert.equal(hook('preferences').candidates[0].evidence, 'synonym');
});

test('an exact file name beats a concept it happens to contain', () => {
  const r = hook('githubPanel');
  assert.deepEqual(paths(r), ['src/renderer/githubPanel.js'], 'not the whole github group');
  assert.equal(r.candidates[0].evidence, 'file name');
  // the CLI still lists the rest, ranked below
  assert.equal(cli('githubPanel').candidates[0].path, 'src/renderer/githubPanel.js');
});

test('ambiguous names list every file of equal standing', () => {
  const zoom = hook('uiZoom');
  assert.equal(zoom.status, 'ambiguous');
  assert.deepEqual(paths(zoom), ['src/main/uiZoom.js', 'src/shared/uiZoom.js']);
  const fn = hook('extractFunctions');
  assert.equal(fn.status, 'ambiguous');
  assert.deepEqual(paths(fn), ['scripts/lang/go.js', 'scripts/lang/rust.js']);
});

test('files differing only in case stay two candidates', () => {
  assert.deepEqual(paths(cli('case.js')).sort(), ['src/main/Case.js', 'src/main/case.js']);
  assert.equal(cli('case.js').status, 'ambiguous');
});

test('description and path words reach the CLI only', () => {
  const r = cli('rust extractor');
  assert.deepEqual(paths(r).slice(0, 1), ['scripts/lang/rust.js']);
  assert.deepEqual(paths(cli('extractor')), ['scripts/lang/go.js', 'scripts/lang/rust.js']);
  assert.equal(hook('extractor').status, 'no-match', 'a description word never becomes a hint');
  assert.equal(hook('primitives').status, 'no-match');
});

/* ------------------------------ silence rules ----------------------------- */

test('every identifier word must be explained; one matching word does not answer the query', () => {
  assert.equal(cli('webpack config').status, 'no-match', '"config" alone is a synonym, "webpack" explains nothing');
  assert.equal(hook('elasticsearch index').status, 'no-match');
  assert.equal(hook('payment gateway').status, 'no-match');
});

test('words with non-ASCII letters are prose and may stay unexplained', () => {
  assert.deepEqual(paths(hook('frameStore dosyası')), ['src/main/frameStore.js']);
  assert.deepEqual(paths(hook('GitHub yöneticisi')), ['src/main/githubManager.js', 'src/renderer/githubPanel.js']);
  assert.equal(hook('ödeme sayfası').status, 'no-match', 'prose alone is no query');
});

test('when no file carries every word, files rank by how many they carry', () => {
  // githubPanel.js carries both words (concept + "the sidebar tab"), so it leads
  assert.equal(cli('github sidebar').candidates[0].path, 'src/renderer/githubPanel.js');
  // "GitHub paneli": no file is in both groups, yet both words are explained
  const loose = cli('github zoom');
  assert.deepEqual(paths(loose).sort(), ['src/main/githubManager.js', 'src/main/uiZoom.js', 'src/renderer/github/rowModels.js', 'src/renderer/githubPanel.js', 'src/shared/uiZoom.js'], 'rowModels.js by its github/ directory');
});

test('noise, comment markers and short partial words never produce a hint', () => {
  assert.equal(hook('console.log').status, 'no-match');
  assert.equal(hook('async function').status, 'no-match');
  assert.equal(hook('TODO').status, 'no-match', 'a grep for TODO looks for comments');
  assert.equal(cli('todo').status, 'no-match', 'no tasks concept in this map');
  assert.equal(hook('bar').status, 'no-match', '"bar" ⊂ "sidebar" is below the partial-concept minimum');
  assert.equal(hook('foo|bar').status, 'no-match');
});

test('a partial concept is a hook-eligible tier below exact file evidence', () => {
  const r = hook('settingsPanel');
  assert.equal(r.candidates[0].evidence, 'partial concept');
  assert.deepEqual(paths(r), ['src/main/userSettings.js', 'src/renderer/settingsOverlay.js']);
});

/* ------------------------------ normalization ----------------------------- */

test('Turkish letters, dotted capitals and accents fold; identifiers split on case and separators', () => {
  assert.equal(R.fold('GİTHUB'), 'github');
  assert.equal(R.fold('İPC KANALLARI'), 'ipc kanallari');
  assert.equal(R.fold('çıkarıcı'), 'cikarici');
  assert.equal(R.fold('Café'), 'cafe');
  assert.deepEqual(R.splitWords('structureBootstrap'), ['structure', 'bootstrap']);
  assert.deepEqual(R.splitWords('LOAD_GITHUB_ISSUES'), ['load', 'github', 'issues']);
  assert.deepEqual(R.splitWords('XMLParser-v2'), ['xml', 'parser', 'v2']);
  assert.deepEqual(paths(hook('GİTHUB')), ['src/main/githubManager.js', 'src/renderer/githubPanel.js']);
});

test('regex and glob syntax is stripped; alternations are tried in order', () => {
  assert.deepEqual(paths(hook('\\bwriteFileAtomic\\b')), ['src/main/fsSafe.js']);
  assert.deepEqual(paths(hook('**/frameStore.js')), ['src/main/frameStore.js']);
  assert.deepEqual(paths(hook('nothingHere|factorFor')), ['src/shared/uiZoom.js']);
  const q = R.normalizeQuery('a'.repeat(2000));
  assert.equal(q.raw.length, R.LIMITS.queryChars);
  assert.ok(R.normalizeQuery('a b c d e f g h i j k').alternatives[0].length <= R.LIMITS.queryUnits);
});

/* --------------------------------- limits -------------------------------- */

test('results are bounded: hooks show at most 8 files, the CLI at most 20', () => {
  const modules = {};
  const group = [];
  for (let i = 0; i < 30; i++) {
    modules[`m${i}`] = mod(`src/widget${i}.js`, `Widget ${i}`);
    group.push({ module: `m${i}`, file: `src/widget${i}.js` });
  }
  const big = R.compileIndex({ modules, intentIndex: { widgets: group } }, {});
  const h = R.retrieve(big, 'widgets', { mode: 'hook' });
  assert.equal(h.candidates.length, 8);
  assert.equal(h.truncated, true);
  assert.equal(R.retrieve(big, 'widgets', { mode: 'cli', limit: 50 }).candidates.length, 20);
  assert.equal(R.retrieve(big, 'widgets', { mode: 'cli' }).candidates.length, 8, 'default limit');
});

test('postings are capped per term and the truncation is recorded', () => {
  const modules = {};
  for (let i = 0; i < 100; i++) modules[`m${i}`] = mod(`pkg${i}/index.js`, 'x', { functions: { handle: { line: 1 } } });
  const idx = R.compileIndex({ modules, intentIndex: {} }, {});
  assert.equal(idx.terms['5:handle'].length, R.LIMITS.postingsPerTerm);
  assert.ok(idx.truncated.includes('5:handle'));
  assert.ok(idx.truncated.includes('4:index.js'));
});

test('the index is deterministic and carries its revision and algorithm', () => {
  const again = R.compileIndex(JSON.parse(JSON.stringify(STRUCTURE)), CURATION);
  assert.equal(JSON.stringify(again), JSON.stringify(index));
  assert.equal(index.revision, 'rev-1');
  assert.equal(index.algorithm, R.ALGORITHM);
  assert.equal(index.version, R.INDEX_VERSION);
  assert.ok(index.files.every(([p, d]) => typeof p === 'string' && d.length <= R.LIMITS.descriptionChars));
});

test('missing files are flagged for the CLI and dropped from hooks', () => {
  const exists = (p) => p !== 'src/renderer/githubPanel.js';
  const c = cli('github', { exists });
  assert.equal(c.candidates.find((x) => x.path === 'src/renderer/githubPanel.js').missing, true);
  assert.deepEqual(paths(hook('github', { exists })), ['src/main/githubManager.js']);
  assert.ok(!paths(hook('githubPanel', { exists })).includes('src/renderer/githubPanel.js'), 'falls back to other evidence, never the missing file');
});

/* --------------------------------- legacy -------------------------------- */

function legacyProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-legacy-parity-'));
  fs.mkdirSync(path.join(dir, '.frame'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.frame', 'STRUCTURE.json'), JSON.stringify(STRUCTURE));
  for (const m of Object.values(STRUCTURE.modules)) {
    fs.mkdirSync(path.dirname(path.join(dir, m.file)), { recursive: true });
    fs.writeFileSync(path.join(dir, m.file), '// x\n');
  }
  return dir;
}

test('the legacy engine reproduces find-module\'s four tiers', (t) => {
  const dir = legacyProject();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const curation = JSON.parse(fs.readFileSync(path.join(SCRIPTS, 'intent-map.json'), 'utf8'));
  for (const q of ['github', 'issues', 'git', 'extractor', 'checkGhAuth', 'nothing-here']) {
    const out = spawnSync('node', [path.join(SCRIPTS, 'find-module.js'), q], { encoding: 'utf8', env: { ...process.env, FRAME_PROJECT_ROOT: dir } }).stdout;
    const listed = out.split('\n').map((l) => /^ {2}(\S+\.\w+)/.exec(l)).filter(Boolean).map((m) => m[1]);
    assert.deepEqual(paths(R.legacyRetrieve(STRUCTURE, curation, { mode: 'cli', query: q })), listed, q);
  }
});

test('the legacy hook engine takes the first keyword that hits a curated tier', () => {
  const r = R.legacyRetrieve(STRUCTURE, CURATION, { mode: 'hook', words: ['nothing', 'issues', 'github'] });
  assert.equal(r.keyword, 'issues');
  assert.equal(r.groups[0].matchType, 'synonym');
  assert.deepEqual(paths(r), ['src/main/githubManager.js', 'src/renderer/githubPanel.js']);
  assert.equal(R.legacyRetrieve(STRUCTURE, CURATION, { mode: 'hook', words: ['checkghauth'] }).status, 'no-match', 'no deep tier in hooks');
  assert.equal(R.legacyRetrieve({ modules: {} }, {}, { mode: 'cli', query: 'x' }).status, 'unavailable');
});

/* ------------------------- the published lookup file ------------------------ */

function lookupProject(t, files = { 'src/a.js': '// Alpha module\nfunction runAlpha() {}\nmodule.exports = { runAlpha };\n' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-lookup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  const working = path.join(dir, '.frame', 'runtime', 'structure', 'working.json');
  fs.mkdirSync(path.dirname(working), { recursive: true });
  fs.writeFileSync(working, JSON.stringify({ generation: { revision: 'r1' }, modules: { a: mod('src/a.js', 'Alpha module', { functions: { runAlpha: {} } }) }, intentIndex: {} }));
  const curation = path.join(dir, 'intent-map.json');
  fs.writeFileSync(curation, JSON.stringify({ alpha: { synonyms: ['first'] } }));
  return { dir, working, curation };
}

test('publishLookup writes a fresh index once and reports unchanged until an input changes', (t) => {
  const { dir, working, curation } = lookupProject(t);
  const first = R.publishLookup(dir, { curationPath: curation });
  assert.equal(first.status, 'published');
  assert.equal(first.oversize, false);
  const loaded = R.loadLookup(dir, { curationPath: curation, maxBytes: R.LIMITS.hookIndexBytes });
  assert.equal(loaded.state, 'fresh');
  assert.equal(loaded.index.source.path, '.frame/runtime/structure/working.json');
  assert.deepEqual(R.retrieve(loaded.index, 'runAlpha', { mode: 'hook' }).candidates.map((c) => c.path), ['src/a.js']);
  assert.equal(R.publishLookup(dir, { curationPath: curation }).status, 'unchanged');

  // a changed map makes it stale until it is republished
  fs.writeFileSync(working, fs.readFileSync(working, 'utf8').replace('Alpha module', 'Alpha module, edited'));
  assert.equal(R.loadLookup(dir, { curationPath: curation }).state, 'stale');
  assert.equal(R.publishLookup(dir, { curationPath: curation }).status, 'published');
  assert.equal(R.loadLookup(dir, { curationPath: curation }).state, 'fresh');

  // so does a changed curation file
  fs.writeFileSync(curation, JSON.stringify({ alpha: { synonyms: ['first', 'premier'] } }));
  assert.equal(R.loadLookup(dir, { curationPath: curation }).state, 'stale');
  assert.equal(R.publishLookup(dir, { curationPath: curation }).status, 'published');
});

test('loadLookup reports missing, invalid and oversize indexes without reading past the cap', (t) => {
  const { dir, curation } = lookupProject(t);
  assert.equal(R.loadLookup(dir).state, 'missing');
  fs.writeFileSync(R.lookupPath(dir), '{ not json');
  assert.equal(R.loadLookup(dir).state, 'invalid');
  fs.writeFileSync(R.lookupPath(dir), JSON.stringify({ version: 999 }));
  assert.equal(R.loadLookup(dir).state, 'invalid');
  R.publishLookup(dir, { curationPath: curation, mapPath: undefined });
  assert.equal(R.loadLookup(dir, { maxBytes: 10 }).state, 'oversize');
});

test('an index above the hook cap is published, flagged oversize, and refused to hooks', (t) => {
  const modules = {};
  for (let i = 0; i < 14000; i++) modules[`m${i}`] = mod(`src/area${i % 50}/widgetNumber${i}.js`, `Widget number ${i} with a long description to grow the index`, { functions: { [`handleWidget${i}`]: {} } });
  const { dir, working, curation } = lookupProject(t);
  fs.writeFileSync(working, JSON.stringify({ modules, intentIndex: {} }));
  const r = R.publishLookup(dir, { curationPath: curation });
  assert.equal(r.status, 'published');
  assert.equal(r.oversize, true);
  assert.ok(r.bytes > R.LIMITS.hookIndexBytes);
  assert.equal(R.loadLookup(dir, { curationPath: curation, maxBytes: R.LIMITS.hookIndexBytes }).state, 'oversize');
  assert.equal(R.loadLookup(dir, { curationPath: curation }).state, 'fresh', 'the CLI may still use it');
});

test('indexFromMap compiles the read view in memory and refuses a map above the cap', (t) => {
  const { dir, curation } = lookupProject(t);
  const r = R.indexFromMap(dir, { curationPath: curation });
  assert.equal(r.state, 'compiled');
  assert.deepEqual(R.retrieve(r.index, 'first', { mode: 'hook' }).candidates, [], 'no alpha concept in the intentIndex');
  assert.equal(R.indexFromMap(dir, { maxBytes: 10 }).state, 'oversize');
  assert.equal(fs.existsSync(R.lookupPath(dir)), false, 'never writes');
});

/* --------------------------- STR-03b: engine rules --------------------------- */

test('a hook needs one file to carry every word; the CLI still ranks partial coverage', () => {
  assert.equal(hook('github zoom').status, 'no-match', 'no single file is both');
  assert.ok(cli('github zoom').candidates.length >= 4, 'the CLI keeps the relaxation');
  // githubPanel carries "sidebar" only in its description, which is not hook evidence
  assert.equal(hook('github sidebar').status, 'no-match');
  // one file carrying both words still answers in a hook
  assert.deepEqual(paths(hook('githubManager checkGhAuth')), ['src/main/githubManager.js']);
});

test('function candidates carry their definition line and the symbol as asked', () => {
  const withLines = R.compileIndex({
    modules: {
      a: mod('src/a.js', 'A', { functions: { buildThing: { line: 42 } }, exports: ['buildThing', 'CONSTANT'], ipc: { listens: ['RUN_TASK'], emits: [] } })
    },
    intentIndex: {}
  }, {});
  const fn = R.retrieve(withLines, 'buildThing', { mode: 'cli' }).candidates[0];
  assert.deepEqual([fn.path, fn.line, fn.symbol, fn.evidence], ['src/a.js', 42, 'buildThing', 'symbol']);
  assert.equal(R.retrieve(withLines, 'BUILDTHING', { mode: 'hook' }).candidates[0].line, 42, 'case-insensitive');
  assert.equal(R.retrieve(withLines, 'CONSTANT', { mode: 'cli' }).candidates[0].line, undefined, 'exports carry no line');
  assert.equal(R.retrieve(withLines, 'RUN_TASK', { mode: 'cli' }).candidates[0].line, undefined, 'IPC channels carry no line');
  assert.equal(R.retrieve(withLines, 'a.js', { mode: 'cli' }).candidates[0].line, undefined, 'only symbol evidence has a line');
});

test('paths match by scanning the file list, with no path postings in the index', () => {
  assert.ok(!Object.keys(index.terms).some((k) => k.startsWith('1:')));
  assert.equal(cli('src/main/frameStore.js').candidates[0].evidence, 'path');
  assert.equal(cli('SRC/Main/FrameStore.js').candidates[0].path, 'src/main/frameStore.js', 'case-insensitive');
  assert.equal(cli('main/frameStore.js').candidates[0].evidence, 'path', 'suffix at a directory boundary');
  assert.notEqual((cli('ain/frameStore.js').candidates[0] || {}).evidence, 'path', 'not mid-name');
  const root = R.compileIndex({ modules: { m: mod('main.js', 'Root entry') }, intentIndex: {} }, {});
  assert.equal(R.retrieve(root, 'main.js', { mode: 'cli' }).candidates[0].evidence, 'path', 'a root file by its exact path');
});

test('the algorithm version moved, so indexes compiled under the old rules are stale', () => {
  assert.equal(R.ALGORITHM, 'str03-v2.2');
});
