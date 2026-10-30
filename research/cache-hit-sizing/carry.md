# Revised per-hit estimate including subsequent prompts

Codex, 2026-10-30. Follow-up to the initial sizing audit, at the owner's request.
This is a local accounting sensitivity analysis, not an agent experiment.

**Including context carry materially increases the conditional per-hit estimate.**
For 28 confirmed hits in 22 sessions with observable request payloads, the current
one-read estimate totals 444,660 tokens. Holding those same reading sizes fixed,
and subtracting the note text on every observed appearance, gives **52,158,262 net
input tokens**. A scenario that ends avoided-code retention at the next observed
new-clearing boundary gives **43,770,253**.

The observed part is the note payload's presence in outgoing requests. The
counterfactual part is whether the note avoided the credited reading, and how
long that hypothetical reading would otherwise have remained. These are revised
estimates, not measured savings or a new universal multiplier. No learning/model
maintenance costs enter this calculation: it answers savings per cache hit.

## Results on the same 28 hits

| Calculation | Total input tokens | Mean per hit |
| --- | ---: | ---: |
| Shipped gross estimate, one read | 444,660 | 15,881 |
| One read minus the note text on first appearance | 430,885 | 15,389 |
| Same reading size, with observed note lifetime, minus carried note text | 52,158,262 | 1,862,795 |
| Stop hypothetical reading at the next observed new clear; still charge carried notes | 43,770,253 | 1,563,223 |
| Assume only 25% of the reading is avoided, plus that clear boundary | 9,829,790 | 351,064 |

The 25% row is a stress test, not an empirically calibrated fraction or confidence
interval. It represents smaller needed excerpts, reading that still happens, or
partial replacement. At every setting the note's full observed text cost is
subtracted, including duplicate copies.

The base carried calculation is 53,641,960 gross hypothetical avoided input minus
1,483,698 input tokens of note text. The complete-overlap sensitivity assumes that
all concurrently present notes in a session replace nested reading sets, crediting
only the largest one per request while charging all notes. Under that assumption:

| Additional overlap assumption | Total net input tokens |
| --- | ---: |
| Observed lifetime, full reading size | 44,255,632 |
| Stop at new clear, full reading size | 37,277,871 |
| Stop at new clear, only 25% of reading avoided | 8,206,694 |

These alternatives address uncertainty in today's file-size estimate. None proves
that the original read would have happened, so even the smallest row is not a
guaranteed lower bound. Do not extrapolate these totals to the other 89 hits.

## Long-lived hits make a large difference

The median observed lifetime is **61 successful requests**, mean **113.6**, maximum
**607**. The median net per-hit estimate under equal lifetimes is 1,114,504 tokens;
the mean is larger because long-lived hits contribute disproportionately.

| Observed requests carrying the note | Hits | Net estimate at full reading size |
| --- | ---: | ---: |
| Fewer than 20 | 6 | 798,308 |
| 20–99 | 10 | 7,630,952 |
| 100 or more | 12 | 43,729,002 |

The 12 longest-lived hits supply **84%** of the total; the five largest individual
hits supply **58%**. The revised metric should accumulate per request, not apply a
constant machine-wide multiplier at the time of the hit.

Example: the telemetry/dashboard synchronization note was credited with 21,032
tokens of reading. Its 416-token rendered text appeared in **607** successful
requests, from October 16 into October 17. Conditional on replacing that reading
for the same lifetime:

```
(21,032 − 416) × 607 = 12,513,912 net input tokens
```

That is one cache hit's continuing effect, not 607 separate cache hits. No new
clear for this session is present in the available proxy log; absence of a log
record does not establish complete server-side retention.

A second example shows the clearing adjustment: the note preventing tests from
writing real machine settings appeared in 413 requests. Its reading estimate was
14,928 tokens and note size 330 tokens. Equal lifetimes yield 6,028,974 net input
tokens. Ending hypothetical code retention at the observed new clear leaves 126
requests credited but all 413 note appearances charged: **1,744,638** net tokens.

## Computation and evidence

The log window is unchanged: 2026-09-30 05:00 UTC to 2026-10-30 05:00 UTC. Select
the same 117 distinct named session–note pairs whose latest in-window verdict is
confirmed. Keep each pair's first logged `[files, tokens]` estimate.

Claude's `api-request` records identify the messages in a request through a base
request id, a retained prefix length, and a tail of content hashes. The diagnostic
reconstructs those reference lists, resolving explicit `api-request-blob` records
and ordinary transcript messages by canonical SHA-256. Streamed assistant blocks
are joined by message id/block index, restoring recorded wire tool inputs.

Only main-thread requests with a linked assistant response reporting positive
input usage count. Streaming blocks do not duplicate a request. Failed or unmatched
requests are excluded. Requests after the fixed cutoff are excluded. Exact rendered
note sections, with ids and pointer lines, identify positively observed payloads;
bare id mentions and escaped transcript dumps do not count.

For hit i, let R_i be its logged reading estimate, P_i the successful requests
after delivery in which its known rendered text appears, and N_ij its rendered
text size on request j, counting every copy. The equal-lifetime estimate is:

```
gross_i = R_i × |P_i|
net_i   = gross_i − Σ(j in P_i) N_ij
```

It does not reset at a later user turn or assessment. A repeated copy increases
the note cost but does not buy another avoided read set in the same request.
Requests in which the known note payload is absent receive no benefit. Compaction,
branch changes, truncation, and reinjection are reflected through request membership
rather than a global remaining-tool-call multiplier. If a compaction paraphrases
the note without its rendered id, that later semantic influence is uncounted.

For the clearing scenario, new boundaries are increases in `clearedUses` on
successful logged clear responses, not the same cumulative clear reported again.
At the first such boundary after a hit's first observed request, hypothetical
avoided code stops contributing; the note continues to cost its observed input.
This assumes that new clearing would remove the hypothetical avoided read. It
does not establish that the read would meet that clear's age/keep criteria, or
that adding hypothetical code would leave the clear schedule unchanged.
The boundary uses the proxy response timestamp and requests use their start
timestamps, so the triggering request can remain credited. This timing mismatch
is another reason to read this scenario as approximate, not an exact clear replay.

## Coverage and limits

- **28/117 hits** have matching rendered note payloads in successful Claude request
  snapshots, across **22 sessions**. There is no corresponding Claude transcript
  for 28 other hits; 61 have no matching successful request evidence. This is a
  selected subset, not a representative sample of every hit or client.
- Some non-note message bodies remain unresolved: **2,389 of 3,181 per-hit request
  appearances** also reference at least one unresolved body. The known note's
  membership is directly observable from its reference even when other bodies are
  unavailable. Unknown bodies are never guessed; additional note text in them
  would increase overhead. Therefore this is observed rendered-note accounting,
  not a claim to reconstruct every byte of every request.
- Six covered sessions have observed new-clearing boundaries. Proxy logging is
  incomplete historically; the client request snapshot precedes server clearing.
  Client payload presence does not prove the API processed a tool result that the
  server may have cleared. The clearing scenario is a sensitivity check, not an
  exact counterfactual simulation.
- The same-size calculation inherits the shipped file estimate's weaknesses:
  entire files versus excerpts, shared dependencies, and confirmation without
  demonstrated avoided reading. Late hits can arrive after some reading already
  happened. The lifetime evidence does not resolve those uncertainties.
- Note text uses characters / 3.6 to align with the logged injection estimator;
  the reading estimate uses bytes / 3.6. These are approximations, not tokenizer
  counts. Shared hook boilerplate and unrelated/unconfirmed notes are not charged
  to this confirmed-hit cohort. This is not the cache's total net operating return.
- Models are listed separately in the artifact; mixed-model sessions are explicit.
  Aggregated input tokens are workload accounting, not a model comparison or a
  monetary saving. No dollar conversion or distillation cost is included.

## Reproduce and validate

```sh
THINKER_TEST=1 node research/cache-hit-sizing/carry.mjs \
  /path/to/thinker /path/to/.thinker/log.jsonl \
  /path/to/.claude/projects /path/to/.thinker/state/proxy.jsonl \
  2026-10-30T05:00:00.000Z

npm test -- research/cache-hit-sizing/carry.test.mjs
```

`carry.json` records input hashes, aggregate alternatives, model/lifetime groups,
and the arithmetic per hit. Session ids are hashed; raw transcript bodies are not
published. Nine tests pass, covering retained prefixes, dropped context, duplicate
injection, clearing, incomplete request bodies, canonical hashes, branched request
bases, streamed blocks/wire inputs, and overlapping reading sets. The initial
research PR's full-suite baseline remains 966 passed, 2 skipped; no production
source changed in this follow-up. No agent experiment or model call was run.

The concrete revision proposed is to track **per-hit lifetime accumulation** with
separate evidence for reading size and retention. A hit's displayed estimate grows
as subsequent requests carry its substitute context. Actual savings calibration
still requires paired agent sessions through Artemis. Production estimates remain
unchanged in this research PR.
