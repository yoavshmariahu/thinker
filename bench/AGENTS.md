# Benchmark cache source: hard requirement

Every benchmark cache must be built by mining recent merged PRs through Thinker's
PR-mining path. This applies to canaries and full suites. Do not create exploration
sessions, synthesize sessions, distill sessions, or substitute handwritten notes.
There are no prior benchmark sessions to distill.

Freeze the recent PR corpus before inference and use the same corpus for matched
model cohorts. Include only merges ancestral to and before the task's base; exclude
the target fix and later evidence. Record the corpus hash and PR/model provenance.
Missing, failed, empty, or incorrectly sourced caches stop execution before coding.
Do not reinterpret those failures as permission to change the cache source.

Use the enforced workflow in `research/performance-canary/GUARDRAILS.md` (from the
repository root). Historical runners/results do not authorize a different method.
Do not run a legacy harness until it meets this policy.
