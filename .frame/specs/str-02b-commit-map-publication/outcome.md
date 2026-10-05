# Outcome — STR-02b — Commit Map Publication

## T01 — Build the commit map from the staged snapshot

Added `scripts/structure-commit.js` with `buildStaged`: effective index (`GIT_INDEX_FILE` or `rev-parse --git-path index`), `ls-files -s -z` entries (any unmerged stage → `unavailable`), blobs via `cat-file --batch-check`/`--batch`, and a read-only fs adapter over the staged tree that STR-01 discovery and `buildFull` run on unchanged; policy from the staged config or recorded defaults, the staged map as prior, working-tree curation, and the STR-02 extraction cache keyed by blob content. Deviation outside the planned footprint: a one-line change in `scripts/structure-snapshot.js` so the extraction cache parses from the caller's fs (the index adapter) instead of always from disk — without it, cache reuse across views (planned) would have read working-tree bytes. Files touched: `scripts/structure-commit.js` (new), `scripts/structure-snapshot.js`, `test/structureCommit.test.js` (new).

_Captured: 2026-09-26 · 3 file change(s)_

---

## T02 — Publish the commit map into the index only

Added `publishStaged`: captures the effective index's content hash, builds, refuses a map path that is neither tracked nor shareable (`check-ignore`, covering local sharing and `.gitignore`), writes the blob with `hash-object -w`, rechecks the index hash and publishes with `update-index --add --cacheinfo` under Git's own lock; results `published`/`unchanged`/`skipped`/`unavailable`/`aborted`/`failed` are recorded in `.frame/runtime/structure/commit.json`, and the working map is never written. Found here: before the map was first staged, the index view had no `.frame/` directory, so the second build's discovery counts differed and a no-op re-published; the index fs now always presents `.frame/`, which also matches the working view's counts. Files touched: `scripts/structure-commit.js`, `test/structureCommit.test.js`.

_Captured: 2026-09-26 · 2 file change(s)_

---

## T03 — Add the --staged command

`update-structure.js --staged [--json]` runs `publishStaged` and prints one bounded envelope (`command: 'staged'`); exits 0 for published/unchanged/skipped, 1 for unavailable/aborted, 2 for failures and conflicting modes; a staged-config fallback is noted on stderr, and the run is recorded like the other modes. `structure-commit.js` is loaded only in this mode, so the other modes keep working with an older helper set; `--changed` is unchanged for hooks that still call it. Files touched: `scripts/update-structure.js`, `test/projectAgnostic.test.js`.

_Captured: 2026-09-26 · 2 file change(s)_

---

## T04 — Replace the hook snippet and template

The structure snippet now runs `update-structure.js --staged || true` through the unchanged worktree-borrowing logic and never runs `git add`; the template's header promise changed from "Frame will not overwrite it on subsequent inits" to "While this file is unmodified, Frame keeps it up to date; once you edit it, Frame leaves it alone" (D2 makes the old promise untrue). Earlier templates are recognized by SHA-256 recovered from history (d3b098d, fa17c93, a8c1c8c) via `classifyStructureHook`. Pulled forward from T05 to keep every commit green: shipping `structure-commit.js` as a parser helper (`HELPER_FILES`, `PARSER_REQUIRES`, `build.files`), since the new hook needs it; the snapshot helper is now a parser requirement as well. Five STR-01-era hook tests in `scriptsProjectRoot` were rewritten to the new contract (commit map read from the index, working map untouched), the busy-writer test replaced by an old-`.frame/bin` compatibility test. Files touched: `src/shared/frameTemplates.js`, `src/main/structureBootstrap.js`, `package.json`, `test/projectAgnostic.test.js`, `test/scriptsProjectRoot.test.js`, `test/frameProjectInit.test.js`, `test/structureBootstrap.test.js`.

_Captured: 2026-09-26 · 7 file change(s)_

---

## T05 — Install and upgrade the hook where Git keeps it

`structureBootstrap` resolves the hooks directory with `git rev-parse --git-path hooks`/`--git-common-dir` (async, so the main process is not blocked): linked worktrees now install into the shared hooks directory instead of failing on a `.git` file; a `core.hooksPath` outside Git's directory is treated as the user's (instructions, nothing written); an unmodified earlier Frame template is replaced on init (`upgraded`) and on every open via the new `upgradeStructureHook` (called from `openProjectLayout` after tools are refreshed), the current template reports `up-to-date`, and edited/custom/Husky/lefthook hooks are never touched — lefthook guidance now uses `--staged` without `git add`. An open never installs a missing hook. The end-to-end test commits through a real installed hook and proves an untracked private note and an unstaged sentinel never reach the committed map, including a pathspec commit. (Shipping `structure-commit.js` moved to T04.) Files touched: `src/main/structureBootstrap.js`, `src/main/frameProject.js`, `test/structureBootstrap.test.js`, `test/frameProjectOpen.test.js`, `test/scriptsProjectRoot.test.js`.

_Captured: 2026-09-26 · 5 file change(s)_

---

## T06 — Report outdated integration, document it, switch this repository

`check-freshness` gained `structure-commit` findings: a pre-commit hook (Git's hooks path or `.husky/pre-commit`) whose Frame block still runs `--changed` and `git add`, a lefthook config still calling `--changed`, and a last `--staged` run recorded as unavailable/aborted/failed in `commit.json`. The generated REFERENCE now explains that commits get their own map from what is staged, the expected `git status` difference, the `--no-verify` gap, and how to call `--staged` from Husky/lefthook/custom hooks. This repository's `.githooks/pre-commit` runs `node scripts/update-structure.js --staged || true` on every commit (it used to run only for staged `src/*.js` and `git add` the working map), keeping the freshness report. Files touched: `scripts/check-freshness.js`, `src/shared/frameTemplates.js`, `.githooks/pre-commit`, `test/scriptsProjectRoot.test.js`, `test/projectAgnostic.test.js`.

_Captured: 2026-09-26 · 5 file change(s)_

---
