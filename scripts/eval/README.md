# Orientation Eval — does Frame's context actually help the agent?

An internal measurement instrument (not a product surface). It turns the
core claim — *"Frame keeps an agent oriented, so it edits the right file,
searches less, and succeeds first-try"* — from an assertion into a number.

## Method

Fixed local task suite, A/B by context only:

- **Suite** — `tasks.json`: 10 tasks against this repo pinned to a recorded
  commit. Prompts name *concepts* ("the Claude usage polling", "the GitHub
  issues panel"), not files — finding the right file is the thing being
  measured. Each task declares `expectedFiles` and a deterministic shell
  `successCheck`. Three `scripts/*` tasks name their target file in the
  prompt, deliberately: they isolate execution quality from orientation.
- **Arms** — `frame`: the worktree as-is (AGENTS.md, STRUCTURE.json,
  PROJECT_NOTES.md, tasks.json, find-module.js all present). `bare`: those
  files removed, stripping committed inside the worktree so agent diffs
  stay clean. Same task, same commit, same model — only the context differs.
- **Runner** — `run-eval.js`: ephemeral `git worktree` per task×arm,
  headless agent (`claude -p … --output-format stream-json`, binary/flags
  configurable via `FRAME_EVAL_AGENT` / `FRAME_EVAL_AGENT_ARGS`), per-run
  timeout, captures `transcript.jsonl`, `diff.patch` (before the
  successCheck runs), and the check verdict; worktrees always removed.
- **Scorer** — `score.js`: deterministic, no LLM judging.
  - **first-try success** — successCheck passed, no timeout
  - **wrong-file edits** — changed files ∉ expectedFiles (meta files like
    STRUCTURE.json excluded: regenerating them alongside a change is
    legitimate)
  - **search effort** — Grep/Glob/grep-ish-Bash tool calls before the first
    Edit/Write
  - turns, tool calls, duration, output tokens

## How to run

```bash
node scripts/eval/run-eval.js                          # full suite, both arms
node scripts/eval/run-eval.js --task <id> --arm bare   # one cell
node scripts/eval/score.js scripts/eval/results/<run>  # summary table (--json for machine use)
```

`results/` is gitignored — transcripts are bulky. Only this README's
summary is versioned.

## How to interpret

The frame−bare delta *is* the measured orientation benefit. Look at
wrong-file edits and search-before-first-edit first — they are the direct
"stays oriented" signals; first-try success is the outcome signal but also
absorbs model-capability noise. Single runs are noisy: model responses are
not deterministic, so treat small deltas (±1 task) as noise and re-run
before concluding. The suite must be re-pinned (new `pinnedCommit`, checks
re-verified) whenever the referenced code moves materially.

## Baseline — pending

No baseline numbers are recorded yet, deliberately. A pilot run
(2026-07-06, 10 tasks × 2 arms, **single run per cell, haiku**, pinned
`ccbd47d`) validated the instrument end-to-end — worktrees, stripping,
capture, scoring all work, and the deltas appeared exactly where the
design predicts (in concept-named tasks, not in the file-named `scripts/*`
controls) — but a single non-deterministic run per cell is too weak to
publish as *the* number: the success-rate delta was 2 paired wins on
n=10 (sign test p≈0.25), and one bare-arm cell looked like an agent
anomaly (0 tool calls, 8s) rather than a context effect.

**What a credible baseline needs** (then record it here):
- 3–5 repeats per cell, default model (not haiku)
- report per-task paired wins/losses with a sign test, not just arm means
- re-check the anomalous cells before counting them

The pilot's methodological catches are already folded into the harness:
diffs are taken against the starting sha (agents that self-commit in the
worktree no longer hide their changes), and grep-based success checks
measure "did the named change land", not code quality.

---

# Retrieval benchmark (STR-03)

Does `find-module` find the right file, and does the search hook speak only
when it should? A deterministic, local measurement: no agent, no network.

## Method

- **Corpus** — `retrieval-cases.json`: 194 labelled queries against this
  repository at `pinnedCommit` (262f91b). 72 development and 122 held-out,
  disjoint by file family so paraphrases cannot leak between the splits.
  35 Turkish queries (10 purely Turkish, with no identifier in them), 39
  negatives, 72 whose expected files belong to no intent group, plus shell
  and regex noise, same-name files, symbols, and three cases that change the
  tree after indexing (a removed file, a renamed file, a file the map has not
  seen). `expect` lists the acceptable files; `[]` means nothing should be
  returned. Each split carries the SHA-256 of its cases, frozen before any
  tuning; `test/retrievalEval.test.js` fails if a split is edited.
- **Runner** — `run-retrieval.js`:
  1. Exports the pinned commit with `git archive` and builds its map with this
     checkout's `update-structure.js --full`.
  2. Runs every case through `find-module.js` and the real `module-hint.js`
     adapters, with Claude Code payloads (Grep/Glob/Bash) and Codex payloads
     (Bash only, `search codex`). Every case is a cold process.
  3. Generates synthetic 1k- and 10k-file projects for latency and index size.
- **Metrics**:
  - recall@5 (answerable cases, CLI);
  - exact recall (path/basename/symbol/curated/synonym cases that are not Turkish-mixed);
  - precision@1 (cases where the CLI returned anything);
  - per adapter: emitted-hint precision, hint recall, false-hint rate on negatives, abstention;
  - p50/p95 latency; additionalContext characters and bytes;
  - map/lookup size and build time;
  - strata per tag.

```bash
node scripts/eval/run-retrieval.js                  # every split and available engine
node scripts/eval/run-retrieval.js --split heldOut --engine v2 --no-scale
node scripts/eval/run-retrieval.js --json           # the full report
```

## Gates

Evaluated on the held-out split only, and decided before the new engine was
written. The new engine becomes the default only when all of them pass:

| Gate | Limit |
|---|---|
| Exact recall | 100% |
| recall@5 | ≥ 90% and not below legacy |
| precision@1 | ≥ 90% |
| Emitted-hint precision, every adapter | ≥ 98% |
| False hints on negatives, every adapter | ≤ 2% |
| Hook p95, this repository and the 10k-file fixture | ≤ 50 ms |
| CLI p95 | ≤ 150 ms |
| Hook payload | ≤ 1,800 characters |

## Legacy baseline — 2026-10-01

Apple M2 · macOS (Darwin 24.6.0) · node v20.20.0 · pinned 262f91b. The map is
662 KB; `--full` builds it in 194 ms.

| Held-out (122) | CLI | Hook (Claude) | Hook (Codex) |
|---|---|---|---|
| recall@5 / hint recall | 57.4% | 31.9% | 31.9% |
| Exact recall (77) | 64.9% | — | — |
| precision@1 / emitted precision | 55.3% | 56.6% | 56.6% |
| False hints on negatives | — | 10.7% | 10.7% |
| p50 / p95 | 41 / 44 ms | 30 / 33 ms | 30 / 33 ms |
| Max payload | — | 852 chars | 852 chars |

Development split (72): CLI recall@5 63.9%, P@1 68.1%; hook precision 63.9%,
false hints 27.3%. Scale: 1k files gives a 607 KB map and hook p95 28 ms;
10k files gives a 6.1 MB map and hook p95 60 ms (the hook parses the whole
map on every search).

Legacy fails 8 gates: exact recall, recall@5, precision@1, emitted precision
and false hints (both adapters), and the 10k-file hook latency. The misses are
the ones the spec describes: files outside every intent group, function names,
and partial concept matches that hint the wrong group (for example
`structureBootstrap nerede` → every file in the `structure` group).

## Held-out result and promotion decision — 2026-10-01

Same machine and pin as the baseline. v2 was tuned on the development split
only. The held-out split was run once, for both engines, after T05.

| Held-out (122) | legacy | v2 | Gate |
|---|---|---|---|
| Exact recall (77) | 64.9% | **100%** | 100% ✓ |
| recall@5 | 57.4% | 89.4% | ≥ 90% ✗ |
| precision@1 | 55.3% | **92.0%** | ≥ 90% ✓ |
| Emitted-hint precision (Claude / Codex) | 56.6% | 96.5% | ≥ 98% ✗ |
| Hint recall | 31.9% | 88.3% | — |
| False hints on negatives (28) | 10.7% | 3.6% (1) | ≤ 2% ✗ |
| Hook p50/p95, this repository | 31 / 35 ms | 34 / 41 ms | ≤ 50 ms ✓ |
| Hook p95, 10k files | 68 ms | 55 ms | ≤ 50 ms ✗ |
| CLI p95 | 30 ms | 39 ms (10k: 105 ms) | ≤ 150 ms ✓ |
| Max payload | 852 chars | 692 chars | ≤ 1,800 ✓ |
| Index read by the hook | 662 KB map | 130 KB lookup | — |

Development split, v2: recall@5 95.1%, P@1 98.3%, hook precision 100%,
false hints 0/11.

**Decision: the default stays `legacy`.** v2 is better than legacy on every
measured metric, but it misses four predeclared gates, and the rule fixed
before the run was that all of them must pass. v2 is available now with
`--retrieval=v2` or `"project": { "retrieval": { "engine": "v2" } }` in
`.frame/config.json`.

Failure analysis (no engine change was made after this run):
- **recall@5:** all 10 misses are Turkish queries. 8 are purely Turkish
  ("ayarlar", "komut paleti", "güncelleme kontrolü") and need Turkish
  synonyms in `intent-map.json`, which is curation and out of scope. 2 contain
  ASCII Turkish words that the coverage rule cannot treat as prose
  ("structureBootstrap nerede", "ana sayfa widget kaydı").
- **Hint precision and false hints:** the 3 wrong hints come from the
  "no file carries every word → rank by coverage" relaxation combined with
  partial concepts. "görev paneli" hinted the `panel` group, "görev çalıştırma
  modalı" the `modal` group, and "docker compose" `feedbackReport.js` (`dock` ⊂
  "docker", plus its `compose` function).
- **10k-file latency:** the 1.9 MB lookup index costs about 25 ms to parse on
  top of node's startup.

Candidates for the next round, each to be validated on a **new** held-out
split (this one is now spent):
1. Hooks require every identifier word to be covered by one file; the
   relaxation stays CLI-only.
2. Turkish synonyms for the curated concepts.
3. A smaller index at scale: drop description postings for hooks, or split the
   index by tier.

## Matched-agent navigation (S8) — pending

Does the search hint actually save the agent work? The retrieval benchmark
measures the hint, not its effect. This run measures the effect, and it costs
real agent time and tokens, so it only runs when asked.

- **Suite** — `retrievalSuite` in `tasks.json`: 12 navigation tasks at the
  corpus pin (262f91b). Each prompt describes a file's behavior, never its
  name. The task is done when a marker comment lands in that file and in no
  other (`successCheck`).
- **Arms** — `no-hint`, `legacy`, `v2`. Every cell gets its own worktree,
  with this checkout's `update-structure.js --full` map and the same prompt,
  model and permissions. Only the search hook differs: none, or this
  checkout's `module-hint.js` with the arm's engine. The hook writes to a
  per-cell `FRAME_ACTIVITY_HOME`.
- **Validity** — a cell is invalid, and excluded from comparisons, when:
  - its setup failed;
  - a hooked arm's hook never ran although the agent searched;
  - the no-hint arm recorded hook activity.
- **Scoring** (`score.js`):
  - expected files found (read or changed);
  - search calls and read calls;
  - input tokens including cache creation and cache reads, output tokens separately;
  - elapsed time, failures.

  Tokens come only from the final `result` event; a run without one is
  `unknown`, not 0. Arms are compared per task (repeats averaged first): mean
  difference, and how many tasks went down / up.

```bash
node scripts/eval/run-eval.js --retrieval-arms --repeat 5 --seed 7   # 12 × 3 × 5 = 180 agent runs
node scripts/eval/score.js scripts/eval/results/<run>
```

**Status: not run yet.** No token saving is claimed for v2. A hint firing
does not show that work was saved; only this paired measurement can.

## STR-03b — heldOut2 result and promotion decision — 2026-10-07

What changed since the STR-03 run:
- hooks need one file to carry every word;
- function answers carry their line;
- a hint stays quiet after `find-module` answered the same lookup;
- the lifecycle worker answers hooks over a local socket.

`heldOut2` is a new English-only split, frozen before those changes: 132 cases, 106 answerable, 26 negative. It ran once for both engines. Same machine (Apple M2, Darwin 24.6.0, node v20.20.0) and pin. This round is English only; Turkish queries are not measured and are deferred to a later spec.

| heldOut2 (132) | legacy | v2 | Gate |
|---|---|---|---|
| Exact recall (87) | 69.0% | **100%** | 100% ✓ |
| recall@5 | 67.9% | **92.5%** | ≥ 90% ✓ |
| precision@1 | 53.6% | **92.3%** | ≥ 90% ✓ |
| Hint precision (Claude / Codex) | 65.9% | 97.8% (88 of 90) | ≥ 98% ✗ |
| Hint recall | 50.9% | 83.0% | — |
| False hints on negatives | 30.8% | 7.7% (2 of 26) | ≤ 2% ✗ |
| Hook p95, this repository | 37 ms | 40 ms | ≤ 50 ms ✓ |
| Hook p95, 10k files, lookup.json | 60 ms | 51 ms | — |
| Hook p95, 10k files, running worker | — | **34 ms** (same answers 30/30) | ≤ 50 ms ✓ |
| CLI p95 | 31 ms | 37 ms | ≤ 150 ms ✓ |
| Max payload | 809 chars | 660 chars | ≤ 1,800 ✓ |

**Decision: the default stays `legacy`.** v2 passes every gate except the two
about wrong hints, and it misses those by two hints. Both wrong hints come
from one rule: the partial-concept tier (6) applied to a code identifier.
- `useState` (a negative) contains the concept `state`, so the hint offered
  `dockState.js`, `sectionState.js` and `accessState.js`.
- After `pollGate.js` was removed, its own name contains `gate`, so the hint
  offered the gate group.

The engine was not changed after this run.

Candidate for the next round, to be validated on a new split: the hook stops
at tier 5 (path, concept, synonym, file name, symbol) and leaves partial
concepts to `find-module`, or it allows them only for a query that is not a
single camelCase identifier.

## STR-03b — Opus without the engine vs v2 (pilot) — 2026-10-07

Question: what does Opus do, spend and take to find code when Frame's search engine is not there, compared with v2?
- **`no-engine`** removes the search hint, `find-module` and the find-module instructions. The rest of Frame stays.
- **`v2`** runs this checkout's engine with the lifecycle worker answering hints.

Setup: 16 tasks (10 natural English change requests, 6 question-only) × 2 arms × 1 repeat, `claude --model opus`, seed 7, pinned 262f91b. All 32 cells were valid and passed. The repository was unchanged afterwards.

| Per task, average | no-engine | v2 | Change |
|---|---|---|---|
| Input tokens (incl. cache) | 169,095 | 137,858 | **−18.5%** |
| Output tokens | 1,397 | 1,093 | −21.8% |
| Time | 29.7 s | 22.7 s | **−23.6%** |
| Agent turns | 8.8 | 7.4 | −15.9% |
| Tool calls | 5.1 | 4.1 | −20.3% |
| Lookups (find-module + searches) | 5.25 | 4.81 | −8.4% |
| Success | 16/16 | 16/16 | — |

| By kind | no-engine | v2 | Change |
|---|---|---|---|
| Natural requests: input tokens | 205,507 | 174,161 | −15.3% |
| Natural requests: time | 40.3 s | 31.7 s | −21.3% |
| Questions: input tokens | 108,408 | 77,352 | −28.6% |
| Questions: time | 12.0 s | 7.7 s | −35.8% |

Paired by task, v2 used fewer input tokens on 14 of 16 tasks and less time on 12 of 16.

How to read it: one repeat per cell is a pilot, not a verdict. One no-engine natural cell took 116 s against 13 s with v2, which inflates the time average. In natural requests, repeated lookups did not go down (1.9 vs 2.1). In v2 the agents mostly followed AGENTS and ran `find-module` first, so the hint itself rarely fired: the gain here comes from the lookup answering directly. Five repeats would settle the size of the effect (`--repeat 5`).
