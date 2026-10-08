---
keywords: STR, retrieval, v2, search hint, find-module, line numbers, worker socket, heldOut2, Opus pilot
related: str-03-local-file-retrieval, str-02-structure-lifecycle, str-04-jev-evaluation
---
English-only round to promote v2. Hooks now need one file to carry every
word. find-module answers functions as `path:line name`. The hint stays
quiet after find-module answered the same lookup. The lifecycle worker
answers hints over a local socket (10k files: 34 ms vs 51 ms from file).
On the new English-only heldOut2 split, v2 passed recall, P@1, exact recall
and latency, but missed hint precision (97.8%) and false hints (2/26), both
from partial concepts on identifiers. `legacy` stays the default.
Opus pilot, 16 tasks × no-engine/v2: v2 used 18.5% fewer input tokens and
23.6% less time, all tasks passed; one repeat per cell. Turkish is deferred.

Chain: spec.md → plan.md → tasks.md → outcome.md
