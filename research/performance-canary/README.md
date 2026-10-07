# Stopped performance canary: invalid for efficiency

Authors: Yoav Shmariahu and Codex. Run date: 2026-10-06, America/Los_Angeles (UTC artifacts extend into October 7).

**Decision: stop and invalidate this efficiency experiment.** The user challenged the empty caches and task execution; all active benchmark process trees were stopped at 2026-10-07 05:48:59 UTC. Nine coding runs completed, two were interrupted, and seven never started. None will be silently resumed or replaced. The stop marker prevents the current runner, pipeline and cache builder from restarting this batch.

On Thinker `3db79d2a969ccbf18821925acb3b2af2b76da3ed`, all nine fresh session-learning caches were empty. Eight distillations completed: one proposed no notes, and seven proposed nine notes that grounding deferred. The ninth distillation failed Opus's required output schema. No coding run received a note. These were new isolated caches, not deleted or overwritten historical caches. This canary cannot establish a cache efficiency benefit or show that recent changes caused a performance regression; there is no matched older-revision arm.

The canary contains 9/18 coding runs: three identical real Click tasks per model, with and without Thinker, using `claude-opus-5-5`, `gpt-6.1-sol`, and `gemini-3.8-flash-high`, all high effort. Results below are diagnostic measurements of the actual empty-cache condition. Differences can reflect ordinary solver variation and the availability of an empty lookup tool. They must not replace historical efficiency claims on the public UI as if useful memory had been evaluated.

## Harness audit

The operator should have stopped at cache readiness. `pipeline.py` checked exploration validity and the cache-building process exit code, but never checked saved notes, retrieval coverage or distillation failure. `memory.mjs` converted a distillation exception into an empty cache checkpoint, then returned success. As a result coding ran without the intended memory intervention. The freeze preserves these mistakes; they are not grounds for claiming a product-wide cache outage.

The harness used one topic-focused exploration and a custom caller of production learning functions per task/model. It did not invoke normal full setup, PR mining, repository-wide area discovery, the complete `distillFile` orchestration, or native MCP retrieval. In particular it omitted the initial existing-note catalog selection (the catalog was empty), pending-learning persistence and assessment orchestration. It asked exploration for JSON notes and then distilled that answer again. The shared selection/distillation/grounding functions did genuinely produce the recorded rejection outcomes, but those outcomes require an independent normal-path reproduction before attributing them to all cache building.

Task monitoring was also inadequate. `run.py` used `subprocess.run(..., capture_output=True, timeout=1200)` and saved events only after exit. It did not stream progress or enforce child-command deadlines/process-tree cleanup. The interrupted Opus capture task first passed 1,616 ordinary tests, then ran `pytest tests -q -o addopts= tests/test_stream_lifecycle.py`. Clearing `addopts` removed Click's default `-m 'not stress'` exclusion and enabled three 10,000-case stress parametrizations. That upstream test file documents roughly 52 minutes for stress testing. Opus then issued a four-minute sleep while waiting. The saved process inventory and task output establish this concrete cause of the long wait; it was not evidence of slow cache retrieval. No remaining child tests were left running.

Gemini's completed default-map task used 113 tool calls, and its interrupted counterpart had 116 recorded calls, including repeated local probes and source reads. The latter was still active when stopped, not a completed latency observation. Its native transcript is preserved. Opus's in-flight stdout was held by the parent process and was not recoverable after stopping; its partial patch, process command lines and available task output are preserved, with final usage unknown. The interrupted runs are not graded as ordinary model failures.

Before any new efficiency run: validate a nonempty, source-backed cache and actual retrieval using the intended product path; keep model/effort and baseline isolation matched; stream native events to disk; bound test commands and avoid stress suites unless explicitly part of the task; terminate the entire child tree on timeout; and stop immediately on a failed setup gate. This report makes no production-code change and starts no replacement model calls.

## Coding results

Tokens include provider cache reads. Wall time is summed agent-process elapsed time, excluding setup and evaluator execution; concurrent cohorts and provider prompt caching may affect it. “Pass” means the frozen upstream tests passed, independently of the agent's self-report. Provider success and per-test counts remain separate in [summary.json](summary.json).

| Model | Arm | Completed | Acceptance pass | Affected module pass | Total tokens | Tool calls | Wall seconds |
|---|---|---:|---:|---:|---:|---:|---:|
| Opus 5.5 | baseline | 1/3 | 1/3 | 1/3 | 335,986 | 15 | 90.2 |
| Opus 5.5 | thinker | 1/3 | 1/3 | 1/3 | 323,033 | 14 | 89.8 |
| GPT-6.1 Sol | baseline | 3/3 | 3/3 | 3/3 | 1,209,947 | 46 | 495.5 |
| GPT-6.1 Sol | thinker | 3/3 | 3/3 | 3/3 | 1,035,074 | 41 | 546.3 |
| Gemini 3.8 Flash | baseline | 1/3 | 1/3 | 1/3 | 11,358,975 | 113 | 575.3 |
| Gemini 3.8 Flash | thinker | 0/3 | 0/3 | 0/3 | 0 | 0 | 0.0 |

One draw per arm and only three tasks per model are insufficient for general efficiency claims. Do not pool the models into one ranking. Input, output, cache reads, provider validity, immutable patch hashes, and exact grades are in [summary.json](summary.json). AGY reports a total that excludes its `cache_read_tokens`; the summary adds those reads, preserves original totals in raw results, and does not add thinking twice. Tool-call definitions also differ among CLIs.

| Task | Model | Arm | Affected-module tests | Total tokens | Wall seconds |
|---|---|---|---|---:|---:|
| click-3364 | Opus 5.5 | baseline | 39 passed, 0 failed, 0 errors, 0 skipped | 335,986 | 90.2 |
| click-3364 | Opus 5.5 | thinker | 39 passed, 0 failed, 0 errors, 0 skipped | 323,033 | 89.8 |
| click-3364 | GPT-6.1 Sol | baseline | 39 passed, 0 failed, 0 errors, 0 skipped | 234,664 | 87.3 |
| click-3364 | GPT-6.1 Sol | thinker | 39 passed, 0 failed, 0 errors, 0 skipped | 231,183 | 115.5 |
| click-3391 | GPT-6.1 Sol | baseline | 41 passed, 0 failed, 0 errors, 1 skipped | 834,749 | 339.0 |
| click-3391 | GPT-6.1 Sol | thinker | 41 passed, 0 failed, 0 errors, 1 skipped | 639,807 | 343.0 |
| click-3677 | GPT-6.1 Sol | baseline | 100 passed, 0 failed, 0 errors, 0 skipped | 140,534 | 69.2 |
| click-3677 | GPT-6.1 Sol | thinker | 100 passed, 0 failed, 0 errors, 0 skipped | 164,084 | 87.9 |
| click-3364 | Gemini 3.8 Flash | baseline | 39 passed, 0 failed, 0 errors, 0 skipped | 11,358,975 | 575.3 |

## Setup results and diagnosis

| Model | Exploration complete | Failed distillations | Notes proposed | Grounding deferred | Notes saved | Notes served |
|---|---:|---:|---:|---:|---:|---:|
| Opus 5.5 | 3/3 | 1 | 3 | 3 | 0 | 0 |
| GPT-6.1 Sol | 3/3 | 0 | 2 | 2 | 0 | 0 |
| Gemini 3.8 Flash | 3/3 | 0 | 4 | 4 | 0 | 0 |

All seven nonempty proposals reached `prepareNotes` and were deferred with `source evidence does not establish every proposed claim`. This is distinct from Sol's empty style-task distillation and Opus's capture-task structured-output failure: the captured error identifies missing required `tags` fields. The failed setup remains failed and its cache stays empty; no other model or hand-written notes replace it.

The selected evidence and the proposed note are not always aligned. In the Sol defaults-task diagnostic, the proposed note describes `Parameter.consume_value`, `Context._default_map_has`, and `Command.parse_args`. The selected actual source includes final UNSET normalization in `Command.parse_args`, but omits the complete source-selection/default-map helper implementations. Other selected text contains agent-authored summaries. The grounding replay gives individual claim support scores far below the required 0.9 threshold; it does not prove all proposed claims false or all rejections mistaken.

The relevant mechanisms are [learning-evidence.js](../../src/learning-evidence.js) (ranked, budgeted passage selection with adjacent context) and [note-learning.js](../../src/note-learning.js) (title, body lines and applicability each need support of at least 0.9 from a supplied evidence chunk; a contradiction can reject the note). Together with broad distillation, this creates a plausible evidence-coverage bottleneck. The saved diagnostic supports investigating source retention and narrower claims before changing confidence thresholds. It is one diagnostic replay, not a validated product fix.

**Next experiment:** first make source-backed learning produce useful notes under the same model pins, audit their support, then rerun a fresh matched canary. Do not scale this empty-cache result to more repositories. Changing selection, distillation or grounding would be a new experiment, not a repair to these frozen outcomes.

## Setup accounting

Setup uses nine explorations and nine intended frontier distillations, with failed same-model calls retained. Current session-pipeline Jev counts include evidence selection, reconciliation search and grounding. The earlier source-only prototype and one diagnostic replay are reported separately. No financial estimates are made.

| Model | Exploration tokens | Distillation tokens | Current-pipeline Jev tokens | Unscored prototype Jev tokens |
|---|---:|---:|---:|---:|
| Opus 5.5 | 424,788 | 18,919 + unknown | 190,400 + unknown | 58,882 |
| GPT-6.1 Sol | 539,786 | 59,686 | 181,829 | 125,454 |
| Gemini 3.8 Flash | 3,363,062 | 92,147 | 209,830 | 69,067 |

The separate grounding diagnostic consumed 7,241 reported tokens across 3 calls. Three failed Opus frontier calls and one failed Jev request have unknown usage. Known sums are lower bounds where marked; unknown does not mean zero. Final build-attempt timings omit earlier failed attempts, so this report does not claim complete setup latency, amortization or end-to-end savings. Detailed call accounting is in [setup-usage.json](setup-usage.json).

## Method and evidence

- Tasks: [Click #3364](https://github.com/pallets/click/pull/3364), [#3391](https://github.com/pallets/click/pull/3391), and [#3677](https://github.com/pallets/click/pull/3677). [tasks.json](tasks.json) pins base/fixed commits, learning prompts, coding requests and test selectors. The first two requests reuse existing task definitions, but all sessions, caches and solver results here are fresh.
- Each solver and exploration runs in an isolated, history-free snapshot with no remote. Exploration sees only pre-change code and a topic request, not the requested fix or upstream gold tests. No cache is shared across tasks, cohorts or arms.
- This is a session-learning simulation, not the full default setup command: `parseTranscript → refineLearningPlan → distillEvents → prepareNotes → saveNotes`, with the frontier model/effort matched to its coding cohort. Jev is pinned to `jev-1.13.0`. The experiment-only [model-pins.patch](model-pins.patch) fixes effort and records CLI responses; it is not a production change.
- Thinker arms receive `orient` with a 750 estimated-token budget and a two-note limit, plus optional `thinker_lookup` with a 1,500-token budget. All catalogs and retrievals are empty. This does not measure native MCP overhead, PR mining or automatic background learning.
- Every base fails target tests before agent calls; every upstream gold source patch passes. Scoring installs the unchanged upstream test module after applying the agent patch in a separate worktree. Agent-written tests cannot weaken those tests. The capture module skips one Windows-only case on macOS; the full Click suite is not the acceptance claim.
- `THINKER_TEST=1` is inherited throughout. Tests and benchmarks send no production Thinker telemetry. Explicit live Jev requests use a personal key directly to TypeSafe, with no hosted enrollment. No credentials are included in artifacts.
- [PROTOCOL.md](PROTOCOL.md) retains the pre-coding preparation correction, schema normalization, failed-call resume and token-accounting amendments. No successful solver result was retried or selected from multiple draws. The initial prototype accepted no notes and did not reach coding.
- [audit.json](audit.json) checks frozen harness/task hashes, model invocations, immutable note exports and exploration source changes. Native tool inputs are retained for review. CLI sandbox strength differs; Gemini's native transcript may truncate fields, so this is not a claim of hermetic isolation or complete visibility.

## Reproduction and artifact layout

The raw archive contains prompts, native events, patches, upstream gold tests and licenses, JUnit XML, validation logs, learning plans, distilled proposals, grounding decisions, and local usage records. It excludes agent credential homes and the benchmark repositories. Extract it beside this report to `raw/`, then regenerate the summary and report without model calls:

```sh
tar -xzf research/performance-canary/raw-artifacts.tar.gz -C research/performance-canary
THINKER_TEST=1 python3 research/performance-canary/summarize.py
THINKER_TEST=1 python3 research/performance-canary/report.py
```

The original harness is retained in `raw/frozen-harness/`; execution hashes refer to those originals. Current model-calling entry points refuse to run while [STOPPED.json](STOPPED.json) exists. Do not remove that marker to resume this batch. A replacement experiment needs the readiness and execution safeguards above, a new isolated worktree/output directory, the intended cache-building path, and a separately frozen protocol. Python dependencies are recorded in [python-requirements.txt](python-requirements.txt). The old harness contains machine-local absolute interpreter and checkout paths; it is an audit artifact, not a portable supported benchmark command.
