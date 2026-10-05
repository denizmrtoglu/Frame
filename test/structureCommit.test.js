/**
 * structure-commit tests (STR-02b): the map a commit carries is built from
 * the staged snapshot — never from unstaged edits, untracked files or
 * unstaged settings — and published into the index only. Every case runs
 * against a real temporary Git repository.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const commit = require('../scripts/structure-commit');
const lifecycle = require('../scripts/structure-lifecycle');

function repo(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-commit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    return r;
  };
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  write(dir, files);
  return { dir, git };
}

function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

const filesOf = (structure) => Object.values(structure.modules).map((m) => m.file).sort();
const entryOf = (structure, file) => Object.values(structure.modules).find((m) => m.file === file);

/* ---------------------------- staged snapshot ---------------------------- */

test('partial staging: the commit map describes staged content only', (t) => {
  const { dir, git } = repo(t, { 'src/a.js': '// Original\n', 'src/b.js': '// B\n' });
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  write(dir, { 'src/a.js': '// Staged description\n' });
  git('add', 'src/a.js');
  write(dir, {
    'src/a.js': '// UNSTAGED_SENTINEL\n',
    'private-notes.md': '# My private salary notes\n',
    'src/new-untracked.js': '// not added\n'
  });
  // Everything outside Frame's gitignored runtime directory (the shared
  // extraction cache lives there).
  const outsideRuntime = () => {
    const out = [];
    const walk = (d) => {
      for (const name of fs.readdirSync(d).sort()) {
        const abs = path.join(d, name);
        const rel = path.relative(dir, abs);
        if (rel === '.git' || rel === path.join('.frame', 'runtime')) continue;
        const st = fs.statSync(abs);
        out.push(`${rel}:${st.size}:${st.mtimeMs}`);
        if (st.isDirectory()) walk(abs);
      }
    };
    walk(dir);
    return out.filter((line) => !line.startsWith('.frame:'));
  };
  const before = outsideRuntime();

  const built = commit.buildStaged(dir);
  assert.deepEqual(filesOf(built.structure), ['src/a.js', 'src/b.js']);
  assert.equal(entryOf(built.structure, 'src/a.js').description, 'Staged description');
  assert.ok(!built.candidate.includes('UNSTAGED_SENTINEL'));
  assert.ok(!built.candidate.includes('private'));
  assert.ok(!built.candidate.includes('new-untracked'));
  assert.deepEqual(outsideRuntime(), before, 'building writes nothing into the working tree or its map');
  assert.equal(built.mapPath, '.frame/STRUCTURE.json');
});

test('the staged map is the prior: its authored prose survives, unstaged prose does not', (t) => {
  const { dir, git } = repo(t, { 'src/a.js': '// Generated\n' });
  const staged = { version: '1.1', modules: { a: { file: 'src/a.js', description: 'Committed hand-written prose', owner: 'team' } } };
  write(dir, { '.frame/STRUCTURE.json': JSON.stringify(staged) });
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const working = JSON.parse(JSON.stringify(staged));
  working.modules.a.description = 'Unstaged local prose';
  write(dir, { '.frame/STRUCTURE.json': JSON.stringify(working) });

  const built = commit.buildStaged(dir);
  assert.equal(built.structure.modules.a.description, 'Committed hand-written prose');
  assert.equal(built.structure.modules.a.owner, 'team');
  assert.ok(!built.candidate.includes('Unstaged local prose'));
  assert.ok(built.stagedMapId);
});

test('a repository without HEAD builds from the index alone', (t) => {
  const { dir, git } = repo(t, { 'src/first.js': '// First\n' });
  git('add', '-A');
  const built = commit.buildStaged(dir);
  assert.deepEqual(filesOf(built.structure), ['src/first.js']);
  assert.equal(built.structure.generation.inventory.coverage, 'complete');
});

test('an unmerged index makes the snapshot unavailable', (t) => {
  const { dir, git } = repo(t, { 'a.txt': 'base\n' });
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'other');
  write(dir, { 'a.txt': 'theirs\n' });
  git('commit', '-q', '-am', 'theirs');
  git('checkout', '-q', '-');
  write(dir, { 'a.txt': 'ours\n' });
  git('commit', '-q', '-am', 'ours');
  git('merge', 'other');
  assert.throws(() => commit.buildStaged(dir), (err) => err instanceof commit.CommitUnavailable && err.reason === 'unmerged');
});

test('policy comes from the staged config, or defaults when none is staged', (t) => {
  const { dir, git } = repo(t, { 'src/a.js': '// A\n', 'src/secret.js': '// S\n' });
  git('add', 'src');
  write(dir, { '.frame/config.json': JSON.stringify({ project: { structure: { exclude: ['src/secret.js'] } } }) });

  const unstaged = commit.buildStaged(dir);
  assert.equal(unstaged.policyFallback, true);
  assert.deepEqual(filesOf(unstaged.structure), ['src/a.js', 'src/secret.js'], 'unstaged settings never shape a commit');

  git('add', '.frame/config.json');
  const staged = commit.buildStaged(dir);
  assert.equal(staged.policyFallback, false);
  assert.deepEqual(filesOf(staged.structure), ['src/a.js']);
});

test('curation is read from the working copy beside the parser', (t) => {
  const { dir, git } = repo(t, { 'src/payments/charge.js': '// Charge\n', 'src/payments/refund.js': '// Refund\n' });
  git('add', '-A');
  const curationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-commit-curation-'));
  t.after(() => fs.rmSync(curationDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(curationDir, 'intent-map.json'), JSON.stringify({ billing: { modules: ['payments/charge', 'payments/refund', 'payments/untracked'] } }));
  write(dir, { 'src/payments/untracked.js': '// not in the commit\n' });

  const built = commit.buildStaged(dir, { curationDir });
  assert.deepEqual(built.structure.intentIndex.billing.map((e) => e.file), ['src/payments/charge.js', 'src/payments/refund.js']);
});

test('extraction already done for the working tree is reused for identical staged content', (t) => {
  const { dir, git } = repo(t, { '.frame/.keep': '', 'src/a.js': '// A\nfunction f() {}\nmodule.exports = { f };\n', 'src/b.py': '"""B."""\n' });
  git('add', '-A');
  assert.equal(lifecycle.reconcile(dir, { fullHash: true }).status, 'published');
  const built = commit.buildStaged(dir);
  assert.equal(built.cacheHits, 2);
});

test('symlinks and submodules in the index follow the shared policy', (t) => {
  const { dir, git } = repo(t, { 'src/a.js': '// A\n' });
  fs.symlinkSync('src/a.js', path.join(dir, 'link.js'));
  git('add', '-A');
  git('update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},deps/sub`);
  const built = commit.buildStaged(dir);
  assert.deepEqual(filesOf(built.structure), ['src/a.js']);
  assert.equal(built.structure.generation.counts.symlinks, 1);
  assert.equal(built.structure.generation.counts.specialFiles, 1);
});

/* ------------------------------ publication ------------------------------ */

const lsFiles = (git, env) => spawnSync('git', ['ls-files', '-s'], { cwd: git.dir, encoding: 'utf8', env: env || process.env }).stdout.trim().split('\n');

function committedRepo(t) {
  const r = repo(t, { 'src/a.js': '// A\n', 'src/b.js': '// B\n', 'bin/tool.sh': '#!/bin/sh\n' });
  fs.chmodSync(path.join(r.dir, 'bin', 'tool.sh'), 0o755);
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'init');
  return r;
}

test('publishing changes only the map entry and mirrors it to the tracked file', (t) => {
  const { dir, git } = committedRepo(t);
  write(dir, { 'src/a.js': '// Staged\n' });
  git('add', 'src/a.js');
  write(dir, { 'untracked.md': '# Private\n' });
  const before = lsFiles({ dir });

  const result = commit.publishStaged(dir);
  assert.equal(result.status, 'published', JSON.stringify(result));
  const after = lsFiles({ dir });
  const changed = after.filter((line) => !before.includes(line));
  assert.equal(changed.length, 1);
  assert.match(changed[0], /^100644 [0-9a-f]{40} 0\t\.frame\/STRUCTURE\.json$/);
  assert.deepEqual(after.filter((l) => !l.endsWith('.frame/STRUCTURE.json')), before, 'every other entry, mode and stage unchanged');
  const staged = spawnSync('git', ['show', ':.frame/STRUCTURE.json'], { cwd: dir, encoding: 'utf8' }).stdout;
  assert.equal(result.mirror, 'written');
  assert.equal(fs.readFileSync(path.join(dir, '.frame', 'STRUCTURE.json'), 'utf8'), staged, 'the tracked file holds the commit map');
  assert.ok(!staged.includes('untracked') && !staged.includes('Private'));
  assert.equal(JSON.parse(staged).modules.a.description, 'Staged');

  const receipt = JSON.parse(fs.readFileSync(commit.receiptPath(dir), 'utf8'));
  assert.equal(receipt.status, 'published');
  assert.equal(receipt.blob, result.blob);
  assert.equal(receipt.mapPath, '.frame/STRUCTURE.json');

  assert.equal(commit.publishStaged(dir).status, 'unchanged', 'a second run is a no-op');
});

test('an index changed while building is left alone', (t) => {
  const { dir, git } = committedRepo(t);
  write(dir, { 'src/a.js': '// Staged\n', 'src/c.js': '// C\n' });
  git('add', 'src/a.js');
  const result = commit.publishStaged(dir, { hooks: { beforePublish: () => git('add', 'src/c.js') } });
  assert.equal(result.status, 'aborted');
  assert.equal(result.reason, 'index-changed');
  assert.equal(spawnSync('git', ['ls-files', '-s', '.frame/STRUCTURE.json'], { cwd: dir, encoding: 'utf8' }).stdout, '');
});

test('a held index lock aborts without writing', (t) => {
  const { dir, git } = committedRepo(t);
  write(dir, { 'src/a.js': '// Staged\n' });
  git('add', 'src/a.js');
  const lock = path.join(dir, '.git', 'index.lock');
  const result = commit.publishStaged(dir, { hooks: { beforePublish: () => fs.writeFileSync(lock, '') } });
  fs.rmSync(lock, { force: true });
  assert.equal(result.status, 'aborted');
  assert.equal(result.reason, 'index-locked');
});

test('a map that is not shared with the repository is never force-added', (t) => {
  for (const setup of [
    (dir) => fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '/.frame/\n'), // local sharing mode
    (dir) => write(dir, { '.gitignore': '.frame/\n' })
  ]) {
    const { dir, git } = committedRepo(t);
    setup(dir);
    write(dir, { 'src/a.js': '// Staged\n' });
    git('add', 'src/a.js');
    const result = commit.publishStaged(dir);
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'map-not-shared');
    assert.equal(spawnSync('git', ['ls-files', '.frame'], { cwd: dir, encoding: 'utf8' }).stdout, '');
  }
});

test('an alternate index (GIT_INDEX_FILE) receives the map; the default index does not', (t) => {
  const { dir, git } = committedRepo(t);
  const alt = path.join(dir, '.git', 'alt-index');
  fs.copyFileSync(path.join(dir, '.git', 'index'), alt);
  const env = { ...process.env, GIT_INDEX_FILE: alt };
  write(dir, { 'src/a.js': '// Only in the alternate index\n' });
  spawnSync('git', ['add', 'src/a.js'], { cwd: dir, env });
  const before = lsFiles({ dir });

  const result = commit.publishStaged(dir, { env });
  assert.equal(result.status, 'published');
  const altMap = spawnSync('git', ['show', ':.frame/STRUCTURE.json'], { cwd: dir, encoding: 'utf8', env }).stdout;
  assert.equal(JSON.parse(altMap).modules.a.description, 'Only in the alternate index');
  assert.deepEqual(lsFiles({ dir }), before, 'the default index is untouched');
});

test('a linked worktree publishes into its own index only', (t) => {
  const { dir, git } = committedRepo(t);
  const wt = path.join(os.tmpdir(), `frame-commit-wt-${process.pid}-${Date.now()}`);
  t.after(() => { git('worktree', 'remove', '--force', wt); fs.rmSync(wt, { recursive: true, force: true }); });
  git('worktree', 'add', '-q', '-b', 'wt', wt);
  write(wt, { 'src/wt.js': '// Worktree only\n' });
  spawnSync('git', ['add', 'src/wt.js'], { cwd: wt });
  const mainBefore = lsFiles({ dir });

  const result = commit.publishStaged(wt);
  assert.equal(result.status, 'published');
  const wtMap = JSON.parse(spawnSync('git', ['show', ':.frame/STRUCTURE.json'], { cwd: wt, encoding: 'utf8' }).stdout);
  assert.ok(wtMap.modules.wt);
  assert.deepEqual(lsFiles({ dir }), mainBefore, 'the main checkout index is untouched');
  assert.ok(fs.existsSync(commit.receiptPath(wt)));
  assert.ok(!fs.existsSync(commit.receiptPath(dir)));
});

test('an unavailable snapshot is recorded, not thrown', (t) => {
  const { dir, git } = committedRepo(t);
  git('checkout', '-q', '-b', 'other');
  write(dir, { 'src/a.js': '// theirs\n' });
  git('commit', '-q', '-am', 'theirs');
  git('checkout', '-q', '-');
  write(dir, { 'src/a.js': '// ours\n' });
  git('commit', '-q', '-am', 'ours');
  git('merge', 'other');
  const result = commit.publishStaged(dir);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'unmerged');
  assert.equal(JSON.parse(fs.readFileSync(commit.receiptPath(dir), 'utf8')).status, 'unavailable');
});

/* ------------- STR-02c: mirroring to the tracked file, pathspec repair ------------- */

function trackedMapRepo(t) {
  const r = committedRepo(t);
  assert.equal(commit.publishStaged(r.dir).status, 'published');
  r.git('commit', '-q', '-m', 'map');
  return r;
}

test('unstaged edits in the tracked map are kept, never overwritten', (t) => {
  const { dir, git } = trackedMapRepo(t);
  const file = path.join(dir, '.frame', 'STRUCTURE.json');
  const edited = fs.readFileSync(file, 'utf8').replace('"A"', '"Hand-written, not staged"');
  fs.writeFileSync(file, edited);
  write(dir, { 'src/a.js': '// A2\n' });
  git('add', 'src/a.js');
  const result = commit.publishStaged(dir);
  assert.equal(result.status, 'published');
  assert.equal(result.mirror, 'kept');
  assert.equal(fs.readFileSync(file, 'utf8'), edited);
  assert.equal(JSON.parse(fs.readFileSync(commit.receiptPath(dir), 'utf8')).mirror, 'kept');
});

test('a missing tracked map is restored from the commit map', (t) => {
  const { dir } = trackedMapRepo(t);
  const file = path.join(dir, '.frame', 'STRUCTURE.json');
  const committed = fs.readFileSync(file, 'utf8');
  fs.rmSync(file);
  const result = commit.publishStaged(dir);
  assert.equal(result.status, 'unchanged');
  assert.equal(result.mirror, 'written');
  assert.equal(fs.readFileSync(file, 'utf8'), committed);
});

test('repairPathspecIndex only moves an index entry that lags a disk equal to HEAD', (t) => {
  const { dir, git } = trackedMapRepo(t);
  assert.equal(commit.repairPathspecIndex(dir), 'clean');
  const headId = git('rev-parse', 'HEAD:.frame/STRUCTURE.json').stdout.trim();
  const setIndex = (id) => git('update-index', '--cacheinfo', `100644,${id},.frame/STRUCTURE.json`);

  setIndex(git('hash-object', '-w', 'src/a.js').stdout.trim());
  assert.equal(commit.repairPathspecIndex(dir), 'repaired');
  assert.equal(git('rev-parse', ':.frame/STRUCTURE.json').stdout.trim(), headId);

  // disk differs from HEAD: the staged entry may be deliberate
  const file = path.join(dir, '.frame', 'STRUCTURE.json');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + ' ');
  setIndex(git('hash-object', '-w', 'src/b.js').stdout.trim());
  assert.equal(commit.repairPathspecIndex(dir), 'clean');
  assert.notEqual(git('rev-parse', ':.frame/STRUCTURE.json').stdout.trim(), headId);
});

test('repairPathspecIndex skips a repository whose HEAD has no map', (t) => {
  const { dir } = committedRepo(t);
  assert.equal(commit.repairPathspecIndex(dir), 'skipped');
});

/* ------------- a commit hook never hangs, never pipes the map through Git ------------- */

test('blobId matches git hash-object for SHA-1 ids and follows a SHA-256 id', (t) => {
  const { dir } = repo(t);
  for (const bytes of [Buffer.from(''), Buffer.from('{"a":1}\n'), Buffer.from('ç\u0000x'.repeat(5000))]) {
    const expected = spawnSync('git', ['hash-object', '--stdin'], { cwd: dir, input: bytes, encoding: 'utf8' }).stdout.trim();
    assert.equal(commit.blobId(bytes, expected), expected);
  }
  const sha256 = commit.blobId(Buffer.from('x'), 'f'.repeat(64));
  assert.equal(sha256.length, 64);
  assert.equal(sha256, require('crypto').createHash('sha256').update('blob 1\0x').digest('hex'));
});

test('a Git call that does not return in time fails the run instead of hanging the commit', (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-slow-git-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const started = Date.now();
  assert.throws(() => commit.git(bin, ['status'], { env, timeout: 200 }), (err) => err.reason === 'git-timeout');
  assert.ok(Date.now() - started < 3000);
});
