---
name: pricing-tokens
description: >-
  Which rate a token is priced at, and where the rate comes from. Use whenever code or an analysis turns
  tokens into dollars or compares token costs: session cost, a cut's saving, a rewrite's cost, a subagent's
  bill, a payback ratio, a replay. Read before touching prices.js, model-usage.js, cutting.js rates, or any
  script that multiplies tokens by a price.
---

# Pricing tokens

A token has no price until you know **what kind it was on the call that paid for it** and **which model
answered that call**. Most of thinker's wrong cost figures were a right token count at the wrong rate.

## The four kinds, per call

| kind | what it is | rate, relative to input |
|---|---|---|
| fresh input | sent and not cached | 1 |
| cache write | written into the cache on this call | 1.25 at a five-minute TTL, 2 at one hour |
| cache read | read back from the cache | the model's own: a tenth, a twentieth or a fortieth |
| output | what the model wrote | the model's own |

- The agents the proxy serves write at **one hour**, so a rewrite after a cut is priced at 2x
  (`cacheWrite1h`). The usage says which TTL a write was; use it where it is there (`prices.js:writeCost`).
- The read rate **differs by model** and the difference is the whole answer to whether a cut pays: a written
  token needs 20, 40 or 80 reads to earn back. Never a constant; `cutting.js:readRate(model)`.
- A provider with **no cache-write charge** (OpenAI) pays nothing for a rewrite. Price it from its own
  record, not Anthropic's ratios.

## One door

Dollars come from `prices.js` only: `listPrice(model)` for the rates, `costOf(usage, price)` for a call or a
session. Anthropic's rates are `model-usage.js:relativeRate` at Opus's input price; other providers are
listed; `prices` in config and the provider registry override.

- **Unpriced is not zero.** A model nobody priced returns `null`; the figure is left out and named as left
  out. Never borrow another model's rate.
- **Stated, not invented, for a decision.** `fill` defaults a missing cache rate to a tenth and 1.25x; fine
  for a report, wrong for moving a guard. The cut decision reads `statedRates`, which answers `null` unless
  the record states both.
- **Never the agent's own dollar figure.** Claude Code's `total_cost_usd` is on an unknown schedule (3.3x to
  4.3x list in one check). It is data to log, not a price. Price from the usage counts.
- **List prices only**, and say so. Most people are on subscriptions; a list figure is a common scale, not a bill.

## Which rate for which question

| question | rate |
|---|---|
| A token cut from the prefix, on a later call | cache read, that call's model |
| The request that made a cut | cache write (1h), on what it wrote |
| Work handed to a subagent, at the handoff | the same work at the lead's rates, less the subagent's whole bill at its own (cheaper) model |
| A read handed to a subagent, later calls | cache read, the lead's model |
| A file read again after it was cut | cache write once, then cache read on each later call |
| An instruction section or tool definition carried by a call | that session's input cost per input token |
| A subagent's own conversation | its own model, never the parent's |

The first row is the one that was wrong longest: a cleared token priced at the input rate overstates the
saving by 10 to 40 times.

## Tokens from characters

Where the API's count is not available, the estimate is by kind of text:

- tool results: 0.445 tokens a character (`RESULT_TOKENS_PER_CHAR`, measured from transcript usage deltas);
- a whole prompt on Anthropic: 0.36 (1.44 / 4, the Report's calibration).

Using the prompt's figure for a result understates a cut by about a fifth. Mark an estimated figure as
estimated, and where the API reports the number (`cache_creation_input_tokens`,
`cache_read_input_tokens`), use the API's.

## Adding up

Tokens of different kinds or models **never add into a dollar figure before pricing**: price each call's
kinds at its model, then add dollars. Token totals may add across a parent and its subagents; their dollars
are each priced at their own model first.
