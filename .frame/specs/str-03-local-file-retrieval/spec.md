---
keywords: STR, structure, file retrieval, module hints, local search, cache, evaluation, token savings
related: reliable-structure-generation, str-02-structure-lifecycle, str-04-jev-evaluation, audit-q3-core-value-efficacy, audit-q3-deterministic-graph-hints, codex-parity
---

# STR-03 — Local File Retrieval

## Problem

Being present in STRUCTURE does not guarantee a file can be found through a hint. Current hooks depend on intent groups, leaving single-file concepts invisible, while broad content matching previously produced noisy hints. Session deduplication does not account for map changes. Moreover, injecting a hint does not itself prevent the original search or prove token savings.

## Goal

Give agents a fast local route from a filename, path, symbol, or concept to a small set of relevant files. Share retrieval semantics between explicit lookup and supported search hooks, while allowing hooks stricter evidence thresholds. Measure actual navigation effort and establish the baseline for STR-04.

## Constraints

- Series: **STR — Structure Reliability and Retrieval**. Order: STR-01 → STR-02 → STR-03 → STR-04. Depends on `reliable-structure-generation` and `str-02-structure-lifecycle` for coverage, identity, and revision contracts.
- Retain curated intent precedence from `audit-q3-core-value-efficacy`. Candidate discovery must also reach individual modules without requiring an intent group. Do not restore broad noisy hook matching without measured evidence.
- Preserve the additive, non-blocking hook contract recorded in `audit-q3-deterministic-graph-hints` and `codex-parity`: search remains available, malformed input degrades quietly, and no network request or map rebuild occurs in the hook.
- Keep existing CLI adapters and user settings intact. This is STRUCTURE retrieval; the graph-specific work in `audit-q3-deterministic-graph-hints` remains separate.
- Use bounded local work, payloads, and caches. Set latency, payload, and false-positive budgets during planning before comparing implementations; preserve the existing approximately 50 ms hook target unless evidence justifies an explicit revision.

## Success Criteria

1. When a query names an indexed path, filename, or extracted symbol, then the relevant file is retrievable even without an intent group. When a curated concept or synonym matches, then curated ownership remains authoritative.
2. When a query is ambiguous, then results expose a bounded candidate set and match evidence rather than falsely asserting one definitive answer. Weak automatic matches remain silent.
3. When the map is incomplete, stale, or missing, then explicit lookup reports that condition, hooks avoid authoritative claims, and ordinary filesystem search remains usable.
4. When queries repeat, then caching and hint deduplication avoid redundant work within the same revision. When the map, curation, or retrieval configuration changes, then stale hits and cached misses are invalidated, including within an existing session.
5. When a file is removed or renamed between indexing and lookup, then invalid paths are not presented as verified answers; projects and worktrees cannot reuse one another's results.
6. When supported CLI search inputs run through their real hook adapters, then hints remain bounded, non-blocking, and compatible with each adapter's output contract.
7. When representative held-out queries run against baseline and improved retrieval, then the report measures relevant-file recall, top-result precision, false hints, p50/p95 latency, and payload size, including singleton files, multilingual queries, and no-match cases.
8. When matched agent tasks run with and without the change, then the report records files found, search/read calls, total context tokens, and elapsed time. Deployment requires the predeclared quality budgets; token savings are claimed only when observed, not inferred from a hint firing.

## Out of Scope

- Generation and lifecycle changes owned by STR-01 and STR-02.
- Jev, remote reranking, embeddings, and paid semantic enrichment: STR-04.
- Graph construction or graph-specific hints in `audit-q3-deterministic-graph-hints`.
- Blocking or cancelling agent tools, and new CLI integrations beyond existing adapters.
