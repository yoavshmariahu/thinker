# PR-only efficiency canary: stopped during cache construction

Authors: Yoav and Codex. October 7, 2026. Recorded event timestamps below are UTC.

The corrected canary used **recent merged PRs through the normal `minePrs` product path**, with no exploration sessions, session distillation, or handwritten notes. It stopped during the first cache build in each model cohort after a recorded Jev grounding response failed validation: `jev: missing or invalid c4`, while processing Click PR #3158 in the Opus cohort. That failed model record already violated the frozen readiness rule. The operator's live audit wrote the shared stop marker before waiting for the 20-PR build to finish, and all three supervisors terminated their active work.

**No coding runs started.** Three cache builds were partial, six never started, and there is no correctness or efficiency comparison. At stop, 21 proposed notes had been deferred and zero notes saved across the three partial caches. This confirms a problem encountered in the PR-learning path under these conditions; it does not establish that all PR mining is broken or that every deferred note should have been accepted. No failed or incomplete attempt was retried.

## Frozen design and preparation

Thinker `6c0dd6c5e6473c7b3aa3925a0deefb875b7694bd`, plus the recorded exact-model/high-effort adapter and a pre-inference PR-query correction. [execution.json](execution.json) pins all source/harness hashes. [PROTOCOL.md](PROTOCOL.md) was written before inference; [tasks.json](tasks.json) fixes the three Click tasks and executable grades. The [PR corpus](prs.json) is identical across model cohorts for each task.

| Cohort | PR writer and intended coder | Effort |
| --- | --- | --- |
| Opus | claude-opus-5-5 | high |
| Sol | gpt-6.1-sol | high |
| Gemini Flash | gemini-3.8-flash-high | high |

Jev was pinned to `jev-1.13.0` for catalog/grounding/retrieval. No model fallback. Every process used `THINKER_TEST=1`, telemetry off, isolated worktrees, disabled background learning and machine hooks. The model adapter is preserved as [model-pins.patch](model-pins.patch), not committed to production source. Completed Gemini native traces confirm Gemini 3.8 Flash (High); completed Opus calls were checked against the actual model-usage identity. Sol was invoked with strict explicit model/effort configuration.

The collector initially found no eligible corpus because its bounded search sorted by recent metadata updates and only applied the historical metadata cutoff client-side. Adding the same `updated:<cutoff` constraint to the GitHub query recovered eligible historical PRs without weakening the cutoff. This was corrected and regression-tested **before freezing or any inference**. Frozen hashes include that correction. This is a harness preflight fix, not a cache-result retry.

Each task froze 60 eligible PR candidates and a normal mining limit of 20. The collector scans up to 250 candidates, sorts eligible PRs by merge date, and enforces ancestry plus pre-base merge and metadata timestamps. Comments edited/created later are excluded. Product fix/size/body filters select up to 20. This conservative metadata policy excludes otherwise valid historical merges edited later, so the oldest candidates extend well back in history:

| Task | Base cutoff | Eligible candidate merge range |
| --- | --- | --- |
| Click 3364 | 2026-04-28 23:31:25 -07:00 | 2023-03-20 to 2026-04-13 |
| Click 3391 | 2026-05-15 21:48:03 -07:00 | 2024-12-22 to 2026-04-29 |
| Click 3677 | 2026-07-08 08:57:37 -07:00 | 2025-03-16 to 2026-05-08 |

The target fix is excluded from each task's own corpus. Only frozen public Click metadata/diffs/comments were replayed to the miner. The inputs are not task-specific synthetic memories.

All base/gold preflights passed the expected gate: 3364 base had 2 failures in 39 module tests, gold 39 passes; 3391 base had 12 failures, 29 passes and 1 skip, gold 41 passes and 1 skip; 3677 base had 38 failures in 100 tests, gold 100 passes. Acceptance subsets also failed on base and passed on gold, without collection errors. These validate the evaluator, not agent correctness.

## Partial cache results

All active builds were for Click 3364. Counts below describe observed completed calls and persisted pending notes, not completed 20-PR batches.

| Model | Completed PR-writing calls | Pending notes | Insufficient support | Conflicting evidence | Invalid response | Saved notes | Builder seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Opus | 8 | 13 | 11 | 1 | 1 | 0 | 98.463 |
| Sol | 4 | 5 | 5 | 0 | 0 | 0 | 97.592 |
| Gemini Flash | 2 | 3 | 2 | 1 | 0 | 0 | 96.832 |

Completed writer PR IDs: Opus 2957, 3245, 3151, 3021, 3158, 2991, 2539, 2846; Sol 2957, 3245, 3151, 3021; Gemini 2957, 3245. A writer returning no notes is distinct from a grounding rejection. Source-backed usefulness and completed cache yield cannot be inferred from these interrupted batches.

There are 79 finalized model-usage records: 45 Opus-cohort, 21 Sol-cohort, 13 Gemini-cohort. These include Jev calls. Known recorded tokens sum to 298,579 (109,494 / 104,661 / 84,424 respectively). All finalized records reported usage, including the invalid Jev response. Interrupted in-flight calls may have no final record, so this is a lower bound, not complete run consumption. There is no cross-model efficiency ranking or coding latency estimate.

## Initiating failure and diagnostic limits

At `2026-10-07T07:09:29.637Z`, event `8bddb7a1-3b08-4611-8007-09cb8610faa1` recorded a failed `jev-grounding` call for PR #3158 with model `jev-1.13.0` and 2,687 tokens. The pending note is titled “Record deprecations, removals and behaviour changes for 9.0 in docs/upgrade-guides.md”; its reason is `jev: missing or invalid c4` and status `unavailable`.

`c4` identifies a claim about preferring deprecation before removal and explaining removals without prior deprecation. This is **response validation failure**, not an ordinary judgment that the claim lacks support. `src/jev.js:jevEvaluate` uses the same error for missing/wrong-type answers, invalid choice/probability keys or ranges, non-normalized probabilities, a choice inconsistent with the highest probability, or invalid confidence. The harness persisted model identity/usage but not raw Jev answers. We therefore cannot identify which response field violated validation or attribute this confidently to provider output versus validator strictness.

The 18 insufficient-support and two conflict decisions are separate observations. The PR inputs and proposed notes are retained, but per-claim Jev probabilities were not recorded; no inference replay was performed. Do not treat all those rejections as proved false negatives. Diagnose their evidence support with exact request/response capture before changing grounding or repeating the performance experiment.

The product miner catches per-PR failures and continues the batch; the harness checks failed call records at the end of a cache build. Live inspection discovered this invalid record earlier and explicitly stopped the batch. Some additional PR calls completed between the initiating record and observation. The stop was not automatically triggered at the instant of the malformed response. All three supervisors recorded `batch-stopped`, returned -15 for their child, and subsequent process inspection found no remaining canary jobs. No cleanup exception occurred in this run.

## Artifacts and validation

[summary.json](summary.json) contains exact counts, process records and the original stop reason. [raw-artifacts.tar.gz](raw-artifacts.tar.gz) preserves original stdout/stderr, preflight grades, model responses and completed Gemini native traces, each partial cache's Thinker state (including pending notes and logs), frozen PR inputs/source/harness, and the public base snapshots. [archive-manifest.json](archive-manifest.json) records hashes. Credential homes/symlinks are excluded. Original failure evidence is not rewritten into synthetic build-success receipts.

The 24 local guard tests passed before inference. The query correction has a dedicated regression test. The full telemetry-disabled Node suite passed: 497 tests passed, 5 skipped, zero failures. PR CI is checked before merging the report and correction. The frozen experiment remains stopped; do not resume it or publish it as an efficiency result. A new run should follow diagnosis, with the same PR-only requirement and a new output directory.
