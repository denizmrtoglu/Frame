# Outcome — STR-03b — Retrieval v2 Promotion

## T01 — Freeze heldOut2 (English only)

Scope change during implementation (2026-10-07, user decision): this round is English only. The Turkish filler list and Turkish synonyms were removed from spec, plan and tasks and listed as a later spec.

`scripts/eval/retrieval-cases.json` gained `heldOut2`, written before any STR-03b engine change and frozen with its SHA-256:
- 132 English queries in 21 families, none shared with the development split;
- 26 negatives;
- 18 natural-phrasing queries that name behavior, not files;
- symbols, file names, paths, globs, shell searches, two ambiguous names, and a removed and a renamed file.

The spent STR-03 `heldOut` split stays in the file as a record. No non-negative query repeats one from it.

`test/retrievalEval.test.js` checks:
- English-only queries (ASCII);
- the minimum sizes;
- family disjointness;
- no reuse of spent queries;
- expected files present at the pinned commit, now for every split.

Honest note: the same author wrote the corpus and the fixes; freezing it before the code changes guards against tuning, not against that bias. During this task's suite run, a supervisor test in `structureLifecycle` ("attach starts one worker per checkout") failed once under load and passed on three isolated reruns and the next full run; it is a timing flake outside this spec. Files touched: `scripts/eval/retrieval-cases.json`, `test/retrievalEval.test.js`, and spec/plan/tasks for the scope change.

_Captured: 2026-10-07 · 2 file change(s)_

---

## T02 — Engine rules

`scripts/structure-retrieval.js` (algorithm `str03-v2.2`, so older indexes read as stale):
- **Hook coverage:** in hook mode, a file must carry every required word, otherwise the hint stays quiet. The CLI keeps ranking partial coverage.
- **Definition lines:** a `lines` map (`"<fileId>:<folded function>": line`, functions only). Symbol candidates carry `line` and `symbol`; exports and IPC channels have no line in the map.

Deviations, both found while building:
- **Path postings dropped.** Exact and suffix paths are now matched by scanning the file list, folded once per index object. The line map would otherwise have pushed the 10k-file fixture's index over the 2 MiB hook cap. The pinned map's index went from 130 KB to 164 KB.
- **Short file names are searchable.** A query containing `.` or `/` is never treated as noise. Before, `a.js` or `go.js` was dropped because its words are short.

Development split, unchanged: recall@5 95.1%, P@1 98.3%, hook precision 100%, false hints 0/11. Hook recall went from 93.4% to 91.8%: the Turkish "GitHub paneli" now goes quiet in hooks, which is the intended effect of the stricter rule.

The oversize-index test needed 14,000 modules instead of 9,000 to stay above the cap. Files touched: `scripts/structure-retrieval.js`, `test/structureRetrieval.test.js`.

_Captured: 2026-10-07 · 2 file change(s)_

---

## T03 — Definition lines in find-module

With v2, `find-module` prints function answers as `path:line name` (for example `scripts/structure-commit.js:522 publishStaged`), so the file can be opened at the definition without a follow-up `grep -n`. `--json` candidates carry `line` and `symbol`. File-name, path and concept answers are printed as before. This was checked against the live map: `resolveReadPath` → `scripts/structure-read.js:86`, which is the actual line. The legacy engine's output is unchanged. Files touched: `scripts/find-module.js`, `test/findModule.test.js`.

_Captured: 2026-10-07 · 2 file change(s)_

---

## T04 — The hook sees find-module calls

With v2, `scripts/module-hint.js` parses every Bash call for `node …/find-module.js <query>` (quoted paths, flags, `cd … &&` and pipes; `--list` is ignored), and does this before its non-search bail.
- **Recording:** the query is stored in the session state (`lookedUp`, at most 64 entries) with the map revision from the read contract. The find-module call itself never gets a hint. A command like `find-module X && grep X` is one lookup.
- **Quiet repeat:** a later search in the same session, with the same normalized query and the same revision, stays quiet with reason `already-looked-up`. That reason is added to `HINT_REASONS` and `SEARCH_REASON_TEXT`, and the reason-count test went from 15 to 16.
- **When it hints again:** another session, another query, or a new revision.
- **Hint text:** symbol answers show `path:line name`. The tail reads "Open it at the line shown directly" (or "Open these files directly"), "grep is for searching inside a file", "Your search still runs".

Legacy behavior is unchanged: it records nothing and keeps its wording. Files touched: `scripts/module-hint.js`, `src/shared/activityEvents.js`, `test/module-hint.test.js`, `test/activityEvents.test.js`.

_Captured: 2026-10-07 · 4 file change(s)_

---

## T05 — The worker answers lookups over a local socket

**Worker side.** `scripts/structure-lifecycle.js` in `--watch` and `--supervised` mode starts `startLookupServer` (`startWorker({ serveLookup: true })`; `--once` starts nothing).
- **Address:** the socket sits at `lookupAddress(root)`, which `structure-retrieval.js` defines: `<tmpdir>/frame-lookup-<sha256(realpath) 16 hex>.sock`, or a named pipe on Windows. The path is 83 characters here, under macOS's 104.
- **Endpoint file:** `lookup.endpoint` records the address, pid and algorithm.
- **Protocol:** one JSON line in, one out. The served index refreshes after each published or unchanged lookup and is checked by stat. Answers apply the same contained-file check. A hook-mode miss carries `weak`.
- **Bad input:** a malformed or wrong-version request gets `bad-request`.
- **Shutdown:** stopping removes the endpoint (when it is ours) and the socket.

**Hook side.** `scripts/module-hint.js` (v2) asks the worker first: live pid, same algorithm, a 25 ms budget for connect and answer, path-only connection. It falls back to the `lookup.json` path. `searchMode` is now async, with the same never-throw wrapper.

**Import-closure test.** It now allows `net` only in the hook itself, and only as `net.createConnection({ path: endpoint.address })` with no host or port. No helper may load it, and `tls` was added to the banned list.

**Benchmark.** `scripts/eval/run-retrieval.js` (v2 scale runs) starts `--watch` on the synthetic project, waits for the endpoint and a settled receipt, times the hook again, and compares its answers with the file path. The 10k-file gate uses the worker latency when it was measured. Gates now run on `heldOut2`, and the summary names the split.

Development-split smoke run, without touching `heldOut2`:
- hook precision 100%, hint recall 91.8%, false hints 0;
- 1k files: hook p95 34 ms from the file, 37 ms with the worker;
- **10k files: p95 52 ms from the file, 33 ms with the worker**; both paths gave the same answers for 30 of 30 queries.

Found and fixed while measuring:
- **Line parsing:** the benchmark's hook parser read `path:line` as the path, which showed a false 69.6% precision. It now strips the line.
- **Busy worker:** the first latency run measured while the worker's attach scan held its event loop, which showed p95 81 ms. The benchmark now waits for the steady state.

Design note: while a full reconciliation runs (attach, and the periodic check), the worker cannot answer, so a hook in that window pays up to 25 ms more than the file path. Files touched: `scripts/structure-retrieval.js`, `scripts/structure-lifecycle.js`, `scripts/module-hint.js`, `scripts/eval/run-retrieval.js`, `test/structureLifecycle.test.js`, `test/module-hint.test.js`, `test/retrievalEval.test.js`.

_Captured: 2026-10-07 · 7 file change(s)_

---

## T06 — Wording

`src/shared/frameTemplates.js`:
- **AGENTS navigation:** find-module is described as "concept, file name or function → files", followed by "Its answer is enough to open the file — a function answer comes with its line. Use grep to search inside a file, not to find it again."
- **REFERENCE "Looking Files Up":**
  - function answers come as `path:line name`;
  - the search hint needs one file to match every word, stays quiet while the map updates or when `find-module` already answered in the session, and is answered from memory by the background worker while Frame runs.

`test/projectAgnostic.test.js` checks both texts, and checks that the section names no `.frame/` file a fresh project lacks. As with earlier template changes, this repository's own `.frame/AGENTS.md` and REFERENCE copies are regenerated by Frame, not edited here. Files touched: `src/shared/frameTemplates.js`, `test/projectAgnostic.test.js`.

_Captured: 2026-10-07 · 2 file change(s)_

---
