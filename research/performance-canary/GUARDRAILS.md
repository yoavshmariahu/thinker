# Guarded future performance runs

The October 6 canary stays stopped. Its archive, protocol, report and original harness hashes are unchanged. These safeguards apply to this performance harness; other historical benchmark runners are not retrofitted by this change.

Benchmark caches MUST be mined from recent merged PRs. Exploration, synthetic sessions, session distillation and manually authored notes are forbidden cache sources. Before either coding arm starts, every task in every model cohort must have a successful cache build through the product's `minePrs` orchestration, nonempty saved notes, intact immutable export hashes and matching learned content in the product’s local note store (only usage and staleness fields may change), and a nonempty retrieval containing those note IDs. Baseline worktrees must have no `.thinker` directory. Frozen upstream preflight tests must show actual assertion failures on the base and successful nonempty tests on the gold patch; collection errors, timeouts and empty selections do not qualify. Any failed readiness check creates a shared `STOPPED.json`, preventing subsequent calls and terminating already supervised calls. A nonempty cache is an operational precondition, not proof of note quality or an efficiency benefit.

Setup and solving are separate commands. The runner has no exploration mode: `run.py learn` exits before setup or model calls. The freezer requires a PR manifest, verifies every merge commit is ancestral to the task base, excludes the target fix, and rejects merge dates or metadata updated at/after the base cutoff. It freezes PR IDs, commits, dates, diffs, comments and the mining limit. All matched cohorts replay the same corpus through a read-only GitHub shim; unfrozen requests fail. The actual product `minePrs` function performs selection, distillation, grounding, pending-note persistence and saving. There is no fallback to Git history or sessions that can pass the provenance gate.

Execution schema 2 pins `cacheSource: recent-merged-prs`, `cacheBuildPath: minePrs` and the corpus hash. Build receipts must match that hash and the model/effort, identify processed PRs in the corpus, and every saved note must have a matching PR source. Relabeling an old session build or copying agent-authored notes cannot satisfy readiness. Historical execution schema 1 is rejected. These are benchmark requirements, not changes to product session learning.

Every external agent, cache-building process and evaluator has a wall deadline, exclusive stdout/stderr files, and a `.process.json` heartbeat. Output goes directly to disk while the process runs. AGY's native session transcript is mirrored while it runs, since its JSON stdout is normally emitted at the end; an absent native trace stops the call. Timeout, cancellation, process failure or a shared stop flag prevents more work. Supervision kills the process group and observed descendants, including workers left after a successful parent exit. Failed attempts and partial output are retained; there is no automatic retry. Missing final usage stays unknown.

Pytest loads an explicit plugin through its inherited environment. It refuses any selected `stress` test or more than 2,000 selected tests and imposes a 120-second timer covering collection and execution. Clearing `addopts` or selecting stress tests therefore fails before the tests run. A violation is written to the supervisor and stops the batch. This is a guard against accidental runaway work, not a security sandbox for a hostile agent: disabling the plugin/environment or detaching an unobserved process would require OS/container enforcement. Prompts prohibit those actions. Non-pytest commands remain bounded by the overall agent deadline (default 600 seconds, maximum 1,200).

## The arm receives thinker as it ships (schema 3)

The `thinker` arm is wired by the product itself, not described to the agent in its prompt. Both arms
get the identical request; the cache reaches the wired arm through the prompt hook's `<thinker-cache>`
bundle and the MCP server (`orient`, `lookup`, `find`, `drilldown`, and the learning tools the product
offers), carrying the guidance text that `src/cache-guidance.js` composes. Schema 2, which pasted an
offline retrieval into the prompt under "PRIOR REPOSITORY KNOWLEDGE" and offered no `find` or
`drilldown`, is rejected: it measured notes-in-a-prompt, not the product.

`wire.mjs` writes the wiring through the product's own `installClient`, so the arm cannot receive a
transcription that has drifted from what ships, and nothing machine-wide is touched: Claude Code is
wired at repo scope inside the task checkout and reads it from `--settings`/`--mcp-config`, while
Codex's MCP entry and hook trust go to the run's own `CODEX_HOME`. Hooks must be repo-scope, since
test mode silences user-scope hooks alone (`src/commands/hooks.js:38`). `wiring.py` validates the
receipt before the agent starts: the frozen copy's `cli.js` and `mcp.js`, the MCP entry pinned to this
checkout, and instructions identical to what the frozen `cacheInstructions` composes and within the
host's 2048-character cap. The guidance file's hash is frozen in `execution.json`, so editing it after
freezing fails the gate instead of quietly changing the measurement.

Serving must come from the shipped ranker. Test mode would otherwise fall back to the cross-encoder
inside the agent's child process, where `memory.mjs`'s in-process Jev transport cannot reach, so the
wired arm sets `THINKER_JEV=on` and `THINKER_JEV_ALLOW_NETWORK=1` (fail-closed, personal key only;
`freeze.py` refuses to freeze without one). After each run `assert_served_by_jev` reads the checkout's
own log and fails the run on a `jev-error`, on a serving ranked by the cross-encoder, or on no
Jev-ranked serving at all — the same rule `memory.mjs` already held for the offline preflight: do not
silently substitute another ranker. Holdout is pinned off in both arms, since a withheld session would
read as a wired arm that happened to be served nothing.

The baseline carries no cache and no wiring: `.thinker`, `.mcp.json`, `.claude/settings.local.json`,
`.codex/hooks.json` and a wiring receipt are all refused for it, and its server and hooks stay off.
The wired arm is offered `remember`, so a finished run may leave an agent-authored note in its own
private copy of the cache; that is allowed only after that run completed, must be agent-sourced, and
is never counted as cache content.

## Starting a new experiment

Use an isolated Thinker git worktree and a **new output directory**. Do not remove the archived canary's stop marker. These commands prepare a new experiment but must not be used to restart the invalid historical batch.

1. Prepare the benchmark Python environment and source clone with `THINKER_TEST=1`. `prepare.py` currently expects the Click clone at the recorded machine path; adjust it before freezing on another machine.
2. Collect recent historical PRs **without inference**, using a new manifest file inside the worktree:
   ```sh
   export THINKER_TEST=1
   python3 research/performance-canary/collect_prs.py --tasks research/performance-canary/tasks.json --source /path/to/click --out /path/in/worktree/prs.json --limit 20
   ```
   The default mining limit is 20 per task/model (maximum 60). The collector scans up to 250 GitHub candidates and freezes the most recent eligible entries, up to `max(3 * limit, 60)`; the product's normal fix/size filters and selection choose which are mined. It excludes metadata edited after the cutoff and comments created/edited after it. Review the recorded coverage before freezing. Missing ancestral commits in the source clone are excluded. An empty corpus is an error, never a reason to explore source instead.
3. Apply the reviewed exact-model/high-effort adapter (`model-pins.patch`). Freeze tasks, PR evidence, model/effort, source/harness hashes, revision and deadline:
   ```sh
   export THINKER_PERF_DIR="$PWD/bench/runs/performance-new"
   python3 research/performance-canary/freeze.py --out "$THINKER_PERF_DIR" --tasks research/performance-canary/tasks.json --prs /path/in/worktree/prs.json --source /path/to/click
   python3 research/performance-canary/prepare.py
   python3 research/performance-canary/verify.py preflight
   ```
4. Run `pipeline.py build MODEL` for each cohort the protocol froze (`--cohorts opus,sol` compares two; the default is all three). A cohort left out is never built, gated or solved, and a frozen cohort without a passing cache blocks every arm. Building does **not** launch coding. Check cache quality and coverage before solving. There are no exploration sessions or session-distillation commands in this workflow.
5. Only after every frozen cohort's PR caches pass (one per task and cohort), explicitly run `pipeline.py solve MODEL`. Direct `run.py solve` has the same global readiness gate. No model/effort fallback is permitted. A source, task, PR corpus or harness change after freezing fails the gate.

Authentication must already exist. The canary's scripts still use the recorded machine's Codex credential symlink and local Python interpreter; credentials are never copied into reports. Use `verify.py score` for frozen executable grades. The historical `summarize.py`/`report.py` continue to describe the archived batch; a new experiment needs its own report based on its saved records.

## Local checks, without model calls

`npm test` runs the Python guard tests through `test/benchmark-guardrails.test.js`. Python 3.9+ is required for these repository checks. Set `THINKER_BENCH_PYTHON` to the benchmark interpreter to include real pytest integration tests if the default Python lacks pytest. The tests cover forbidden exploration entrypoints, PR provenance, future/target-fix leakage, frozen GitHub replay, a failed cohort blocking all coding, corrupt/empty/unserved notes, baseline contamination, invalid preflight, live output/heartbeats, signals, shared stops, timeouts, orphan cleanup, and real stress-selection bypass attempts.
