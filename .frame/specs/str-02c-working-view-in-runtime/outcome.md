# Outcome — STR-02c — Working-Tree Map in Runtime

## T01 — Point the write target and the read contract at the working view

`runAttempt`/`snapshot` accept `mapPath` (default: the owned tracked map), so any writer can publish another artifact with the same lock, recovery and atomic rules. `structure-read` gained `workingViewPath` (`.frame/runtime/structure/working.json`) and `resolveReadPath` (working view first, tracked map otherwise); without a working view freshness is `unknown` with reason `no-working-view`. Deviation: a receipt written before STR-02c that still matches the tracked file byte for byte is honored, so projects mid-upgrade (and every commit until T02 moves the writers) keep their freshness instead of all turning `unknown`. A hand edit of the tracked map is no longer reported as `artifact-changed` — the tracked file is where prose is edited now (D2); that STR-02 reader test was updated. Files touched: `scripts/structure-state.js`, `scripts/structure-read.js`, `test/structureState.test.js`, `test/structureRead.test.js`, `test/scriptsProjectRoot.test.js`.

_Captured: 2026-10-01 · 5 file change(s)_

---

## T02 — Build the working view in runtime; mirror only when the map is untracked

The lifecycle worker and `update-structure.js` (`--full`, explicit files, `--check`) now build into `.frame/runtime/structure/working.json`. The tracked map is the generation prior (D2), so prose, unknown fields and architecture notes written there reach the working view; the existing working view is only the byte/`lastUpdated` reference. `structure-state` gained `workingViewPath`, `mapTrackedByGit` (`git ls-files --error-unmatch`) and `mirrorToUntrackedMap`: when the map path is not in the index (no Git, before the first commit, local sharing) the working view's bytes are copied to it (D5), archiving the current file to recovery first when it is invalid. Deviation: a corrupt tracked map is refused as a delta baseline (kind `corrupt`) rather than silently replaced; a fresh project with no working view seeds its delta from the tracked map. The STR-02 reader test was updated — a tracked-map hand edit no longer changes freshness; removing the working view makes it `unknown`. Files touched: `scripts/structure-state.js`, `scripts/update-structure.js`, `scripts/structure-lifecycle.js`, `test/structureLifecycle.test.js`, `test/projectAgnostic.test.js`, `test/frameProjectInit.test.js`, `test/scriptsProjectRoot.test.js`.

_Captured: 2026-10-01 · 7 file change(s)_

---

## T03 — Commit side: mirror, `--changed`, pathspec repair

`publishStaged` now mirrors the published (or already staged) commit map to the tracked file and records `mirror` (`written` / `unchanged` / `kept` / `failed`) in its result and `commit.json`. Deviation (loss-free guard): the disk file is replaced only when it equals the entry that was staged before publishing, or is missing. Anything else holds unstaged edits (prose not yet staged, or a pre-STR-02c working map) and is `kept`; T04's upgrade deals with the latter. `repairPathspecIndex` (in `structure-commit.js`, called by every worker reconciliation in a Git checkout, reported as `indexRepair`) sets the map's index entry to HEAD's blob only when the disk equals HEAD and the index differs. `update-structure.js --changed` is now the same publication as `--staged`, reported as command `changed`; the old Git-diff candidate path is gone. `check-freshness` no longer reports old `--changed` + `git add` snippets or lefthook lines; the finding for a commit that could not stage its map stays. Real-repository tests cover `switch`/`checkout`/`pull` with live untracked and unstaged work, a clean map after a normal commit, a pathspec commit repaired by the worker (a deliberately staged map is left alone) and an old snippet committing the index-built map. Files touched: `scripts/structure-commit.js`, `scripts/structure-lifecycle.js`, `scripts/update-structure.js`, `scripts/check-freshness.js`, `test/structureCommit.test.js`, `test/scriptsProjectRoot.test.js`, `test/projectAgnostic.test.js`.

_Captured: 2026-10-01 · 7 file change(s)_

---

## T04 — Upgrade existing projects without loss

`structure-generation` exports `authoredView`/`sameAuthoredContent`. The view keeps project-level fields (everything except version, lastUpdated, modules, intentIndex, ipcChannels, generation), and per file keeps prose that does not match its fingerprint plus unknown entry and function fields. Modules are keyed by file path, so key reallocation doesn't count. IPC channels count only when enriched beyond the generated skeleton. `structure-commit.reconcileTrackedMap` runs on every worker reconciliation in a Git checkout (replacing T03's direct repair call; the lifecycle result reports `trackedMap`):
- clean: disk equals the index;
- repaired: the pathspec case;
- restored: a generated-only difference; the disk bytes are archived to `recovery/` first and the index version is written back;
- kept: hand edits, or disk/index not valid JSON;
- skipped: no index entry, a conflict, or an `index.lock` present.

The outcome and the disk digest go to `.frame/runtime/structure/tracked.json`. `check-freshness` reports a `kept` map as a `structure-commit` finding while the disk still has that digest ("unstaged hand edits — commits carry them only once you `git add` the file"). Deviation: the comparison is against the index entry (what the next commit starts from) rather than HEAD, so an already staged edit is never considered. Checked on this repository read-only: its tracked map differs from the index in generated content only and will be restored by the worker's next run. Files touched: `scripts/structure-generation.js`, `scripts/structure-commit.js`, `scripts/structure-lifecycle.js`, `scripts/check-freshness.js`, `test/structureGeneration.test.js`, `test/scriptsProjectRoot.test.js`.

_Captured: 2026-10-01 · 6 file change(s)_

---

## T05 — Consumers read the live view; documentation

`find-module`, `module-hint` and `check-freshness` (phantom modules, drift, generation status) read through `structure-read.resolveReadPath`: the working view first, the tracked map otherwise. The kept-edits finding still hashes the tracked file. `frameStore.getStructure` (the app's structure view over `LOAD_STRUCTURE_MAP`) prefers `.frame/runtime/structure/working.json` and falls back to the tracked map when the working view is missing or unreadable; `saveStructure` still writes the tracked file, where prose is edited.

Template wording:
- AGENTS navigation: the tracked map is "as of the last commit, plus your prose edits"; `find-module.js` and hints use the live view.
- REFERENCE "STRUCTURE.json Rules": the two views; `--full` rebuilds the live view; the hook stages and writes the commit map so `git status` stays clean and checkout, switch and pull never conflict; unstaged hand edits are kept and reported; old `--changed` + `git add` snippets work; prose is edited in the tracked file and reaches commits once staged.
- QUICKSTART key-files row.
- Hook snippet comment.

Deviation: the REFERENCE text names the working view as `working.json` in `.frame/runtime/structure/`, not as a full path, because docs health requires every named `.frame/` file to exist and a fresh project has none yet. The hook template changed, so the STR-02b template's hash (from 2291b13) joined `PREVIOUS_STRUCTURE_HOOK_TEMPLATE_SHA256`, and its test now rebuilds both earlier templates from history. Files touched: `scripts/find-module.js`, `scripts/module-hint.js`, `scripts/check-freshness.js`, `src/main/frameStore.js`, `src/shared/frameTemplates.js`, `test/module-hint.test.js`, `test/frameStore.test.js`, `test/scriptsProjectRoot.test.js`, `test/projectAgnostic.test.js`.

_Captured: 2026-10-01 · 9 file change(s)_

---
