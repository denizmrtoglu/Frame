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
