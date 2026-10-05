# Plan — STR-02c — Working-Tree Map in Runtime

## Architecture

### Resolved plan-time decisions

- **D1 · Reverse STR-02b D1 (business, asked 2026-10-01).** The tracked `.frame/STRUCTURE.json` holds the committed view; the working-tree view moves to `.frame/runtime/structure/working.json`. Reason: while the two views differed, Git refused `checkout`/`switch`/`pull` — the cost stated when D1 was chosen ("`git status` shows it modified") understated this.
- **D2 · Prose is edited in the tracked file (business, asked).** Every working-view build uses the tracked map as its generation prior, so hand-written descriptions, purposes, unknown fields, architecture notes, curated key owners and legacy groups flow into the working view; once staged they reach the commit map (STR-02b D7). The runtime file is generated only.
- **D3 · `--full` rebuilds the working view only (business, asked).** Commit maps are already full builds of the index at every commit; the tracked file changes only through commits.
- **D4 · Test posture (technical, asked).** Everything testable, including real `checkout`/`switch`/`pull`, normal and pathspec commits, and the upgrade path.
- **D5 · Untracked map files keep today's behavior (technical, silent).** When the map path is not in the index (no Git, local sharing, before the first commit), no checkout can conflict with it, so every working-view write is mirrored to the map file too. This also covers a freshly initialized project and keeps the file useful to agents that read it directly where it is never committed.
- **D6 · The hook mirrors what it stages (technical, silent; verified 2026-10-01).** After `--staged` publishes (or finds the entry unchanged) it writes the same bytes to the tracked file, so after a normal commit `git status` is clean. During a pathspec commit Git holds the real index lock and the hook only sees the temporary index; afterwards HEAD and the disk hold the new map while the real index keeps the old entry. The worker repairs exactly that state on its next reconciliation (a HEAD change triggers one): when the disk equals HEAD and the index entry differs, the index entry is set to HEAD's blob. That state cannot be a deliberate staged edit — the disk would then equal the staged version.
- **D7 · `--changed` becomes "staged + mirror" (technical, silent).** Old snippets in Husky/custom hooks run `--changed` and then `git add` the tracked file; with this meaning they stage the index-built map and work correctly without editing. The STR-02b `check-freshness` finding for old snippets is therefore removed (it would now be a false alarm); the finding for a commit that could not stage its map stays.
- **D8 · Upgrade without loss (technical, silent).** On a worker's first reconciliation (and whenever the condition holds), a tracked map whose disk bytes differ from its index version is compared by authored content only (prose not matching its generated fingerprint, unknown fields, architecture notes, project-level fields, curated owners, legacy groups). Equal → the difference is generated: archive the disk bytes (content-addressed recovery) and restore the index version. Different → leave the file alone (they are the user's edits) and report it. Generation exposes the authored-content view used for the comparison.
- **D9 · Readers prefer the working view (technical, silent).** `structure-read` resolves the working view first and the tracked map otherwise; the lifecycle receipt describes the working-view file; without one, freshness is `unknown` with reason `no-working-view`. `frameStore.getStructure` (the app's structure view) does the same, keeping the storage seam the one place that knows paths.
- **D10 · Collisions.** STR-03/STR-04 and `audit-q3-cross-platform` are planned, not started; `audit-q3-performance-resources` has only a measurement task. Sequential work.

### A1. Paths and the read contract

`structure-state.runAttempt` accepts `mapPath` (default: the owned tracked path) so every writer can target the working view with the same locking, recovery and atomic publication. `structure-read` exports `workingViewPath(root)` and `resolveReadPath(root)`; `readDescriptor`/`readStructure` use the working view when it exists.

### A2. Working-view writers

The lifecycle worker and `update-structure.js` (`--full`, explicit files, `--check`) build into the working view with the tracked map as generation prior (D2) and the existing working view as the byte/lastUpdated reference. The initial scan at init goes through `--full` and, the map being untracked then, is mirrored to the tracked file (D5). A mirror write only happens when the map path is not in the index.

### A3. Commit side

`publishStaged` mirrors the published or unchanged blob to the tracked file (D6). `--changed` runs the staged publication plus mirror (D7). The worker's reconciliation performs the pathspec repair (D6) when Git is available; without Git it does nothing extra.

### A4. Upgrade

The first reconciliation applies D8 and records the outcome; `check-freshness` reports a tracked map kept because it carries uncommitted hand edits.

### A5. Consumers and documentation

`find-module`, `check-freshness` (phantom modules, freshness) and `module-hint` read through `resolveReadPath`. The generated AGENTS/REFERENCE/QUICKSTART text says: `.frame/STRUCTURE.json` is the map as of the last commit plus your own edits — edit prose there; `find-module` and hints use Frame's live view of the working tree.

### Acceptance ownership

`scriptsProjectRoot` (real repositories): worker updates with untracked/unstaged work leave `git status` clean for the map and `checkout`, `switch` and `pull` changing it succeed; after a normal commit the tracked file equals HEAD; after a pathspec commit the next reconciliation clears the index difference; old `--changed` + `git add` snippets commit an index-built map. `structureLifecycle`/`projectAgnostic`: working view written, tracked prior prose carried, mirror only when untracked, `--full`/files/`--check` on the working view. `structureRead`/`module-hint`: working-first resolution, `no-working-view`. `structureGeneration`: authored-content view. Upgrade: generated-only difference restored and archived; hand edits kept and reported. `frameProjectInit`: fresh init leaves both files populated.

## Files

- `scripts/structure-state.js` — **Modified** — `mapPath` option on `runAttempt`.
- `scripts/structure-read.js` — **Modified** — working-view path, working-first resolution, `no-working-view`.
- `scripts/structure-generation.js` — **Modified** — authored-content view for the upgrade comparison.
- `scripts/structure-lifecycle.js` — **Modified** — build into the working view, mirror when untracked, pathspec repair, upgrade.
- `scripts/update-structure.js` — **Modified** — `--full`/files/`--check` on the working view; `--changed` as staged + mirror.
- `scripts/structure-commit.js` — **Modified** — mirror the staged blob to disk.
- `scripts/find-module.js` — **Modified** — read the working view first.
- `scripts/check-freshness.js` — **Modified** — working-view reads; drop the old-snippet finding; report kept hand edits.
- `scripts/module-hint.js` — **Modified** — read the working view first.
- `src/main/frameStore.js` — **Modified** — `getStructure` prefers the working view.
- `src/shared/frameTemplates.js` — **Modified** — AGENTS/REFERENCE/QUICKSTART wording.
- `test/structureState.test.js` — **Modified**
- `test/structureRead.test.js` — **Modified**
- `test/structureGeneration.test.js` — **Modified**
- `test/structureLifecycle.test.js` — **Modified**
- `test/structureCommit.test.js` — **Modified**
- `test/projectAgnostic.test.js` — **Modified**
- `test/scriptsProjectRoot.test.js` — **Modified**
- `test/module-hint.test.js` — **Modified**
- `test/frameStore.test.js` — **Modified**
- `test/frameProjectInit.test.js` — **Modified**

## Footprint

- scripts/structure-state.js
- scripts/structure-read.js
- scripts/structure-generation.js
- scripts/structure-lifecycle.js
- scripts/update-structure.js
- scripts/structure-commit.js
- scripts/find-module.js
- scripts/check-freshness.js
- scripts/module-hint.js
- src/main/frameStore.js
- src/shared/frameTemplates.js
- test/structureState.test.js
- test/structureRead.test.js
- test/structureGeneration.test.js
- test/structureLifecycle.test.js
- test/structureCommit.test.js
- test/projectAgnostic.test.js
- test/scriptsProjectRoot.test.js
- test/module-hint.test.js
- test/frameStore.test.js
- test/frameProjectInit.test.js

## Dependencies

None.

## Sequencing

1. **Target and read paths.** `mapPath` on `runAttempt`; `workingViewPath`/`resolveReadPath` and the working-first descriptor in `structure-read`; extend `structureState` and `structureRead` tests.
2. **Working-view writers.** Lifecycle worker and `update-structure.js` (`--full`, files, `--check`) build into the working view with the tracked prior and mirror only when the map is untracked; extend `structureLifecycle`, `projectAgnostic` and `frameProjectInit` tests.
3. **Commit side.** Mirror in `publishStaged`; `--changed` as staged + mirror; pathspec repair in the worker; drop the old-snippet finding; extend `structureCommit`, `scriptsProjectRoot` (checkout/switch/pull, normal and pathspec commits, old snippets).
4. **Upgrade.** Authored-content view in `structure-generation`; the D8 upgrade in the worker and the kept-edits finding in `check-freshness`; extend `structureGeneration`, `structureLifecycle`, `scriptsProjectRoot`.
5. **Consumers and docs.** `find-module`, `check-freshness`, `module-hint`, `frameStore.getStructure` read the working view first; template wording; extend `module-hint`, `frameStore`, `scriptsProjectRoot`, `projectAgnostic` tests.
