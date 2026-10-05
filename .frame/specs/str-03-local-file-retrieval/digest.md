---
keywords: STR, retrieval, find-module, module-hint, search hint, lookup index, benchmark, eval, Turkish
related: str-02c-working-view-in-runtime, str-02-structure-lifecycle, str-04-jev-evaluation, audit-q3-core-value-efficacy, codex-parity
---
One retrieval engine (`structure-retrieval.js`) serves find-module and the
search hook. Evidence tiers: path, concept, synonym, file name, symbol and
partial concept (hooks stop here), then path and description words (CLI only).
Every identifier word must be explained; non-ASCII words count as prose.
The worker publishes a compact `lookup.json` beside the live view (130 KB
against the 662 KB map). Hooks read it, or compile a map of at most 2 MiB.
find-module gained `--json`, `--limit` and `--retrieval`. On a frozen
194-query corpus (held-out run once), v2 beat legacy everywhere but missed 4
gates (recall 89.4%, hint precision 96.5%, 1 false hint, 10k-file p95 55 ms),
so `legacy` stays the default and v2 is opt-in (`project.retrieval.engine`).
The S8 agent instrument ships; its paid run is pending and no saving is claimed.

Chain: spec.md → plan.md → tasks.md → outcome.md
