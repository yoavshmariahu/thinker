---
name: savings-attribution
description: >-
  How to decide what a context cut or a delegated read saved and what it cost. Use before writing, changing or
  reviewing any saving, net, payback or rewrite figure for the clearing (cutting.js, compression.js, delivery.js,
  rereads.js) or for delegation (delegate.js, delegated.js, report-savings.js), and before claiming that either
  feature wins or loses money.
---

# Savings attribution

A feature that takes tokens out of the lead's context saves money in one way only: **the calls that come
after it are cheaper**. Everything below follows from that sentence. If a figure cannot be traced to a
later call that paid less, it is not a saving.

## The two rules

**1. The value is the future reads.** A token that is not in the prefix is not read from the cache on any
later call. The saving of a cut or a delegation is

    tokens kept out  x  the calls that actually followed  x  the cache-read rate of the model on each call

- Count only calls that happened. A cut on a session's last call saved nothing; a projected call is not a call.
- The rate is the cache-read rate, never the input rate: the token was being read from the cache, not sent
  fresh (see `pricing-tokens`).
- The sum is per request: every later 2xx request carries the cumulative tokens left out of it, and every
  door sums those rows. A session's saving therefore grows call by call and is zero at the cut itself.

**2. A rewrite belongs to the cut only at the moment of the cut.** A cut changes the prefix once, on the
request that makes it. Every later request sends the same replacements byte for byte and reads the cache
back. So:

- The clearing is charged the cache write of **the request that made a cut** (the proxy row carrying
  `clear`; before that field, the row where the session's cleared figure rose past its highest so far).
- A rewrite on **any later request** is not the clearing's cost: a compaction, a model change, a cache that
  lapsed, the agent editing its own history. It was coming with or without the cut.
- A **cold** cut's own request is not charged either (`clear.cold`, or a rewrite whose cache read is zero,
  `cutting.js:chargedRewrite`): past the cache's hour the whole context is written again whatever thinker
  does. The decision no longer prices that cut at zero (2026-11-18: it cleared every resumed session over the
  trigger as deep as it went, and with the breakpoint the cut was made a request later, warm); the ledger still
  does not charge a cut whose own request found the cache cold.
- A **warm** cut is charged whatever its request wrote into the cache, with no floor on the context and no
  share of it (2026-11-18). The report's rewrite heuristic (`cutting.js:isRewrite`: 100k of context, half of it
  written) is not the test: its floor is on the context after the cut, so large cuts were recorded as free.

The code is `compression.js:clearingCostBySession`; the desktop mod holds the same rule.

## Net, for a cut

    net = future reads avoided  -  the cut request's rewrite  -  re-reads of what was cut

A re-read (`rereads.js`) is the one later cost that is the cut's: the model read a file again because its
result was gone. It costs its write once and its reads on every call after. It is found in the session's
own transcript, never by comparing sessions.

## The decision uses the same arithmetic

Payback (`cutting.js:decideCut`) is the number of later calls a cut needs to earn back its own rewrite:

    payback calls = (write rate x conversation rewritten) / (read rate x tokens cut)

What is rewritten is **every message after the cut**, not the tail from the first replaced result: the API
reads a cached prefix only within 20 positions of a breakpoint, so a result replaced further back leaves
the system prompt as the only thing read (`proxy.js:cutCandidates`). Check a pricing change against the
log: the cut row carries the prediction (`clear.recache`) and the API's own `write` and `read`.

The ratio of write to read rate is the model's: 20 where a read is a tenth of input, 40 at a twentieth, 80
at a fortieth. Take it from `readRate(model)`, never a constant. A cut is made when payback is within the
limit (25). Do not add terms to this to make refused cuts pass; re-price the refused cases first and, if
the decision set does not change, the term is not worth having.

## Delegation

A delegated read never entered the lead's context, so nothing in the prefix changed and **there is no
rewrite to charge, ever**. The work goes to a **cheaper model**, and that price gap is where the immediate
half of the saving comes from. Its value has two halves (`report-savings.js:delegationSavings`):

- **The work, once, at the handoff:** what the same work would have cost on the lead, at the lead's rates,
  less the subagent's **whole bill at its own model** (its prefix, its calls, its report). For a read that
  is the lead's cache write of the tokens against the subagent's bill: its own reported cost where thinker
  ran it, its usage priced at its own model where the host ran it, and where neither is known the subagent
  is assumed to have paid what the lead would have, so this half is zero.
- **The reads, on every later call:** as rule 1, on what stayed out of the lead's context (the input the
  subagent took, less the report that came back).

The price gap is only a saving when the subagent is really on the cheaper model. A subagent that ran on the
lead's model has no gap, pays its own prefix on top, and its handoff half is negative; only the later reads
can carry it. Price every subagent at the model its own usage names, never at the model it was meant to run on.

**A scoped task is more than a read** (a suite run, an exploration of several calls). The counterfactual is
still the same work on the lead at the lead's rates: its input written, its output, and the lead's whole
prefix read again on each call the task would have taken. Today's code credits only the input kept out
(its write and its later reads) and subtracts the subagent's whole bill, so for a multi-call task the
figure is a **floor**. Say so beside it; do not add an estimate of the lead's avoided output or calls
without a measurement of what the lead spends on the same task.

A firing counts only if the read was really kept out: not held out, not declined, not failed, not a repeat
answered from the turn's cache, and not a handoff after which the lead read the file anyway.

## Both features on one session

A cleared token and a delegated token are never the same token (a delegated read is not there to be
cleared), so their **measured** figures may be added. Their **projections** may not: replayed over the same
sessions both claim the later reads of the same old results, and whichever acts first takes them.
Delegation's alone is the write half.

## Before a figure ships, answer these five

1. Which tokens were kept out, and on which request did that start?
2. Which later calls happened, and on which model was each?
3. Is every saved token priced at that call's cache-read rate?
4. What did the intervention cause on its own request (the rewrite, the subagent's bill), and is it charged
   exactly once, there?
5. Is anything charged that would have happened without the intervention? If yes, take it out.

## What went wrong before, so it is not done again

| mistake | what it did | the rule |
|---|---|---|
| Cleared tokens priced at the input rate | 202M tokens read as thousands of dollars; the replay said +7.3% | cache-read rate |
| One read rate for every model (2.5%, then 10%) | losses read as wins on the model where a read is 5% | `readRate(model)` |
| Every rewrite after a first clear charged to the clearing | compactions and lapsed caches read as the clearing's loss | only the cut's own request |
| A cold cut's write charged | $11.01 charged against $3.89 saved on a session the cut cost nothing | cold is priced at zero on both sides |
| Cleared sessions compared with held-out sessions | a cut only fires on long sessions, so the sides were never alike | within-session counterfactual, plus re-reads |
| A rung priced on its tail, as if the prompt above the cut stayed cached | cuts taken at a payback of 23-25 calls that the API's writes put at 38-179; three of three lost | the whole post-cut conversation |
| A saving term added that changed 0 of 30 decisions | two constants and a parity exemption for nothing | re-price the refused cases first |
