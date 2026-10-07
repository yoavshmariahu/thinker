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

## Temporary worktree lifecycle

Use `bench/worktrees.js:createWorktree` for benchmark worker checkouts and its
`spawn` wrapper for agent processes inside them. Remove each worker's checkout
with `removeWorktree` in `finally`; the helper also cleans up on process exit,
uncaught errors, SIGINT and SIGTERM, stopping owned agent process groups first.
The grading and CBM pools keep their checkouts until process exit.

Never recursively delete an existing path to make room for a run. Existing
directories or Git registrations must stop creation: they may belong to an
active run or contain unsaved work. Preserve any needed patches and results under
`bench/runs/` before releasing a checkout. SIGKILL and machine crashes cannot run
cleanup; inspect those leftovers and preserve unique changes before using
`git worktree remove` from the owning repository. Do not sweep other agents'
worktrees or prune their registrations.
