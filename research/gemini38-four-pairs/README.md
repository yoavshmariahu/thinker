# Gemini 3.8 Flash cache efficiency: four paired coding tasks

Author: Codex. Requested by Yoav Shmariahu, 2026-10-05. Status: completed.

## Question and design

Does Thinker's cache reduce Gemini's work on coding tasks without losing bug-fix behavior? The prior five-pair Opus 5.5 check did not show a consistent gain. This directional check uses four existing hard-change tasks: two from PostHog and two from Grafana. They were selected before agent runs because a prompt-time preflight retrieved a note for each task. This intentionally tests tasks with cache coverage, not a random task sample.

The agent was Antigravity CLI 1.2.17 with `gemini-3.8-flash-high` and `--effort high` for every arm. Its transcript model-selection record was `Gemini 3.8 Flash (High)` in all eight completed runs. The judge used the same pinned Gemini model for both arms of each task. Tasks, repository snapshots, CLI permissions, 20-minute agent cap, and ambient agent setup were fixed within each pair. Runs were sequential; the first arm alternated between tasks in each repository. Learning, telemetry, background work, and cache holdout were disabled with `THINKER_TEST=1`, `THINKER_TELEMETRY=off`, `THINKER_NO_LEARN=1`, and `THINKER_HOLDOUT=off`.

`nocache` had no Thinker notes or MCP server. `cache` received a fresh copy of the noteset, a prompt-time note bundle, and Thinker's MCP tools. The coding request text was identical between arms. For retrieval, the hook saw the bug description ahead of the benchmark's generic preamble; the agent still saw the original request in both arms. The note source was not shared between runs. An initial cache attempt on PR106672 had used the generic preamble for retrieval and served no note; it was canceled before producing a run record. The completed cache attempt used the corrected hook input. That canceled attempt and run order are limitations when interpreting wall time.

The preflight served notes from the source notesets and updated their local usage fields before the agent runs. Each cache arm copied that post-preflight snapshot; the tracked notesets were restored after the runs. This usage-history effect and the selected-task design limit reproduction of the exact ranking from an untouched noteset.

| Repository | Snapshot | Noteset | Tasks |
| --- | --- | --- | --- |
| PostHog | `a3b3c3685bcffcf273f0d27ffb6a669239200e30` | `posthog-v3` | `PR106672-hard`, `PR105871-hard` |
| Grafana | `1fd1d63980538b9e658a64ce1989851a20adf2f5` | `grafana-v3` | `PR133206-hard`, `PR133011-hard` |

## Results

Figures are **without / with** Thinker. Input includes ordinary input plus provider prompt-cache reads. Provider prompt caching is separate from Thinker's knowledge cache. Full per-run counters, note IDs, model records, patch hashes, and session IDs are in [results.json](results.json).

| Task | Notes served | Wall seconds | Tool calls | Input tokens, M | Essential criteria |
| --- | ---: | ---: | ---: | ---: | --- |
| PostHog PR106672 | 1 | 1,010 / **673** | 144 / **94** | 15.75 / **11.81** | 6/7 / 6/7; both incomplete |
| PostHog PR105871 | 1 | **433** / 560 | **76** / 105 | **9.29** / 14.18 | 100% / 100%; both pass |
| Grafana PR133206 | 1 | 467 / **391** | 87 / **74** | 9.29 / **6.96** | 100% / 100%; both pass |
| Grafana PR133011 | 1 | 778 / **603** | 131 / **102** | 14.98 / **13.80** | 100% / 100%; both pass |
| **Four-pair total** | **4 of 4** | **2,688 / 2,227 (−17.1%)** | **438 / 375 (−14.4%)** | **49.31 / 46.74 (−5.2%)** | Three passes in each arm |

Ordinary input tokens fell 7.1%, provider prompt-cache reads fell 5.1%, and output tokens fell 19.6%. The router task's `go test -short -count=1 ./pkg/router/` passed in both arms; its test duration is outside the agent wall-time figures. The other three tasks have no executable test in this benchmark. On PR106672 both patches missed the same essential agent-guidance change. Thus this sample shows **efficiency gains on three tasks and a loss on one**, with **no measured correctness difference** between arms.

The PR106672 note described shared-metric frontend handling rather than the backend identifier collision directly. The other three served notes mapped more closely to their requested changes. The positive aggregate therefore should not be read as every note being useful. Four selected, covered tasks are too few to estimate a general Gemini effect or support a website percentage.

## Reproduction

Run from an isolated thinker worktree with `bench/repos` pointing to the pinned repository clones. Set the environment controls above and `THINKER_LLM=gemini THINKER_LLM_MODEL=gemini-3.8-flash-high THINKER_LOG=local`. For each repository run `node bench/gemini-run.js` with `--repo <repo> --tasks bench/tasks/<repo>-hard.json --notes-dir bench/notesets/<repo>-v3/notes --only <two task IDs above> --arm nocache,cache --counterbalance --reps 1 --conc 1 --model gemini-3.8-flash-high --effort high --judge gemini-3.8-flash-high --strict-model --max-min 20 --tag <unique tag>`. The eight raw run records were archived separately; `results.json` retains the measurements needed to audit this comparison.
