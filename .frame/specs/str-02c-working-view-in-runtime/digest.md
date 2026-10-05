---
keywords: STR, structure, working view, runtime, tracked map, checkout, pathspec commit, upgrade
related: str-02b-commit-map-publication, str-02-structure-lifecycle, reliable-structure-generation
---
Reverses STR-02b D1: while the tracked STRUCTURE.json held the working-tree
view, Git refused checkout/switch/pull. The live view now lives in
`.frame/runtime/structure/working.json`; the tracked file is the committed
view plus prose edits, and is the generation prior for the live view.
The hook stages the index-built map and writes it to disk unless the file
has unstaged edits. The worker repairs the stale index a pathspec commit
leaves. It also restores tracked maps that differ only in generated content
(compared by `authoredView`, old bytes archived) and reports hand edits.
Untracked maps (no Git, local sharing) mirror the live view. Readers,
hints and the app read the live view first; `--changed` = `--staged`.
Rules: never overwrite unstaged edits; mirror only untracked maps.

Chain: spec.md → plan.md → tasks.md → outcome.md
