---
keywords: STR, structure, commit, git index, staged snapshot, pre-commit hook, partial staging
related: str-02-structure-lifecycle, reliable-structure-generation, frame-bin-out-of-repo, non-invasive-overlay, str-03-local-file-retrieval
---

# STR-02b — Commit Map Publication

## Problem

The map committed with a change describes the working tree at commit time, not what was committed. With partial staging, the committed STRUCTURE.json can list unstaged edits, untracked files and local-only descriptions that are not in the commit — so a teammate, a CI job or a later checkout reads a map that does not match the tree it came with. STR-02 split this work out and left the limitation documented.

It is also a leak, and STR-02 made it continuous. STR-01's inventory includes untracked files by design, the STR-02 worker keeps them in the on-disk map on every edit, and the pre-commit hook stages that whole file. Verified 2026-09-26 in a scratch repository: after committing an unrelated change, the staged map contained an untracked `private-notes.md` with its first heading ("My private salary notes") as the description.

## Goal

Generate the map for a commit from Git's effective index (the staged snapshot) and publish it into the index only, while the on-disk map stays the agents' working-tree view. The commit's map describes exactly the committed tree; when that cannot be guaranteed, the commit still proceeds and the reason is visible.

## Constraints

- Series STR: follows STR-02 (`str-02-structure-lifecycle`), independent of STR-03/STR-04. Reuse STR-01's discovery policy, identities, extractors, annotation merge and recovery rules; the eligible set may differ only because the snapshot differs.
- STR-02 D2/D8: the on-disk map is the working-tree view and is never swapped for staged content; `--changed` remains the hook's contract until this spec replaces the hook path.
- STR-01 ownership: overlay first, root only when `config.files` records it; a local sharing mode or an ignored map never becomes tracked implicitly (`non-invasive-overlay`).
- Hook delivery (`frame-bin-out-of-repo`, STR-01): Frame installs only into a vanilla `.git/hooks/pre-commit`; Husky, lefthook and custom hooks get instructions, never edits. A commit is never blocked by map generation.
- Honor `GIT_INDEX_FILE`, linked worktrees (a `.git` file) and non-standard hook paths; no source file, runtime file or unrelated index entry may be staged or changed.
- Local only: Git is required for this integration; no service, no new npm dependency.

## Success Criteria

1. When a file is partially staged, then the committed map describes the staged content only, and no unstaged description, source fact or untracked file leaks into it; the on-disk map keeps the working-tree view.
2. When a commit is made, then only the map's index entry changes; every other staged entry, mode and flag is identical before and after.
3. When the index changes concurrently, has unresolved merge stages, or uses an unsupported form, then the index is left untouched and the commit integration reports why.
4. When the commit uses an alternate index (`GIT_INDEX_FILE`, pathspec commits) or runs in a linked worktree, then the map comes from that index and lands in that checkout only.
5. When the repository has no HEAD yet, then the first commit's map is generated from the index alone.
6. When Git or the hook integration is unavailable or customized, then working-tree maintenance still works and the missing commit integration is visible to the user.
7. When fixtures replay staged/unstaged edits in real repositories, then the committed map's facts match the staged blobs and an unstaged sentinel is never present.

## Out of Scope

- Working-tree maintenance and freshness: `str-02-structure-lifecycle`.
- Retrieval ranking, hints and caches: `str-03-local-file-retrieval`.
- Jev evaluation: `str-04-jev-evaluation`.
- Blocking commits or rewriting user-owned hook files.

## Open Questions

- **Upgrading existing hooks.** Automatically replace a pre-commit hook that is byte-identical to a known Frame template, or only show replacement instructions for every existing hook? (The replaced 2026-09-25 STR-02 plan leaned toward auto-upgrading exact Frame templates only.)
- **Policy and curation for the staged snapshot.** When the index has no staged `.frame/config.json` or curation file, fall back to the working-tree copies, or to generator defaults and empty curation? (The earlier plan leaned toward defaults, recording the fallback, so unstaged local settings never shape a commit.)
