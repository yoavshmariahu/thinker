# Opus 5.5 cache efficiency: five paired coding tasks

Author: Codex. Requested by Yoav Shmariahu, 2026-10-05. Status: completed.

## Question and prior baseline

Does Thinker's current cache reduce the total work Claude Opus 5.5 spends on coding tasks, while preserving task completion? The earlier Opus 5 evaluation in `bench/RESULTS.md` found fewer calls before the first edit but no clear reduction in total calls, tokens, or cost. Its arms had unequal task counts. This experiment uses five complete pairs across three repositories.

## Locked design

- Coding agent: Claude Code 2.1.289, exact model `claude-opus-5-5`, effort `medium`, max 60 turns. No model fallback. The harness checked the provider's resolved model and transcript model IDs: all 10 runs used `claude-opus-5-5`.
- Arms: `nocache` and `hook`, same prompt, repository commit, tool configuration, agent settings, model, and effort. `hook` serves a staged copy of the noteset through Thinker's prompt hook; `nocache` has no Thinker hook. Learning, automatic background work, telemetry, and cache holdout are disabled in both arms.
- One agent session at a time to avoid machine contention in wall-time measurements. Arm order is reversed on each repo's second task. No retries for an ordinary task failure; a session limit can be retried by the existing harness.
- The agent loaded no user/project/local settings, had no subagents, and could use only the explicitly configured MCP servers (none in these `hook` and `nocache` arms). The `hook` arm added Thinker's prompt hook and its short system guidance. Both arms inherited `THINKER_TEST=1`, `THINKER_TELEMETRY=off`, `THINKER_NO_LEARN=1`, `THINKER_HOLDOUT=0`, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- Task selection: from the repository's existing hard-change task set, require a cached note anchored to at least one file in the merged patch. Rank eligible tasks by the first eight hex digits of SHA-256 of `opus55-2026-10-05:<task id>`. Take the first two PostHog tasks, first Grafana backend and first Grafana frontend task, and first mitmproxy task. Selection is made before inspecting Opus 5.5 outcomes.

| Repository | Snapshot | Noteset | Task |
| --- | --- | --- | --- |
| PostHog | `a3b3c3685bcffcf273f0d27ffb6a669239200e30` | `posthog-v3` | `PR107042-hard` |
| PostHog | same | same | `PR105793-hard` |
| Grafana | `1fd1d63980538b9e658a64ce1989851a20adf2f5` | `grafana-v3` | `PR133148-hard` |
| Grafana | same | same | `PR133090-hard` |
| mitmproxy | `d482bbaa20af168f8307a504f1de8927144f7f99` | `mitmproxy-systematic` | `PR8295-hard` |

## Measurements

Report paired differences in wall time, tool calls, input tokens (including provider cache reads and writes), and output tokens. Keep these distinct from task quality. Check whether the hook served relevant notes and whether either run failed or hit the turn limit. Grade task completion against the calibrated behavioral criteria where available; inspect the mitmproxy patch against the merged change separately. Five pairs are a directional check, not a stable effect size or a homepage claim by themselves.

## Results

Figures are **without / with** the cache. Input tokens include provider cache reads and writes. The structured per-run measurements and patch hashes are in [`results.json`](results.json); the original sessions are identified there by Claude Code session ID.

| Repository · task | Notes served | Wall seconds | Tool calls | Input tokens, M | Essential criteria met |
| --- | ---: | ---: | ---: | ---: | --- |
| mitmproxy · PR8295 | 1 | 109 / **38** | 18 / **9** | 0.60 / **0.25** | Both patches appear to fix the stall on inspection; automated test unavailable |
| PostHog · PR107042 | 0 | **139** / 215 | 35 / **34** | 1.36 / **1.25** | 0.80 / 0.80; neither fully passes |
| PostHog · PR105793 | 1 | **171** / 179 | **24** / 27 | **1.02** / 1.28 | 1.00 / 1.00; both pass |
| Grafana · PR133148 | 0 | 167 / **157** | 26 / 26 | 1.45 / **1.33** | 1.00 / 0.83; baseline passes, cache does not |
| Grafana · PR133090 | 0 | **66** / 83 | **14** / 16 | **0.35** / 0.51 | 0.00 / 0.00; neither passes |
| **Five-pair total** | **2 of 5** | **653 / 671 (+2.8%)** | **117 / 112 (−4.3%)** | **4.79 / 4.62 (−3.5%)** | See task rows; do not collapse quality into efficiency |

The two pairs that actually received a note point in opposite directions: mitmproxy used 9 fewer tool calls and 71 fewer seconds, while PostHog PR105793 used 3 more calls and 8 more seconds. The other three `hook` runs received general Thinker guidance but no cached note. Their timing changes cannot be attributed to cache knowledge. Selection used static note-to-gold-file coverage, which did not predict prompt-time serving.

[Opus 5.5 defaults to medium effort](https://platform.claude.com/docs/en/models/opus-5-5/overview). It graded both arms of the four tasks with pre-existing calibrated criteria; `THINKER_LLM=claude` and an exact model pin prevented provider fallback. The existing Go test for Grafana PR133148 passed in both arms, although the criteria judge found one essential behavior missing in the cache patch. Both mitmproxy patches have the same key change as the merged fix: they limit the wait-for-more-data path to packets that look like DTLS, letting unparseable QUIC data proceed. Its targeted pytest file could not collect because this checkout lacks `mitmproxy_rs`; this is an unverified manual assessment, not a test pass.

**Conclusion:** This five-pair sample does not establish a whole-task efficiency gain for Opus 5.5. It shows one strong win, one small loss when a note was served, and three coverage misses. It also does not establish a quality gain. Do not use an Opus efficiency percentage from this sample on the website.

## Reproduction

Run with the environment controls above, using `--model claude-opus-5-5 --effort medium --arm nocache,hook --counterbalance --reps 1 --conc 1 --no-judge --isolated-settings --no-subagents --strict-model` on `bench/run.js`. The mitmproxy pair used `--arm hook,nocache` to balance first-arm order across the five pairs. Use the task IDs and notesets in the table above. Grade stored PostHog and Grafana patches with `bench/criteria.js grade`, `--judge claude-opus-5-5`, and `--strict-model` under the same test-mode controls and `THINKER_LLM=claude THINKER_LLM_MODEL=claude-opus-5-5`. The five task pairs ran under the same code revision; `results.json` records the resolved model for every agent run and judge result.
