# Astra comparison protocol

Author: Codex with Yoav Shmariahu. Run date: 2026-10-05.

This repeats the two actual Click code-change tasks from the Sonnet experiment using **GPT-6 Astra (`gpt-6-astra`), medium reasoning** in exploration, both memory builders, and all three coding arms. The coding arms are no memory, thinker, and Mem0 OSS. There is one run per arm per task. Correctness uses executable upstream tests, not a model judge.

The model, task inputs and run order are frozen in [raw/protocol.json](raw/protocol.json). `AGENTS.md` now requires matched models and reasoning settings in future comparisons, forbids silent fallback, and keeps different-model results in separate cohorts. This run is not a v0.1.6 comparison.

## What is held fixed

- Tasks: [Click #3364](https://github.com/pallets/click/pull/3364), string default-map values for multi-value parameters; [Click #3391](https://github.com/pallets/click/pull/3391), explicit sys/fd capture modes for CliRunner. Exact source commits and behavioral prompts are in the protocol.
- Thinker implementation: `f1cf3aea24e68c8325bb09e63bfeff9b91b2a169`, the same implementation as the earlier Sonnet comparison. It is loaded from a separate detached worktree rather than the evolving main checkout.
- Mem0 OSS: `abb81c88e1f738a8117d8293530fbc31a5ef8fd9`, version 2.2.1. Qdrant local storage; FastEmbed `BAAI/bge-small-en-v1.5`, 384 dimensions. Optional spaCy models absent, retaining the SDK fallback. No hosted Mem0 API or key.
- Codex CLI 0.160.0, isolated homes containing only an authentication symlink and experiment configuration. Same model, medium reasoning, no external plugins, no multi-agent work, no web search, and ignored repository instruction files. Model settings are asserted by the wrapper and recorded with each call; failed calls are not replaced with another model.
- Learners inspect only pre-fix code using general exploration prompts. Both builders receive byte-identical condensed evidence, with hashes recorded before coding. Memory stores are fresh and independent per task/system. Mem0 never receives thinker notes. Shell tools are disabled during memory building; the audit requires zero tool use from either builder.
- Solvers get at most 750 estimated tokens of prefetched memory, using `ceil(chars/3.6)`, or none for control. No live memory tools, post-edit retrieval, or learning during coding. Order: control/thinker/Mem0 on #3364, then Mem0/thinker/control on #3391. Calls run sequentially during coding; provider prompt-cache state is not reset.
- Every arm uses its own history-free, single-commit snapshot with no remote. Read-only exploration, workspace-write coding. Prompts bar sibling directories, hidden tests, history, networking, installs, delegation and commits. This is not complete OS-enforced read isolation: the filesystem sandbox permits reads outside the checkout, so tool inputs are audited too.
- Setup and all children have telemetry disabled. The pinned thinker engine predates unified test mode, so its legacy isolation flags are retained alongside `THINKER_TEST=1`.

## Scoring and interpretation

Before coding, the original snapshots and upstream fixes are scored with the same evaluator. The original #3364 snapshot fails two acceptance cases; #3391 fails twelve. The upstream reference fixes pass both acceptance and full suites. The #3391 base full-suite preflight also had an unrelated `test_echo_via_pager[test6-less]` failure (absent from the reference-fix run); keep that baseline caveat when interpreting any full-suite failures.

Each frozen solver patch is applied to a separate scoring checkout. The affected test module is replaced with the unchanged upstream post-fix module before acceptance and full-suite execution. Agent edits cannot weaken those tests. This also replaces the agent's own tests in that module; “full suite” refers to the resulting upstream suite. It is evidence of tested behavior, not a proof of every requested edge case or documentation claim. One Windows-only capture acceptance test is skipped on macOS.

Primary outcomes are acceptance success and regression-suite success. Tokens and time are separate costs. Codex input counters already include cached input; total tokens equal input plus output, not input plus cached input plus output. Exploration, memory building, retrieval and coding are accounted separately. These are not financial cost estimates.

Both source sessions were generated for this experiment. Treat their cost as setup when evaluating a fresh start; treat it as sunk only if such prior work would already exist. With two public historical tasks and one run per arm, differences cannot establish significance or a general ranking. Model training-data familiarity remains possible.

The earlier Sonnet run used another coding harness and generated other exploration evidence. Even with pinned tasks, implementation and budgets, a between-cohort difference is not a clean estimate of model effect. Native interactive MCP retrieval, repeated memory reuse, dependency invalidation and long-running memory reconciliation are not tested here.

## Reproduce

Create an isolated worktree containing this harness. Keep raw results under a new run directory or move the recorded `raw/` aside: the scripts resume existing results. Use the pinned `python-requirements.txt` with Python 3.13 and pytest 8.4.2 in `.venv-astra-mem0`. A logged-in Codex CLI is required; adapt the authentication-symlink and executable paths in the harness for your machine. Do not copy credentials into artifacts.

1. Create the pinned engine: `git worktree add --detach bench/worktrees/astra-engine f1cf3ae`.
2. Set `CLICK_REPO` to a local Click clone containing the pinned commits, then run `prepare.py` and `verify.py preflight` from `bench/astra-mem0-real/`. Run every command with `THINKER_TEST=1 THINKER_TELEMETRY=off`.
3. Run `run.py learn`. Hash the evidence and freeze the protocol before coding.
4. Create `bench/worktrees/astra-mem0-real/home-build` with an auth symlink and a medium-reasoning config. Put a `codex` symlink to `codex-wrapper.py` under the experiment's `bin/` directory and prepend it to PATH.
5. Start `server.py` on loopback port 18883 with that CODEX_HOME, `MEM0_DIR` and `FASTEMBED_CACHE_PATH` under the experiment's state directory, `MEM0_TELEMETRY=false` and `OTEL_SDK_DISABLED=true`.
6. Run `node bench/astra-mem0-real/build.js` with `THINKER_LLM=codex`, `THINKER_LLM_MODEL=gpt-6-astra`, `ASTRA_TEXT_ONLY=1`, the wrapper PATH and isolated CODEX_HOME. Disable the pinned engine's hooks, MCP, learning, background verification, auto-update and usage logging. Stop the server when all four retrieval bundles exist.
7. Run `run.py solve`, then `verify.py score`, `summarize.py` and `audit.py`; review the tool-input audit. Retain failures instead of rerunning selectively.
8. Archive raw data, stop child processes and remove the task and engine worktrees.

Full prompts, native events, patches, build outputs, retrieval bundles and XML test reports are preserved in `raw-evidence.tar.gz`. Extract it with `tar -xzf raw-evidence.tar.gz` in this directory to inspect or replay aggregation. The public Click gold fixtures retain their upstream license. No Codex homes or authentication files are archived.

Codex invocation and reasoning overrides follow the [official iterative-repair example](https://developers.openai.com/cookbook/examples/codex/build_iterative_repair_loops_with_codex); the actual commands and model settings used are recorded in the raw call artifacts.
