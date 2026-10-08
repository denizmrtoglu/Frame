---
keywords: STR, retrieval, v2, promotion, search hint, hook latency, benchmark gates, find-module, duplicate lookups, agent eval
related: str-03-local-file-retrieval, str-02-structure-lifecycle, str-04-jev-evaluation, audit-q3-core-value-efficacy
---

# STR-03b — Retrieval v2 Promotion

## Problem

STR-03's v2 retrieval beats the legacy engine on every measured metric, but it missed four of its predeclared held-out gates. Because of that, `legacy` stays the default: most agents keep getting a hint that is wrong about half the time (legacy hint precision 56.6%), while the better engine sits behind an opt-in. The failure analysis traced each miss to a specific cause:

| Gate | v2 result | Target | Cause |
|---|---|---|---|
| recall@5 | 89.4% | ≥ 90% | all 10 misses are Turkish queries (8 purely Turkish, 2 with ASCII Turkish words); every English answerable query was found |
| Hint precision | 96.5% | ≥ 98% | 3 wrong hints, from the hook applying the "no file carries every word → rank by coverage" relaxation together with partial concepts ("görev paneli", "görev çalıştırma modalı", "docker compose") |
| False hints | 3.6% | ≤ 2% | the same relaxation ("docker compose") |
| Hook p95 at 10k files | 55 ms | ≤ 50 ms | node startup (~30 ms) plus parsing a 1.9 MB lookup index on every search |

A second problem showed up in real sessions: **agents look the same thing up twice.** AGENTS.md tells them to run `find-module` before a broad grep, and they do. But `find-module` only gives a path, so they follow with `grep -n` to find the spot inside the file. That grep triggers the search hint, which repeats the answer `find-module` just gave, because the hook does not know `find-module` ran. One lookup becomes three calls, and the same context enters the window twice.

What it costs is not measured yet. In this project's own STR session (an author who mostly knew the paths), 148 Bash calls contained searches and the legacy hint fired 22 times, of which at most 2 were relevant. Neither that session nor the STR-03 benchmark measures agents in realistic, conversational requests.

## Goal

Fix these causes, measure the result on a new held-out split, and promote v2 to the default engine if every gate passes:
- In hook mode, every identifier word must be covered by a single file. The relaxation stays in the CLI only.
- A search hint at 10k files returns within the latency budget.
- A new frozen corpus split replaces the spent held-out split, and the gates are re-run once. This round is **English only**: the new split has no Turkish queries, and the gates are measured on English queries.
- `DEFAULT_ENGINE` becomes `v2` only if every gate passes.
- One lookup per question:
  - `find-module` prints the definition line for symbol matches (`path:line name`, from the map's function lines);
  - the search hook notices a `find-module` call in the same session and stays quiet when a later search asks for the same thing;
  - the generated AGENTS/REFERENCE text says a `find-module` answer is enough to open the file, and grep is for searching inside it.
- The matched-agent evaluation runs on realistic work:
  - natural, conversational requests in English that name behavior, never files;
  - question-only tasks that measure lookup cost without edits;
  - the existing 12 navigation tasks.

  All of it runs across the no-hint / legacy / v2 arms, and the results for every arm are recorded.

## Constraints

- Keep STR-03's gates and their values unchanged (`scripts/eval/run-retrieval.js` `GATES`); the decision rule "all gates pass, or the default stays legacy" from STR-03 D2 stands.
- The STR-03 held-out split is spent; the new split is written and hashed before any tuning, by family, and is never used for tuning.
- Keep the hook contract (STR-03 D3, `codex-parity`): never block, exit 0 on any failure, no Git, no rebuild, no network, bounded payload.
- `legacy` stays selectable as the rollback path (`--retrieval=legacy`, `project.retrieval.engine`).
- Curation stays in `intent-map.json` and keeps its authority (STR-01 curation, `audit-q3-core-value-efficacy`): synonyms are added, never inferred by a model.
- Development-split results must not regress (STR-03: recall@5 95.1%, P@1 98.3%, hint precision 100%, false hints 0/11).
- The evaluation leaves the repository untouched:
  - every cell runs in a temporary detached worktree that is removed afterwards;
  - results and hook activity go outside the repository (`--out`);
  - `git status`, `git branch` and `git worktree list` are the same before and after a run.
- Agent runs cost real usage. They run only on an explicit command, starting with a one-repeat pilot; the model is chosen at that point.
- A `find-module` answer stays within its current output bounds (at most 20 candidates); line numbers add no extra lookup work.

## Success Criteria

1. When a hook query has an identifier word that no single file shares with the other words, then the hook stays quiet while `find-module` still lists the ranked candidates.
2. When the gates run, then they run on the English-only `heldOut2` split, and the README states that Turkish queries are not measured in this round.
3. When the hook runs on the 10k-file synthetic project, then its p95 is at most 50 ms on the recorded reference machine, and its answers match the ones from reading `lookup.json`.
4. When the new held-out split runs once, then the README records every gate for both engines with sample counts.
5. When all gates pass, then `DEFAULT_ENGINE` is `v2`, the REFERENCE wording says so, and legacy stays selectable. When any gate fails, then the default stays `legacy` and the failed gate is named.
6. When `find-module` answers a function, export or IPC name, then each such candidate shows the line it is defined on.
7. When an agent runs `find-module X` and then searches for X in the same session, then the hook does not repeat the answer, and the activity record says why (`already-looked-up`).
8. When a matched-agent run finishes, then for every arm the report shows:
   - lookups per task: `find-module`, Grep/Glob, search-bearing Bash calls;
   - repeated lookups, meaning the same term looked up again after an answer;
   - input tokens including cache, output tokens, elapsed time, and success.

   These are shown per task type (natural request, question-only, navigation), with invalid cells excluded.
9. When a question-only task finishes, then its success is decided from the agent's final answer (the expected path appears in it), not from a file change.
10. When an evaluation run ends, successful or not, then `git status`, `git branch` and `git worktree list` match their state before the run.

## Out of Scope

- Turkish queries (Turkish synonyms for curated concepts, Turkish filler words such as "nerede" or "ana sayfa", Turkish agent requests): deferred to a later spec, after this English round.
- Semantic or remote reranking, embeddings: `str-04-jev-evaluation`.
- The paid matched-agent run (STR-03 S8).
- Moving hand-written prose out of `STRUCTURE.json` (a separate architecture spec).
- Consolidating the runtime state files.

## Open Questions

- **Hook latency at 10k files:**
  - (a) the hook asks the already-running lifecycle worker over a local socket and falls back to `lookup.json` without one;
  - (b) a smaller index for hooks: drop description postings or split the index by tier.
- **Model for the agent runs:** the default model (more representative, costlier) or Haiku (cheaper, noisier); the README's pilot note recommends the default model.
