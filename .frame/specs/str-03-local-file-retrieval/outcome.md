# Outcome — STR-03 — Local File Retrieval

## T01 — Frozen corpus, benchmark runner, legacy baseline

`scripts/eval/retrieval-cases.json` holds 194 labelled queries against pinned 262f91b: 72 development and 122 held-out, disjoint by family. It includes 35 Turkish queries (10 purely Turkish), 39 negatives, 72 whose files belong to no intent group, and three tree mutations (removed, renamed, not yet indexed). Each split carries the SHA-256 of its cases. Deviation: the plan said 180 (60/120); the corpus came out larger, and the tests assert minimums (≥60/≥120/≥180, ≥30 Turkish, ≥30 negatives, ≥20 singletons). Labels were checked against the pinned map while authoring, and `test/retrievalEval.test.js` re-checks them against `git ls-tree` of the pinned commit.

`scripts/eval/run-retrieval.js` exports the pinned commit, builds its map with `--full`, and runs every case through `find-module` and the real hook in the Claude (Grep/Glob/Bash) and Codex (Bash, `search codex`) payload shapes. It measures synthetic 1k/10k-file projects too. Engine selection is via `project.retrieval.engine`, with `--json` used when the CLI supports it. Activity records go to a temporary `FRAME_ACTIVITY_HOME`. Metric and gate functions are exported and tested.

Legacy baseline on held-out (recorded in `scripts/eval/README.md`):
- CLI: recall@5 57.4%, exact recall 64.9%, P@1 55.3%.
- Hook: precision 56.6%, false hints 10.7%, p95 33 ms.
- 10k files: hook p95 60 ms.
- 8 gates fail.

Files touched: `scripts/eval/retrieval-cases.json`, `scripts/eval/run-retrieval.js`, `scripts/eval/README.md`, `test/retrievalEval.test.js`.

_Captured: 2026-10-01 · 4 file change(s)_

---

## T02 — Retrieval core

`scripts/structure-retrieval.js` (pure, dependency-free) provides:
- `compileIndex`: files `[[path, description]]`; postings keyed `<tier>:<folded term>` for path, basename (with and without extension), symbol (functions, exports, IPC channels), path words and description words, capped at 64 per term with truncation recorded; concepts `[[name, fileIds, synonyms]]` in intentIndex order.
- `normalizeQuery`: NFKC, Turkish folding (including İ), accent stripping, camel/snake/kebab splitting, regex escapes and glob prefixes stripped, `|` alternatives tried in order, at most 512 characters and 8 units.
- `retrieve`, with the eight tiers.
- `legacyRetrieve`, reproducing find-module's four tiers and the hook's three; a parity test runs the current `find-module.js`.

Rules added during development-split tuning (the held-out split has not been run against v2):
- Every identifier word must be explained by some match. Words with a non-ASCII letter are prose and may stay unexplained.
- When no file carries every word, files rank by how many they carry ("GitHub paneli").
- The hook shows only the leading group (same coverage, tier and score).
- Partial concepts need ≥ 4 letters on both sides (the case that prompted it: "foo|bar" hinted the sidebar group).
- Comment markers (TODO/FIXME/XXX/HACK) are ignored by the hook.

Development split, in process on the pinned map: recall@5 95.1%, P@1 98.3%, hook precision 100%, false hints 0/11. The remaining misses are 2 purely Turkish queries. The pinned map's index is 130 KB, against the 662 KB map. Honest note: the corpus and these rules share an author, so the held-out split guards against tuning, not against that bias. Files touched: `scripts/structure-retrieval.js`, `test/structureRetrieval.test.js`.

_Captured: 2026-10-01 · 2 file change(s)_

---

## T03 — Lookup index publication

`structure-retrieval.js` gained three functions:
- `publishLookup(root, { mapPath, curationPath })`: atomic `.frame/runtime/structure/lookup.json` (compact JSON) recording the source map path and signature (ino/size/mtime/ctime), the intent-map.json signature, revision and algorithm. It returns `unchanged` while those inputs match, and sets `oversize: true` above 2 MiB. It never throws.
- `loadLookup(root, { maxBytes })`: `fresh` / `stale` / `missing` / `oversize` / `invalid`; above the cap it doesn't read the file.
- `indexFromMap(root, { maxBytes })`: the in-memory fallback for D6, which never writes.

The lifecycle worker (`lookup` in its result) and `update-structure.js` (`--full` and file updates, `lookup` in the envelope, with a stderr warning on failure) publish after every working-view publication.

Deviation: `update-structure.js` does not list the new helper in its activation requirements. An existing bootstrap test records that the parser itself must not depend on `structure-read`. The call is guarded instead, so an older `.frame/bin/` just skips the index. `find-module.js` and `module-hint.js` require `structure-retrieval.js` for activation, and it ships as a helper (bootstrap list, `package.json`).

Unplanned, separate: a commit hook hang (170 s in `git hash-object --stdin`, STR-02c's mirror) was fixed on its own branch, `fix/structure-hook-hash-in-process` (PR #168), outside this spec's footprint. Files touched: `scripts/structure-retrieval.js`, `scripts/structure-lifecycle.js`, `scripts/update-structure.js`, `src/main/structureBootstrap.js`, `package.json`, `test/structureRetrieval.test.js`, `test/structureLifecycle.test.js`, `test/projectAgnostic.test.js`, `test/scriptsProjectRoot.test.js`.

_Captured: 2026-10-01 · 9 file change(s)_

---

## T04 — Explicit lookup on the shared engine

`scripts/find-module.js` now uses `structure-retrieval.js` for both engines. Engine selection: `--retrieval=legacy|v2`, else `project.retrieval.engine`, else `DEFAULT_ENGINE` (still `legacy` until T06 decides). An invalid value falls back with a stderr note.

What each engine does:
- `legacy` keeps the feature listing, IPC line, synonym tier and "⚠ file missing" marker (via `legacyRetrieve`).
- `v2` prints "Files for" or "Candidates for … (several match equally)" with `[evidence]` per line. It uses a fresh `lookup.json` when there is one, otherwise compiles from the map.

New flags:
- `--json`: one `frame.lookup/1` envelope with status, engine, freshness, reasons, candidates and truncation. `no-match` exits 0; a missing or corrupt map gives `unavailable` with exit 1.
- `--limit`: default 8, at most 20.

Candidates are present only as regular files inside the project (a symlink escaping it counts as missing). The Git/`--check` date banner is gone (D13). An unknown map now says "⚠ Map: unverified (<reason or no lifecycle record>)", and the STR-02c reader test was updated for that. Files touched: `scripts/find-module.js`, `scripts/structure-retrieval.js` (engine constants), `test/findModule.test.js`, `test/scriptsProjectRoot.test.js`.

_Captured: 2026-10-01 · 4 file change(s)_

---

## T05 — Search hook on the shared engine

`scripts/module-hint.js` resolves the engine from `project.retrieval.engine` (else `DEFAULT_ENGINE`). Legacy keeps today's behavior and output through `legacyRetrieve`.

In v2 the hook:
- Takes the raw pattern (Grep/Glob, `find -name|-path|-wholename`, the first parsable grep/rg/ag/ack segment).
- Stays quiet when the map is dirty or its inventory coverage is not complete.
- Reads a fresh `lookup.json` (≤ 2 MiB). Otherwise it compiles the read view in memory when that is ≤ 2 MiB, else quiet with `index-oversize`.
- Emits only the leading tier-1–6 group. Files must be regular and inside the project.
- Says "points to these files" for a fresh map and "has candidates … — map not verified recently (<freshness>)" otherwise.
- Shell-quotes the query in the suggested command.
- Fits at most 8 files in 1,800 characters: descriptions are clipped first, the cut falls on a whole candidate, and a "… more" line is reserved.
- Dedups by revision plus answer fingerprint (at most 256 per session). Without a session id nothing is persisted.

New quiet reasons: `map-incomplete`, `index-oversize`, `ambiguous-weak`, with texts in `src/shared/activityEvents.js`. Deviations:
- The reasons also had to join `HINT_REASONS`, the enum `hint.quiet` validates against. `test/activityEvents.test.js` (not in the plan's file list) pins that count, so it was updated from 12 to 15.
- The import test became a transitive closure walk (comments stripped), allowing exactly `activity-log`, `redact`, `structure-read`, `structure-retrieval` and `toolVocabulary`, and no `child_process`/network built-ins.

Files touched: `scripts/module-hint.js`, `src/shared/activityEvents.js`, `test/module-hint.test.js`, `test/activityEvents.test.js`.

_Captured: 2026-10-01 · 4 file change(s)_

---

## T06 — Held-out run and promotion decision

Both engines were run once on the held-out split (122 cases) after T05; v2 had been tuned on the development split only.

v2 on held-out: exact recall 100%, recall@5 89.4%, P@1 92.0%, hook precision 96.5% (both adapters), false hints 3.6% (1/28), hook p95 41 ms on this repository and 55 ms at 10k files, max payload 692 characters, a 130 KB index against the 662 KB map. Legacy: 64.9 / 57.4 / 55.3 / 56.6 / 10.7%, 10k-file p95 68 ms.

**The default stays `legacy`** (D2): v2 misses four predeclared gates (recall@5, hint precision, false hints, 10k-file latency), even though it beats legacy on every metric. `DEFAULT_ENGINE` is unchanged, and v2 is opt-in through `project.retrieval.engine` or `--retrieval=v2`.

Failure analysis, without changing the engine afterwards:
- All 10 recall misses are Turkish: 8 purely Turkish queries that need curated synonyms, and 2 with ASCII Turkish words.
- The 3 wrong hints come from the coverage relaxation combined with partial concepts.

Next-round candidates are recorded in `scripts/eval/README.md`, to be validated on a new held-out split. REFERENCE (STRUCTURE.json Rules) gained "Looking Files Up": what find-module answers, `--json`/`--limit`, the hook sharing the engine, and the two engines with the opt-in. Files touched: `scripts/eval/README.md`, `src/shared/frameTemplates.js`.

_Captured: 2026-10-01 · 2 file change(s)_

---

## T07 — Matched-agent instrument

`run-eval.js --retrieval-arms [--repeat N] [--seed S]` runs the new `retrievalSuite` (12 navigation tasks at 262f91b) across `no-hint` / `legacy` / `v2`, in a mulberry32-shuffled, reproducible order.

Each cell:
- builds the map with this checkout's `update-structure.js --full` (which publishes `lookup.json`);
- for hooked arms, sets `project.retrieval.engine` and registers this checkout's `module-hint.js` for Grep|Glob|Bash with a per-cell `FRAME_ACTIVITY_HOME`;
- commits the setup, so it never counts as agent diff;
- records `setupOk`, `hookRecords`, `hintsInjected`, `worktree` and `repeat` in meta.

`score.js` adds:
- search and read calls, files read (made relative to the worktree), and expected files found (read or changed);
- token accounting from the final `result` event only: input, cache creation and cache read, with output separate. No result event means `null`/unknown, kept out of averages.
- `cellValidity`: setup failed, hook never ran while the agent searched, or hook activity in the no-hint arm.
- `paired`: per-task means across repeats, valid cells only, with mean difference and lower/higher/same counts. Comparisons are printed and included in `--json`.

The legacy frame/bare suite is unchanged. Re-scoring the old haiku pilot with cache tokens shows the frame arm used more input tokens (373k vs 173k average), another reason no saving is claimed before S8 runs.

Deviation: task ids are neutral (`nav-01…12`), because descriptive ids leaked file names through the marker line. A test enforces that no prompt contains its file's stem. The README records the S8 protocol as **pending**: the paid run happens only on explicit command. Files touched: `scripts/eval/run-eval.js`, `scripts/eval/score.js`, `scripts/eval/tasks.json`, `scripts/eval/README.md`, `test/retrievalEval.test.js`.

_Captured: 2026-10-01 · 5 file change(s)_

---
