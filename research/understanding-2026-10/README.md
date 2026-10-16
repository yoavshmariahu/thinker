# Understanding notes: from an upper bound to a build (2026-10-15/16)

Notes on how the code works now (maps, change recipes, invariants), read from the code at a base
commit, against notes mined from merged PRs. Task set: the 13 mlflow harder-set requests
(`bench/tasks/mlflow-b2-hard.json`, base 1bb65f1c6). The product path this led to is
`thinker understand` (src/understand.js) and Artemis's understanding caches.

## 1. Upper bound (2026-10-15)

42 notes written by Sonnet from base-commit code over ten areas chosen knowing which files each PR
touched, served with best-of-three-views cross-encoder scoring and a 1500-token hook budget. Codex
gpt-6-astra, one-shot, 30 sessions on the six served tasks against the same day's 30 no-cache and 30
PR-note sessions (not interleaved): tool calls 0.80 [0.73–0.87], input 0.81 [0.75–0.89] of no cache;
the gain came from the two tasks served a change recipe (PR26300 7 vs 13 calls, PR26442 9 vs 12);
fresh input flat; passes identical. The run records were lost with the deleted mlflow-bench
worktree; the numbers survive in the session's report.

## 2. Choosing the code without knowing the tasks

`area-coverage.mjs`, `file-coverage.mjs`: ranking by recency-weighted commits in the 180 days before the
base (gold files only score coverage).

| read whole | lines | ≈ input tokens | tasks fully covered | changed source files covered |
|---|---|---|---|---|
| top 10 directories (src/areas.js at depth 2) | 716k | 14M | 8/13 | — |
| top 100 files | 123k | 2.5M | 4/13 | 18/31 |
| **top 200 files** | 171k | 3.4M | 6/13 | 23/31 |
| top 400 files | 235k | 4.7M | 8/13 | 26/31 |

Files, not directories. Three tasks change files nobody touched lately (PR26252, PR26265, PR26311):
recency cannot reach them; demand-driven builds are the open route. In use the ranking stays inside
the person's focus areas (`thinker understand --areas`, default the saved areas).

## 3. Top 200, built and judged

Built by Sonnet (the later `thinker understand` skips generated files, which this run read):
114 calls, 474 notes, 5.19M input and 0.61M output tokens (`build-log-top200.json`). Judged by Haiku
on the bench/serving rubric (2 = the task's mechanism, 1 = a useful map), candidates = lexical top 20
plus notes in a changed directory (`evaluate.mjs`, `labels-top200.json`).

A rated-2 note exists for 8 of 13 tasks (PR-mined cache: 3). Serving, simulated with the shipped
ranker:

| notes | scoring | rated-2 served | useful served | precision | served with nothing useful |
|---|---|---|---|---|---|
| PR-mined | search text | 2/13 | 6/13 | 0.82 | 0 |
| understanding | search text | 4/13 | 4/13 | 0.80 | 0 |
| **understanding** | **best of three views** | **5/13** | **7/13** | **0.86** | **0** |
| both | either | 4/13 | 8/13 | 0.71–0.75 | 0 |

Mixed with PR notes, the PR notes outrank the understanding notes where they share the request's
words; understanding notes should be served on their own. The ranker still passes over rated-2 notes
on PR26442, PR26267 and PR26307.

## 4. Acceptance criteria for loop experiments

`draft-criteria.mjs`: one read-only Claude Code session (Read, Glob, Grep) per task in a checkout of the
base outside the bench tree, from the request only. The first draft (`criteria-draft.json`) named code
locations, which would hand the no-cache arm the map; the second (`criteria-v2.json`) states behavior
only. After normalizing the test commands to the bench venv and replacing a suite that already fails
at the base, `acceptance-mlflow-6.json` was frozen into the task file (34 criteria, six tasks). PR26225's
request now names `UnsupportedGuardrailScorerError`, which its gold test imports.
