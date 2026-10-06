# Jev learning decisions — 2026-10-06

The existing distiller used touched-file/BM25 context and lexical duplicate merging.
There was no independent source check or description-fidelity check; evidence selection
was local heuristics. The hypothesis is that bounded semantic judgments can improve
which existing notes the writer sees and prevent unsupported/lossy writes.

Implemented four decisions: catalog reconciliation, per-claim evidence support,
search-description support/scope, and numbered transcript-passage selection. Jev makes
typed judgments; the configured writing model writes prose. Dependency hashes remain
the freshness mechanism. Human behavior notes are protected in automatic learning.

Initial policies: catalog relevance >=0.35; relationship chosen probability >=0.85;
rewritten-body preservation >=0.9 (literal preservation is deterministic); each claim
supported >=0.9, with any evidence-chunk contradiction probability >=0.2 deferring;
summary support and scope each >=0.9; passage selection >=0.7. These are conservative
engineering thresholds, not calibrated real-corpus accuracy claims.

## Validation

`THINKER_TEST=1 node bench/jev-eval/learning-smoke.mjs --live` uses only fictional
hard-coded notes, code excerpts and transcript events. Exact model `jev-1.13.0`;
reasoning effort is not configurable; model mismatches invalidate the run. No writing
model or judge model is used in this smoke, and no private repository evidence is sent.

The final run passed all six scenarios in each of two repeats: covered-note suppression,
complete extension, conflicting-note deferral, unsupported-claim deferral, faithful vs
scope-broadening descriptions, and selection of the source-code passage. Recorded
results are in `synthetic-smoke.json`. This is integration evidence, not a retrieval
benchmark, causal comparison, calibrated accuracy estimate or end-to-end saving.

Earlier runs exposed a false deferral when the proposed body literally preserved the
old body. Code now recognizes literal preservation while still requiring relationship
and source checks. A subsequent run accepted the extension in one repeat and deferred
it in another at the source-support threshold; the final two repeats both accepted it.
This variation is retained here rather than treated as proof that uncertainty vanished.

Automated coverage includes malformed probabilities, UTF-8/request limits, daily-budget
exhaustion, all-catalog batching, unsupported claims, concurrent merge/edit/deletion,
stale dependency evidence, behavior protection, lost scope/exceptions, source identity
in deep transcript spans, full/local fallback, and retry checkpoints. A session-level
integration fixture verifies that catalog failures stop before writing, transport failures
retain the checkpoint, and persisted contradictions leave the original note untouched.

## Limits and follow-up

Long transcripts sample at most 96 source spans and select at most 12,000 characters;
coverage is reported. Audit sessions preserve the full trace path. A model can still
misjudge support or miss a related note. Uncertain findings are retained in the local
`state/learning-pending/` queue, not silently committed as note changes. Transient service
failures remain retryable; semantic deferrals checkpoint once persisted to avoid repeat
spend. Real session/PR quality and latency comparisons remain unmeasured and require
matched writer/model settings and explicit authorization for private external payloads.
