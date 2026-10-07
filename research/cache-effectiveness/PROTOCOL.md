# Cache-effectiveness canary after the PR-mining repair

Authors: Codex and Yoav. Frozen before inference, 2026-10-07.

Use Thinker main at merge 3aa5cbd (PR #110), the reviewed exact-model/high-effort
adapter, and a harness instrumentation change retaining complete Jev requests and
responses. The execution manifest freezes every harness/product source hash.
Old stopped canaries remain untouched.

Three Click tasks (#3364, #3391, #3677), three models, two arms: 18 coding runs.
Models: claude-opus-5-5, gpt-6.1-sol, gemini-3.8-flash-high, all high effort.
Jev is pinned to jev-1.13.0 for every cohort. No provider/model fallback.

Reuse and revalidate the archived pre-task PR corpora from
research/pr-efficiency-canary/prs.json against the upstream clone: 60 recent eligible
candidate PRs per task, normal mining limit 20. Build nine NEW caches through
minePrs using each cohort's exact writer model/effort. No exploration, sessions,
manual notes, target fixes or later evidence. The product's bounded transient retry
and single grounded writer revision are unchanged. The benchmark retains its
stricter failed-call gate: even a recovered failed model attempt invalidates cache
readiness. Do not select successful retries or overwrite failed attempts.

Require real failing-base/passing-gold upstream tests before model calls. Require
all nine nonempty PR caches, matching provenance/hashes and nonempty task retrieval
before any solver. A failed gate stops the shared batch. No automatic expansion or
restart. Counterpart model/effort, prompt, environment and test policy are matched;
only the Thinker arm receives orientation plus on-demand thinker_lookup access.
Orientation budget is 750 estimated tokens and at most two notes. Each solver has
a separate history-free snapshot; baseline has no cache. Background learning and
machine hooks are disabled through inherited THINKER_TEST=1.

Alternate arm order by task/model as in the guarded runner. One active session per
model, up to three models concurrently, with a 600-second solver deadline. Provider
prompt caches are not reset; shared machine/provider contention limits latency
claims. The supervised cache-build deadline is 3600 seconds per model cohort.
Pytest guardrails exclude stress tests, cap selection at 2000 tests and cap pytest
at 120 seconds. Retain native events, usage, patches, test outputs and failures.

Correctness uses frozen upstream post-fix tests in separate scoring worktrees,
never solver-modified tests. Report acceptance and affected-module results
separately. Report coding tokens, cache reads, tool calls and elapsed time by model
and arm, with per-task comparisons. For Codex, input_tokens already includes cache
reads; do not add them twice. For AGY, add separately reported cache reads to input
and total, but do not add thinking again. Missing usage remains unknown.

Report PR cache construction, Jev judgments and initial/on-demand retrieval costs
separately from coding. Efficiency ratios need correctness context; show paired
both-pass results and the whole canary. Audit native tool inputs for forbidden
history/network/sibling/evaluator access and provider identity. No claim of OS-level
hermetic isolation. Three tasks per model is a canary, not a general efficiency
estimate. Preserve and report failures rather than replacing tasks or tuning caches
after observing solver results.
