# Thinker versus open-source Mem0: two-task pilot

Author: Codex with Yoav Shmariahu. Date: 2026-10-04.

## Result

This small pilot does not establish a general winner. On two read-only Click questions, both systems scored **0.5/1 on each question**, and both used **six code-inspection tool calls total**. Mem0's two solver runs took 19.63 seconds versus thinker's 23.46 seconds. Thinker's independent memory build took 15.18 seconds and 19,023 model tokens versus Mem0's 27.81 seconds and 83,014 tokens. Timing has one repetition and includes CLI startup and provider/cache variance.

**Mem0 received no thinker notes.** Two fresh source-exploration sessions were the shared learning corpus. Each system extracted its own memories with Sonnet 5.5: thinker produced two notes and Mem0 eighteen memories. Neither learner saw the evaluation questions or their reference answers. These are independently built memories from common source evidence, not imported thinker summaries.

The official Mem0 LoCoMo pipeline also completed a **reduced first-session smoke test: 18 turns, two temporal questions, 2/2 judged correct**. This is neither the full LoCoMo benchmark nor a reproduction of Mem0's published scores. Thinker was not evaluated on LoCoMo.

## Pinned configuration

| Component | Version |
|---|---|
| Thinker | `b8b8f80` |
| Mem0 OSS | `2.2.1`, `abb81c88e1f738a8117d8293530fbc31a5ef8fd9` |
| Official benchmark submodule | `4b61c5d31b9c668a12b4f5e78064248a02c82d2b` |
| Click | `8c1a0a7abbc1c36f70d1f65f3604acc46c5ce6ab` |
| Extraction, solver, judge | `claude-sonnet-5-5`, installed Claude CLI login |
| Mem0 storage/embeddings | Local Qdrant; FastEmbed `BAAI/bge-small-en-v1.5`, 384 dimensions |
| Thinker retrieval | Default orientation, dependency checks and cross-encoder enabled |

No hosted Mem0 account or Mem0 API key was used. The loopback OpenAI-compatible adapter invokes the real Claude model through its installed CLI login; it does not mock the model or memory engine. Its placeholder API-key value is used only for loopback HTTP. This adapter is a benchmark configuration, not Mem0's default OpenAI model stack. Optional spaCy models were absent, so Mem0 used its SDK fallback behavior for those features. See [protocol](raw/protocol.json), [Mem0 configuration](raw/mem0-config.json), and [Python dependency versions](python-requirements.txt).

## Coding tasks and controls

Learning: `L1-option-value-path` and `L5-testing` from `bench/tasks/click.json`. Evaluation: `E1-flag-parsing` and `E5-runner-exit` from that same existing task set. The normalized raw session events are retained with hashes; the two native ingestion paths consume these events. Thinker applies its standard transcript condensation and selective note policy. Mem0 receives prompts, assistant messages, and full tool evidence, with instructions to remember reusable repository facts. Consequently extraction input volume differs; this measures these native policies, not equal-size model prompts.

Each solver gets a separate clean Click worktree, identical generic instructions, the same model and read-only code tools, and one prefetched memory bundle. Both bundles use a 750-token budget with the same `ceil(chars / 3.6)` estimator. Thinker uses its default selection and packing; Mem0 ranks its top 20 results and fits whole memories into the budget. Both have learning and machine-wide hooks disabled. There are no ongoing memory-tool calls, so this does **not** measure thinker's full MCP workflow, Mem0's agent integration, change-task correctness, or dependency invalidation under edits.

Arm order alternates between tasks. The judge sees the task, existing gold reference and answer, without arm labels; its allowed scores are 0, 0.5 and 1. Solver token totals include cache reads and cache writes. These are reported model tokens, not estimated money or novel input alone. There is no no-memory baseline.

| Task | System | Judge score | Solver seconds | Tool calls | Input incl. cache | Output |
|---|---|---:|---:|---:|---:|---:|
| Flag parsing | Thinker | 0.5 | 14.52 | 4 | 29,482 | 1,669 |
| Flag parsing | Mem0 | 0.5 | 12.06 | 5 | 29,687 | 1,607 |
| Runner exit/capture | Thinker | 0.5 | 8.94 | 2 | 25,265 | 1,092 |
| Runner exit/capture | Mem0 | 0.5 | 7.58 | 1 | 16,250 | 951 |
| **Total** | **Thinker** | **0.5 mean** | **23.46** | **6** | **54,747** | **2,761** |
| **Total** | **Mem0** | **0.5 mean** | **19.63** | **6** | **45,937** | **2,558** |

The common failure was incomplete reference coverage, not complete failure to answer. These are model-graded comprehension answers, not executable acceptance-test pass rates. [Full answers, judge explanations and measurements](raw/summary.json) accompany the per-task artifacts.

## Build and retrieval measurements

| Measurement | Thinker | Mem0 |
|---|---:|---:|
| Independently extracted memories | 2 | 18 |
| Build wall time, both sessions | 15.18 s | 27.81 s |
| Build tokens, input + cached input + output | 19,023 | 83,014 |
| Flag question warm retrieval median | 35.3 ms | 17.2 ms |
| Runner question warm retrieval median | 34.4 ms | 13.5 ms |

Retrieval measured one initial request followed by ten warm requests per task, before solvers started. Medians use the average of the middle two warm samples. Thinker is called in-process; Mem0 is called through loopback HTTP to an already initialized server. The comparison includes their differing native work: thinker's dependency verification and cross-encoder versus Mem0's embedding/vector/hybrid retrieval. Model download and server initialization are excluded from build and warm retrieval times. With only 2 versus 18 stored items, this says nothing about scaling to a large corpus.

Thinker injected **no memory** for the flag question and one for the runner question. A follow-up read-only diagnostic found the relevant pipeline note in lexical ranking (`rel=1`), but the default cross-encoder returned no selection. Thus the empty context was a selection decision, not a missing or failed memory build. [Diagnostic](raw/thinker-retrieval-diagnostic.json). No retrieval parameters were tuned after observing scores.

## Official Mem0 benchmark smoke test

The initial attempt used the official runner on conversation 0 with two questions. `--max-questions 2` limits questions, not ingestion: that conversation still contains **419 one-turn ingestion chunks** across 19 sessions. The local adapter initially forwarded the runner's timestamp and hit the OSS SDK's explicit unsupported-timestamp error. This was an adapter mistake, not proof that the supplied upstream server has the same failure: upstream's request model drops that field. The upstream wrapper also uses legacy search arguments; this adapter maps the request to the current SDK's `filters` and `top_k`.

After matching that timestamp behavior, the smoke run used the first conversation's **first session only**, and the first two original questions whose evidence is entirely in that session, preserving their order. The official ingestion, retrieval, answer and judge code was unchanged. Ingestion completed 18/18 chunks in approximately 40 seconds, and answering/judging two questions took approximately 12 seconds. Top-k was 20. Both answers were judged correct.

There is an important qualification beyond sample size: some extracted memories contained October 2026 dates because the supplied OSS wrapper discards the historical timestamp. The official answer prompt supplies the conversation reference date and explicitly constrains dates to 2022–2024. Therefore **2/2 answer accuracy does not imply correct temporal memory storage**. Retained outputs show both the stored dates and final answers. See [official results](raw/locomo-smoke/locomo_results_20261004_223525.json) and [run log](raw/locomo-smoke.log).

No full LoCoMo, LongMemEval or BEAM run was completed. Mem0's published managed-platform scores include proprietary components and cannot be equated to this locally configured OSS smoke run: [Mem0 README](https://github.com/mem0ai/mem0/blob/abb81c88e1f738a8117d8293530fbc31a5ef8fd9/README.md), [official evaluation repository](https://github.com/mem0ai/memory-benchmarks/tree/4b61c5d31b9c668a12b4f5e78064248a02c82d2b).

## Reproduction

Work in an isolated thinker worktree. Export these settings before setup, installs, tests and runs so children inherit them:

```sh
export THINKER_TELEMETRY=off MEM0_TELEMETRY=false OTEL_SDK_DISABLED=true
export THINKER_HOOKS=off THINKER_NO_LEARN=1 THINKER_NO_BG_VERIFY=1
export THINKER_NO_AUTO_UPDATE=1 THINKER_LOG=off HF_HUB_DISABLE_TELEMETRY=1
npm ci
python3.13 -m venv .venv-mem0
.venv-mem0/bin/pip install -r research/mem0-comparison/python-requirements.txt
```

Clone Mem0 at the pinned commit into `bench/mem0-upstream` and initialize its `evaluation` submodule. Clone Click into `bench/repos/click`, then create `bench/worktrees/click-source` at the pinned Click commit with `git worktree add --detach`. The source corpus can be replayed from the committed `raw/L*.events.json`; alternatively move the old evidence aside and run `node bench/mem0-sessions.js learn` to generate fresh sessions. New sessions are stochastic and change the experiment.

```sh
export MEM0_DIR="$PWD/bench/mem0-state"
export FASTEMBED_CACHE_PATH="$PWD/bench/mem0-state/models"
.venv-mem0/bin/python bench/mem0-local-server.py
# In a second shell with the same exports:
node bench/mem0-build.js thinker
node bench/mem0-build.js mem0
node bench/mem0-compare.js
```

These scripts resume from existing output files. For a genuine fresh run, archive/remove generated build, retrieval, solver and judge JSON plus `summary.json`, remove `bench/mem0-state`, and restart the server; retain the two raw `L*.events.json` files when replaying this exact learning corpus. The local adapter listens only on `127.0.0.1:18881` and supports only the nonstreaming chat operations used here. Stop it after benchmarking and remove all task/source worktrees with `git worktree remove`.

For the official smoke fixture, download upstream's `datasets/locomo/locomo10.json`, take conversation 0, keep only speaker names, `session_1` and its date, and retain the first two non-adversarial questions whose evidence references all begin `D1:`. Invoke the official runner with `--dataset-path` pointing to that fixture, `--conversations 0 --max-questions 2 --top-k 20 --top-k-cutoffs 20 --max-workers 1 --backend oss --mem0-host http://127.0.0.1:18881`. Set `OPENAI_BASE_URL=http://127.0.0.1:18881/v1`, `OPENAI_API_KEY=local-cli-only`, and both model flags to `claude-sonnet-5-5`.

## Validation and exclusions

- Thinker suite: **365 passed, 4 skipped, 0 failed** (369 total); sandboxed loopback-server failures were resolved by rerunning with local socket access.
- Mem0 `tests/memory/test_performance_slow_query_notice.py`: **21 passed**. These test notice behavior with mocks, not performance throughput or retrieval quality.
- Harness JavaScript syntax and Python compilation checked.
- Excluded preflights: differing Sonnet aliases, an initial Mem0 token-budget estimator that allowed extra context, and an out-of-scale judge score. Final runs use a common model, common estimator, and a constrained score enum. No successful preflight was selected based on its outcome.
- Telemetry was disabled throughout. The benchmark adapter disables FastAPI automatic telemetry explicitly as well as the OpenTelemetry SDK.

The next useful comparison is a larger held-out set of actual code changes, repeated runs, a no-memory arm, and an edit between learning and solving. That would test the repository-specific dependency invalidation that this static two-question pilot never exercises.
