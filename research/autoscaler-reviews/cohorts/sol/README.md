# Autoscaler historical-fix review: GPT Sol cohort

Ten cases were frozen in the [shared manifest](../../cases.json) before note creation or review. Each case reverses one historical merged fix in a clean worktree at the same Autoscaler base commit (`40889a675092c0939c59160fc5270273db4e0555`). The same pinned model first mined notes from the fixed PR, then reviewed the reversed fix in two independent calls: `nocache` and `holistic` with related notes. These product modes differ in prompt and selected code context. `related:true` matches the product's retrieval default. Arm order alternates by case. No model-generated tools or browsing were available inside review calls.

Every model call used the Codex CLI with `--model gpt-6.1-sol --strict-config --config model_reasoning_effort="high"`, `THINKER_LLM=codex`, and `THINKER_LLM_MODEL=gpt-6.1-sol`; fallback was disabled. All ten pairs report one `codex/gpt-6.1-sol` response per arm. `THINKER_TEST=1`, `THINKER_TELEMETRY=off`, `THINKER_LOG=local`, and `THINKER_NO_LEARN=1` were set for the runs. The CLI reports model identity to Thinker; its output does not independently attest reasoning effort, so the explicit invocation is the effort evidence.

An actionable hit is an error or warning in a changed production file within six lines of the reversed fix *and* an explanation matching the historical failure. An outdated-note warning, a test-only finding, or a different plausible bug does not count. `scores.json` records each manual decision and reason.

| Historical fix | Note(s) saved from that fix | No cache | With notes |
| --- | --- | --- | --- |
| [#10325](https://github.com/kubernetes/autoscaler/pull/10325) stale quick OOM | Quick-OOM eligibility requires a recent termination | Hit | Hit |
| [#10178](https://github.com/kubernetes/autoscaler/pull/10178) checkpoint cleanup | Give checkpoint writing and garbage collection independent timeouts; Record checkpoint cleanup completion only after successful collection | Hit (completion) | Hit (both failures) |
| [#10141](https://github.com/kubernetes/autoscaler/pull/10141) DaemonSet updates | Use desired DaemonSet size for VPA eviction restrictions | Miss | Hit |
| [#10349](https://github.com/kubernetes/autoscaler/pull/10349) AWS placeholder slash | Preserve complete AWS placeholder names when parsing provider IDs | Hit | Miss (reported another regex issue) |
| [#10258](https://github.com/kubernetes/autoscaler/pull/10258) CAPI zone | CAPI scale-up simulation must preserve stable zone labels | Miss | Hit |
| [#10094](https://github.com/kubernetes/autoscaler/pull/10094) transient resize | Defer transient kubelet resize errors without caching infeasibility | Hit | Hit |
| [#9949](https://github.com/kubernetes/autoscaler/pull/9949) Scaleway creation state | Scaleway creation errors must retain the creating state | Miss | Hit |
| [#10001](https://github.com/kubernetes/autoscaler/pull/10001) CAPI Failed phase | Require Failed phase before tracking a machine as failed | Miss | Hit |
| [#9725](https://github.com/kubernetes/autoscaler/pull/9725) fresh OOM | Anchor OOM staleness to the latest memory sample | Hit | Hit |
| [#9691](https://github.com/kubernetes/autoscaler/pull/9691) JSONPatch escaping | Escape resource and annotation keys before constructing JSONPatch paths | Hit | Hit |

**Observed historical-fix recall:** 6/10 no cache; 9/10 with notes. The cache created 11 notes across the ten fixes, at 177,637 reported note-generation tokens. Review calls used 184,927 tokens without notes and 191,053 with notes (+6,126, or 3.3%). Total measured call time was 139.5 seconds without notes and 178.6 seconds with notes; serial local timing is descriptive, not a latency benchmark. All ten target notes were retrieved in their cases. The cached calls consulted 54 notes total, averaging 5.4 per case, so unrelated-note retrieval is substantial. The cited target note did not guarantee a target hit in #10349.

These are **in-sample historical recalls**: each note was mined from the very fix later reversed. They establish that the notes can carry actionable repo-specific failure knowledge into a review, not that the same recall will hold for unseen future bugs. Ten single-sample pairs are too small for a stable quality estimate. `notes.json` contains full generated note bodies and `results/results.json` contains per-arm findings, model reports, tokens and timings. The selected case rule and commit hashes are in the shared manifest; scripts reproduce note creation and review.
