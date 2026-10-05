/**
 * Shipped-script project-root tests (non-invasive-overlay T03).
 *
 * The copies under a project's `.frame/bin/` used to resolve their project as
 * `__dirname/..`, which is `.frame/` — so running one by hand from a user
 * project reported on (or wrote into) the wrong tree. Each script now derives
 * the project from its own location, honours FRAME_PROJECT_ROOT above
 * everything, and resolves meta files overlay-first without ever creating one
 * at the project root.
 *
 * The scripts are staged with the real `copyParserScripts`, so this also pins
 * that migration's refresh path ships everything they require.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const structureBootstrap = require('../src/main/structureBootstrap');

let projectDir;
let binDir;

function run(script, args = [], env = {}) {
  return spawnSync('node', [path.join(binDir, script), ...args], {
    // cwd is deliberately somewhere else: the script must find the project
    // from its own location, not from where it happens to be invoked.
    cwd: os.tmpdir(),
    encoding: 'utf8',
    env: { ...process.env, FRAME_PROJECT_ROOT: undefined, ...env },
    timeout: 30000
  });
}

before(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-scripts-'));
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });

  fs.writeFileSync(
    path.join(projectDir, 'src', 'widgetManager.js'),
    [
      '/**',
      ' * Widget Manager — creates and stores widgets.',
      ' */',
      'function createWidget(name) { return { name }; }',
      'module.exports = { createWidget };',
      ''
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(projectDir, 'src', 'reportPrinter.js'),
    [
      '/**',
      ' * Report Printer — renders widget reports.',
      ' */',
      'function printReport(rows) { return rows.join("\\n"); }',
      'module.exports = { printReport };',
      ''
    ].join('\n'),
    'utf8'
  );

  binDir = path.join(projectDir, '.frame', 'bin');
  structureBootstrap.copyParserScripts(projectDir);
});

after(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test('copyParserScripts stages the scripts and their extractors', () => {
  for (const file of ['update-structure.js', 'find-module.js', 'check-freshness.js', 'intent-map.json']) {
    assert.ok(fs.existsSync(path.join(binDir, file)), `${file} staged`);
  }
  assert.ok(fs.existsSync(path.join(binDir, 'lang', 'javascript.js')), 'lang extractors staged');
});

test('update-structure.js writes .frame/STRUCTURE.json for the project it lives in', () => {
  const result = run('update-structure.js');
  assert.equal(result.status, 0, result.stderr);

  const overlayPath = path.join(projectDir, '.frame', 'STRUCTURE.json');
  assert.ok(fs.existsSync(overlayPath), 'map written under .frame/');
  assert.ok(!fs.existsSync(path.join(projectDir, 'STRUCTURE.json')), 'nothing created at the project root');

  const structure = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
  const keys = Object.keys(structure.modules);
  assert.ok(keys.some((k) => k.includes('widgetManager')), `widgetManager in ${keys}`);
  assert.ok(keys.some((k) => k.includes('reportPrinter')), `reportPrinter in ${keys}`);
});

test('find-module.js resolves the same project', () => {
  const result = run('find-module.js', ['widget']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /widgetManager/);
});

test('check-freshness.js reports no phantom modules for a freshly parsed tree', () => {
  const result = run('check-freshness.js', ['--json']);
  assert.equal(result.status, 0, result.stderr);
  const findings = JSON.parse(result.stdout);
  const phantom = (findings.findings || findings).filter((f) => f.check === 'phantom-module');
  assert.deepEqual(phantom, [], 'the modules it lists are the ones on disk');
});

test('an owned root STRUCTURE.json keeps being updated in place', () => {
  // Unmigrated project: the map is still at the root, so the parser must
  // keep writing there rather than starting a second copy under .frame/.
  // Ownership is the `config.files` record frameStore trusts (STR-01); a
  // root file without it is the user's and is left alone (tested below).
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-scripts-legacy-'));
  fs.mkdirSync(path.join(legacyDir, '.frame'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, '.frame', 'config.json'), JSON.stringify({ files: { structure: 'STRUCTURE.json' } }));
  fs.mkdirSync(path.join(legacyDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, 'src', 'legacyModule.js'),
    '/** Legacy Module — one export. */\nmodule.exports = { legacy: true };\n',
    'utf8'
  );
  fs.writeFileSync(path.join(legacyDir, 'STRUCTURE.json'), JSON.stringify({ modules: {} }, null, 2) + '\n', 'utf8');
  structureBootstrap.copyParserScripts(legacyDir);

  const result = spawnSync('node', [path.join(legacyDir, '.frame', 'bin', 'update-structure.js')], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    env: { ...process.env, FRAME_PROJECT_ROOT: undefined },
    timeout: 30000
  });
  assert.equal(result.status, 0, result.stderr);

  const structure = JSON.parse(fs.readFileSync(path.join(legacyDir, 'STRUCTURE.json'), 'utf8'));
  assert.ok(Object.keys(structure.modules).some((k) => k.includes('legacyModule')), 'root map updated');
  assert.ok(!fs.existsSync(path.join(legacyDir, '.frame', 'STRUCTURE.json')), 'no second copy under .frame/');

  fs.rmSync(legacyDir, { recursive: true, force: true });
});

test('the pre-commit snippet updates a linked worktree\'s own STRUCTURE.json', () => {
  // Worker worktrees (.frame/worktrees/<slug>) are linked checkouts. Resolving
  // the parser from `--show-toplevel` alone finds nothing there when the
  // checkout has no .frame/bin of its own, and the hook silently did nothing.
  const { getStructureHookSnippet } = require('../src/shared/frameTemplates');
  const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-hook-main-'));
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-hook-wt-'));
  fs.rmSync(worktreeDir, { recursive: true, force: true });
  try {
    git(mainDir, ['init', '-q']);
    git(mainDir, ['config', 'user.email', 'test@example.com']);
    git(mainDir, ['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(mainDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(mainDir, 'src', 'widgetManager.js'), '/** Widget Manager — one export. */\nmodule.exports = {};\n', 'utf8');
    git(mainDir, ['add', 'src']);
    git(mainDir, ['commit', '-q', '-m', 'init']);
    structureBootstrap.copyParserScripts(mainDir); // only the main checkout has .frame/bin

    git(mainDir, ['worktree', 'add', '-q', '-b', 'wt', worktreeDir]);
    assert.ok(!fs.existsSync(path.join(worktreeDir, '.frame', 'bin')), 'the worktree has no parser of its own');

    fs.writeFileSync(path.join(worktreeDir, 'src', 'gadgetManager.js'), '/** Gadget Manager — one export. */\nmodule.exports = {};\n', 'utf8');
    git(worktreeDir, ['add', 'src/gadgetManager.js']);

    const hookFile = path.join(worktreeDir, 'run-hook.sh');
    fs.writeFileSync(hookFile, `#!/bin/sh\n${getStructureHookSnippet()}\nexit 0\n`, { mode: 0o755 });
    const result = spawnSync('sh', [hookFile], { cwd: worktreeDir, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);

    // STR-02b: the hook stages the commit's map into the worktree's index
    const staged = git(worktreeDir, ['show', ':.frame/STRUCTURE.json']);
    assert.equal(staged.status, 0, 'the worktree got its own commit map');
    const structure = JSON.parse(staged.stdout);
    assert.ok(Object.keys(structure.modules).some((k) => k.includes('gadgetManager')), 'and it describes the worktree');
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: mainDir });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    fs.rmSync(mainDir, { recursive: true, force: true });
  }
});

test('FRAME_PROJECT_ROOT still wins over the script location', () => {
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-scripts-other-'));
  fs.mkdirSync(path.join(otherDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(otherDir, 'src', 'otherModule.js'),
    '/** Other Module — elsewhere entirely. */\nmodule.exports = { other: true };\n',
    'utf8'
  );

  // Same staged script, pointed at a different project by env alone.
  const result = run('update-structure.js', [], { FRAME_PROJECT_ROOT: otherDir });
  assert.equal(result.status, 0, result.stderr);

  const structure = JSON.parse(fs.readFileSync(path.join(otherDir, '.frame', 'STRUCTURE.json'), 'utf8'));
  assert.ok(Object.keys(structure.modules).some((k) => k.includes('otherModule')), 'env target parsed');

  const staged = JSON.parse(fs.readFileSync(path.join(projectDir, '.frame', 'STRUCTURE.json'), 'utf8'));
  assert.ok(!Object.keys(staged.modules).some((k) => k.includes('otherModule')), 'the script\'s own project untouched');

  fs.rmSync(otherDir, { recursive: true, force: true });
});

/* ---------- STR-01: one STRUCTURE ownership rule for writer and readers ---------- */

const structureState = require('../scripts/structure-state');
const SCRIPTS = path.join(__dirname, '..', 'scripts');

function ownershipProject({ overlay = false, root = false, owned = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-owner-'));
  fs.mkdirSync(path.join(dir, '.frame'), { recursive: true });
  const map = (label) => JSON.stringify({
    version: '1.1',
    modules: { [`${label}Widget`]: { file: `src/${label}Widget.js`, description: label } },
    intentIndex: { widget: [{ module: `${label}Widget`, file: `src/${label}Widget.js`, description: label }] }
  });
  if (overlay) fs.writeFileSync(path.join(dir, '.frame', 'STRUCTURE.json'), map('overlay'));
  if (root) fs.writeFileSync(path.join(dir, 'STRUCTURE.json'), map('root'));
  if (owned) fs.writeFileSync(path.join(dir, '.frame', 'config.json'), JSON.stringify({ files: { structure: 'STRUCTURE.json' } }));
  return dir;
}

/** Which copy each reader used: find-module prints files, freshness flags phantoms. */
function readersSee(dir) {
  const env = { ...process.env, FRAME_PROJECT_ROOT: dir };
  const find = spawnSync('node', [path.join(SCRIPTS, 'find-module.js'), 'widget'], { encoding: 'utf8', env });
  const fresh = spawnSync('node', [path.join(SCRIPTS, 'check-freshness.js'), '--json'], { encoding: 'utf8', env });
  const hint = spawnSync('node', [path.join(SCRIPTS, 'module-hint.js'), 'search'], {
    encoding: 'utf8', env,
    input: JSON.stringify({ session_id: `s-${Math.random()}`, cwd: dir, tool_name: 'Grep', tool_input: { pattern: 'widget' } })
  });
  const pick = (text) => (/overlayWidget/.test(text) ? 'overlay' : /rootWidget/.test(text) ? 'root' : 'none');
  const phantoms = JSON.parse(fresh.stdout).findings.filter((f) => f.check === 'phantom-module').map((f) => f.message).join(' ');
  return { find: pick(find.stdout), freshness: pick(phantoms), hint: pick(hint.stdout) };
}

for (const [label, layout, expected] of [
  ['overlay only', { overlay: true }, 'overlay'],
  ['unowned root file only', { root: true }, 'none'],
  ['owned root file', { root: true, owned: true }, 'root'],
  ['overlay beside an owned root file', { overlay: true, root: true, owned: true }, 'overlay']
]) {
  test(`writer and every reader agree on STRUCTURE ownership: ${label}`, () => {
    const dir = ownershipProject(layout);
    try {
      const writerTarget = structureState.resolveStructurePath(dir);
      const writer = writerTarget === path.join(dir, 'STRUCTURE.json') ? 'root' : 'overlay';
      const readers = readersSee(dir);
      if (expected === 'none') {
        assert.equal(writer, 'overlay', 'the writer creates the overlay, never touches the user file');
        assert.deepEqual(readers, { find: 'none', freshness: 'none', hint: 'none' });
      } else {
        assert.equal(writer, expected);
        assert.deepEqual(readers, { find: expected, freshness: expected, hint: expected });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('the parser leaves an unrelated root STRUCTURE.json alone and writes the overlay', () => {
  const dir = ownershipProject({ root: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), '// A\n');
  const before = fs.readFileSync(path.join(dir, 'STRUCTURE.json'), 'utf8');
  try {
    const result = spawnSync('node', [path.join(SCRIPTS, 'update-structure.js')], { encoding: 'utf8', env: { ...process.env, FRAME_PROJECT_ROOT: dir } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'STRUCTURE.json'), 'utf8'), before);
    const map = JSON.parse(fs.readFileSync(path.join(dir, '.frame', 'STRUCTURE.json'), 'utf8'));
    assert.ok(map.modules.a);
    // the user's file is ordinary project content in the inventory
    assert.ok(Object.values(map.modules).some((m) => m.file === 'STRUCTURE.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readers report partial, unverified and non-replacing scans; a missing attempt record is silent', () => {
  const dir = ownershipProject({ overlay: true });
  const env = { ...process.env, FRAME_PROJECT_ROOT: dir };
  const freshness = () => JSON.parse(spawnSync('node', [path.join(SCRIPTS, 'check-freshness.js'), '--json'], { encoding: 'utf8', env }).stdout)
    .findings.filter((f) => f.check === 'structure-generation').map((f) => f.message);
  const find = () => spawnSync('node', [path.join(SCRIPTS, 'find-module.js'), 'widget'], { encoding: 'utf8', env }).stdout;
  const setMap = (generation) => {
    const file = path.join(dir, '.frame', 'STRUCTURE.json');
    const map = JSON.parse(fs.readFileSync(file, 'utf8'));
    map.generation = generation;
    fs.writeFileSync(file, JSON.stringify(map));
  };
  try {
    assert.deepEqual(freshness(), [], 'no generation block and no attempt record → nothing to report');

    setMap({ inventory: { coverage: 'partial', reasons: ['limit-maxFiles'] } });
    assert.match(freshness()[0], /covers only part of the project \(limit-maxFiles\).*--full/);
    assert.match(find(), /covers only part of the project/);

    setMap({ inventory: { coverage: 'unknown', reasons: ['no-baseline'] } });
    assert.match(freshness()[0], /not been verified by a full scan/);

    setMap({ inventory: { coverage: 'unknown', reasons: ['delta'] } });
    assert.deepEqual(freshness(), [], 'an ordinary partial update is not a warning');

    fs.mkdirSync(path.join(dir, '.frame', 'runtime', 'structure'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.frame', 'runtime', 'structure', 'scan.json'), JSON.stringify({ state: 'partial', retainedPrevious: true, reason: 'incomplete-inventory' }));
    assert.match(freshness()[0], /earlier scan — the latest one was incomplete/);

    fs.writeFileSync(path.join(dir, '.frame', 'runtime', 'structure', 'scan.json'), JSON.stringify({ state: 'interrupted', published: true, acknowledged: false }));
    assert.match(freshness()[0], /interrupted right after publishing/);

    // readers never repair: the map is byte-identical afterwards
    const before = fs.readFileSync(path.join(dir, '.frame', 'STRUCTURE.json'), 'utf8');
    find();
    freshness();
    assert.equal(fs.readFileSync(path.join(dir, '.frame', 'STRUCTURE.json'), 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- the pre-commit hook: the commit's map comes from the index (STR-02b) ---------- */

const stagedMap = (dir) => {
  const r = spawnSync('git', ['show', ':.frame/STRUCTURE.json'], { cwd: dir, encoding: 'utf8' });
  return r.status === 0 ? JSON.parse(r.stdout) : null;
};

test('the hook snippet runs --staged, never runs git add, and stays non-blocking', () => {
  const { getStructureHookSnippet } = require('../src/shared/frameTemplates');
  const snippet = getStructureHookSnippet();
  assert.match(snippet, /node "\$FRAME_PARSER" --staged \|\| true/);
  assert.ok(!/--full|--changed/.test(snippet), 'no full scan and no working-tree update in a commit hook');
  assert.ok(!/git add/.test(snippet), 'the working map is never staged');
});

test('hook commit → no-op commit: the commit map follows the index, the working map is left alone', () => {
  const { getStructureHookSnippet } = require('../src/shared/frameTemplates');
  const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-hook-staged-'));
  try {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), '// A\n');
    fs.writeFileSync(path.join(dir, 'src', 'b.js'), '// B\n');
    fs.writeFileSync(path.join(dir, 'app', 'user.rb'), 'class User; end\n');
    fs.writeFileSync(path.join(dir, 'README.md'), '# Readme\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'init']);
    structureBootstrap.copyParserScripts(dir);
    const hookFile = path.join(dir, '.git', 'run-hook.sh');
    fs.writeFileSync(hookFile, `#!/bin/sh\n${getStructureHookSnippet()}\nexit 0\n`, { mode: 0o755 });

    // the working map (agents' view) exists and must not change
    spawnSync('node', [path.join(dir, '.frame', 'bin', 'update-structure.js')], { cwd: dir, env: { ...process.env, FRAME_PROJECT_ROOT: undefined } });
    const mapFile = path.join(dir, '.frame', 'STRUCTURE.json');
    const working = fs.readFileSync(mapFile, 'utf8');

    fs.writeFileSync(path.join(dir, 'src', 'a.js'), '// A changed\n');
    git(dir, ['add', 'src/a.js']);
    const hook = spawnSync('sh', [hookFile], { cwd: dir, encoding: 'utf8' });
    assert.equal(hook.status, 0, hook.stderr);
    const staged = git(dir, ['diff', '--cached', '--name-only']).stdout.split('\n').filter(Boolean).sort();
    assert.deepEqual(staged, ['.frame/STRUCTURE.json', 'src/a.js'], 'no runtime, recovery or source files beyond the commit');
    const commitMap = stagedMap(dir);
    assert.equal(commitMap.modules.a.description, 'A changed');
    assert.deepEqual(Object.keys(commitMap.modules).sort(), ['README', 'a', 'app/user.rb', 'b']);
    assert.equal(fs.readFileSync(mapFile, 'utf8'), working, 'the working map is untouched');

    git(dir, ['commit', '-q', '-m', 'change']);
    const blob = git(dir, ['rev-parse', ':.frame/STRUCTURE.json']).stdout;
    const noop = spawnSync('sh', [hookFile], { cwd: dir, encoding: 'utf8' });
    assert.equal(noop.status, 0, noop.stderr);
    assert.equal(git(dir, ['rev-parse', ':.frame/STRUCTURE.json']).stdout, blob, 'a no-op hook run stages nothing new');
    assert.deepEqual(git(dir, ['diff', '--cached', '--name-only']).stdout.trim(), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a new hook with an older .frame/bin stays non-blocking and stages nothing', () => {
  const { getStructureHookSnippet } = require('../src/shared/frameTemplates');
  const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-hook-old-bin-'));
  try {
    git(dir, ['init', '-q']);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.frame', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), '// A\n');
    // a parser generation that does not know --staged
    fs.writeFileSync(path.join(dir, '.frame', 'bin', 'update-structure.js'), 'console.error("unknown option"); process.exit(2);\n');
    git(dir, ['add', 'src/a.js']);
    const hookFile = path.join(dir, '.git', 'run-hook.sh');
    fs.writeFileSync(hookFile, `#!/bin/sh\n${getStructureHookSnippet()}\nexit 0\n`, { mode: 0o755 });
    const hook = spawnSync('sh', [hookFile], { cwd: dir, encoding: 'utf8' });
    assert.equal(hook.status, 0);
    assert.deepEqual(git(dir, ['diff', '--cached', '--name-only']).stdout.trim().split('\n'), ['src/a.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a linked worktree borrowing the main parser stages its own commit map and leaves the main checkout alone', () => {
  const { getStructureHookSnippet } = require('../src/shared/frameTemplates');
  const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-wt-main-'));
  const worktreeDir = path.join(os.tmpdir(), `frame-wt-linked-${process.pid}-${Date.now()}`);
  try {
    git(mainDir, ['init', '-q']);
    git(mainDir, ['config', 'user.email', 'test@example.com']);
    git(mainDir, ['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(mainDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(mainDir, 'src', 'mainOnly.js'), '// Main\n');
    git(mainDir, ['add', '.']);
    git(mainDir, ['commit', '-q', '-m', 'init']);
    structureBootstrap.copyParserScripts(mainDir);
    fs.writeFileSync(path.join(mainDir, '.frame', 'bin', 'intent-map.json'), JSON.stringify({ widgets: { modules: ['gadget'] } }));
    spawnSync('node', [path.join(mainDir, '.frame', 'bin', 'update-structure.js')], { cwd: mainDir, env: { ...process.env, FRAME_PROJECT_ROOT: undefined } });
    const mainMap = fs.readFileSync(path.join(mainDir, '.frame', 'STRUCTURE.json'), 'utf8');
    const mainIndex = git(mainDir, ['ls-files', '-s']).stdout;

    git(mainDir, ['worktree', 'add', '-q', '-b', 'wt', worktreeDir]);
    fs.writeFileSync(path.join(worktreeDir, 'src', 'gadget.js'), '// Gadget\n');
    git(worktreeDir, ['add', 'src/gadget.js']);
    const hookFile = path.join(worktreeDir, 'run-hook.sh');
    fs.writeFileSync(hookFile, `#!/bin/sh\n${getStructureHookSnippet()}\nexit 0\n`, { mode: 0o755 });
    const result = spawnSync('sh', [hookFile], { cwd: worktreeDir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    const wtMap = stagedMap(worktreeDir);
    assert.ok(wtMap.modules.gadget, 'the worktree commit map describes the worktree');
    // curation is looked up beside the borrowed parser, as before
    assert.deepEqual(wtMap.intentIndex.widgets.map((e) => e.file), ['src/gadget.js']);
    assert.ok(fs.existsSync(path.join(worktreeDir, '.frame', 'runtime', 'structure', 'commit.json')), 'the receipt belongs to the worktree');
    assert.equal(fs.readFileSync(path.join(mainDir, '.frame', 'STRUCTURE.json'), 'utf8'), mainMap, 'main map untouched');
    assert.equal(git(mainDir, ['ls-files', '-s']).stdout, mainIndex, 'main index untouched');
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: mainDir });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    fs.rmSync(mainDir, { recursive: true, force: true });
  }
});

/* ---------------- STR-02: readers on the freshness contract ---------------- */

const lifecycleScript = path.join(SCRIPTS, 'structure-lifecycle.js');
const { readDescriptor } = require('../scripts/structure-read');

function lifecycleState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.frame', 'runtime', 'structure', 'lifecycle.json'), 'utf8'));
}

test('readers report the lifecycle freshness and skip the date heuristic once it is known', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-fresh-readers-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.frame'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'widgetMaker.js'), '// Widget maker\n');
  fs.writeFileSync(path.join(dir, 'src', 'widgetStore.js'), '// Widget store\n');
  const env = { ...process.env, FRAME_PROJECT_ROOT: dir };
  const find = () => spawnSync('node', [path.join(SCRIPTS, 'find-module.js'), 'widget'], { encoding: 'utf8', env }).stdout;
  const findings = () => JSON.parse(spawnSync('node', [path.join(SCRIPTS, 'check-freshness.js'), '--json'], { encoding: 'utf8', env }).stdout)
    .findings.filter((f) => f.check.startsWith('structure-')).map((f) => `${f.check}: ${f.message}`);
  try {
    assert.equal(spawnSync('node', [lifecycleScript, '--once'], { env }).status, 0);
    assert.match(find(), /^Map: fresh · working tree/);
    assert.deepEqual(findings(), []);

    const state = lifecycleState(dir);
    state.epoch = { requested: 5, applied: 4 };
    state.dirty = ['file-event'];
    state.missedBound = { reason: 'changing-files', at: new Date().toISOString() };
    fs.writeFileSync(path.join(dir, '.frame', 'runtime', 'structure', 'lifecycle.json'), JSON.stringify(state));
    assert.match(find(), /^⚠ Map: dirty \(file-event\)/);
    assert.deepEqual(findings(), [
      'structure-freshness: STRUCTURE.json is dirty (file-event) — changes are waiting to be applied',
      'structure-freshness: the last STRUCTURE update missed its time bound (changing-files)'
    ]);

    state.dirty = [];
    state.epoch = { requested: 5, applied: 5 };
    state.missedBound = null;
    state.receipt.observedAt = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(path.join(dir, '.frame', 'runtime', 'structure', 'lifecycle.json'), JSON.stringify(state));
    assert.match(find(), /^⚠ Map: stale \(lease-expired\) — run: node .*structure-lifecycle\.js --once/);
    assert.match(findings()[0], /is stale \(lease-expired\)/);

    // STR-02c: readers use the working view; prose edited in the tracked map
    // does not change what the receipt vouches for.
    const mapFile = path.join(dir, '.frame', 'STRUCTURE.json');
    fs.writeFileSync(mapFile, fs.readFileSync(mapFile, 'utf8').replace('Widget maker', 'Edited by hand'));
    assert.match(find(), /^⚠ Map: stale \(lease-expired\)/);

    // Without a working view there is nothing live to vouch for: unknown, said
    // as such (STR-03 D13: no Git date heuristic in a lookup), not an alarm.
    fs.rmSync(path.join(dir, '.frame', 'runtime', 'structure', 'working.json'));
    assert.match(find(), /^⚠ Map: unverified \(no-working-view\)/);
    assert.deepEqual(findings().filter((f) => f.startsWith('structure-freshness')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a linked worktree keeps its own map, receipt and lease when it borrows the main parser', () => {
  const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-life-main-'));
  const worktreeDir = path.join(os.tmpdir(), `frame-life-wt-${process.pid}-${Date.now()}`);
  try {
    git(mainDir, ['init', '-q']);
    git(mainDir, ['config', 'user.email', 'test@example.com']);
    git(mainDir, ['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(mainDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(mainDir, 'src', 'mainOnly.js'), '// Main\n');
    fs.writeFileSync(path.join(mainDir, '.gitignore'), '.frame/\n');
    git(mainDir, ['add', '.']);
    git(mainDir, ['commit', '-q', '-m', 'init']);
    structureBootstrap.copyParserScripts(mainDir);
    const mainBin = path.join(mainDir, '.frame', 'bin', 'structure-lifecycle.js');
    assert.equal(spawnSync('node', [mainBin, '--once'], { env: { ...process.env, FRAME_PROJECT_ROOT: undefined } }).status, 0);
    const mainState = fs.readFileSync(path.join(mainDir, '.frame', 'runtime', 'structure', 'lifecycle.json'), 'utf8');

    git(mainDir, ['worktree', 'add', '-q', '-b', 'wt', worktreeDir]);
    fs.writeFileSync(path.join(worktreeDir, 'src', 'worktreeOnly.js'), '// Worktree\n');
    assert.equal(spawnSync('node', [mainBin, '--once'], { env: { ...process.env, FRAME_PROJECT_ROOT: worktreeDir } }).status, 0);

    const wtMap = JSON.parse(fs.readFileSync(path.join(worktreeDir, '.frame', 'STRUCTURE.json'), 'utf8'));
    assert.ok(wtMap.modules.worktreeOnly);
    assert.equal(readDescriptor(worktreeDir).freshness, 'fresh');
    assert.equal(lifecycleState(worktreeDir).checkout, fs.realpathSync(worktreeDir));
    assert.equal(fs.readFileSync(path.join(mainDir, '.frame', 'runtime', 'structure', 'lifecycle.json'), 'utf8'), mainState, 'main receipt untouched');
    assert.ok(!JSON.parse(fs.readFileSync(path.join(mainDir, '.frame', 'STRUCTURE.json'), 'utf8')).modules.worktreeOnly);
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: mainDir });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    fs.rmSync(mainDir, { recursive: true, force: true });
  }
});

/* ---------------- STR-02b: the leak, end to end through git commit ---------------- */

test('git commit with Frame\'s hook: untracked and unstaged content never reach the committed map', async () => {
  const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-leak-'));
  try {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), '// A\n');
    fs.writeFileSync(path.join(dir, 'src', 'b.js'), '// B\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'init']);
    structureBootstrap.copyParserScripts(dir);
    assert.equal((await structureBootstrap.installPreCommitHook(dir)).status, 'installed');

    // the agents' working view knows about untracked work
    fs.writeFileSync(path.join(dir, 'private-notes.md'), '# My private salary notes\n');
    assert.equal(spawnSync('node', [path.join(dir, '.frame', 'bin', 'structure-lifecycle.js'), '--once'], { cwd: dir }).status, 0);
    const workingMap = fs.readFileSync(path.join(dir, '.frame', 'STRUCTURE.json'), 'utf8');
    assert.match(workingMap, /private salary/);

    fs.writeFileSync(path.join(dir, 'src', 'a.js'), '// A staged\n');
    git(dir, ['add', 'src/a.js']);
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), '// UNSTAGED_SENTINEL\n');
    const commit = git(dir, ['commit', '-q', '-m', 'change a']);
    assert.equal(commit.status, 0, commit.stderr);
    const committed = git(dir, ['show', 'HEAD:.frame/STRUCTURE.json']).stdout;
    assert.ok(!/private|salary|UNSTAGED_SENTINEL/.test(committed), 'nothing untracked or unstaged in the commit');
    assert.equal(JSON.parse(committed).modules.a.description, 'A staged');
    assert.equal(fs.readFileSync(path.join(dir, '.frame', 'STRUCTURE.json'), 'utf8'), workingMap, 'the working view is untouched');

    // a pathspec commit uses Git's temporary index
    fs.writeFileSync(path.join(dir, 'src', 'b.js'), '// B via pathspec\n');
    const partial = git(dir, ['commit', '-q', '-m', 'only b', '--', 'src/b.js']);
    assert.equal(partial.status, 0, partial.stderr);
    const second = JSON.parse(git(dir, ['show', 'HEAD:.frame/STRUCTURE.json']).stdout);
    assert.equal(second.modules.b.description, 'B via pathspec');
    assert.equal(second.modules.a.description, 'A staged', 'the unstaged sentinel stayed out');
    assert.ok(!Object.values(second.modules).some((m) => m.file === 'private-notes.md'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('check-freshness accepts old --changed snippets and reports commits that kept an old map', () => {
  const oldSnippet = [
    '# >>> frame:structure (managed) >>>',
    'FRAME_PROJECT_ROOT="$FRAME_ROOT" node "$FRAME_PARSER" --changed || true',
    'git add "$FRAME_ROOT/.frame/STRUCTURE.json" || true',
    '# <<< frame:structure (managed) <<<'
  ].join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-commit-findings-'));
  const env = { ...process.env, FRAME_PROJECT_ROOT: dir };
  const findings = () => JSON.parse(spawnSync('node', [path.join(SCRIPTS, 'check-freshness.js'), '--json'], { encoding: 'utf8', env, cwd: dir }).stdout)
    .findings.filter((f) => f.check === 'structure-commit').map((f) => f.message);
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    // STR-02c D7: `--changed` stages the index-built map, so an old snippet is fine
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n${oldSnippet}\n`);
    fs.writeFileSync(path.join(dir, 'lefthook.yml'), 'pre-commit:\n  commands:\n    s:\n      run: node .frame/bin/update-structure.js --changed && git add .frame/STRUCTURE.json\n');
    assert.deepEqual(findings(), []);

    fs.mkdirSync(path.join(dir, '.frame', 'runtime', 'structure'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.frame', 'runtime', 'structure', 'commit.json'), JSON.stringify({ status: 'aborted', reason: 'index-locked' }));
    assert.deepEqual(findings(), ["the last commit's STRUCTURE.json was not staged (aborted: index-locked) — that commit kept the previous map"]);
    fs.writeFileSync(path.join(dir, '.frame', 'runtime', 'structure', 'commit.json'), JSON.stringify({ status: 'published' }));
    assert.deepEqual(findings(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------- STR-02c: the tracked map is the committed view; Git never refuses ------- */

function frameRepo(prefix) {
  const { getStructurePreCommitHookTemplate } = require('../src/shared/frameTemplates');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (args, cwd = dir) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), '// A\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), '// B\n');
  structureBootstrap.copyParserScripts(dir);
  fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), getStructurePreCommitHookTemplate(), { mode: 0o755 });
  const env = { ...process.env, FRAME_PROJECT_ROOT: undefined };
  const worker = () => {
    const r = spawnSync('node', [path.join(dir, '.frame', 'bin', 'structure-lifecycle.js'), '--once'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const mapStatus = () => git(['status', '--porcelain', '--', '.frame/STRUCTURE.json']).stdout;
  const working = () => JSON.parse(fs.readFileSync(path.join(dir, '.frame', 'runtime', 'structure', 'working.json'), 'utf8'));
  worker();
  git(['add', '-A']);
  const init = git(['commit', '-q', '-m', 'init']);
  assert.equal(init.status, 0, init.stderr);
  return { dir, git, worker, mapStatus, working };
}

test('live work never blocks checkout, switch or pull; a normal commit leaves the map clean', () => {
  const r = frameRepo('frame-02c-switch-');
  const clone = `${r.dir}-clone`;
  try {
    assert.equal(r.mapStatus(), '', 'clean after the first commit');

    // a branch whose committed map differs
    assert.equal(r.git(['switch', '-q', '-c', 'feature']).status, 0);
    fs.writeFileSync(path.join(r.dir, 'src', 'c.js'), '// C on feature\n');
    r.git(['add', 'src/c.js']);
    assert.equal(r.git(['commit', '-q', '-m', 'c']).status, 0);
    assert.equal(r.mapStatus(), '', 'the hook mirrored the commit map');
    assert.equal(JSON.parse(r.git(['show', 'HEAD:.frame/STRUCTURE.json']).stdout).modules.c.description, 'C on feature');

    // untracked and unstaged work lands in the working view only
    fs.writeFileSync(path.join(r.dir, 'scratch.js'), '// Scratch\n');
    fs.writeFileSync(path.join(r.dir, 'src', 'b.js'), '// B unstaged\n');
    r.worker();
    assert.ok(r.working().modules.scratch);
    assert.equal(r.working().modules.b.description, 'B unstaged');
    assert.equal(r.mapStatus(), '');

    const sw = r.git(['switch', '-q', 'main']);
    assert.equal(sw.status, 0, sw.stderr);
    r.worker();
    assert.ok(!r.working().modules.c);
    const co = r.git(['checkout', '-q', 'feature']);
    assert.equal(co.status, 0, co.stderr);
    r.worker();
    assert.ok(r.working().modules.c);

    // a pull that changes the committed map
    assert.equal(r.git(['stash', '-q']).status, 0);
    assert.equal(r.git(['clone', '-q', '-b', 'feature', r.dir, clone], os.tmpdir()).status, 0);
    r.git(['config', 'user.email', 'test@example.com'], clone);
    r.git(['config', 'user.name', 'Test'], clone);
    fs.writeFileSync(path.join(clone, 'src', 'd.js'), '// D upstream\n');
    r.git(['add', 'src/d.js'], clone);
    spawnSync('node', [path.join(r.dir, '.frame', 'bin', 'update-structure.js'), '--staged'], { cwd: clone, env: { ...process.env, FRAME_PROJECT_ROOT: clone } });
    assert.equal(r.git(['commit', '-q', '--no-verify', '-m', 'd'], clone).status, 0);
    assert.equal(r.git(['stash', 'pop', '-q']).status, 0);
    r.worker();
    const pull = r.git(['pull', '-q', '--ff-only', clone, 'feature']);
    assert.equal(pull.status, 0, pull.stderr);
    assert.equal(r.mapStatus(), '');
    r.worker();
    assert.ok(r.working().modules.d);
    assert.ok(r.working().modules.scratch, 'untracked work is still in the working view');
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
  }
});

test('a pathspec commit leaves the index behind HEAD until the worker repairs it', () => {
  const r = frameRepo('frame-02c-pathspec-');
  try {
    fs.writeFileSync(path.join(r.dir, 'src', 'a.js'), '// A via pathspec\n');
    const commit = r.git(['commit', '-q', '-m', 'a only', '--', 'src/a.js']);
    assert.equal(commit.status, 0, commit.stderr);
    const head = r.git(['rev-parse', 'HEAD:.frame/STRUCTURE.json']).stdout;
    assert.equal(JSON.parse(r.git(['show', 'HEAD:.frame/STRUCTURE.json']).stdout).modules.a.description, 'A via pathspec');
    assert.notEqual(r.git(['rev-parse', ':.frame/STRUCTURE.json']).stdout, head, 'the real index kept the old entry');

    r.worker();
    assert.equal(r.git(['rev-parse', ':.frame/STRUCTURE.json']).stdout, head);
    assert.equal(r.mapStatus(), '');

    // a deliberately staged map is never reverted
    const file = path.join(r.dir, '.frame', 'STRUCTURE.json');
    const map = JSON.parse(fs.readFileSync(file, 'utf8'));
    map.modules.b.description = 'Staged prose';
    fs.writeFileSync(file, JSON.stringify(map, null, 2) + '\n');
    r.git(['add', '.frame/STRUCTURE.json']);
    r.worker();
    assert.equal(r.mapStatus(), 'M  .frame/STRUCTURE.json\n');
    assert.equal(r.working().modules.b.description, 'Staged prose', 'prose from the tracked file reaches the working view');
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('an old --changed + git add snippet commits the index-built map', () => {
  const r = frameRepo('frame-02c-old-snippet-');
  try {
    fs.writeFileSync(path.join(r.dir, '.git', 'hooks', 'pre-commit'), [
      '#!/bin/sh',
      '# >>> frame:structure (managed) >>>',
      'FRAME_ROOT="$(git rev-parse --show-toplevel)"',
      'FRAME_PROJECT_ROOT="$FRAME_ROOT" node "$FRAME_ROOT/.frame/bin/update-structure.js" --changed || true',
      'git add "$FRAME_ROOT/.frame/STRUCTURE.json" || true',
      '# <<< frame:structure (managed) <<<',
      ''
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(r.dir, 'private-notes.md'), '# Private\n');
    fs.writeFileSync(path.join(r.dir, 'src', 'b.js'), '// B staged\n');
    r.git(['add', 'src/b.js']);
    r.worker();
    const commit = r.git(['commit', '-q', '-m', 'b']);
    assert.equal(commit.status, 0, commit.stderr);
    const committed = JSON.parse(r.git(['show', 'HEAD:.frame/STRUCTURE.json']).stdout);
    assert.equal(committed.modules.b.description, 'B staged');
    assert.ok(!Object.values(committed.modules).some((m) => m.file === 'private-notes.md'), 'untracked files stay out');
    assert.equal(r.mapStatus(), '');
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('upgrade: a generated-only difference is archived and restored; hand edits are kept and reported', () => {
  const r = frameRepo('frame-02c-upgrade-');
  const mapFile = path.join(r.dir, '.frame', 'STRUCTURE.json');
  const env = { ...process.env, FRAME_PROJECT_ROOT: r.dir };
  const findings = () => JSON.parse(spawnSync('node', [path.join(SCRIPTS, 'check-freshness.js'), '--json'], { encoding: 'utf8', env, cwd: r.dir }).stdout)
    .findings.filter((f) => f.check === 'structure-commit').map((f) => f.message);
  try {
    const committed = fs.readFileSync(mapFile, 'utf8');
    // what STR-02b left behind: the working-tree view in the tracked file
    fs.writeFileSync(path.join(r.dir, 'scratch.js'), '// Scratch\n');
    r.worker();
    const oldWorkingMap = fs.readFileSync(path.join(r.dir, '.frame', 'runtime', 'structure', 'working.json'));
    fs.writeFileSync(mapFile, oldWorkingMap);
    assert.equal(r.mapStatus(), ' M .frame/STRUCTURE.json\n');

    r.worker();
    assert.equal(fs.readFileSync(mapFile, 'utf8'), committed, 'restored to the committed view');
    assert.equal(r.mapStatus(), '');
    const tracked = JSON.parse(fs.readFileSync(path.join(r.dir, '.frame', 'runtime', 'structure', 'tracked.json'), 'utf8'));
    assert.equal(tracked.status, 'restored');
    assert.deepEqual(fs.readFileSync(path.join(r.dir, tracked.recoveryPath)), oldWorkingMap, 'the old bytes are archived');
    assert.deepEqual(findings(), []);

    // the same difference plus a hand-written description: nothing is touched
    const edited = JSON.parse(oldWorkingMap.toString('utf8'));
    edited.modules.a.description = 'Hand-written, not staged';
    const editedText = JSON.stringify(edited, null, 2) + '\n';
    fs.writeFileSync(mapFile, editedText);
    r.worker();
    assert.equal(fs.readFileSync(mapFile, 'utf8'), editedText);
    assert.deepEqual(findings(), ['STRUCTURE.json has unstaged hand edits — commits carry them only once you `git add` the file']);
    assert.equal(r.working().modules.a.description, 'Hand-written, not staged', 'the working view still carries the prose');

    // once staged there is nothing left to report
    r.git(['add', '.frame/STRUCTURE.json']);
    r.worker();
    assert.deepEqual(findings(), []);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('find-module and check-freshness read the live working view before the tracked map', () => {
  const r = frameRepo('frame-02c-readers-');
  const env = { ...process.env, FRAME_PROJECT_ROOT: r.dir };
  const find = (word) => spawnSync('node', [path.join(SCRIPTS, 'find-module.js'), word], { encoding: 'utf8', env }).stdout;
  const phantoms = () => JSON.parse(spawnSync('node', [path.join(SCRIPTS, 'check-freshness.js'), '--json'], { encoding: 'utf8', env, cwd: r.dir }).stdout)
    .findings.filter((f) => f.check === 'phantom-module');
  try {
    fs.writeFileSync(path.join(r.dir, 'src', 'widgetMaker.js'), '// Widget maker\n');
    fs.writeFileSync(path.join(r.dir, 'src', 'widgetStore.js'), '// Widget store\n');
    fs.rmSync(path.join(r.dir, 'src', 'b.js'));
    r.worker();
    const tracked = JSON.parse(fs.readFileSync(path.join(r.dir, '.frame', 'STRUCTURE.json'), 'utf8'));
    assert.ok(tracked.modules.b && !tracked.modules.widgetMaker, 'the tracked map is the committed view');
    const out = find('widget');
    assert.match(out, /^Map: fresh · working tree/);
    assert.match(out, /src\/widgetMaker\.js/);
    assert.deepEqual(phantoms(), [], 'a deleted file is gone from the live view');
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('a copied .frame/bin/ publishes lookup.json without Frame\'s repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-03-bin-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'gadget.js'), '// Gadget\nfunction buildGadget() {}\nmodule.exports = { buildGadget };\n');
    structureBootstrap.copyParserScripts(dir);
    assert.ok(fs.existsSync(path.join(dir, '.frame', 'bin', 'structure-retrieval.js')));
    const env = { ...process.env, FRAME_PROJECT_ROOT: undefined };
    const run = spawnSync('node', [path.join(dir, '.frame', 'bin', 'structure-lifecycle.js'), '--once'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const index = JSON.parse(fs.readFileSync(path.join(dir, '.frame', 'runtime', 'structure', 'lookup.json'), 'utf8'));
    assert.ok(index.terms['5:buildgadget']);
    assert.ok(index.curation.signature, 'built with the copied intent-map.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
