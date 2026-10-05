/**
 * STRUCTURE for a commit — the map built from Git's staged snapshot
 * (STR-02b).
 *
 * The working-tree view lives in `.frame/runtime/structure/working.json`
 * (STR-02c); the tracked `.frame/STRUCTURE.json` is the committed view. A
 * commit must carry a map of what it actually contains, so the pre-commit
 * hook builds one from the effective index, publishes it into the index and
 * mirrors the same bytes to the tracked file — unless that file holds
 * unstaged edits, which are never overwritten.
 *
 * The snapshot is read through Git plumbing (`ls-files -s -z`,
 * `cat-file --batch`) and exposed as a small read-only fs. STR-01 discovery,
 * identities, annotation merging and serialization run on it unchanged, so
 * there is one definition of an eligible file.
 *
 *   policy      the staged `.frame/config.json`, or generator defaults when
 *               the index has none (recorded as a fallback) — unstaged local
 *               settings never shape a commit
 *   prior       the map staged at the owned path, so unstaged prose never
 *               reaches a commit
 *   curation    the working copy beside the parser: it lives in the
 *               gitignored `.frame/bin/` and is never staged; it can only
 *               resolve to module keys present in this commit's map
 *
 * Standalone: ships into `.frame/bin/`; needs Git for this path only.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const discovery = require('./structure-discovery');
const generation = require('./structure-generation');
const state = require('./structure-state');
const snapshot = require('./structure-snapshot');

const MODE_FILE = new Set(['100644', '100755']);
const MODE_SYMLINK = '120000';
const MODE_GITLINK = '160000';
const GIT_TIMEOUT_MS = 60000;

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

class CommitUnavailable extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = 'CommitUnavailable';
    this.reason = reason;
  }
}

/* --------------------------------- git ----------------------------------- */

/**
 * Run Git for this checkout and its effective index. `GIT_INDEX_FILE` from
 * the hook environment is passed through untouched.
 */
function git(root, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    env: options.env || process.env,
    input: options.input,
    maxBuffer: 1024 * 1024 * 1024,
    // a commit hook must never hang the commit: a stuck Git call fails this run
    timeout: options.timeout || GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL'
  });
  if (result.error) {
    const reason = result.error.code === 'ETIMEDOUT' ? 'git-timeout' : 'git-unavailable';
    throw new CommitUnavailable(reason, result.error.message);
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new CommitUnavailable(options.failureReason || 'git-failed', String(result.stderr || '').trim().split('\n')[0]);
  }
  return result;
}

/**
 * Git's object id for a blob, computed here instead of piping the bytes
 * through `git hash-object --stdin` (no filters apply to either). The hash
 * function follows the id it is compared with: 40 hex digits SHA-1, 64
 * SHA-256.
 */
function blobId(bytes, like) {
  const algorithm = typeof like === 'string' && like.length === 64 ? 'sha256' : 'sha1';
  return crypto.createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** The index this commit uses: the hook's GIT_INDEX_FILE, else the checkout's. */
function resolveIndex(root, env = process.env) {
  if (env.GIT_INDEX_FILE) return path.resolve(root, env.GIT_INDEX_FILE);
  const out = git(root, ['rev-parse', '--git-path', 'index'], { env }).stdout.toString().trim();
  return path.resolve(root, out);
}

/**
 * Staged entries of the effective index. Any unmerged stage makes the
 * snapshot unavailable: there is no single staged content to describe.
 */
function listEntries(root, env = process.env) {
  const out = git(root, ['ls-files', '-s', '-z'], { env }).stdout.toString('utf8');
  const entries = new Map();
  for (const record of out.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, id, stage] = record.slice(0, tab).split(' ');
    const file = record.slice(tab + 1);
    if (stage !== '0') throw new CommitUnavailable('unmerged', `unmerged path: ${file}`);
    entries.set(file, { mode, id });
  }
  return entries;
}

/**
 * Read blobs with one `cat-file --batch` process. Returns Map(id → Buffer).
 * Objects Git cannot produce make the snapshot unavailable.
 */
function readBlobs(root, ids, env = process.env) {
  const unique = [...new Set(ids)];
  const blobs = new Map();
  if (unique.length === 0) return blobs;
  const out = git(root, ['cat-file', '--batch'], { env, input: `${unique.join('\n')}\n` }).stdout;
  let offset = 0;
  for (const id of unique) {
    const newline = out.indexOf(0x0a, offset);
    const header = out.subarray(offset, newline).toString('utf8');
    const [, type, size] = header.split(' ');
    if (type === 'missing' || type !== 'blob') throw new CommitUnavailable('object-unreadable', header);
    const start = newline + 1;
    const length = Number(size);
    blobs.set(id, out.subarray(start, start + length));
    offset = start + length + 1;
  }
  return blobs;
}

/* ------------------------- the snapshot as an fs ------------------------- */

function enoent(p) {
  const err = new Error(`ENOENT: no such file in the staged snapshot, '${p}'`);
  err.code = 'ENOENT';
  return err;
}

function fakeStat(kind, size) {
  return {
    size,
    mtimeMs: 0,
    ctimeMs: 0,
    ino: 0,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink'
  };
}

/**
 * A read-only fs over the staged tree, enough for STR-01 discovery and
 * extraction: stat/lstat, readdir, existsSync, readFileSync and fd reads.
 * Blob bytes are looked up lazily through `blobOf(relPath)`.
 */
function createIndexFs(root, entries, blobOf) {
  // `.frame/` always exists in a Frame checkout. Present it even before any
  // of its files is staged, so a map's own first staging does not change the
  // discovery counts of the next build (and counts match the working view).
  const dirs = new Map([['', new Set(['.frame'])], ['.frame', new Set()]]);
  const files = new Map();
  for (const [file, entry] of entries) {
    files.set(file, entry);
    const parts = file.split('/');
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (!dirs.has(parent)) dirs.set(parent, new Set());
      dirs.get(parent).add(parts[i]);
      if (i < parts.length - 1) {
        const dir = parts.slice(0, i + 1).join('/');
        if (!dirs.has(dir)) dirs.set(dir, new Set());
      }
    }
  }

  const rel = (p) => {
    const r = path.relative(root, path.resolve(root, String(p)));
    if (r.startsWith('..') || path.isAbsolute(r)) return null;
    return r.split(path.sep).join('/');
  };
  const statOf = (p) => {
    const r = rel(p);
    if (r === null) throw enoent(p);
    if (dirs.has(r)) return fakeStat('dir', 0);
    const entry = files.get(r);
    if (!entry) throw enoent(p);
    if (entry.mode === MODE_SYMLINK) return fakeStat('symlink', 0);
    if (entry.mode === MODE_GITLINK) return fakeStat('special', 0);
    return fakeStat('file', blobOf(r).length);
  };
  const bytesOf = (p) => {
    const r = rel(p);
    const entry = r === null ? null : files.get(r);
    if (!entry || !MODE_FILE.has(entry.mode)) throw enoent(p);
    return blobOf(r);
  };

  const fds = new Map();
  let nextFd = 1000;
  return {
    statSync: statOf,
    lstatSync: statOf,
    existsSync: (p) => {
      try { statOf(p); return true; } catch (e) { return false; }
    },
    readdirSync: (p) => {
      const r = rel(p);
      if (r === null || !dirs.has(r)) throw enoent(p);
      return [...dirs.get(r)];
    },
    readFileSync: (p, encoding) => {
      const buf = bytesOf(p);
      const enc = typeof encoding === 'string' ? encoding : encoding && encoding.encoding;
      return enc ? buf.toString(enc) : Buffer.from(buf);
    },
    openSync: (p) => {
      const fd = nextFd++;
      fds.set(fd, bytesOf(p));
      return fd;
    },
    readSync: (fd, buffer, offset, length, position) => {
      const buf = fds.get(fd);
      if (!buf) throw enoent(`fd ${fd}`);
      const start = position === null || position === undefined ? 0 : position;
      const n = Math.max(0, Math.min(length, buf.length - start));
      buf.copy(buffer, offset, start, start + n);
      return n;
    },
    closeSync: (fd) => { fds.delete(fd); },
    has: (relPath) => files.has(relPath),
    entry: (relPath) => files.get(relPath) || null
  };
}

/* ------------------------------- the build ------------------------------- */

/**
 * Build the commit's map from the effective index.
 *
 * Returns { candidate (text), structure, report, mapPath (repo-relative),
 * indexFile, entries, policyFallback, stagedMapId } or throws
 * CommitUnavailable with a reason (unmerged, object-unreadable,
 * git-unavailable, git-failed).
 */
function buildStaged(root, options = {}) {
  const env = options.env || process.env;
  const indexFile = resolveIndex(root, env);
  const entries = listEntries(root, env);

  // Blobs are read in one batch: every regular file within the parse limit
  // (larger ones are metadata-only anyway; their bytes are fetched singly if
  // discovery needs a sample).
  const regular = [...entries].filter(([, e]) => MODE_FILE.has(e.mode));
  const sizes = new Map();
  if (regular.length) {
    const out = git(root, ['cat-file', '--batch-check'], { env, input: `${regular.map(([, e]) => e.id).join('\n')}\n` }).stdout.toString('utf8');
    const lines = out.split('\n').filter(Boolean);
    lines.forEach((line, i) => {
      const [id, type, size] = line.split(' ');
      if (type !== 'blob') throw new CommitUnavailable('object-unreadable', line);
      sizes.set(regular[i][1].id, Number(size) || 0);
    });
  }
  const eager = regular.filter(([, e]) => sizes.get(e.id) <= (options.maxEagerBytes || 2 * 1024 * 1024)).map(([, e]) => e.id);
  const blobs = readBlobs(root, eager, env);
  const blobOf = (relPath) => {
    const entry = entries.get(relPath);
    if (!blobs.has(entry.id)) blobs.set(entry.id, readBlobs(root, [entry.id], env).get(entry.id));
    return blobs.get(entry.id);
  };
  const indexFs = createIndexFs(root, entries, blobOf);

  // Policy from the staged config, or defaults (recorded).
  const policyFallback = !indexFs.has('.frame/config.json');
  const loaded = discovery.loadProjectStructureConfig(root, indexFs);
  let stagedProject = {};
  if (!policyFallback) {
    try {
      const config = JSON.parse(indexFs.readFileSync(path.join(root, '.frame', 'config.json'), 'utf8'));
      stagedProject = config && config.project && typeof config.project === 'object' ? config.project : {};
    } catch (e) {
      stagedProject = {};
    }
  }
  const found = discovery.discover(root, { structure: loaded.structure, legacyFiles: loaded.legacyFiles, fs: indexFs });

  // Prior: the map staged at the path this checkout owns.
  const mapPath = path.relative(root, state.resolveStructurePath(root)).split(path.sep).join('/');
  let prior = null;
  const stagedMap = indexFs.entry(mapPath);
  if (stagedMap && MODE_FILE.has(stagedMap.mode)) {
    try {
      const parsed = JSON.parse(blobOf(mapPath).toString('utf8'));
      prior = state.validateStructure(parsed) ? null : parsed;
    } catch (e) {
      prior = null;
    }
  }

  // Content identities for the shared extraction cache (same content, same
  // facts, whichever view built them first).
  const manifest = { version: 1, entries: Object.create(null) };
  for (const record of found.files) {
    const entry = entries.get(record.path);
    if (entry && blobs.has(entry.id)) manifest.entries[record.path] = { sha256: sha256(blobs.get(entry.id)) };
  }
  const cache = snapshot.createExtractionCache(root, manifest);

  const built = generation.buildFull({
    rootDir: root,
    discovery: found,
    prior,
    curation: generation.loadCuration(options.curationDir || __dirname),
    projectConfig: stagedProject,
    fs: indexFs,
    extract: cache.extract
  });
  cache.prune();

  return {
    candidate: generation.serializeStructure(built.structure, prior),
    structure: built.structure,
    report: built.report,
    mapPath,
    indexFile,
    entries,
    stagedMapId: stagedMap ? stagedMap.id : null,
    policyFallback,
    cacheHits: cache.stats.hits
  };
}

/* ------------------------------ publication ----------------------------- */

function indexIdentity(indexFile) {
  try {
    return sha256(fs.readFileSync(indexFile));
  } catch (e) {
    return null;
  }
}

function receiptPath(root) {
  return path.join(root, '.frame', 'runtime', 'structure', 'commit.json');
}

function writeReceipt(root, value) {
  writeJson(receiptPath(root), value);
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) {
    /* visibility only: a commit never fails over it */
  }
}

/**
 * Set the tracked map on disk to the commit's map (STR-02c D6), so a normal
 * commit leaves `git status` clean. Only a file equal to the entry staged
 * before publishing (or a missing one) is replaced: anything else holds
 * unstaged edits and is kept. Returns written | unchanged | kept | failed.
 */
function mirrorToDisk(root, mapPath, candidate, stagedId, env) {
  const file = path.join(root, ...mapPath.split('/'));
  let current = null;
  try {
    current = fs.readFileSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') return 'failed';
  }
  const bytes = Buffer.isBuffer(candidate) ? candidate : Buffer.from(candidate, 'utf8');
  if (current && current.equals(bytes)) return 'unchanged';
  try {
    if (current) {
      if (blobId(current, stagedId) !== stagedId) return 'kept';
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
    return 'written';
  } catch (e) {
    return 'failed';
  }
}

/**
 * A pathspec commit (`git commit -- <paths>`) runs the hook on a temporary
 * index: HEAD and the disk get the new map while the real index keeps the
 * old entry. The worker repairs exactly that state (STR-02c D6): the tracked
 * map on disk equals HEAD and the index entry differs → the entry is set to
 * HEAD's blob. A deliberately staged edit cannot look like this — the disk
 * would equal the staged version. Returns repaired | clean | skipped | failed.
 */
function repairPathspecIndex(root, options = {}) {
  const env = options.env || process.env;
  try {
    const rel = path.relative(root, state.resolveStructurePath(root)).split(path.sep).join('/');
    const head = git(root, ['rev-parse', '-q', '--verify', `HEAD:${rel}`], { env, allowFailure: true });
    if (head.status !== 0) return 'skipped';
    const headId = head.stdout.toString().trim();
    const entry = git(root, ['ls-files', '-s', '--', rel], { env }).stdout.toString().trim();
    const match = /^(\d+) ([0-9a-f]+) 0\t/.exec(entry);
    if (!match || entry.includes('\n')) return 'skipped';
    if (match[2] === headId) return 'clean';
    let disk;
    try {
      disk = fs.readFileSync(path.join(root, ...rel.split('/')));
    } catch (e) {
      return 'skipped';
    }
    if (blobId(disk, headId) !== headId) return 'clean';
    const update = git(root, ['update-index', '--cacheinfo', `${match[1]},${headId},${rel}`], { env, allowFailure: true });
    return update.status === 0 ? 'repaired' : 'failed';
  } catch (e) {
    return 'failed';
  }
}

function trackedReceiptPath(root) {
  return path.join(root, '.frame', 'runtime', 'structure', 'tracked.json');
}

/**
 * Bring the tracked map on disk back to the committed view when that loses
 * nothing (STR-02c D6 + D8). Runs on every worker reconciliation:
 *
 *   clean      disk equals the index entry
 *   repaired   a pathspec commit left the index behind HEAD (see above)
 *   restored   disk differed from the index in generated content only (a
 *              pre-STR-02c working map): the disk bytes are archived to
 *              recovery and the index version is written back
 *   kept       disk carries hand edits (or is not a valid map): left alone
 *   skipped    no Git, no tracked map, a conflict or a Git operation running
 *   failed     anything else
 *
 * The outcome is recorded in `.frame/runtime/structure/tracked.json` with the
 * disk digest it describes, so a reader can tell whether it still applies.
 */
function reconcileTrackedMap(root, options = {}) {
  const env = options.env || process.env;
  let result;
  try {
    result = reconcileTracked(root, env);
  } catch (err) {
    result = { status: err instanceof CommitUnavailable ? 'skipped' : 'failed', reason: err.reason || 'error' };
  }
  writeJson(trackedReceiptPath(root), { version: 1, at: new Date().toISOString(), ...result });
  return result;
}

function reconcileTracked(root, env) {
  const rel = path.relative(root, state.resolveStructurePath(root)).split(path.sep).join('/');
  const indexFile = resolveIndex(root, env);
  if (fs.existsSync(`${indexFile}.lock`)) return { status: 'skipped', reason: 'git-busy' };
  const entry = git(root, ['ls-files', '-s', '--', rel], { env }).stdout.toString().trim();
  const match = /^(\d+) ([0-9a-f]+) 0\t/.exec(entry);
  if (!match || entry.includes('\n')) return { status: 'skipped', reason: entry ? 'conflict' : 'untracked' };
  const file = path.join(root, ...rel.split('/'));
  let disk;
  try {
    disk = fs.readFileSync(file);
  } catch (e) {
    return { status: 'skipped', reason: 'missing' };
  }
  const diskDigest = sha256(disk);
  if (blobId(disk, match[2]) === match[2]) return { status: 'clean', diskDigest };

  const repair = repairPathspecIndex(root, { env });
  if (repair === 'repaired') return { status: 'repaired', diskDigest };

  const staged = readBlobs(root, [match[2]], env).get(match[2]);
  const parse = (bytes) => {
    try {
      const value = JSON.parse(bytes.toString('utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (e) {
      return null;
    }
  };
  const onDisk = parse(disk);
  const inIndex = parse(staged);
  if (!onDisk || !inIndex) return { status: 'kept', reason: onDisk ? 'index-invalid' : 'disk-invalid', diskDigest };
  if (!generation.sameAuthoredContent(onDisk, inIndex)) return { status: 'kept', reason: 'hand-edits', diskDigest };

  const paths = state.statePaths(root);
  const archived = state.preserveBytes(paths, disk);
  const current = fs.readFileSync(file);
  if (!current.equals(disk)) return { status: 'kept', reason: 'changed-while-checking', diskDigest: sha256(current) };
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, staged);
  fs.renameSync(tmp, file);
  return {
    status: 'restored',
    diskDigest: sha256(staged),
    recoveryPath: path.relative(root, archived).split(path.sep).join('/')
  };
}

/**
 * Build the commit's map and publish it into the effective index.
 *
 * Only the map's index entry can change. The index identity is captured
 * before building and rechecked right before `update-index`, which takes
 * Git's own lock; a changed or locked index aborts without writing. A map
 * path that is neither tracked nor shareable (ignored, local sharing mode)
 * is never force-added. After publishing (or finding it already staged)
 * the tracked file on disk is set to the same bytes when it held no
 * unstaged edits (`mirror` in the result).
 *
 * Returns { status, reason?, message?, blob?, mapPath?, policyFallback? }:
 *   published   the staged map entry now holds this commit's map
 *   unchanged   it already did
 *   skipped     the map path is not shared with the repository
 *   unavailable no single staged snapshot (unmerged, unreadable object, no Git)
 *   aborted     the index changed or was locked while building
 *   failed      anything else
 * and records it in `.frame/runtime/structure/commit.json`.
 */
function publishStaged(root, options = {}) {
  const env = options.env || process.env;
  const startedAt = Date.now();
  let context = {};
  const finish = (result) => {
    const value = { version: 1, at: new Date().toISOString(), ms: Date.now() - startedAt, ...context, ...result };
    writeReceipt(root, value);
    return value;
  };

  try {
    const indexFile = resolveIndex(root, env);
    const identity = indexIdentity(indexFile);
    const built = buildStaged(root, options);
    context = {
      mapPath: built.mapPath,
      policyFallback: built.policyFallback,
      files: Object.keys(built.structure.modules).length,
      indexDigest: identity
    };

    const staged = built.entries.get(built.mapPath);
    if (!staged) {
      const ignored = git(root, ['check-ignore', '-q', '--', built.mapPath], { env, allowFailure: true }).status === 0;
      if (ignored) return finish({ status: 'skipped', reason: 'map-not-shared' });
    }

    const blob = git(root, ['hash-object', '-w', '--stdin'], { env, input: built.candidate }).stdout.toString().trim();
    const mirror = () => mirrorToDisk(root, built.mapPath, built.candidate, staged ? staged.id : null, env);
    if (staged && staged.id === blob) return finish({ status: 'unchanged', blob, mirror: mirror() });

    if (options.hooks && typeof options.hooks.beforePublish === 'function') options.hooks.beforePublish();
    if (indexIdentity(indexFile) !== identity) return finish({ status: 'aborted', reason: 'index-changed' });

    const mode = staged && staged.mode === '100755' ? '100755' : '100644';
    const update = git(root, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${built.mapPath}`], { env, allowFailure: true });
    if (update.status !== 0) {
      const stderr = String(update.stderr || '');
      return finish({
        status: 'aborted',
        reason: /index\.lock|File exists/.test(stderr) ? 'index-locked' : 'update-failed',
        message: stderr.trim().split('\n')[0]
      });
    }
    return finish({ status: 'published', blob, mirror: mirror() });
  } catch (err) {
    if (err instanceof CommitUnavailable) return finish({ status: 'unavailable', reason: err.reason, message: err.message });
    return finish({ status: 'failed', reason: 'error', message: err && err.message });
  }
}

module.exports = {
  publishStaged,
  blobId,
  repairPathspecIndex,
  reconcileTrackedMap,
  trackedReceiptPath,
  receiptPath,
  buildStaged,
  createIndexFs,
  listEntries,
  resolveIndex,
  readBlobs,
  git,
  CommitUnavailable
};
