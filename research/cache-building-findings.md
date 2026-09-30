# Cache construction: findings and hypotheses at the research pause

Author: Codex (OpenAI) · September 29, 2026 (Pacific)

**Status: paused; performance comparison incomplete.** This note records what
the study supports and what future research still needs to establish. No
production runtime behavior was changed. The coding evaluation remains paused.

## Conclusion

**Broad source coverage alone was insufficient to deliver the right notes in
this setup. We have not established a better cache-building or retrieval
technique, or a coding-performance improvement.**

The recommendation to prioritize precise symbol matching and selective graph
expansion is a hypothesis for future experiments. It must not be cited as a
validated fix or as evidence that Thinker should adopt CodeGraph's architecture.

## What was compared

Three fresh source-derived caches were built from the same pinned PostHog
checkout and a fresh CodeGraph 1.6.1 index:

1. **Symbols:** one location note per selected production source file, with
   principal symbols and signatures.
2. **Relationships:** those notes plus bounded static cross-file relationships.
3. **Evidence:** those relationships plus bounded docstrings and source excerpts.

Each cache contains 25,315 notes. Builders received source/index data, not task
prompts, expected patches, prior sessions, or existing Thinker notes. This tests
cache construction with Thinker's existing ranking and two-note initial
delivery; it is not a test of CodeGraph's complete retrieval or MCP product.

The planned coding evaluation was two cache and two independent no-cache runs
per technique: one pair on invite validation and one on sandbox failure
reporting. At the pause, only two cache runs had completed, both using the
symbols cache. **There is no completed cache/control pair in the primary sample.**
All study processes were stopped at the user's request.

## Observations supported by the completed analysis

Offline diagnostics used 14 existing PostHog tasks:

| Cache | Tasks with target dependencies present in cache | Tasks served any target-dependent note | Tasks served a note directly about a target file |
|---|---:|---:|---:|
| Symbols | 13/14 | 5/14 | 5/14 |
| Relationships | 13/14 | 6/14 | 5/14 |
| Evidence | 13/14 | 6/14 | 5/14 |

- **Coverage and delivery are separate problems.** High coverage did not ensure
  that a target-file note reached the agent. Neither richer construction
  technique improved the direct-file hit count in this diagnostic sample.
- **Additional text can worsen ranking.** For the sandbox task, the first
  target-dependent note ranked fourth with symbols, first with relationships,
  and sixth with evidence. Only two notes were served. This is one observed
  example, not proof that excerpts are generally harmful.
- **Selection filters can create coverage gaps.** The uncovered task involved
  a generated file and a constant-only manifest; the builder excluded generated
  files and constant definitions. Fixing those filters is an untested proposal.
- **Serving a large cache has a cost.** Initial retrieval took 8.29 and 7.96
  seconds in the two completed symbol-cache sessions. These are observations
  from this corpus and environment, not a general latency estimate for Thinker.

Target-file overlap is a proxy based on upstream patch filenames, not a human
relevance judgment. A note about a neighboring file can be useful. Adding graph
dependencies also makes the target-dependent metric easier to satisfy, so the
increase from 5/14 to 6/14 is not evidence of better task understanding.

The two completed symbol-cache runs took 9.74 and 4.67 minutes. Model judging
found 5/6 essential criteria satisfied on invite validation and all essential
criteria satisfied on sandbox failure reporting. Application tests were not run,
as required by the task prompts. These results cannot establish a correctness,
speed, or token advantage without completed controls.

## What remains hypothetical

**Precise symbol matching** would prioritize a particular function, class, or
identifier when the request names one or exploration discovers it. Requests
using only product language still need a way to find that initial symbol.

**Selective graph expansion** would start with a relevant symbol and follow a
small number of useful connections, such as its callers or validation helpers,
within a fixed context budget. It differs from putting every neighboring symbol
or excerpt into ordinary notes before knowing the request.

These ideas are informed by the inspected
[CodeGraph context builder](https://github.com/colbymchenry/codegraph/blob/7cc2edadce4363f30559782328e07f3d00f75d7e/src/context/index.ts),
but neither was implemented or tested as a retrieval treatment in this study.
We also have no evidence here that lowering relevance thresholds or increasing
the number of injected notes improves coding outcomes.

## Conditions for future research

Resume only after an explicit decision to continue. Keep the current result
separate from any new experiment and label exact matching/graph expansion as
hypotheses until measured. A useful next study would:

1. Compare the existing ranker with exact-symbol priority and bounded graph
   expansion while keeping cache contents and delivery budget fixed.
2. Include both identifier-rich and product-language requests, and diagnose
   coverage, rejection by relevance gates, ranking, and packing separately.
3. Complete matched cache/control coding runs on fresh state, measuring
   correctness before interpreting wall time, tool calls, and token use.
   Include retrieval/build costs and use more tasks or repetitions before
   claiming a reliable benefit.

Do not count the predeclared warm-up, stalled control, capacity rejection, or
user-interrupted attempts as completed controls. The paused harness also needs
to reject signal-terminated children with null exit codes and sessions without
a completed turn before resumption. Shutdown exposed that bookkeeping issue;
the affected attempts are excluded from the preserved summary.

## Evidence and provenance

- [Offline diagnostics](cache-building-evidence/retrieval-diagnostics.json)
- [Completed-run metrics and unfinished runs](cache-building-evidence/summary.json)
- [Original protocol](cache-building-evidence/protocol.json)
- [Cache construction manifests](cache-building-evidence/builds.json)

Runtime revision: `e4995487822cdf78ba34a3b563067bd7ba7761c3`.
PostHog base: `a3b3c3685bcffcf273f0d27ffb6a669239200e30`.
Coding model: `gpt-6-sol`, high reasoning. Common judge:
`gemini-3.8-flash-high`. The two tasks were already known evaluation tasks,
not a newly held-out set.

The full scripts, raw records, excluded attempts, source index, and exact
caches remain locally in the paused `agent/cache-building-research` worktree
at `.worktrees/cache-building-research`; they are not all merged with this
note. The linked compact evidence is versioned with this note. Unfinished
arms have zero observations; zero aggregate values in the summary are not
measurements of free work or successful controls.
