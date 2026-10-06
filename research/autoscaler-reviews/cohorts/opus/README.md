# Autoscaler historical fix recall: Opus cohort

Ten paired reviews of reverted historical bug fixes from [kubernetes/autoscaler](https://github.com/kubernetes/autoscaler). The selection was frozen before any review outputs: newest first-parent merge since 2026-05-01 with a fix-like branch name, 1–120 changed production Go lines, at most 200 total lines and 10 files, and a clean reverse application at base `40889a675092c0939c59160fc5270273db4e0555`. The exact merge and parent for each case are in the [shared case manifest](../../cases.json).

## Method

- A note-building pass mined the *same ten fix PRs* with `distillPr`, saving 18 notes total. [notes.json](notes.json) lists the saved note titles, bodies, source PRs, and dependencies.
- At the fixed base, each fix's parent-to-merge patch was reversed in a disposable Autoscaler worktree. This creates a known regression. The no-cache arm reviewed the diff with `mode: nocache`; the cached arm reviewed the identical diff with `mode: holistic, related: true`. Both use a single model call, but the two product modes differ in prompt and selected code context. Arm order alternated by case and is recorded in [results/results.json](results/results.json).
- Both note building and paired reviews pinned `THINKER_LLM=claude`, `THINKER_LLM_MODEL=claude-opus-5`, `MAX_THINKING_TOKENS=8192`, `THINKER_TEST=1`, `THINKER_TELEMETRY=off`, `THINKER_LOG=local`, `THINKER_NO_LEARN=1`, and `THINKER_NO_LIMIT_WAIT=1`. No provider fallback was allowed. Ten note-building model records show `claude/claude-opus-5`; all 20 review reports show exactly one `claude/claude-opus-5` call and no errors. The provider did not expose a separate thinking-token counter, so the setting is verified from the launcher environment rather than measured per call.
- A hit requires an error/warning in a changed production file within six lines of the reverted fix, with an explanation matching the historical failure. Outdated-note text alone and deleted-test-only findings do not count. This qualitative rubric was fixed before scoring. Review token counts and elapsed wall time are reported separately from hits.

## Results

| Fix PR | Regression; mined note used | No cache | With notes | Review tokens (no cache / notes) | Wall time (no cache / notes) |
| --- | --- | --- | --- | ---: | ---: |
| [#10325](https://github.com/kubernetes/autoscaler/pull/10325) | Stale quick OOM repeatedly forces VPA updates; recency rule | Hit | Hit | 7,930 / 9,686 | 30.6s / 20.4s |
| [#10178](https://github.com/kubernetes/autoscaler/pull/10178) | Failed checkpoint GC is recorded as success; per-step timeout/progress rule | Hit | Hit | 43,450 / 27,766 | 73.0s / 38.0s |
| [#10141](https://github.com/kubernetes/autoscaler/pull/10141) | Zero ready DaemonSet pods cause creator drop, blocking VPA eviction; desired-count rule | Miss | Hit | 10,009 / 28,213 | 48.2s / 53.0s |
| [#10349](https://github.com/kubernetes/autoscaler/pull/10349) | Slash-bearing AWS placeholder name is truncated; provider-ID parsing rule | Hit | Hit | 17,129 / 25,135 | 67.8s / 70.2s |
| [#10258](https://github.com/kubernetes/autoscaler/pull/10258) | Stable zone label disappears from scale-from-zero template; label allowlist rule | Hit | Hit | 6,364 / 22,087 | 27.0s / 38.4s |
| [#10094](https://github.com/kubernetes/autoscaler/pull/10094) | Transient resize error cached as permanently infeasible; status-mapping rule | Miss | Hit | 9,451 / 14,156 | 24.2s / 22.1s |
| [#9949](https://github.com/kubernetes/autoscaler/pull/9949) | Scaleway creation error has no instance state; error-state rule | Hit | Hit | 16,956 / 10,437 | 60.1s / 26.3s |
| [#10001](https://github.com/kubernetes/autoscaler/pull/10001) | Provisioning Machine classified failed from transient message; phase rule | Miss | Hit | 26,748 / 12,086 | 67.1s / 28.8s |
| [#9725](https://github.com/kubernetes/autoscaler/pull/9725) | Fresh boundary OOM discarded as old; sample-time rule | Hit | Hit | 7,084 / 9,510 | 37.6s / 30.3s |
| [#9691](https://github.com/kubernetes/autoscaler/pull/9691) | Unescaped JSON Pointer path breaks extended-resource mutation; escaping rule | Hit | Hit | 8,020 / 11,875 | 29.0s / 22.0s |
| **Total** | **18 saved notes** | **7/10** | **10/10** | **153,141 / 170,951** | **464.6s / 349.5s** |

The three cache-only hits are #10141, #10094, and #10001. In #10141 the baseline complained about wording and removed test coverage but missed the `NumberReady` versus `DesiredNumberScheduled` behavior. In #10094 it produced no findings. In #10001 it produced only an information-level test coverage observation. The cached arm supplied an actionable production finding in each case, citing the mined note. On seven cases the baseline already found the regression; notes usually focused the explanation but did not improve detection. The cached arm used about 12% more review tokens overall. Wall times are descriptive: model calls ran alongside other cohorts, despite alternating arm order.

These are **in-sample historical-fix recall** results. The cache learned from the same PRs whose fixes were reversed. The no-cache arm also saw the full reversed diff, including deleted regression tests where present. This shows the review path can retrieve and apply a recorded fix rule; it is not evidence of prospective detection on unseen bugs. There was one review sample per arm per case, no independently executed bug reproduction, and no statistical uncertainty estimate. A website benchmark should label the task this way and add a temporal holdout before claiming general bug-detection improvement.

For each case, [results/results.json](results/results.json) contains the structured findings, note provenance, model usage, and token counts.
