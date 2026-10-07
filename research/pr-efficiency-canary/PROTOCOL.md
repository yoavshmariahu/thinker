# PR-only efficiency canary

Authors: Yoav and Codex. October 7, 2026. Written before inference.

Use three frozen Click tasks (3364, 3391, 3677), with independent PR-only caches for Opus claude-opus-5-5, Sol gpt-6.1-sol and Gemini gemini-3.8-flash-high, all high effort throughout PR distillation and coding. Jev is pinned to jev-1.13.0. Record the current Thinker commit, reviewed model adapter and exact source hashes in execution.json. No exploration sessions, session distillation, handwritten notes, model fallback, retries or reuse of the invalid earlier caches.

For each task, collect recent merged PRs ancestral to its starting commit, with merge/metadata timestamps before that commit; exclude its target fix and later comments. Freeze this corpus before calls, identical across models. Use the normal minePrs path with a limit of 20 PRs per task/model and read-only GitHub replay. The collector freezes up to 60 eligible candidates from a bounded 250-PR scan; normal product filters and fix prioritization select up to 20. Report actual processed/saved/served counts, including empty and failed builds.

Run frozen base/gold executable preflight, then build all nine caches in three concurrent model cohorts, tasks sequential within each. Coding is forbidden until every cache passes immutable provenance, nonempty/fresh-note and retrieval checks. Inspect note relevance before admitting solvers. Any failed phase stops the batch; no automatic expansion or selective replacement. An empty or failed PR cache is a measured outcome, not permission to change its source.

Conditional coding: three tasks × three models × baseline/Thinker = 18 runs. Same exact model and high effort within each pair; alternate arm order by task/model parity. Separate isolated history-free snapshots; no baseline cache. Thinker gets orient and optional thinker_lookup. Machine hooks/MCP/background learning are disabled. All setup, benchmark and child processes inherit THINKER_TEST=1 and telemetry off.

Agent deadline 600 seconds, cache builder 3600 seconds, evaluator 180 seconds. Pytest excludes stress, limits selected tests to 2000 and collection/execution to 120 seconds. Preserve live traces, model errors and shared-stop interruptions. Grade unchanged upstream acceptance and affected-module tests independently. Report correctness, normalized input/output/cache-read tokens, tool calls, setup and coding wall time separately per model. Unknown usage stays unknown; no efficiency claims without valid paired solutions. No UI performance claims from an invalid batch.

Pre-inference preparation correction: the initial bounded GitHub query returned no eligible corpus after client-side metadata cutoff filtering. Applying the same updated-time cutoff in the GitHub search recovered historical candidates. The collector query was corrected and regression-tested before freezing; no model calls or outcome-driven retries preceded this change. Execution hashes include the correction.
