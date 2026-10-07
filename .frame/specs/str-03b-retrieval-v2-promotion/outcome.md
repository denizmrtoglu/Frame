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
