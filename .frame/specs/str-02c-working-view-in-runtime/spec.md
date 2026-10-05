---
keywords: STR, structure, working tree, runtime, git checkout, git status, commit map
related: str-02b-commit-map-publication, str-02-structure-lifecycle, reliable-structure-generation, str-03-local-file-retrieval
---

# STR-02c — Working-Tree Map in Runtime

## Problem

STR-02b kept the agents' working-tree view in the tracked `.frame/STRUCTURE.json` (its D1) while commits get a separate map from the index. The two almost always differ — the STR-02 worker keeps untracked files and unstaged edits in the working view — so Git sees the tracked file as modified and refuses every `checkout`, `switch` or `pull` that would update it. Observed on 2026-10-01: switching to `main` after merging #166 was refused. The cost stated when D1 was chosen ("`git status` shows the map as modified") understated this; the user reversed the decision.

## Goal

The tracked `.frame/STRUCTURE.json` only ever holds a committed view, so Git updates it like any other file. The working-tree view moves to `.frame/runtime/structure/` (never tracked), and every Frame consumer reads it when present, falling back to the tracked map otherwise.

## Constraints

- Explicitly overturns STR-02b D1 (`str-02b-commit-map-publication`); keeps its commit map generation and publication from the index.
- STR-02 lifecycle and freshness contract (`str-02-structure-lifecycle`) stay: same scheduling, same `fresh | dirty | stale | unknown` meanings, now describing the runtime working view.
- STR-01 ownership (`reliable-structure-generation`): the tracked map stays at the overlay path, or the root copy only when `config.files` records it; nothing new is written at the project root.
- No change to hook installation or upgrade policy; the hook stays non-blocking.
- Existing projects must upgrade without losing authored prose or curated references.

## Success Criteria

1. When the lifecycle worker updates the working view with untracked files or unstaged edits, then `git status` does not list the tracked map and `git checkout`, `git switch` and `git pull` that change it succeed.
2. When a commit is made through Frame's hook, then the tracked map on disk equals the committed map afterwards.
3. When find-module, module-hint, check-freshness or the STR-03 descriptor read the map, then they get the working view with its freshness; when there is no working view (fresh clone, Frame never ran), they read the tracked map as `unknown`.
4. When a project upgrades with a tracked map that currently holds a working view, then the first reconciliation moves that view to runtime, returns the tracked file to the committed version, and loses no authored prose or curated reference.
5. When a person or agent edits prose in the map, then that edit reaches the working view and, once staged, the commit map.

## Out of Scope

- Retrieval, ranking and hints: `str-03-local-file-retrieval`.
- Changing how commit maps are generated or published: `str-02b-commit-map-publication`.
- Hook installation and upgrade rules.

## Open Questions

- **Where prose is edited.** The REFERENCE tells agents to enrich entries in `.frame/STRUCTURE.json`. Keep that file as the place for hand-written prose (the working view merges from it), or point editors to the runtime working view (edits there never reach commits unless copied)?
- **Manual `update-structure.js --full`.** Should the repair command rebuild the working view only, or also rewrite the tracked file (which then shows as modified until committed)?
