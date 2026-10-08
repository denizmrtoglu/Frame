# Plan — STR-03b — Retrieval v2 Promotion

## Architecture

### Resolved plan-time decisions

- **D1 · Model for agent runs (business, asked 2026-10-07).** The default model. A one-repeat pilot across every arm runs first; the five-repeat run follows only if the pilot's cells are valid. Haiku was rejected as noisier and less representative.
- **D2 · Hook latency (technical, asked).** The hook asks the running lifecycle worker over a local socket and falls back to `lookup.json` when no worker answers. Rejected: a smaller hook index, because node's ~30 ms startup would remain and the gain is limited.
- **D3 · English only for now (business, decided 2026-10-07).** This round covers English queries only. The Turkish work — a filler-word list (chosen earlier for ASCII Turkish words) and Turkish synonyms — moves to a later spec. `heldOut2` has no Turkish cases, and the natural agent requests are in English.
- **D4 · Test posture (technical, asked).** Everything testable, by the project's standing convention (`.frame/PROJECT_NOTES.md` → Testing).
- **D5 · Gates and rule unchanged (carried, STR-03 D2).** Same `GATES`, and all must pass, otherwise the default stays `legacy`. The STR-03 held-out split is spent. A new split `heldOut2` is written and hashed **before** any engine change in this spec (Sequencing step 1); the old split stays in the file as a record.
- **D6 · Hook requires one file to carry every word (silent; STR-03 failure analysis).** In `mode: 'hook'` the "rank by words covered" relaxation is off; the CLI keeps it.
- **D8 · Socket placement (silent; verified).**
  - The path is `<os.tmpdir()>/frame-lookup-<sha256(realpath(root)) first 16 hex>.sock` on POSIX and `\\.\pipe\frame-lookup-<same>` on Windows, because macOS caps a socket path at 104 characters.
  - The worker writes the address into `.frame/runtime/structure/lookup.endpoint` with its pid and the lookup revision.
  - "Local socket" is process-to-process IPC, not the network that the hook contract (STR-03 D3) forbids.
- **D9 · Socket protocol (silent).**
  - One newline-terminated JSON request per connection: `{ v: 1, query, mode: 'hook', limit }`. The answer is the `retrieve` result plus `revision`.
  - The hook gives the socket 25 ms in total (connect + answer). On a timeout, refusal or version mismatch it reads `lookup.json` as today. A stale endpoint whose pid is dead is ignored.
  - The worker answers from the in-memory index it published, and rebuilds that index whenever it publishes `lookup.json`.
- **D10 · find-module awareness (silent).** The search hook already runs on every Bash call. A command that runs `find-module` (`node …/find-module.js <query>`) is parsed before the fast bail. Its query is recorded in the session state (`lookedUp: [{ query, revision }]`, capped at 64), and the command itself gets no hint. A later search whose normalized query matches a recorded one, at the same revision, stays quiet with the new reason `already-looked-up`.
- **D11 · Line numbers (silent; verified: every function in the map carries `line`).** Function candidates show `path:line name`. Exports and IPC channels carry no line in the map, so they show the path only. In `--json`, a candidate gets `line` when it is known.
- **D12 · Wording (silent).** The AGENTS navigation and REFERENCE "Looking Files Up" say that a `find-module` answer is enough to open the file (with its line), and that grep is for searching inside a file.
- **D13 · Evaluation design (silent; from the spec).**
  - `tasks.json` `retrievalSuite` tasks gain `kind: 'navigation' | 'natural' | 'question'`:
    - `natural`: conversational English requests that name behavior and never files; success is a check on the file change;
    - `question`: no edit; success is `answerCheck`, the expected path appearing in the final `result` text.
  - Lookup metrics, computed from transcripts:
    - lookups per task: `find-module` Bash calls, Grep/Glob, search-bearing Bash calls, using the hook's own leading-segment rule;
    - repeated lookups: the same normalized term looked up again after an answer.
- **D14 · Repository cleanliness (silent; from the spec).** `run-eval.js` snapshots `git status --porcelain`, `git branch --list` and `git worktree list` before a run and compares them afterwards. A difference is printed and makes the run exit non-zero. `--out` defaults to the OS temp directory for retrieval arms.
- **D15 · Collisions (silent).** `str-04-jev-evaluation` (planned) shares the eval files. The `exp/find-module-first` worktree is the user's own experiment and is not part of this spec.

### A1. Engine rules (`structure-retrieval.js`)

- Hook mode drops the coverage relaxation (D6).
- `ALGORITHM` goes to `str03-v2.2`, so indexes compiled under the old rules are stale.
- `retrieve` returns `line` for function evidence from a new `lines` map in the index: `{ "<fileId>:<symbol>": line }`, functions only.

### A2. Worker socket (`structure-lifecycle.js`)

In `--watch` and `--supervised` modes, after the first publication:
- the worker listens on the D8 address;
- it keeps the last compiled index in memory and answers D9 requests;
- it writes `lookup.endpoint` atomically, and removes both the endpoint and the socket on exit.

`--once` starts no server. A failure to listen is recorded and never stops the worker.

### A3. Hook (`module-hint.js`)

For v2 only:
1. D10 parsing comes first.
2. Then the socket query (D9).
3. Then today's `lookup.json` / in-memory path.

D12 wording goes into the hint tail. The quiet reason `already-looked-up` is added to `activityEvents` (`HINT_REASONS`, `SEARCH_REASON_TEXT`). Legacy behavior is unchanged.

### A4. CLI (`find-module.js`)

`path:line name` for function candidates in human output, and `line` in `--json` (D11).

### A5. Evaluation

- **Corpus:** `retrieval-cases.json` gains `heldOut2`: English only, at least 120 cases, families disjoint from development, at least 25 negatives, natural-phrasing cases included, frozen with SHA-256 before step 2.
- **Benchmark:** `run-retrieval.js` takes `--split heldOut2`. It measures the hook with and without a worker socket: it starts `structure-lifecycle.js --watch` on the 10k fixture and waits for its endpoint.
- **Agent runs:**
  - `run-eval.js`: `--out` outside the repository, the D14 check, and `kind` / `answerCheck`;
  - `score.js`: the D13 lookup and repeat metrics, a per-kind summary, and answer-checked success;
  - `tasks.json`: 10 natural and 6 question tasks, added to the 12 navigation tasks.
- **README:** the protocol, `heldOut2` results, the promotion decision and the pilot results.

## Files

- `scripts/structure-retrieval.js` — **Modified** — hook coverage rule, function line map, algorithm v2.2.
- `scripts/structure-lifecycle.js` — **Modified** — local socket server and endpoint file in watch and supervised modes.
- `scripts/module-hint.js` — **Modified** — find-module awareness, socket client with fallback, D12 wording.
- `scripts/find-module.js` — **Modified** — definition lines for function candidates.
- `src/shared/activityEvents.js` — **Modified** — `already-looked-up` reason and text.
- `src/shared/frameTemplates.js` — **Modified** — AGENTS and REFERENCE wording (D12).
- `scripts/eval/retrieval-cases.json` — **Modified** — frozen `heldOut2` split.
- `scripts/eval/run-retrieval.js` — **Modified** — split selection and socket-backed latency.
- `scripts/eval/run-eval.js` — **Modified** — task kinds, answer checks, `--out` default, repository check.
- `scripts/eval/score.js` — **Modified** — lookups, repeats, per-kind summary, answer-checked success.
- `scripts/eval/tasks.json` — **Modified** — natural and question tasks.
- `scripts/eval/README.md` — **Modified** — protocol, results, decision.
- `test/structureRetrieval.test.js` — **Modified** — hook coverage, lines.
- `test/structureLifecycle.test.js` — **Modified** — socket lifecycle, endpoint, answers, cleanup.
- `test/module-hint.test.js` — **Modified** — find-module awareness, socket path and fallback, wording.
- `test/findModule.test.js` — **Modified** — line output.
- `test/activityEvents.test.js` — **Modified** — reason count.
- `test/retrievalEval.test.js` — **Modified** — `heldOut2` integrity, lookup and repeat metrics, answer checks, repository check.
- `test/projectAgnostic.test.js` — **Modified** — template wording.

## Footprint

- scripts/structure-retrieval.js
- scripts/structure-lifecycle.js
- scripts/module-hint.js
- scripts/find-module.js
- src/shared/activityEvents.js
- src/shared/frameTemplates.js
- scripts/eval/retrieval-cases.json
- scripts/eval/run-retrieval.js
- scripts/eval/run-eval.js
- scripts/eval/score.js
- scripts/eval/tasks.json
- scripts/eval/README.md
- test/structureRetrieval.test.js
- test/structureLifecycle.test.js
- test/module-hint.test.js
- test/findModule.test.js
- test/activityEvents.test.js
- test/retrievalEval.test.js
- test/projectAgnostic.test.js

## Dependencies

None. Node's built-in `net` serves the socket. Agent runs use the configured `claude` CLI with the default model, on explicit command only.

## Sequencing

1. **Freeze `heldOut2`.** Write the new held-out split with its hash, before any engine change. Extend `retrievalEval` with its integrity checks.
2. **Engine rules.** Hook coverage rule, function line map, algorithm v2.2. Check them on the development split. Extend `structureRetrieval`.
3. **Line numbers in `find-module`.** Extend `findModule`.
4. **find-module awareness in the hook.** Session record, `already-looked-up` quiet reason, wording in the hint. Extend `module-hint` and `activityEvents`.
5. **Worker socket.** Server and endpoint in the worker, client and fallback in the hook. Socket-backed latency in `run-retrieval.js`. Extend `structureLifecycle` and `module-hint`.
6. **Wording.** AGENTS and REFERENCE text (D12). Extend `projectAgnostic`.
7. **Agent evaluation instrument.** Task kinds, answer checks, lookup and repeat metrics, `--out` default and the repository check. 10 natural and 6 question tasks. Extend `retrievalEval`.
8. **Gate run and decision.** Run `heldOut2` once for both engines, record the results, and set `DEFAULT_ENGINE` per D5.
9. **Agent pilot.** On explicit command: all kinds × three arms × one repeat, default model. Record the results, and check the repository afterwards. The five-repeat run is offered with the pilot results.
