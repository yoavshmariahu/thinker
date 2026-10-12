# Astra: two real coding tasks, matched models

Author: Codex with Yoav Shmariahu. 2026-10-05.

**GPT-6 Astra, medium reasoning** was used for exploration, both memory builders and all six coding runs. Same tasks and thinker implementation as the earlier Sonnet experiment; no memory crossed between arms.

All three arms passed both task-specific acceptance sets. Neither memory arm demonstrated a correctness advantage on this sample. No memory used the fewest build-plus-solve tokens; thinker used 19% more and Mem0 48% more. Thinker helped on the smaller task but spent more on the capture task.

## Correctness

| Task | Arm | Acceptance passed | Acceptance failures/errors | Full-suite passed | Full-suite failures/errors |
|---|---|---:|---:|---:|---:|
| click-3364 | control | 5 | 0 | 1440 | 0 |
| click-3364 | thinker | 5 | 0 | 1440 | 0 |
| click-3364 | mem0 | 5 | 0 | 1440 | 0 |
| click-3391 | control | 12 | 0 | 1597 | 0 |
| click-3391 | thinker | 12 | 0 | 1596 | 1 |
| click-3391 | mem0 | 12 | 0 | 1597 | 0 |

The default-map acceptance set has five tests; capture mode has twelve runnable tests plus one Windows-only skip. Full suites also contain platform/optional skips. Passing these tests does not establish untested behavior.

The original thinker full-suite run had one failure: `test_echo_via_pager[test5- cat ]`, outside the task's acceptance tests. It expects a pager subprocess not to write before a generator raises—a timing-sensitive assumption. The solver patch changes `src/click/testing.py`, not the pager implementation or `tests/test_utils.py`.

A balanced diagnostic ran the generator-exception pager cases ten times each on all three solver patches, the upstream reference fix, and the original base, in rotating order. Every solver arm and the base passed all ten diagnostic runs; the upstream reference failed once (`test5-cat`). Together with the base preflight's pager failure, this supports a pre-existing timing flake rather than evidence of a thinker-specific regression. The original **1/2 full-suite score remains unchanged**; no solver was rerun. See [raw/pager-diagnostic.json](raw/pager-diagnostic.json).

## Tokens and time

| Both tasks | No memory | thinker | Mem0 OSS |
|---|---:|---:|---:|
| Acceptance tasks passed | 2/2 | 2/2 | 2/2 |
| Full suites passed | 2/2 | 1/2 | 2/2 |
| Solver tokens | 465,689 | 521,939 | 641,785 |
| Memory-build tokens | 0 | 33,074 | 47,261 |
| Build + solve tokens | 465,689 | 555,013 | 689,046 |
| Tool events | 21 | 22 | 22 |
| Solver seconds | 399.4 | 398.5 | 534.7 |
| Build + retrieval + solver seconds | 399.4 | 464.3 | 627.4 |

Input tokens already include cached input. Totals add input and output only. These counters are not financial costs.

| Task | Arm | Solver tokens | Solver seconds | Build tokens |
|---|---|---:|---:|---:|
| click-3364 | control | 162,606 | 128.8 | 0 |
| click-3364 | thinker | 117,490 | 91.9 | 16,479 |
| click-3364 | mem0 | 172,785 | 164.8 | 23,754 |
| click-3391 | control | 303,083 | 270.6 | 0 |
| click-3391 | thinker | 404,449 | 306.6 | 16,595 |
| click-3391 | mem0 | 469,000 | 369.9 | 23,507 |

Generating the shared source sessions cost **308,817 tokens and 223.0 seconds**, excluded above. Add that cost to each memory arm when treating the source sessions as setup; it is sunk only when equivalent prior work already exists.

## Limits and evidence

One run per arm on two historical public tasks is a pilot, not a general ranking. No selective solver retries. No model judge. Differences from the earlier Sonnet cohort also include the coding harness and regenerated evidence; do not attribute them solely to the model.

See [METHOD.md](METHOD.md) for the pinned commits, environment, model controls, baseline pager-test caveat, isolation limits and reproduction steps. [raw/summary.json](raw/summary.json) retains detailed counters; `raw-evidence.tar.gz` retains prompts, full events, patches, memory outputs, upstream gold fixtures and test logs.

## Literal arm (added 2026-10-10)

A fourth arm, `literal`, reuses the frozen source sessions, solver model and scoring above with no
memory builder at all: the condensed session is cut into paragraph-sized units (one command with
its output, one paragraph of the agent's answer), ranked by BM25 against the task request and packed
verbatim under the same 750-token budget (`bench/astra-mem0-real/literal-retrieve.mjs`, run and
scored by `literal.py`). One run per task, Codex CLI 0.162.0, GPT-6 Astra medium.

| Task | Arm | Acceptance | Full suite | Solver tokens | Uncached input + output | Solver seconds |
|---|---|---:|---:|---:|---:|---:|
| click-3364 | literal | 5/5 | 1440/1440 | 149,784 | 21,144 | 61.4 |
| click-3391 | literal | 12/12 | 1626/1626 | 453,614 | 44,526 | 203.1 |

Against the rows above: both tasks pass, zero build tokens, the shortest solver time of the four
arms, and uncached spend between thinker's notes (55,123 over both tasks) and the control (77,465).
Artifacts: `raw-evidence-literal.tar.gz`. Discussion: `research/mem0-review-2026-10/README.md`.
