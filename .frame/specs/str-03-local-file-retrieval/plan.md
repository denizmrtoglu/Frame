# Plan — STR-03 — Local File Retrieval

## Architecture

### Resolved plan-time decisions

Re-planned 2026-10-01 on top of the merged STR-01, STR-02, STR-02b and STR-02c; the 2026-09-25 plan predates all four and is replaced.

- **D1 · Scope of the evidence (business, asked).** This spec ships local retrieval, a deterministic held-out benchmark (S7) and the matched-agent instrument (S8): runner arms, transcript accounting and paired reporting, validated on synthetic transcripts. The paid matched-agent run is a separate, explicitly commanded operation; until it has run, the eval README records the S8 result as pending and no token saving is claimed.
- **D2 · Rollout (business, asked).** The new engine (`v2`) becomes the default for `find-module` and the search hook within this spec, once the held-out benchmark passes the A5 gates. `legacy` stays selectable (`--retrieval=legacy`, or `project.retrieval.engine` in `.frame/config.json`) as the rollback path. If a gate fails, the default stays `legacy` and the README records the failed gate.
- **D3 · Delivery stays additive (business, carried).** Hooks remain optional, local, non-blocking and exit 0 with empty output on any failure; they never cancel the original search, run Git, rebuild the map or touch the network. No graph hints, no new CLI integrations, no change to hook registration, trust or user overrides (`audit-q3-deterministic-graph-hints`, `codex-parity`).
- **D4 · One compact lookup index (technical, asked).** After every working-view publication the writer also publishes `.frame/runtime/structure/lookup.json`: paths, basenames, symbols, curated concepts/synonyms and short descriptions only. The hook reads it only when it is at most 2 MiB; above that it stays quiet while the CLI keeps working from the map. Sharded buckets were rejected: more code and activation machinery for scales (50k files) this project's users have not reached.
- **D5 · Test posture (technical, asked).** Everything testable with Node's built-in runner and subprocess fixtures — the project's standing convention (`.frame/PROJECT_NOTES.md` → Testing): ranking, normalization, index build/staleness, hook and CLI adapters, benchmark metrics and transcript scoring.
- **D6 · Fallback without an index (technical, silent).** A missing or stale `lookup.json` is never rebuilt in a hook. The hook then compiles the same index in memory from the read view (`structure-read.resolveReadPath`) only if that file is at most 2 MiB, else stays quiet. This keeps today's behavior for a clone without a worker; the CLI always may compile in memory.
- **D7 · Staleness by signature (technical, silent).** `lookup.json` records the signature (`structure-read.artifactSignature`) of the map file it was built from, the signature of `intent-map.json`, the map's `generation.revision` and an algorithm version. Any mismatch with the current files makes the index stale (D6 applies). No hashing of the map in the hook.
- **D8 · Evidence hierarchy (technical, silent; carried from the old D5 with today's measurements).** Tiers, highest first:
  1. exact repo-relative path;
  2. exact curated concept;
  3. curated synonym;
  4. exact basename, with or without extension;
  5. exact symbol (exported name, function name, IPC channel);
  6. partial curated concept (substring either way, today's hook tier 3, kept because transcript replay found it useful — `audit-q3-core-value-efficacy`);
  7. path-token match;
  8. description-token overlap.

  Hooks emit tiers 1–6; tiers 7–8 are CLI-only. A query that exactly names a file is a file request: tiers 1/4 beat a coincidental concept alias. Curated order is preserved; ties sort by path.
- **D9 · Query normalization (technical, silent).** The raw operand is tried first as a path/basename. Tokens are then built with Unicode NFKC, case folding plus Turkish aliases (ı/i, İ/i, ş/s, ğ/g, ç/c, ö/o, ü/u), camelCase/snake_case/kebab-case splitting, the existing noise list, and length ≥ 3 for concept tokens. Raw path identities are never merged: two files differing only in case stay two candidates. Queries are bounded to 512 characters and 8 tokens.
- **D10 · No separate result cache (technical, silent).** The revision-stamped `lookup.json` is the precomputed cache: a query costs one bounded read plus in-memory term lookups, so a candidate cache would add invalidation risk without measurable gain at the D4 cap. The old plan's `structure-retrieval-cache.js` is dropped.
- **D11 · Revision-aware dedup (technical, silent).** The hook's session state (`.frame/runtime/module-hint/<session>.json`, 7-day TTL, unchanged location) keys deliveries by `revision + candidate-set fingerprint` instead of the concept name. A map, curation or engine change therefore permits a new hint in the same session (S4). Without a session id nothing is persisted, so no global bucket is shared across sessions.
- **D12 · Freshness wording (technical, silent).**
  - Fresh map: normal hint.
  - Map `dirty`, or inventory not `complete`: the hook stays quiet, as today for `dirty`.
  - Map `stale` or `unknown`: the hook still hints, but as "candidates — map not verified recently", never as "already answers" (S3).
  - CLI: prints the descriptor as today, plus a structured `freshness` field in `--json` output.
- **D13 · Lookup stays read-only and fast (technical, silent).** `find-module` drops its date heuristic (`stalenessBanner`, which runs `git log` and a full `--check` for up to 30 s) and keeps the STR-02 descriptor only. An unknown map says "Map: unverified (no lifecycle record)". `check-freshness` keeps the drift check.
- **D14 · Path validation (technical, silent).** Before output, each of at most 8 candidates is checked:
  - its relative path must stay inside the root (no `..`, absolute or symlink-escaping path);
  - it must be a regular file now.

  A missing candidate is dropped from hooks and shown with "⚠ missing on disk" by the CLI (S5). Projects and worktrees never share results, because the index lives in each checkout's own runtime directory.
- **D15 · Settings home (technical, silent; verified).** `project.structure` rejects unknown keys (`structure-discovery.js:139`) and feeds the generation policy digest, so retrieval settings live under a new `project.retrieval` key with one field: `engine: "v2" | "legacy"`. An invalid value falls back to the default with a stderr note in the CLI, and silently in the hook.
- **D16 · Collisions (technical, silent).** STR-04 (planned) shares `scripts/eval/run-eval.js`, `score.js` and `structureBootstrap.js`; `audit-q3-performance-resources` (one measurement task left) shares `structureBootstrap.js`. Work stays sequential; STR-04 receives this spec's frozen corpus and measured local baseline.

### A1. Retrieval core

New `scripts/structure-retrieval.js`: pure, dependency-free and shipped to `.frame/bin/`.

- `compileIndex(structure, curation, source)` returns the D4 index object:
  - `version`, `algorithm`, `revision`, `source: { path, signature }`, `curation: { signature }`;
  - `files: [{ path, key, description }]`, with descriptions clipped to 160 characters;
  - `terms`: postings `{ term → [[fileId, tier]] }` for paths, basenames, symbols and description tokens, capped at 64 postings per term and marked truncated;
  - `concepts: { name → { fileIds, synonyms } }`.
- `normalizeQuery(raw)` applies D9.
- `retrieve(index, query, { mode: 'hook' | 'cli', limit })` returns `{ status: 'resolved' | 'ambiguous' | 'no-match', candidates: [{ path, key, tier, evidence, description }], truncated }`.
  - Status is `resolved` only for a single tier-1/2/3/4 answer, or a single curated group.
  - Several exact basenames or symbols are `ambiguous`, and the candidate set is listed.
  - Mode `hook` applies the D8 tier cut; the limit is at most 8.
- `legacyRetrieve(structure, query)` keeps today's tiers exactly (find-module's four, the hook's three) behind the same result shape, for D2 rollback and the A5 baseline.

### A2. Index publication

`scripts/structure-lifecycle.js` (`reconcile`) and `scripts/update-structure.js` (`runFull`, `runDelta`) call one helper after a successful working-view publication, or an unchanged one when the index is missing or stale. The helper is `publishLookup(root)`, new in `structure-retrieval.js`:

- It reads the working view's bytes and `intent-map.json`, compiles the index, and writes `lookup.json` atomically (temp + rename).
- A failure is recorded in the result and never fails the map publication.
- An index above 2 MiB is still written, flagged `oversize: true`, so the CLI can use it and the hook knows to stay quiet.

Discovery, snapshot, writer ownership and refresh timing are not changed (STR-01/02 own them).

### A3. Search hook

`scripts/module-hint.js` keeps its fast non-search bail, segment/heredoc guards, tool vocabulary, activity notes and output contract (`hookSpecificOutput.additionalContext`).

**Changes:**
- Pattern extraction also takes `Glob` patterns, `find -path`, and the full operand for path/basename lookup.
- The engine comes from `project.retrieval.engine`, default per D2. Index loading follows D6/D7, freshness D12, ranking D8, dedup D11 and path checks D14.

**Output:**
- At most 8 files and 1,800 characters. Descriptions are clipped first, and output stops at a whole-candidate boundary.
- It names the evidence ("file name", "symbol", "concept") and the `find-module` command.
- It never claims the search was suppressed.

**New quiet reasons**, with texts in `src/shared/activityEvents.js` `SEARCH_REASON_TEXT`:
- `index-oversize`;
- `map-incomplete`;
- `ambiguous-weak`: only tiers 7–8 matched.

The header comment's obsolete "no sibling imports" rule is rewritten to the real constraint: only read-only helpers. A test enforces it on the import closure (no `child_process`, `net`, `http(s)`, builder or writer modules).

### A4. Explicit lookup

`scripts/find-module.js` uses A1 and keeps positional queries and `--list`. New flags:
- `--json`: one bounded envelope on stdout, with `{ schema: 'frame.lookup/1', status, engine, freshness, candidates, truncated }`. Diagnostics go to stderr. A missing or corrupt map gives `status: 'unavailable'` with exit 1, distinct from `no-match` with exit 0.
- `--limit <n>`: default 8, at most 20.
- `--retrieval=legacy|v2`.

Human output shows evidence and ambiguity, plus ⚠ for missing files. D13 removes the Git/`--check` banner.

### A5. Benchmark, gates and matched-agent instrument

**Corpus.** New `scripts/eval/retrieval-cases.json` holds 180 labelled queries, frozen before tuning, with a SHA-256 of each split recorded in the file:
- Splits: 60 development and 120 held-out, split by file family so paraphrases do not leak.
- Required coverage: at least 30 Turkish queries, 30 no-match/negative queries, 20 singleton files outside every intent group, plus same-name files, symbols, shell/regex noise, a renamed/removed file and a stale map.
- Labels are acceptable file sets in this repository at a pinned commit, and in a small synthetic multilingual fixture generated by the benchmark.

**Runner.** New `scripts/eval/run-retrieval.js`:
1. Exports the pinned commit (`git archive`) into a temp directory.
2. Runs `update-structure.js --full` there (this publishes `lookup.json`).
3. Evaluates both engines through the CLI (`--json`) and the real hook adapter (stdin payloads in the Claude and Codex shapes).
4. Generates synthetic 1k- and 10k-file projects for latency.

It reports, with sample counts per stratum:
- recall@5 (answerable queries), precision@1, emitted-hint precision, false-hint rate on negatives and abstention rate;
- p50/p95 cold-process latency for hook and CLI;
- additionalContext characters and bytes;
- index size and build time.

**Gates for D2,** all on the held-out split:
- 100% expected-file recall on exact path/basename/symbol/curated cases;
- recall@5 ≥ 90% and not below legacy;
- precision@1 ≥ 90%;
- emitted-hint precision ≥ 98%;
- false hints on negatives ≤ 2%;
- hook p95 ≤ 50 ms on this repo and on the 10k fixture, measured on the machine recorded in the README;
- CLI p95 ≤ 150 ms;
- payload within A3.

Tests assert the metric math and gate evaluation, never wall-clock numbers.

**Matched-agent instrument (S8, D1).** `scripts/eval/run-eval.js` gains `--retrieval-arms`: three arms (`no-hint`, `legacy`, `v2`) with identical worktrees, prompts, model and permissions. Only the search-hook registration and engine differ. A cell is invalid if its hook did not emit (or withhold) as the arm intends. `scripts/eval/score.js` adds:
- files found/read;
- search and read calls;
- input tokens including cache-creation and cache-read tokens where reported;
- output tokens, separately;
- elapsed time and failures.

Missing telemetry is `unknown`, not 0, and per-message usage is not double-counted with the final result usage. `tasks.json` gets at least 12 navigation tasks for those arms. The README records the protocol, the gates, the benchmark result and the D2 promotion decision, with S8 marked "pending — run with `node scripts/eval/run-eval.js --retrieval-arms`".

### Coverage

- G1 → A1, A3, A4.
- G2 → A1 (one engine, two modes), D8.
- G3 → A5.
- C1 → D1–D2 (built on the STR-02c read view), A2.
- C2 → D8.
- C3 → D3, A3.
- C4 → D3, D15, A4 (flags are additive).
- C5 → D4, D9, A3 limits, A5 budgets.
- S1 → D8, A1.
- S2 → A1 status/ambiguity, D8 hook cut.
- S3 → D12, A4 `unavailable`.
- S4 → D7, D10, D11.
- S5 → D14.
- S6 → A3, A5 adapter runs.
- S7 → A5 benchmark.
- S8 → A5 instrument, D1.

## Files

- `scripts/structure-retrieval.js` — **New** — index compilation and publication, normalization, tiered retrieval (v2) and the legacy engine.
- `scripts/module-hint.js` — **Modified** — shared engine, index loading/staleness, freshness wording, revision-aware dedup, bounded payload.
- `scripts/find-module.js` — **Modified** — shared engine, `--json`/`--limit`/`--retrieval`, evidence output, no Git banner.
- `scripts/structure-lifecycle.js` — **Modified** — publish `lookup.json` after a working-view publication.
- `scripts/update-structure.js` — **Modified** — publish `lookup.json` after `--full`/file updates.
- `src/main/structureBootstrap.js` — **Modified** — ship `structure-retrieval.js`; entry requirements for `find-module`, `module-hint`, `update-structure`, `structure-lifecycle`.
- `src/shared/activityEvents.js` — **Modified** — texts for the new hook quiet reasons.
- `src/shared/frameTemplates.js` — **Modified** — REFERENCE wording for lookup evidence, `--json`, and `project.retrieval.engine`.
- `package.json` — **Modified** — add `scripts/structure-retrieval.js` to the packaged files.
- `scripts/eval/retrieval-cases.json` — **New** — frozen development/held-out query corpus with split hashes.
- `scripts/eval/run-retrieval.js` — **New** — deterministic quality/latency/payload benchmark and gate evaluation.
- `scripts/eval/run-eval.js` — **Modified** — `--retrieval-arms` (no-hint/legacy/v2) with emission checks.
- `scripts/eval/score.js` — **Modified** — files found/read, search/read calls, full token accounting, unknown-vs-zero.
- `scripts/eval/tasks.json` — **Modified** — navigation tasks for the retrieval arms.
- `scripts/eval/README.md` — **Modified** — protocol, gates, benchmark record, promotion decision, S8 pending note.
- `test/structureRetrieval.test.js` — **New** — tiers, curated precedence, singletons, ambiguity, Turkish/camelCase normalization, limits, legacy parity, index compile/staleness.
- `test/findModule.test.js` — **New** — CLI compatibility, `--json` envelope, `unavailable` vs `no-match`, missing files, engine selection.
- `test/module-hint.test.js` — **Modified** — real adapter payloads, freshness wording/quiet, revision-aware dedup, payload limits, import closure, oversize/missing index fallback.
- `test/structureLifecycle.test.js` — **Modified** — `lookup.json` published with the working view and refreshed on curation change.
- `test/projectAgnostic.test.js` — **Modified** — `update-structure` publishes `lookup.json`; a failed index never fails the map.
- `test/scriptsProjectRoot.test.js` — **Modified** — copied `.frame/bin/` runs lookup and hook without Frame's repo.
- `test/retrievalEval.test.js` — **New** — corpus split integrity, metric and gate math, transcript scoring with synthetic transcripts, arm validity.

## Footprint

- scripts/structure-retrieval.js
- scripts/module-hint.js
- scripts/find-module.js
- scripts/structure-lifecycle.js
- scripts/update-structure.js
- src/main/structureBootstrap.js
- src/shared/activityEvents.js
- src/shared/frameTemplates.js
- package.json
- scripts/eval/retrieval-cases.json
- scripts/eval/run-retrieval.js
- scripts/eval/run-eval.js
- scripts/eval/score.js
- scripts/eval/tasks.json
- scripts/eval/README.md
- test/structureRetrieval.test.js
- test/findModule.test.js
- test/module-hint.test.js
- test/structureLifecycle.test.js
- test/projectAgnostic.test.js
- test/scriptsProjectRoot.test.js
- test/retrievalEval.test.js

## Dependencies

None. The paid matched-agent run uses an already configured agent CLI and runs only on an explicit command (D1).

## Sequencing

1. **Corpus and baseline.** Write `retrieval-cases.json` (frozen splits with hashes) and `run-retrieval.js` measuring the current behavior through the existing CLI and hook. Record the legacy baseline in the eval README. Author `retrievalEval` tests for split integrity and metric/gate math.
2. **Retrieval core.** Add `structure-retrieval.js`:
   - `compileIndex`, `normalizeQuery`, `retrieve` (v2);
   - `legacyRetrieve` reproducing today's tiers;
   - author `structureRetrieval` tests (tiers, curated precedence, singletons, ambiguity, normalization, limits, legacy parity).
3. **Index publication.** `publishLookup` with signatures and the oversize flag; call it from the lifecycle worker and `update-structure.js`; ship the helper (bootstrap, package). Extend the `structureLifecycle`, `projectAgnostic` and `scriptsProjectRoot` tests.
4. **Explicit lookup.** Move `find-module.js` onto the core with `--json`/`--limit`/`--retrieval`, evidence output and the D13 banner removal; author `findModule` tests.
5. **Search hook.** Move `module-hint.js` onto the core with D6/D7 loading, D11 dedup, D12 wording, D14 checks and payload bounds; add the quiet-reason texts. Extend `module-hint` tests (adapters, import closure, fallbacks).
6. **Gate and promotion.** Run the held-out benchmark against both engines, record results in the README, and set the default engine per D2. Update the REFERENCE wording in `frameTemplates.js`.
7. **Matched-agent instrument.** `--retrieval-arms` in `run-eval.js`, token/read/search accounting in `score.js`, navigation tasks in `tasks.json`, and the README S8 protocol marked pending. Extend `retrievalEval` tests with synthetic transcripts and invalid-cell cases.
