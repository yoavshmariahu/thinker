# Astra invitation task after prompt deduplication

Author: Codex, for Yoav Shmariahu. 2026-10-05 UTC (October 4 local time).

The single patched run used 17.4% fewer input tokens than the previous latest-version run, but took 18.7% longer and passed 5/6 essential criteria instead of 6/6. This is not evidence of an overall performance improvement. The note bodies did not repeat, but lookup supplied unrelated replacement notes, and the agent repeated large instruction reads.

## Matched comparison

Same PostHog PR106936-hard task, base `a3b3c3685bcffcf273f0d27ffb6a669239200e30`, 259-note corpus, GPT-6 Astra with medium reasoning, Codex 0.160.0, Node v24.15.0, prompt framing and grading protocol. Task and corpus hashes match the original manifest. Patched Thinker is merge `9b70631440d6bde5411f3953d88b0c05d794c680` (PR #18). All runs were sequential, one sample per condition; model/runtime variation is uncontrolled.

| Condition | Coding seconds | Tool calls | Input tokens | Cached input (subset) | Uncached input | Output | Essential | All criteria |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| v0.1.6 | 224.6 | 18 | 825,849 | 762,752 | 63,097 | 6,035 | 5/6 | 7/9 |
| No Thinker cache | 237.8 | 22 | 1,236,546 | 1,156,096 | 80,450 | 6,505 | 5/6 | 7/9 |
| Previous latest, before fix | 276.9 | 28 | 1,243,234 | 1,146,496 | 96,738 | 7,053 | 6/6 | 8/9 |
| Patched | 328.5 | 29 | 1,027,152 | 949,248 | 77,904 | 6,486 | 5/6 | 7/9 |

Input totals include cached reads; never add them again. Patched uncached input decreased 19.5% versus previous latest; output decreased 8.0%. Against no cache, input decreased 16.9% but time increased 38.2%. Coding time includes CLI/MCP startup and model/tool activity; it excludes checkout preparation, the 3.97-second initial hook, and grading. The trace does not isolate provider queue/streaming latency sufficiently to attribute the wall-time increase.

## Correctness and validation

The same blind, tool-free model judge found essential c3 unmet: submission is blocked, and onboarding has a member-specific disabled reason, but the settings dialog's batch control lacks that reason. Inspection of the saved patch supports this finding. Optional c9, refreshing the member list after a server `already_member` rejection, also remains unmet. All other criteria passed. Quality is model-judged, not an executed PostHog test pass.

The coding agent ran `git diff --check` successfully, added tests, and did not install dependencies or run the target's test suites. Unlike the preceding samples, it did not attempt the unavailable Flox TypeScript check. The Thinker repository suite, run after coding completed, passed: 378 tests, 374 passed, 4 skipped, zero failures. Telemetry was off for all processes.

## What the trace shows

- The initial hook served no notes, as in the prior latest run, but emitted a prompt ID. All four retrieval calls reused it. The framing prefix before the actual request remains a known startup-retrieval limitation held constant across cached arms.
- Orient delivered five relevant notes; drilldown returned source without repeating those note bodies. Lookup returned three different notes, with no repeated full bodies across the retrieval responses. Two of those new notes concerned Rust load generation, unrelated to invite validation. Removing seen candidates can leave room for weak matches; deduplication alone does not guarantee a smaller or better payload.
- There were seven MCP calls: orient, drilldown, lookup, find, two positive feedback calls, and remember. No tool validation errors or budget retry occurred. This run requested 12,000 tokens directly, so it did not exercise the oversized-budget clamp.
- The two useful feedback records concerned bulk partial failures and the shared onboarding/settings flow. Remember wrote a note after all retrievals; it did not affect the observed retrieval results. Automatic learning and background verification were disabled, but explicit agent feedback/remember remain available, as in the cached harness.
- The other calls were 17 shell invocations and five file-change operations. The agent reread AGENTS.md and several skills. Shell output totaled 344,527 characters versus 310,170 previously; MCP response JSON totaled 31,165 characters versus roughly 41k previously. These are character counts, not token attribution. About 92.4% of patched input was provider-cached context reread across steps.

The next focused experiment should stop weak replacement notes from filling the space left by deduplication, while retaining the five useful invite notes. This run does not justify reducing all note coverage, claiming the fix caused the lower quality, or claiming a general speedup. Repeated instruction reads are another observed source of context volume outside note serving.

## Reproduction and artifacts

`bench/astra-patched/run.mjs`, `grading-context.mjs`, and `manifest.json` preserve the harness and pinned conditions. The runner expects the primary PostHog clone and benchmark authentication already configured; it creates and removes a detached target worktree. Runtime homes and credentials are excluded.

Raw coding and grading events, patch, criterion evidence, hook output, logs, runner and manifest are preserved locally at `/private/tmp/thinker-astra-dedup-check-20261005/`. These generated traces are excluded from the source PR because the current staged-review implementation stalls on large trace files. `summary.json` alongside this report retains compact metrics and all criterion evidence. Earlier controls are documented in `research/astra-cache-control/README.md`.

## Rollback decision

After reviewing this result, the user chose to prioritize correctness and restore the serving behavior from before PR #18. The prompt delivery ledger, required MCP prompt IDs, suppression filters, metadata-only hook output, and bundled drilldown budget clamp were reverted together. The benchmark harnesses and observations remain as historical evidence. This is a precautionary rollback based on one sample, not proof that deduplication caused the missed criterion.
