# Jev: five Opus coding tasks and five Sol reviews

Author: Codex, requested by Yoav Shmariahu. 2026-10-06. Completed.

The ten authorized reruns are complete. Against historical cached baselines with the same exact agent model and reasoning effort, Opus used 6.2% fewer tool calls and 3.1% fewer input tokens, with essentially unchanged elapsed time and identical essential-criteria scores. Sol selected 6 notes instead of 26 and still caught the same four of five target bugs, but extra verification doubled model calls and increased total tokens 86.2% and elapsed time 53.5%.

These are separate cohorts and historical single-run comparisons, not a controlled estimate of Jev's causal effect. They do not support a general speed or correctness claim. The useful diagnosis is that review verification added measurable work without improving target-bug detection in these five cases. No production changes or prompt tuning were made during the experiment.

## Locked comparison

The user chose five Sol review tasks because the old Sol coding runs did not record reasoning effort. There were exactly ten valid new task runs: five Opus coding sessions and five Sol reviews. One aborted Opus setup attempt is excluded and preserved separately.

- Opus: `claude-opus-5-5`, medium effort, Claude Code 2.1.289, 60 turns, one coding session at a time, same isolated settings and hook-only configuration as [yesterday's baseline](../opus55-five-pairs/README.md). Same five task prompts, repo commits and saved notesets. The comparator is the old **hook** arm, not its nocache arm. All actual transcript/model IDs matched. Four existing calibrated task criteria were graded by the same exact Opus model and medium effort; no grading model substitution.
- Sol: `gpt-6.1-sol`, high effort, Codex 0.160.0, first five cases from the predeclared [historical review manifest](../autoscaler-reviews/cohorts/sol/README.md). Same autoscaler base, reversed patches, holistic review, related notes enabled, max 12, and exact saved 11-note cache. No cache rebuild or distillation. Main review and every added verification call used the same pinned model and effort.
- Declared intervention: current Thinker at `75f22b4`, Jev enabled. For review this includes both related-note selection and optional step gates. This measures the combined current serving implementation; it does not isolate a particular prompt or gate.
- `THINKER_TEST=1`, telemetry off and learning off inherited by children. Two experiment-only overrides allowed explicit Jev network access in test mode and pinned Sol effort using the historical mechanism. [The patch](benchmark-settings.patch) is saved for reproduction and was removed from production source after the runs.
- No successful run had a timeout, Jev error or model fallback. The first Opus attempt encountered the test-mode network guard, was stopped immediately and excluded; no outcome-based retries or task substitutions.

[protocol.json](protocol.json) records task/cache hashes, snapshots and configuration. [results.json](results.json) holds all paired measurements and scoring reasons. `evidence.tar.gz` contains sanitized run records, patches, retrieval logs and tool transcripts, including the excluded attempt; it excludes credentials and model reasoning blocks. Historical Opus run records are under `historical/`; historical Sol records remain in their original research directory.

## Opus coding results

Numbers are **historical cached → current Jev**. Input includes provider cache reads and writes. Time is coding-session elapsed time, excluding grading and post-run tests.

| Task | Tools | Input tokens | Seconds | Essential criteria |
| --- | ---: | ---: | ---: | --- |
| PostHog PR107042 | 34 → 28 | 1,251,410 → 1,034,450 | 215 → 124 | 80% → 80% |
| PostHog PR105793 | 27 → 24 | 1,278,161 → 1,115,911 | 179 → 176 | 100% → 100% |
| Grafana PR133148 | 26 → 25 | 1,330,864 → 1,328,776 | 157 → 200 | 83% → 83% |
| Grafana PR133090 | 16 → 20 | 509,399 → 802,596 | 83 → 131 | 0% → 0% |
| mitmproxy PR8295 | 9 → 8 | 246,944 → 190,134 | 38 → 41 | Manual inspection only |
| **Total** | **112 → 105 (−6.2%)** | **4,616,778 → 4,471,867 (−3.1%)** | **671 → 673 (+0.3%)** | **Strict pass: 1/4 → 1/4** |

Output tokens increased from 52,647 to 58,109 (+10.4%). Only PostHog PR105793 and mitmproxy received notes in either run. Jev served two notes on each, versus one historically. The other three tasks received no notes in either run, so their variation cannot be attributed to note content. Jev did not improve prompt-time coverage in this cohort.

The new Grafana PR133148 patch passed the existing executable test, as did the historical patch. The criteria judge still identifies the same missing essential fallback behavior. The new mitmproxy patch gates DTLS parsing so non-DTLS UDP/QUIC packets do not wait indefinitely, matching the key mechanism in the upstream fix. It also adds packet regression cases. This is a manual assessment, not a test pass; the historical environment could not collect the targeted pytest file because `mitmproxy_rs` was unavailable. No new automated correctness claim is made for mitmproxy.

## Sol review results

The target-hit rule is the historical one: error/warning on a changed production file within six lines of an inverse-fix location, and an explanation identifying the historical bug. Test-only findings, unrelated bugs and stale-note notices do not count.

| Case | Notes | Model calls | Total tokens | Seconds | Target caught |
| --- | ---: | ---: | ---: | ---: | --- |
| A-10325: stale quick OOM | 5 → 1 | 1 → 2 | 18,135 → 34,371 | 13.1 → 23.0 | Yes → Yes |
| A-10178: checkpoint cleanup | 7 → 2 | 1 → 3 | 21,893 → 56,845 | 25.4 → 40.3 | Yes → Yes |
| A-10141: DaemonSet desired size | 7 → 1 | 1 → 2 | 19,622 → 35,443 | 19.7 → 30.8 | Yes → Yes |
| A-10349: AWS placeholder slash | 3 → 1 | 1 → 2 | 18,499 → 35,129 | 18.4 → 29.9 | No → No |
| A-10258: stable zone label | 4 → 1 | 1 → 1 | 18,229 → 17,665 | 13.6 → 14.7 | Yes → Yes |
| **Total** | **26 → 6 (−76.9%)** | **5 → 10** | **96,378 → 179,453 (+86.2%)** | **90.3 → 138.6 (+53.5%)** | **4/5 → 4/5** |

Each case retained its matching historical fix note(s). Jev's verify gate ran on four cases, producing five additional Sol calls because the checkpoint case had two findings. All verified findings survived; none were dropped. The only case without verification used slightly fewer tokens than its baseline. This supports investigating the value and threshold of verification separately from note selection; it does not prove a gate change would preserve quality on other tasks.

The AWS case is especially useful for prompt investigation: both old and new reviews flag an unanchored regex, while missing slash truncation in placeholder names even with the exact relevant note present. This is not evidence that a bad note was injected. Retrieval delivered the right note; the reviewer still failed to identify the target regression. Verification confirmed the reported nearby issue rather than looking for the missing target bug.

Accounting caveat: `report.models` counts the main review call only, excluding `review-verify`. The totals above count every `op: model` event and reconcile its tokens with `report.tokens`. Jev token usage is not exposed, so the token figures are large-model usage; wall time includes Jev overhead. The review cache was mined from these historical fixes, making this an in-sample regression-memory test, not unseen-bug detection.

## Reproduction and limits

From an isolated worktree of `75f22b4`, apply `benchmark-settings.patch`, provide the pinned CLI versions, existing repository snapshots and cache notesets, and use `THINKER_TEST=1 THINKER_TELEMETRY=off THINKER_NO_LEARN=1 THINKER_JEV=on THINKER_BENCH_JEV_NETWORK=1`. Machine-local wrapper paths are recorded under `bench/jev-sol-opus-tools`; adjust only their installed binary paths, keeping versions and effort fixed. Do not archive the Codex auth home.

For Opus, use `bench/jev-opus-run.js` with the tasks/notesets in the protocol and `--model claude-opus-5-5 --effort medium --arm hook --reps 1 --conc 1 --no-judge --isolated-settings --no-subagents --strict-model`, plus `THINKER_HOLDOUT=0`, `THINKER_LLM=claude`, `THINKER_LLM_MODEL=claude-opus-5-5` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Grade the PostHog/Grafana records using `bench/criteria.js grade`, exact Opus judge and `--strict-model` through the medium-effort wrapper.

For Sol, run `bench/jev-sol-review.mjs` with `THINKER_LLM=codex THINKER_LLM_MODEL=gpt-6.1-sol THINKER_CODEX_REASONING_EFFORT=high THINKER_NO_LIMIT_WAIT=1`, isolated `CODEX_HOME`, and the exact saved `sol-notes/` cache. The harness checks inverse-patch scope equality and stops on errors. Its final validation also checks every model log, including verification.

To recompute this report without model calls, extract `evidence.tar.gz` at the repo root and run `THINKER_TEST=1 python3 research/jev-sol-opus-ten/summarize.py`.

Five tasks per model, one new run per task, historical rather than concurrent controls, unchanged failures, and no-note Opus tasks limit interpretation. The next useful experiment would separately compare note selection and review verification on held-out cases. No additional runs were launched for that hypothesis.

Validation: the full telemetry-disabled test suite passed after restoring the production source: 429 passed, 5 skipped, 0 failed. The report generator reconciles all Sol model-event tokens and checks the recorded exact models.
