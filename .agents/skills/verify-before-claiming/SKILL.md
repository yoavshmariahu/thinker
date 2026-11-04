---
name: verify-before-claiming
description: >-
  Check a claim about thinker's own cost or behaviour against ground truth before asserting it: the API's
  reported usage, the bytes of a dumped request, a control arm's values. Use when analysing the proxy, the
  clearing, cache writes, token cost, or when proposing an improvement to any of them. Complements
  collaborative-research, which covers the research lifecycle; this covers what counts as evidence.
---

# Verify before claiming

Thinker measures itself, so almost every number it reports is its own estimate of something the API
also reports exactly. Reasoning from the estimate is the single most reliable way to be confidently
wrong here. On 2026-11-04 it produced three wrong calls in one session, each caught later by a check
that cost nothing.

**The rule: a claim about cost or behaviour is not a finding until it has been checked against the
API's own numbers, the actual bytes sent, or a control arm. Thinker's estimate of any of those is a
hypothesis.**

## The ladder: cheapest first, and the cheap ones are the good ones

Work down it only as far as the question requires. Nearly everything is answerable in the first two
rungs, and the paid rungs were the least informative per dollar all day.

| rung | cost | answers |
|---|---|---|
| **1. Read the log you already have** | free | what the API reported: `write`, `read`, `input`, `cleared`, per call. Compare against what the policy predicted. |
| **2. Diff the bytes you already have** | free | whether our output is consistent. `THINKER_PROXY_DUMP` writes `{sent, usage}` per request; diff consecutive ones and find the first difference. |
| **3. Unit-call the function on real data** | free | determinism, boundaries, the rule a function claims to implement. Feed it messages from a dump, not a fixture. |
| **4. A short live preflight** | ~$1-3 | does the API accept this at all; how big is a turn really; does the harness work. |
| **5. A paired bench run** | ~$25-50 | only what a live session can answer: does the model do more work, or worse work, because of the change. |

A refused rung-5 run costs nothing but a slower answer. A rung-5 run built on an unchecked assumption
costs the money **and** produces a number you will misread.

## Ground truth, by question

- **What did a call cost?** The API's usage on that call (`write`, `read`, `input`, `out`), not
  `priceCut`/`recache`/`saving`. Those are estimates and have been wrong by 15x.
- **What did we send?** The `sent` body in the dump. Not the policy's own log fields, which describe
  intent rather than bytes.
- **Is the prompt cache being rewritten?** `write` per call, and the first byte where consecutive
  `sent` bodies differ. A write beyond the conversation's growth is a prefix rewrite.
- **Did the model's work get worse?** A control arm's answers, compared value by value. Never a regex
  over the model's prose, and never the model's own account of itself (see the traps).
- **How many calls does a session have?** Count them. Do not model them.

## Traps, each of which has produced a wrong published number here

- **The model's self-report is not evidence.** It has declared answers "made up" that matched the
  control exactly, and explained a guess by a clearing that had not yet happened. Compare values.
- **A regex over prose misses the phrasing it is counting.** "was a guess, because that read's result
  was cleared" matches neither `cleared from` nor `can't see`. It also *over*-counts: a turn saying
  "these reads came back in full, unlike earlier ones that were cleared" is a success.
- **Block-splitting misaligns the arms.** One arm's extra paragraph shifts every later block, so
  turn N of one is compared with turn N+2 of the other. Key answers by something in the prompt
  (`Turn N of 28`), never by position.
- **The second arm to run inherits the first's prompt cache** within the 1h TTL: it wrote 0 where the
  first wrote 28-39k. Alternate the order across reps, or charge the first arm's cold start to both.
- **Estimates measured on the request as received** include everything already edited at full size.
  `m.prompt - dropped` was the whole prompt, not the tail; the error compounded 3x, 8x, 15x.
- **Workload files pointing into a deleted worktree** fail silently: every Read errors, nothing enters
  the context, no clearing fires, and the run reads as a clean negative. Verify every referenced path
  exists before launching.
- **A proxy failure degrades to "no clearing" without complaint.** `reason: 'error'` on a row, a
  catch-all above it. Check the status and reason columns, not just the totals.

## Proposing an improvement

1. **Name the ground truth that would falsify it**, and get it from the lowest rung that can.
2. **Label a prediction as a prediction**, in writing, before the run. Then report it against the
   outcome, including when it was wrong — a silently dropped prediction is how a wrong model survives.
3. **Price the asymmetry.** Here, a cut refused costs only the saving it would have made, while a cut
   taken wrongly pays a full prefix rewrite up front. Where the errors are asymmetric, be conservative
   and say so rather than tuning a constant to one run.
4. **Ship it off by default** if it is a strategy, per AGENTS.md, and cite the measurement that would
   turn it on.
5. **Guard the property, not the symptom.** The write leak was fixed by deleting two flags for
   unrelated reasons; the test added afterwards asserts that no message older than the newest turn
   changes between requests, so any future edit that reaches behind the live turn fails it.
