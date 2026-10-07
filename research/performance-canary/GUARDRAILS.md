# Guarded future performance runs

The October 6 canary stays stopped. Its archive, protocol, report and original harness hashes are unchanged. These safeguards apply to this performance harness; other historical benchmark runners are not retrofitted by this change.

Before either coding arm starts, every task in every model cohort must have a successful exploration, a successful cache build through the product's `distillFile` orchestration, nonempty saved notes, intact exported/copied note hashes, and a nonempty retrieval containing those note IDs. Baseline worktrees must have no `.thinker` directory. Frozen upstream preflight tests must show actual assertion failures on the base and successful nonempty tests on the gold patch; collection errors, timeouts and empty selections do not qualify. Any failed readiness check creates a shared `STOPPED.json`, preventing subsequent calls and terminating already supervised calls. A nonempty cache is an operational precondition, not proof of note quality or an efficiency benefit.

Setup and solving are separate commands. Cache construction no longer turns a distillation exception into a successful empty-cache result, and no longer reimplements a subset of session learning. It uses the normal hydration, catalog lookup, evidence selection, distillation, grounding, deferred-learning persistence and note saving. Explorations return source-backed observations rather than forced JSON notes for another distiller to rewrite. This is still **session learning**, not the full setup command with PR mining and repository-wide area discovery. Whether normal learning now produces useful caches remains a separate live diagnostic; this change does not claim to fix grounding.

Every external agent, cache-building process and evaluator has a wall deadline, exclusive stdout/stderr files, and a `.process.json` heartbeat. Output goes directly to disk while the process runs. AGY's native session transcript is mirrored while it runs, since its JSON stdout is normally emitted at the end; an absent native trace stops the call. Timeout, cancellation, process failure or a shared stop flag prevents more work. Supervision kills the process group and observed descendants, including workers left after a successful parent exit. Failed attempts and partial output are retained; there is no automatic retry. Missing final usage stays unknown.

Pytest loads an explicit plugin through its inherited environment. It refuses any selected `stress` test or more than 2,000 selected tests and imposes a 120-second timer covering collection and execution. Clearing `addopts` or selecting stress tests therefore fails before the tests run. A violation is written to the supervisor and stops the batch. This is a guard against accidental runaway work, not a security sandbox for a hostile agent: disabling the plugin/environment or detaching an unobserved process would require OS/container enforcement. Prompts prohibit those actions. Non-pytest commands remain bounded by the overall agent deadline (default 600 seconds, maximum 1,200).

## Starting a new experiment

Use an isolated Thinker git worktree and a **new output directory**. Do not remove the archived canary's stop marker. These commands prepare a new experiment but must not be used to restart the invalid historical batch.

1. Prepare the benchmark Python environment and source clone with `THINKER_TEST=1`. `prepare.py` currently expects the Click clone at the recorded machine path; adjust it before freezing on another machine.
2. Apply the reviewed exact-model/high-effort adapter (`model-pins.patch`) to the matching source revision. The freezer refuses missing effort support. Record any adapter changes as part of the new protocol.
3. Freeze tasks, exact model/effort, source/harness hashes, revision and deadline:
   ```sh
   export THINKER_TEST=1
   export THINKER_PERF_DIR="$PWD/bench/runs/performance-new"
   python3 research/performance-canary/freeze.py --out "$THINKER_PERF_DIR" --tasks research/performance-canary/tasks.json
   python3 research/performance-canary/prepare.py
   python3 research/performance-canary/verify.py preflight
   ```
4. Run `run.py learn MODEL`, then `pipeline.py build MODEL` for each of `opus`, `sol`, `gemini`. Building does **not** launch coding. Check cache quality and coverage before solving.
5. Only after all caches pass, explicitly run `pipeline.py solve MODEL`. Direct `run.py solve` has the same global readiness gate. No model/effort fallback is permitted. A source, task or harness change after freezing fails the gate.

Authentication must already exist. The canary's scripts still use the recorded machine's Codex credential symlink and local Python interpreter; credentials are never copied into reports. Use `verify.py score` for frozen executable grades. The historical `summarize.py`/`report.py` continue to describe the archived batch; a new experiment needs its own report based on its saved records.

## Local checks, without model calls

`npm test` runs the Python guard tests through `test/benchmark-guardrails.test.js`. Python 3.9+ is required for these repository checks. Set `THINKER_BENCH_PYTHON` to the benchmark interpreter to include real pytest integration tests if the default Python lacks pytest. The tests cover a failed cohort blocking all coding, corrupt/empty/unserved notes, baseline contamination, invalid preflight, live output/heartbeats, signals, shared stops, timeouts, orphan cleanup, and real stress-selection bypass attempts.
