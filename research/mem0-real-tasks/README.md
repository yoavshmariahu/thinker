# Two real coding tasks: thinker vs Mem0 OSS vs no memory

Authors: Codex with Yoav Shmariahu. Date: 2026-10-04 (America/Los_Angeles).

All three arms passed both tasks and their full upstream test suites. On this small sample, neither memory system demonstrated a build-plus-solve token saving over no memory. Mem0 built memories using 2.46× thinker's model tokens, but its subsequent solvers used fewer tokens than thinker's; build expense alone did not predict total expense.

These were actual code changes, not comprehension questions: six independent agents wrote patches, tests and documentation on pre-fix Click snapshots. There was one run per arm per task, so this is a pilot result, not evidence that either system generally wins. Public historical code may be present in model training data.

## Tasks and correctness

| Task | Upstream acceptance | Full suite, each solver arm |
|---|---|---|
| [Click #3364](https://github.com/pallets/click/pull/3364): split string default_map values for multi-value parameters | 5/5 passed | 1,440 passed, 25 skipped/xfail |
| [Click #3391](https://github.com/pallets/click/pull/3391): explicit sys/fd CliRunner capture modes | 12/12 passed, 1 Windows-only skipped | 1,597 passed, 26 skipped/xfail |

Before any solver ran, the original snapshots failed 2 and 12 acceptance cases respectively; the upstream reference fixes passed. The scorer applies each captured patch in a separate checkout and replaces the affected test module with the immutable post-fix upstream version. Thus agents cannot weaken the acceptance tests. The full suite here means the upstream suite with this replacement, not every test an agent added to that module. Passing it does not prove all untested edge cases or documentation claims. Windows behavior was not executed on Windows.

## Measured results

Tokens below sum reported input, cache writes, cache reads and output. Cached reads dominate these totals; they are not a financial cost estimate. Detailed counters remain in [raw/summary.json](raw/summary.json).

| Task | Arm | Solver tokens | Solver seconds | Tool calls | Memory build tokens |
|---|---|---:|---:|---:|---:|
| #3364 | No memory | 101,053 | 30.0 | 10 | 0 |
| #3364 | thinker | 72,969 | 24.6 | 9 | 11,348 |
| #3364 | Mem0 OSS | 97,331 | 32.5 | 9 | 26,327 |
| #3391 | No memory | 236,677 | 85.4 | 10 | 0 |
| #3391 | thinker | 403,063 | 107.8 | 15 | 8,524 |
| #3391 | Mem0 OSS | 229,772 | 81.2 | 13 | 22,576 |

| Both tasks | No memory | thinker | Mem0 OSS |
|---|---:|---:|---:|
| Correct tasks | 2/2 | 2/2 | 2/2 |
| Solver tokens | 337,730 | 476,032 | 327,103 |
| Build tokens | 0 | 19,872 | 48,903 |
| Build + solve tokens | 337,730 | 495,904 | 376,006 |
| Build + retrieval + solve seconds | 115.4 | 148.3 | 150.5 |
| Tool calls | 20 | 24 | 22 |

Thinker saved tokens on the small default-map fix but spent much more on the capture-mode task. Its capture-mode run made a more complex implementation and additional iterations on its own tests, including correcting a macOS `sed -i` invocation. The frozen transcripts show this variance; they do not establish that the memory caused it. Mem0's solver savings versus control (10,627 tokens) did not cover its 48,903-token memory build on these two uses.

We generated the shared source sessions specifically for this evaluation: **172,144 additional tokens and 62.4 seconds**. Those costs are excluded from the table above. If these were ordinary useful prior work, they would be sunk costs; if building memory solely for these tasks, add them to each memory arm's total. Neither interpretation improves this sample's case for paying more to build memories. Repeated reuse might amortize extraction, but two tasks cannot establish that benefit or a break-even point.

## Fairness and isolation

- Thinker baseline `f1cf3aea24e68c8325bb09e63bfeff9b91b2a169`; Mem0 OSS `abb81c88e1f738a8117d8293530fbc31a5ef8fd9` (2.2.1). Model: `claude-sonnet-5-5` for source exploration, both memory builders, and all solvers. Protocol frozen before solving: [raw/protocol.json](raw/protocol.json).
- Both builders received byte-identical condensed source-session evidence, with SHA-256 hashes in the protocol and build records. The source explorers saw only pre-fix code and general exploration questions, not the future task request. Each task had fresh independent memory stores.
- Mem0 received **no thinker notes**. It ran locally with Qdrant and FastEmbed `BAAI/bge-small-en-v1.5` (384 dimensions), using its actual extraction and vector retrieval. A loopback OpenAI-compatible adapter called the authenticated Claude CLI. No hosted Mem0 API key was needed. Optional spaCy models were absent; the SDK's fallback remained in use.
- Thinker produced one note per task; Mem0 produced 15 and 13 memories. Each arm received at most 750 estimated tokens of prefetched memory (ceil(chars/3.6)); actual bundles were thinker 597/648 and Mem0 747/741. Retrieval times were thinker 288/59 ms and Mem0 34/48 ms, excluding startup and model downloads.
- Solver worktrees had a new single-commit snapshot with no remote or future history. MCP and global memory hooks were disabled. The agent prompts barred sibling directories, web access and git history. Tool-input audit found no accesses to other arms, thinker notes, hidden tests or network/history commands. This was prompt-and-audit isolation, **not an OS-enforced filesystem sandbox**; agents had Bash access. Complete normalized events and patches are retained in `raw-evidence.tar.gz`.
- Order was control/thinker/Mem0 for #3364, Mem0/thinker/control for #3391. Provider prompt-cache state was not reset, so order and cache reuse can affect timings and token categories. No solver retries or tuning based on scores.
- Telemetry was disabled throughout. These runs preceded the unified THINKER_TEST change and retain explicit isolation flags. Node tests on the pinned thinker baseline: 365 passed, 4 skipped.

## What the more expensive builder did

In this configuration Mem0's native extraction prompt asks for rich, self-contained factual memories and broad coverage. It split the same trace into many entries, embedded them, and retrieved by vector similarity. Thinker distilled one focused repository note with dependency anchors and served it using its lexical ranking and context packing. Both made one extraction call per task here; Mem0's broader prompt/output used more tokens. This pilot did not exercise memory reconciliation over many sessions, graph memory, dependency invalidation after edits, or native interactive MCP lookup.

The answer to “is the extra building worth it?” for this sample is **not demonstrated**: correctness tied, and no memory was cheapest in aggregate tokens and build-inclusive wall time. It would be premature to conclude expensive memory never helps. A useful next experiment would measure repeated reuse and stale-code changes across more tasks, with multiple runs and the same no-memory control.

## Reproduction

The harness is in [bench/mem0-real](../../bench/mem0-real). Python 3.13.14, pytest 8.4.2, macOS 14.6.1 arm64. The initial pytest 9.1.1 preflight hit historical Click warnings-as-errors unrelated to the tasks; pinning 8.4.2 made both upstream reference suites pass before solver execution. Python dependencies are frozen in [python-requirements.txt](python-requirements.txt).

Use a new isolated thinker worktree at the pinned baseline plus these harness files. Copy the recorded raw directory aside before a fresh experiment: scripts deliberately resume existing records. Keep `THINKER_TELEMETRY=off` for every command and child. Install requirements into `.venv-mem0`, and fetch the pinned Click commits into a separate clone. Then:

1. Set `CLICK_REPO` to that clone; run `.venv-mem0/bin/python bench/mem0-real/prepare.py`.
2. Run `.venv-mem0/bin/python bench/mem0-real/verify.py preflight` and check both reference fixes pass.
3. Run `node bench/mem0-real/run.js learn`.
4. Start `.venv-mem0/bin/uvicorn bench.mem0-real.server:app --host 127.0.0.1 --port 18882` with `MEM0_DIR` and `FASTEMBED_CACHE_PATH` pointing inside the isolated worktree, `MEM0_TELEMETRY=false`, and `OTEL_SDK_DISABLED=true`. The source file includes the remaining controls. This step downloads the embedding model if absent.
5. With `THINKER_HOOKS=off THINKER_NO_LEARN=1 THINKER_NO_BG_VERIFY=1 THINKER_NO_AUTO_UPDATE=1 THINKER_LOG=off`, run `node bench/mem0-real/build.js`, then `node bench/mem0-real/run.js solve`.
6. Run `.venv-mem0/bin/python bench/mem0-real/verify.py score` and `.venv-mem0/bin/python bench/mem0-real/summarize.py`.

Model usage for the two recorded Mem0 extractions is preserved separately in `raw/mem0-model-usage.json`. Full traces, adapter requests, server logs, patches, gold tests and XML reports are preserved in `raw-evidence.tar.gz`; extract with `tar -xzf raw-evidence.tar.gz` inside this report directory to replay the recorded scoring or aggregation. The archive also includes the upstream Click license. The summarizer associates adapter calls with tasks by their shared evidence text. Preserve new protocol hashes and results under a new name. Remove the nested snapshot worktrees and stop the loopback server when finished.
