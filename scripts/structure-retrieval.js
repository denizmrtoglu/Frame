/**
 * STRUCTURE retrieval (STR-03) — from a path, file name, symbol or concept
 * to a small set of files, with the evidence for each.
 *
 * One engine serves both `find-module.js` (explicit lookup) and
 * `module-hint.js` (the automatic search hint); the hook only takes the
 * stronger evidence tiers. Dependency-free: no Git, no subprocess, no
 * network, nothing that builds or rewrites the map. The only file it writes
 * is its own derived `lookup.json` (publishLookup, called by the map's
 * writers). Ships to `.frame/bin/`.
 *
 * Evidence tiers, strongest first:
 *   1 path            exact repo-relative path, or a path suffix ("lang/python.js")
 *   2 concept         a curated or generated intentIndex concept, exactly
 *   3 synonym         a curated synonym of a concept (intent-map.json)
 *   4 basename        a file name, with or without its extension
 *   5 symbol          an exported name, function name or IPC channel
 *   6 partial concept a word containing a concept, or contained in one (both ≥ 4 letters)
 *   7 path token      a word of a file's directories or name
 *   8 description     a word of a file's description
 * Hooks emit tiers 1–6 only; 7–8 are for explicit lookup.
 *
 * Every content word of a query must be explained by some match: a file
 * that matches "config" does not answer "webpack config". A hook is
 * stricter: one file must carry every word, or it stays quiet. A word carrying a
 * non-ASCII letter ("dosyası", "yöneticisi") is natural-language prose —
 * code identifiers here are ASCII — so it may stay unexplained.
 */

'use strict';

const INDEX_VERSION = 1;
const ALGORITHM = 'str03-v2.2';

// `legacy` is the pre-STR-03 behavior, kept selectable as the rollback path;
// the default follows the benchmark gates (scripts/eval/README.md).
const ENGINES = Object.freeze(['legacy', 'v2']);
const DEFAULT_ENGINE = 'legacy';

const LIMITS = Object.freeze({
  descriptionChars: 160,
  postingsPerTerm: 64,
  queryChars: 512,
  queryUnits: 8,
  hookFiles: 8,
  cliFiles: 20,
  hookIndexBytes: 2 * 1024 * 1024
});

const TIER = Object.freeze({ PATH: 1, CONCEPT: 2, SYNONYM: 3, BASENAME: 4, SYMBOL: 5, PARTIAL: 6, PATH_TOKEN: 7, DESCRIPTION: 8 });
const HOOK_MAX_TIER = TIER.PARTIAL;
const TIER_EVIDENCE = { 1: 'path', 2: 'concept', 3: 'synonym', 4: 'file name', 5: 'symbol', 6: 'partial concept', 7: 'path word', 8: 'description' };

// Words that carry no concept: file extensions, shell/code noise (the hook's
// historical list). Short on purpose — over-filtering costs a hit.
const NOISE = new Set(('js ts jsx tsx json md css html node npm git src test tests dist out lib bin tmp log ' +
  'true false null const let var function return async await require module exports import export ' +
  'the and for with from that this not all any new type name file path line text data code').split(' '));
// Comment markers: a grep for them looks for comments, never for a feature.
const MARKERS = new Set(['todo', 'fixme', 'xxx', 'hack']);

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/* ----------------------------- normalization ----------------------------- */

const TURKISH = { 'İ': 'i', 'I': 'i', 'ı': 'i', 'Ş': 's', 'ş': 's', 'Ğ': 'g', 'ğ': 'g', 'Ç': 'c', 'ç': 'c', 'Ö': 'o', 'ö': 'o', 'Ü': 'u', 'ü': 'u' };

/** Case- and accent-insensitive search form; Turkish letters fold to ASCII. */
function fold(text) {
  return String(text)
    .normalize('NFKC')
    .replace(/[İIıŞşĞğÇçÖöÜü]/g, (ch) => TURKISH[ch])
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '');
}

/** Identifier words: camelCase, snake_case, kebab-case, dotted and path parts. */
function splitWords(text) {
  return String(text)
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .map(fold)
    .filter(Boolean);
}

const NON_ASCII_LETTER = /[^\x00-\x7F]/;

/**
 * A raw query → its search units. Regex syntax is dropped, alternations
 * become separate alternatives, globs keep their literal tail. Each unit
 * keeps its raw spelling (for display), its folded form (for exact tiers)
 * and its identifier words (for the word tiers).
 */
function normalizeQuery(raw) {
  const text = String(raw == null ? '' : raw).slice(0, LIMITS.queryChars);
  const alternatives = text.split('|').map((alt) => {
    const cleaned = alt
      .replace(/\\[bBsSwWdD]/g, ' ')
      .replace(/\\(.)/g, '$1')
      .replace(/(^|\s)(?:\*\*\/|\.\/)+/g, '$1')
      .replace(/[\^$()[\]{}+?*'"`,;<>=!&]/g, ' ');
    const units = [];
    for (const piece of cleaned.split(/\s+/)) {
      const token = piece.replace(/^[.:/\-_]+|[.:/\-_]+$/g, '');
      if (!token) continue;
      const folded = fold(token);
      const words = splitWords(token);
      units.push({
        raw: token,
        folded,
        words,
        prose: NON_ASCII_LETTER.test(token),
        // a file name or path ("go.js", "ui/a.js") is never noise, however short its words
        noise: !/[./]/.test(token) && words.length > 0 && words.every((w) => NOISE.has(w) || w.length < 3),
        marker: MARKERS.has(folded)
      });
      if (units.length >= LIMITS.queryUnits) break;
    }
    return units;
  }).filter((units) => units.length > 0);
  return { raw: text, alternatives };
}

/* ------------------------------- the index ------------------------------- */

function basenameOf(file) {
  return file.slice(file.lastIndexOf('/') + 1);
}

function stripExt(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Compile the lookup index from a map (STR-02c read view) and the curated
 * concept file (intent-map.json). Deterministic: files sorted by path,
 * postings in file order, each term capped and marked when truncated.
 *
 *   files     [[path, description]]
 *   terms     { "<tier>:<folded>": [fileId, …] }  tiers 4, 5, 7, 8 (paths are scanned)
 *   lines     { "<fileId>:<folded function>": line }
 *   concepts  [[name, [fileId, …], [synonym, …]]]  intentIndex order
 */
function compileIndex(structure, curation = {}, meta = {}) {
  const modules = structure && structure.modules && typeof structure.modules === 'object' ? structure.modules : {};
  const entries = Object.values(modules)
    .filter((m) => m && typeof m.file === 'string' && m.file)
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const files = [];
  const idOf = new Map();
  const terms = Object.create(null);
  const lines = Object.create(null);
  const truncated = new Set();
  const add = (tier, term, id) => {
    if (!term) return;
    const key = `${tier}:${term}`;
    const list = terms[key] || (terms[key] = []);
    if (list[list.length - 1] === id) return;
    if (list.length >= LIMITS.postingsPerTerm) {
      truncated.add(key);
      return;
    }
    list.push(id);
  };

  for (const mod of entries) {
    if (idOf.has(mod.file)) continue;
    const id = files.length;
    idOf.set(mod.file, id);
    const description = typeof mod.description === 'string' ? mod.description.slice(0, LIMITS.descriptionChars) : '';
    files.push([mod.file, description]);

    // Paths are matched by scanning `files` (tier 1), so they cost no postings.
    const base = basenameOf(mod.file);
    add(TIER.BASENAME, fold(base), id);
    add(TIER.BASENAME, fold(stripExt(base)), id);

    const symbols = new Set();
    for (const name of Object.keys(mod.functions && typeof mod.functions === 'object' ? mod.functions : {})) symbols.add(name);
    for (const name of Array.isArray(mod.exports) ? mod.exports : []) if (typeof name === 'string') symbols.add(name);
    const ipc = mod.ipc && typeof mod.ipc === 'object' ? mod.ipc : {};
    for (const name of [...(ipc.listens || []), ...(ipc.emits || [])]) if (typeof name === 'string') symbols.add(name);
    for (const name of symbols) add(TIER.SYMBOL, fold(name), id);
    // definition lines, functions only (exports and IPC channels carry none)
    for (const [name, fn] of Object.entries(mod.functions && typeof mod.functions === 'object' ? mod.functions : {})) {
      if (fn && Number.isInteger(fn.line) && fn.line > 0) lines[`${id}:${fold(name)}`] = fn.line;
    }

    const seen = new Set();
    for (const w of splitWords(mod.file)) {
      if (w.length < 2 || seen.has(w)) continue;
      seen.add(w);
      add(TIER.PATH_TOKEN, w, id);
    }
    for (const w of splitWords(description)) {
      if (w.length < 3 || NOISE.has(w) || seen.has(w)) continue;
      seen.add(w);
      add(TIER.DESCRIPTION, w, id);
    }
  }

  const synonymsOf = Object.create(null);
  for (const [concept, entry] of Object.entries(curation && typeof curation === 'object' ? curation : {})) {
    if (concept === '_comment' || !entry || !Array.isArray(entry.synonyms)) continue;
    synonymsOf[fold(concept)] = entry.synonyms.filter((s) => typeof s === 'string').map(fold);
  }
  const concepts = [];
  const index = structure && structure.intentIndex && typeof structure.intentIndex === 'object' ? structure.intentIndex : {};
  for (const [name, members] of Object.entries(index)) {
    if (!Array.isArray(members)) continue;
    const ids = [];
    for (const m of members) {
      const id = m && idOf.get(m.file);
      if (id !== undefined && !ids.includes(id)) ids.push(id);
    }
    if (ids.length) concepts.push([fold(name), ids, synonymsOf[fold(name)] || []]);
  }

  return {
    version: INDEX_VERSION,
    algorithm: ALGORITHM,
    revision: (structure && structure.generation && structure.generation.revision) || null,
    ...meta,
    files,
    terms,
    lines,
    concepts,
    truncated: [...truncated].sort()
  };
}

/* ------------------------------- retrieval ------------------------------- */

const FOLDED_PATHS = new WeakMap();
/** The index's paths in search form, computed once per index object. */
function foldedPaths(index) {
  let paths = FOLDED_PATHS.get(index);
  if (!paths) {
    paths = index.files.map(([file]) => fold(file));
    FOLDED_PATHS.set(index, paths);
  }
  return paths;
}

/** Every match one unit has: Map(fileId → best tier) plus the concepts it named. */
function matchUnit(index, unit, phraseConcepts) {
  const found = new Map();
  const note = (id, tier) => {
    const prev = found.get(id);
    if (prev === undefined || tier < prev) found.set(id, tier);
  };
  const postings = (tier, term) => index.terms[`${tier}:${term}`] || [];

  // 1 path: exact, or a suffix that starts at a directory boundary
  if (unit.folded.includes('/') || unit.folded.includes('.')) {
    const paths = foldedPaths(index);
    const suffix = `/${unit.folded}`;
    paths.forEach((file, id) => {
      if (file === unit.folded || (unit.folded.includes('/') && file.endsWith(suffix))) note(id, TIER.PATH);
    });
  }
  // 2–3 concepts and synonyms, 6 partial concepts
  const conceptTerms = new Set([unit.folded, unit.folded.replace(/[\s_]+/g, '-')]);
  for (const [name, ids, synonyms] of index.concepts) {
    let tier = null;
    if (conceptTerms.has(name) || phraseConcepts.has(name)) tier = TIER.CONCEPT;
    else if (synonyms.some((s) => conceptTerms.has(s) || phraseConcepts.has(s))) tier = TIER.SYNONYM;
    else if (!unit.noise && unit.folded.length >= 4 && name.length >= 4 && /^[\p{L}\p{N}_-]+$/u.test(unit.folded)
      && (unit.folded.includes(name) || name.includes(unit.folded))) tier = TIER.PARTIAL;
    if (tier !== null) for (const id of ids) note(id, tier);
  }
  // 4 basename, 5 symbol
  for (const id of postings(TIER.BASENAME, unit.folded)) note(id, TIER.BASENAME);
  for (const id of postings(TIER.SYMBOL, unit.folded)) note(id, TIER.SYMBOL);
  // 7–8 words
  const words = unit.words.filter((w) => w.length >= 3 && !NOISE.has(w));
  if (words.length) {
    // a file matches at a word tier only when it carries every word of the
    // unit: in its path (7), or across its path and description (8)
    let common = null;
    for (const w of words) {
      const ids = new Set([...postings(TIER.PATH_TOKEN, w), ...postings(TIER.DESCRIPTION, w)]);
      common = common === null ? ids : new Set([...common].filter((id) => ids.has(id)));
    }
    for (const id of common) {
      const inPath = words.every((w) => postings(TIER.PATH_TOKEN, w).includes(id));
      note(id, inPath ? TIER.PATH_TOKEN : TIER.DESCRIPTION);
    }
  }
  return found;
}

/**
 * Rank the files that explain the query.
 *
 * options: { mode: 'cli' | 'hook', limit, exists(path) → boolean }
 * Returns {
 *   status: 'resolved' | 'ambiguous' | 'no-match',
 *   candidates: [{ path, description, tier, evidence, missing? }],
 *   answer: the leading group (same coverage and tier) — what a hook shows,
 *   truncated
 * }
 * `resolved` is a single file, or one concept group; several files of equal
 * standing at the file tiers are `ambiguous`. In hook mode only tiers 1–6
 * count and comment markers are ignored.
 */
function retrieve(index, query, options = {}) {
  const mode = options.mode === 'hook' ? 'hook' : 'cli';
  const limit = Math.max(1, Math.min(options.limit || LIMITS.hookFiles, mode === 'hook' ? LIMITS.hookFiles : LIMITS.cliFiles));
  const { alternatives } = normalizeQuery(query);

  for (const units of alternatives) {
    const result = retrieveUnits(index, units, mode, limit, options);
    if (result.status !== 'no-match') return result;
  }
  return { status: 'no-match', candidates: [], answer: [], truncated: false };
}

function retrieveUnits(index, allUnits, mode, limit, options) {
  const units = allUnits.filter((u) => !u.noise && !(mode === 'hook' && u.marker));
  const none = { status: 'no-match', candidates: [], answer: [], truncated: false };
  if (!units.length) return none;

  // a whole multi-word query may name a concept ("file tree" → file-tree)
  const phraseConcepts = new Set();
  if (units.length > 1) {
    const phrase = units.map((u) => u.folded).join('-');
    phraseConcepts.add(phrase);
  }

  const perFile = new Map(); // id → { covered: Set(unitIndex), tier }
  const required = [];
  units.forEach((unit, i) => {
    const matches = matchUnit(index, unit, phraseConcepts);
    const usable = mode === 'hook' ? [...matches].filter(([, tier]) => tier <= HOOK_MAX_TIER) : [...matches];
    if (!usable.length) {
      if (!unit.prose) required.push(i); // an unexplained identifier word: nothing answers the query
      return;
    }
    required.push(i);
    for (const [id, tier] of usable) {
      const entry = perFile.get(id) || { covered: new Set(), tier: Infinity, sum: 0 };
      entry.covered.add(i);
      entry.tier = Math.min(entry.tier, tier);
      entry.sum += tier;
      perFile.set(id, entry);
    }
  });

  const conceptOrder = new Map();
  index.concepts.forEach(([, ids], c) => ids.forEach((id, pos) => {
    if (!conceptOrder.has(id)) conceptOrder.set(id, c * 100000 + pos);
  }));

  // Every required word must be explained by some match. Files carrying
  // all of them come first; when none does ("GitHub paneli": the github
  // group and the panel group), files rank by how many words they carry.
  // A hook is stricter (STR-03b): one file must carry every required word,
  // or the hint stays quiet — the relaxation produced its wrong hints.
  const explained = new Set([...perFile.values()].flatMap((e) => [...e.covered]));
  if (!required.every((i) => explained.has(i))) return none;
  let ranked = [...perFile.entries()]
    .filter(([, e]) => mode !== 'hook' || required.every((i) => e.covered.has(i)))
    .map(([id, e]) => ({ id, tier: e.tier, sum: e.sum, cov: e.covered.size }))
    .sort((a, b) => b.cov - a.cov || a.tier - b.tier || a.sum - b.sum
      || (conceptOrder.get(a.id) ?? Infinity) - (conceptOrder.get(b.id) ?? Infinity)
      || (index.files[a.id][0] < index.files[b.id][0] ? -1 : 1));
  if (!ranked.length) return none;

  if (typeof options.exists === 'function') {
    ranked = ranked.map((r) => ({ ...r, missing: !options.exists(index.files[r.id][0]) }));
    if (mode === 'hook') ranked = ranked.filter((r) => !r.missing);
    if (!ranked.length) return none;
  }

  const lead = ranked.find((r) => !r.missing) || ranked[0];
  const answerIds = ranked.filter((r) => r.cov === lead.cov && r.tier === lead.tier && r.sum === lead.sum && !r.missing);
  const toCandidate = (r) => {
    const [file, description] = index.files[r.id];
    const c = { path: file, description, tier: r.tier, evidence: TIER_EVIDENCE[r.tier] };
    if (r.tier === TIER.SYMBOL && index.lines) {
      for (const u of units) {
        const line = index.lines[`${r.id}:${u.folded}`];
        if (line) {
          c.line = line;
          c.symbol = u.raw;
          break;
        }
      }
    }
    if (r.missing) c.missing = true;
    return c;
  };
  const shown = mode === 'hook' ? answerIds : ranked;
  const candidates = shown.slice(0, limit).map(toCandidate);
  const answer = answerIds.slice(0, limit).map(toCandidate);
  const single = answerIds.length === 1 || lead.tier === TIER.CONCEPT || lead.tier === TIER.SYNONYM;
  return {
    status: single ? 'resolved' : 'ambiguous',
    candidates,
    answer,
    truncated: shown.length > limit
  };
}

/* ------------------------- the published lookup file ------------------------ */
//
// `.frame/runtime/structure/lookup.json` is compiled after every working-view
// publication (STR-03 A2), so a search hook reads a small file instead of the
// whole map. It records the signature of the map file and of intent-map.json
// it was built from; a mismatch makes it stale and a reader never trusts it.

const fs = require('fs');
const path = require('path');

function lookupPath(root) {
  return path.join(root, '.frame', 'runtime', 'structure', 'lookup.json');
}

/** intent-map.json beside the running scripts (scripts/ or .frame/bin/). */
function curationPath(dir = __dirname) {
  return path.join(dir, 'intent-map.json');
}

function readCuration(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function signatureOf(file) {
  try {
    const s = fs.statSync(file);
    return { ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
  } catch {
    return null;
  }
}

function sameSignature(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return a == b; // eslint-disable-line eqeqeq
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/**
 * Compile and atomically publish lookup.json from the map at `mapPath`
 * (default: the read view). Never throws: a failure is reported and the
 * map publication it follows stands.
 *
 * Returns { status: 'published' | 'unchanged' | 'failed', bytes?, oversize?, reason? }.
 */
function publishLookup(root, options = {}) {
  try {
    const read = require('./structure-read');
    const mapFile = options.mapPath || read.resolveReadPath(root);
    const curationFile = options.curationPath || curationPath();
    const relMap = path.relative(root, mapFile).split(path.sep).join('/');
    const source = { path: relMap, signature: signatureOf(mapFile) };
    const curation = { signature: signatureOf(curationFile) };
    if (!source.signature) return { status: 'failed', reason: 'no-map' };

    const target = lookupPath(root);
    try {
      const current = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (current.version === INDEX_VERSION && current.algorithm === ALGORITHM && current.source
        && current.source.path === relMap && sameSignature(current.source.signature, source.signature)
        && current.curation && sameSignature(current.curation.signature, curation.signature)) {
        return { status: 'unchanged', bytes: fs.statSync(target).size, oversize: Boolean(current.oversize) };
      }
    } catch { /* none or unreadable: rebuild */ }

    const structure = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    const index = compileIndex(structure, readCuration(curationFile), { source, curation, oversize: false });
    let text = JSON.stringify(index);
    if (Buffer.byteLength(text) > LIMITS.hookIndexBytes) {
      index.oversize = true;
      text = JSON.stringify(index);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, target);
    return { status: 'published', bytes: Buffer.byteLength(text), oversize: index.oversize };
  } catch (err) {
    return { status: 'failed', reason: (err && err.code) || 'error', message: err && err.message };
  }
}

/**
 * Read the published index for a lookup. Never compiles, never writes.
 *
 * options: { maxBytes } — larger files are not even read.
 * Returns { state: 'fresh' | 'stale' | 'missing' | 'oversize' | 'invalid', index? }:
 * fresh only when it was built from the current read view and curation by
 * this algorithm. A stale index is still returned for callers that may use
 * it with care; hooks must not.
 */
function loadLookup(root, options = {}) {
  const file = lookupPath(root);
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { state: 'missing' };
  }
  if (options.maxBytes && size > options.maxBytes) return { state: 'oversize' };
  let index;
  try {
    index = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { state: 'invalid' };
  }
  if (!index || index.version !== INDEX_VERSION || !Array.isArray(index.files) || !index.terms || !Array.isArray(index.concepts)) {
    return { state: 'invalid' };
  }
  if (index.oversize && options.maxBytes) return { state: 'oversize' };
  let fresh = index.algorithm === ALGORITHM;
  try {
    const read = require('./structure-read');
    const mapFile = read.resolveReadPath(root);
    const relMap = path.relative(root, mapFile).split(path.sep).join('/');
    fresh = fresh && index.source && index.source.path === relMap && sameSignature(index.source.signature, signatureOf(mapFile))
      && index.curation && sameSignature(index.curation.signature, signatureOf(options.curationPath || curationPath()));
  } catch {
    fresh = false;
  }
  return { state: fresh ? 'fresh' : 'stale', index };
}

/**
 * Compile an index in memory from the read view — the fallback when no
 * fresh lookup.json exists (a clone without a running worker). Bounded:
 * a map larger than `maxBytes` is not read.
 * Returns { state: 'compiled' | 'missing' | 'oversize' | 'invalid', index?, structure? }.
 */
function indexFromMap(root, options = {}) {
  let mapFile;
  try {
    mapFile = require('./structure-read').resolveReadPath(root);
  } catch {
    return { state: 'missing' };
  }
  let size;
  try {
    size = fs.statSync(mapFile).size;
  } catch {
    return { state: 'missing' };
  }
  if (options.maxBytes && size > options.maxBytes) return { state: 'oversize' };
  let structure;
  try {
    structure = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  } catch {
    return { state: 'invalid' };
  }
  if (!structure || typeof structure !== 'object' || !structure.modules) return { state: 'invalid' };
  return { state: 'compiled', index: compileIndex(structure, readCuration(options.curationPath || curationPath())), structure };
}

/* ------------------------- the worker's lookup socket ------------------------ */
//
// STR-03b: the lifecycle worker keeps the index it published in memory and
// answers lookups over a local socket, so a hook skips reading and parsing
// lookup.json. Process-to-process IPC on this machine only — never a network
// address. The socket lives in the OS temp directory under a hash of the
// project's real path (macOS caps a socket path at 104 characters); the
// worker announces it in `.frame/runtime/structure/lookup.endpoint`.

const LOOKUP_PROTOCOL = 1;

function lookupAddress(root) {
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch { /* the path as given */ }
  const id = require('crypto').createHash('sha256').update(real).digest('hex').slice(0, 16);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\frame-lookup-${id}`
    : path.join(require('os').tmpdir(), `frame-lookup-${id}.sock`);
}

function lookupEndpointPath(root) {
  return path.join(root, '.frame', 'runtime', 'structure', 'lookup.endpoint');
}

/* --------------------------------- legacy -------------------------------- */

/**
 * Today's behavior, kept selectable as the rollback path (STR-03 D2):
 * find-module's four tiers (exact → synonym → partial → deep substring) in
 * `cli` mode, the hook's curated three (exact → synonym → partial, first
 * keyword that hits) in `hook` mode. Same result shape as `retrieve`, plus
 * `groups` ([{ feature, modules, matchType }]) for the legacy rendering.
 */
function legacyRetrieve(structure, curation, options = {}) {
  const index = (structure && structure.intentIndex) || null;
  const modules = (structure && structure.modules) || {};
  const intentMap = {};
  for (const [k, v] of Object.entries(curation && typeof curation === 'object' ? curation : {})) if (k !== '_comment') intentMap[k] = v;
  const tierOf = { exact: TIER.CONCEPT, synonym: TIER.SYNONYM, partial: TIER.PARTIAL, deep: TIER.DESCRIPTION };
  const shape = (groups) => {
    const candidates = [];
    for (const g of groups) {
      for (const m of g.modules) {
        if (!candidates.some((c) => c.path === m.file)) {
          candidates.push({ path: m.file, description: m.description || '', tier: tierOf[g.matchType], evidence: g.matchType, feature: g.feature, module: m.module });
        }
      }
    }
    return { status: candidates.length ? (groups.length === 1 && groups[0].matchType !== 'deep' ? 'resolved' : 'ambiguous') : 'no-match', candidates, answer: candidates, groups, truncated: false };
  };
  if (!index) return { ...shape([]), status: 'unavailable' };

  if (options.mode === 'hook') {
    for (const keyword of options.words || []) {
      const hit = legacyHookLookup(index, intentMap, keyword);
      if (hit) return { ...shape([{ ...hit, matchType: hit.matchType }]), keyword };
    }
    return shape([]);
  }

  const keyword = String(options.query || '');
  const kw = keyword.toLowerCase();
  const results = [];
  for (const [feature, mods] of Object.entries(index)) if (feature === kw) results.push({ feature, modules: mods, matchType: 'exact' });
  if (!results.length) {
    for (const [concept, entry] of Object.entries(intentMap)) {
      const synonyms = (entry.synonyms || []).map((s) => s.toLowerCase());
      if (synonyms.includes(kw) && index[concept]) results.push({ feature: `${concept} (synonym: "${keyword}")`, modules: index[concept], matchType: 'synonym' });
    }
  }
  if (!results.length) {
    for (const [feature, mods] of Object.entries(index)) {
      if (feature.includes(kw) || kw.includes(feature)) results.push({ feature, modules: mods, matchType: 'partial' });
    }
  }
  if (!results.length) {
    const matched = [];
    for (const [key, mod] of Object.entries(modules)) {
      const searchable = [key, mod.description || '', ...(mod.exports || []), ...((mod.ipc && mod.ipc.listens) || []), ...((mod.ipc && mod.ipc.emits) || [])].join(' ').toLowerCase();
      if (searchable.includes(kw)) matched.push({ module: key, file: mod.file, description: mod.description || '' });
    }
    if (matched.length) results.push({ feature: `search: "${keyword}"`, modules: matched, matchType: 'deep' });
  }
  return shape(results);
}

function legacyHookLookup(index, intentMap, keyword) {
  for (const [feature, modules] of Object.entries(index)) {
    if (feature === keyword) return { feature, modules, matchType: 'exact' };
  }
  for (const [concept, entry] of Object.entries(intentMap)) {
    const synonyms = (entry.synonyms || []).map((s) => String(s).toLowerCase());
    if (synonyms.includes(keyword) && index[concept]) {
      return { feature: `${concept} (synonym: "${keyword}")`, modules: index[concept], matchType: 'synonym' };
    }
  }
  for (const [feature, modules] of Object.entries(index)) {
    if (feature.includes(keyword) || keyword.includes(feature)) return { feature, modules, matchType: 'partial' };
  }
  return null;
}

module.exports = {
  compileIndex,
  publishLookup,
  loadLookup,
  indexFromMap,
  lookupPath,
  curationPath,
  lookupAddress,
  lookupEndpointPath,
  LOOKUP_PROTOCOL,
  normalizeQuery,
  retrieve,
  legacyRetrieve,
  fold,
  splitWords,
  ENGINES,
  DEFAULT_ENGINE,
  TIER,
  HOOK_MAX_TIER,
  LIMITS,
  INDEX_VERSION,
  ALGORITHM,
  NOISE
};
