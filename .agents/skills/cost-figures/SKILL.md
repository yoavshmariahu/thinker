---
name: cost-figures
description: >-
  How to aggregate, compare and show a cost or savings figure once the per-session numbers are right. Use
  when building or reviewing a Report table, the savings footer, `thinker prs`, a telemetry block, a
  dashboard card, a PR comment, or any analysis that sums, averages or compares sessions' costs or savings.
---

# Cost figures

`pricing-tokens` says what a token costs and `savings-attribution` says what a feature saved in one
session. This is what may be done with those numbers afterwards.

## One rule per figure

A figure is one rule a reader can check, stated in under forty words. If the explanation needs caveats,
the formula is wrong: fix the formula, not the tooltip. One unit and one denominator across every row of a
table.

## Rates are ratios of sums

Cost per prompt, per session or per pull request is **total dollars over total count**, never the mean of
per-session ratios (one ledger read $13.93 that way against a true $5.97). Payloads and stored views
therefore carry sums; every rate is taken again from the sums after a merge across repositories or
installs.

## One computation, many doors

The footer, the Report, `thinker prs`, the posted comment and the telemetry read the same computation
(`report-savings.js:weeklySavings`, `delivery.js`). A door never does its own arithmetic. Two doors showing
different numbers for the same thing is a bug in whichever one computed.

## What may be added and what may not

- **Never pool two policies.** Every saving carries the cut policy that made it (`cutting.js:policyId`);
  group by it. A window that spans a dead policy reads the live one as a loss. `unstamped` is its own group.
  Never use a date in place of the stamp: another machine updated on another day.
- **Never add figures that claim the same tokens**: two projections replayed over the same sessions, or an
  estimate beside a measurement of the same thing.
- **Measured and estimated stay apart**, each labelled.
- **Tokens add, dollars are priced first** (a parent and its subagents are on different models).
- **Running totals are not deltas.** A proxy row is one request's figure and rows sum; a desktop or mirrored
  clearing row is the session's total so far, so take the newest and never add them.

## Gross and net

Say which one a figure is. Net is the saving less what the feature itself cost (`savings-attribution`).
Where a surface shows gross, the cost sits beside it. Never show a net with a cost that could not be
measured as if it were zero.

## Missing is not zero

A session with no usage (Cursor), a model with no price, a record from before a field existed: leave it out
and say how many were left out. A pull request with one unpriced session is out of both the cost and the
count. A partial cost is never shown.

## Comparing sessions

- A session that got a cut is a long session. Comparing cleared with uncleared sessions, or normalising by
  context size, measures the selection, not the feature. The clearing's figure is the within-session
  counterfactual; a controlled comparison needs a holdout assigned by hash before the session starts.
- Group a session by what happened to it, not the arm it was assigned to, when the question is what was
  saved; by the arm, when the question is the effect.
- Cost per prompt, not cost per session, when the sides differ in length.
- A few sessions hold most of any saving. Show the spread, and do not publish a typical figure from a sliver.

## Before claiming a win or a loss

1. Is the window one policy?
2. Is the denominator the same on both sides, and is it sums?
3. Is the figure gross or net, and does the text say so?
4. How many sessions were left out, and why?
5. Was it checked against the API's own counts (`verify-before-claiming`)?
