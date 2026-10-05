---
keywords: STR, structure, commit, git index, staged snapshot, pre-commit hook, leak
related: str-02-structure-lifecycle, reliable-structure-generation, frame-bin-out-of-repo, non-invasive-overlay
---
A commit's STRUCTURE.json is now built from the staged snapshot and published
into the index only (`update-structure.js --staged`), closing a verified leak:
the old hook staged the working-tree map, so untracked files' names and first
headings reached commits. The index is read through `ls-files`/`cat-file` as
a small fs, so STR-01 discovery and generation run unchanged; publication
rechecks the index hash and uses `update-index --cacheinfo` under Git's lock.
Rejected: moving the working view to runtime (agents read the file directly)
and parsing the index file. Rules: policy comes from the staged config or
defaults; curation from the working copy; a map path that is ignored or local
is never force-added; only unmodified Frame templates are auto-upgraded
(recognized by historical SHA-256); `core.hooksPath`, Husky, lefthook and
edited hooks get instructions and a check-freshness finding. Known gaps:
`--no-verify`, and `git status` shows the map modified while views differ.

Chain: spec.md → plan.md → tasks.md → outcome.md
