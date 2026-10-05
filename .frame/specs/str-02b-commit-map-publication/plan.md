# Plan — STR-02b — Commit Map Publication

## Architecture

### Resolved plan-time decisions

- **D1 · Working-tree view stays on disk (business, asked 2026-09-26).** `.frame/STRUCTURE.json` remains the agents' working-tree view (STR-02). A commit gets a separately generated map, published into the index only. Accepted costs: while the working view differs from the committed one, `git status` shows the map as modified, and a commit made with `--no-verify` skips the hook and can still carry the working view — both documented, not solved here.
- **D2 · Hook upgrades (business, asked).** A `pre-commit` file byte-identical to a known Frame template is replaced automatically with the new one. Husky, lefthook, custom hooks and hand-pasted snippets are never edited: they get replacement instructions, and their outdated integration is reported.
- **D3 · Policy for the staged snapshot (business, asked).** Project policy (`.frame/config.json`, `project.structure`, legacy `files`) comes from the staged blob; when the index has none, generator defaults apply and the fallback is recorded. Unstaged local settings never shape a commit.
- **D4 · Curation exception (business, asked as a follow-up to D3).** `intent-map.json` lives in the gitignored `.frame/bin/`, so it is never staged in user projects. Curation is read from the working copy beside the running parser (as STR-01/02 do). It can only resolve to module keys present in the commit's map, so it cannot expose untracked files.
- **D5 · Test posture (technical, asked).** Everything testable: real temporary repositories covering partial staging, pathspec commits, alternate indexes, linked worktrees, unborn HEAD, unmerged stages, concurrent index changes, local sharing, and hook installation/upgrade.
- **D6 · Snapshot source (technical, silent — anticipated by STR-02 D7).** No index parser. `git ls-files -s -z` lists staged entries (mode, object id, stage, path) and one `git cat-file --batch` process reads blobs. An fs-shaped adapter over that virtual tree feeds STR-01 discovery and extraction unchanged, so eligibility, keys, annotations and serialization are the same code. Symlinks (120000) and gitlinks (160000) are skipped by the shared policy; any entry with a non-zero stage makes the snapshot unavailable.
- **D7 · Prior map and annotations (technical, silent).** The prior for the commit build is the map blob staged at the owned path (overlay, or the root copy only when the live `config.files` names it). Unstaged descriptions never reach a commit; a map the user staged by hand brings its authored prose for files that are in the commit.
- **D8 · Publication (technical, silent).** Capture the index identity (content hash of the effective index file) before building, re-read it immediately before publishing, and abort if it changed. Publish with `git hash-object -w --stdin` and `git update-index --add --cacheinfo 100644,<blob>,<path>`, which takes Git's own index lock; a held lock aborts. Only the map entry changes. Publication is authorized only when the path is already tracked or not ignored (`git check-ignore`) — a local sharing mode or an ignored map is never force-added. The working map, runtime state of the working view and every other index entry are left untouched.
- **D9 · Entry point (technical, silent).** `update-structure.js --staged` is the commit command (helper `structure-commit.js`); `--changed` stays for hooks that still call it. The new snippet does not run `git add`.
- **D10 · Hook location (technical, silent).** The install target is resolved with `git rev-parse --git-path hooks` (linked worktrees, `core.hooksPath`) instead of a hardcoded `.git/hooks`; the existing Husky/lefthook/custom detection and non-blocking wrapper stay.
- **D11 · Visibility (technical, silent).** Each `--staged` run writes `.frame/runtime/structure/commit.json` (result, reason, index digest, blob id). `check-freshness` reports a `structure-commit` finding when the project's hook still runs the old `--changed` + `git add` snippet (custom/Husky/lefthook) or when the last commit integration was skipped or failed. The bootstrap summary keeps its existing hook statuses.
- **D12 · Collisions (technical, verified 2026-09-26).** STR-03/STR-04 and `audit-q3-cross-platform` are planned, not started; `audit-q3-performance-resources` has only a measurement task open. Implement sequentially.

### A1. The staged snapshot

`scripts/structure-commit.js` resolves the effective index (`GIT_INDEX_FILE` when set, else `git rev-parse --git-path index`), repository and worktree with Git, and lists entries with `git ls-files -s -z` under that index. It builds a virtual tree and an fs adapter (`statSync`, `lstatSync`, `readdirSync`, `openSync`/`readSync`/`closeSync`, `readFileSync`) whose file bytes come from `git cat-file --batch`, reading each blob at most once and only when discovery samples it or extraction parses it. Policy comes from the staged `.frame/config.json` blob or defaults (D3); discovery and `buildFull` run on the adapter with the staged map as prior (D7), working-tree curation (D4) and the STR-02 extraction cache keyed by blob content (identical content is never re-extracted across views). An unborn HEAD works from the index alone. Unmerged stages or an unreadable object end with `unavailable` and no index change.

### A2. Publication

Compare-and-publish per D8, authorization per D8, then the runtime receipt (D11). Result statuses: `published`, `unchanged` (staged map already equal), `skipped` (not shared / ignored / no map path), `unavailable` (unmerged, unsupported index form, object read failure), `aborted` (index changed, lock held), `failed`. None of them blocks the commit.

### A3. CLI and hook

`update-structure.js --staged [--json]`: one bounded envelope like the other modes; exit 0 for published/unchanged/skipped, 1 for unavailable/aborted, 2 for failed or usage errors. The new snippet runs `--staged` through the existing borrowing logic (linked worktrees use the main checkout's parser, the target checkout's index) and keeps `|| true`. `getStructurePreCommitHookTemplate` wraps it. Known previous templates are listed next to the current one so an unmodified old file is recognized byte for byte.

### A4. Installation and upgrades

`structureBootstrap` resolves the hooks directory with Git (D10), installs the new template where none exists, and on init and on every open replaces a hook file that matches a known Frame template exactly (D2); anything else is left alone and reported. `structure-commit.js` ships as a helper; `update-structure.js` requires it. The repository's own `.githooks/pre-commit` switches to `node scripts/update-structure.js --staged`, keeping its other checks.

### A5. Visibility and documentation

`check-freshness` gains the `structure-commit` finding (D11). The generated REFERENCE replaces "the committed map describes the working tree" with how commits get their map, the `--no-verify` and `git status` caveats (D1), and the snippet for custom hooks.

### Acceptance ownership

`structureCommit` (real repositories): partial staging with an unstaged sentinel and an untracked private file never in the committed map; only the map entry changes (every other entry's mode, id and stage compared); pathspec commits and `GIT_INDEX_FILE`; linked worktree isolation; unborn HEAD; unmerged stage → unavailable; index changed mid-build → aborted; held `index.lock` → aborted; local sharing / ignored map → skipped; staged config vs defaults; curation exception; cache reuse across views. `structureBootstrap`/`frameProjectOpen`: hooks path via Git, exact-template upgrade, custom/Husky untouched, packaged closure. `scriptsProjectRoot`: the real hook end to end, including the leak scenario from the spec. `projectAgnostic`: `--staged` envelope and exits, REFERENCE text.

## Files

- `scripts/structure-commit.js` — **New** — staged snapshot adapter, commit build, compare-and-publish, receipt.
- `scripts/update-structure.js` — **Modified** — `--staged` mode.
- `scripts/check-freshness.js` — **Modified** — `structure-commit` finding.
- `src/shared/frameTemplates.js` — **Modified** — new snippet/template, known previous templates, REFERENCE guidance.
- `src/main/structureBootstrap.js` — **Modified** — hooks path via Git, exact-template upgrade, ship and gate `structure-commit.js`.
- `src/main/frameProject.js` — **Modified** — upgrade an exact old template on open.
- `.githooks/pre-commit` — **Modified** — this repository's hook uses `--staged`.
- `package.json` — **Modified** — `build.files`.
- `test/structureCommit.test.js` — **New** — staged generation and publication against real repositories.
- `test/structureBootstrap.test.js` — **Modified** — hooks path, upgrades, packaged closure.
- `test/frameProjectOpen.test.js` — **Modified** — open-time upgrade and untouched custom hooks.
- `test/scriptsProjectRoot.test.js` — **Modified** — end-to-end hook, leak scenario, worktrees.
- `test/projectAgnostic.test.js` — **Modified** — `--staged` contract and documentation.

## Footprint

- scripts/structure-commit.js
- scripts/update-structure.js
- scripts/check-freshness.js
- src/shared/frameTemplates.js
- src/main/structureBootstrap.js
- src/main/frameProject.js
- .githooks/pre-commit
- package.json
- test/structureCommit.test.js
- test/structureBootstrap.test.js
- test/frameProjectOpen.test.js
- test/scriptsProjectRoot.test.js
- test/projectAgnostic.test.js

## Dependencies

None. Git plumbing (`ls-files -s -z`, `cat-file --batch`, `hash-object -w`, `update-index --cacheinfo`, `check-ignore`, `rev-parse --git-path`) is available in Git 2.39 used here; commit integration requires Git, working-tree maintenance does not. Verified 2026-09-26 that an index entry written by a `pre-commit` hook is committed for both a plain commit and `git commit -- <path>` (temporary index).

## Sequencing

1. **Staged snapshot build.** Add `structure-commit.js` with index resolution, entry listing, the blob reader, the fs adapter, staged policy/defaults, staged prior, the curation exception and cache reuse; author the snapshot half of `structureCommit` tests (partial staging, sentinel, untracked file, unborn HEAD, unmerged, policy fallback, curation).
2. **Compare-and-publish.** Add index-identity capture/recheck, authorization, `hash-object`/`update-index` publication and the `commit.json` receipt; author the publication half of `structureCommit` tests (only the map entry changes, index changed, lock held, local sharing, ignored map, pathspec commit, alternate index, worktree).
3. **`--staged` CLI.** Add the mode to `update-structure.js` with envelope and exit codes; extend `projectAgnostic`.
4. **Hook template and installation.** New snippet and template with known previous templates in `frameTemplates`; hooks path via Git, exact-template upgrade on init/open, shipping and gating in `structureBootstrap`, the open-time call in `frameProject`, `build.files`; extend `structureBootstrap`, `frameProjectOpen` and `scriptsProjectRoot` (end-to-end leak scenario).
5. **Visibility, documentation and this repository.** `structure-commit` finding in `check-freshness`, REFERENCE guidance, `.githooks/pre-commit`; extend `scriptsProjectRoot` and `projectAgnostic`.
