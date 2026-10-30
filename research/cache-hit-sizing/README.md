# Cache-hit sizing: source context is useful evidence, not yet savings

Author: Codex, 2026-10-30. Product code: `ea0a4b800` (merged PR #547).

Follow-up: [revised per-hit estimates including context carry](carry.md) counts
observed request membership for 28 confirmed hits, charges the carried note text,
and reports clearing, reading-size, and overlap sensitivity. The initial audit
below explains why a global multiplier or distillation-input size was insufficient.

Visual review: [before](before.jpg) and [proposed](after.jpg) are browser screenshots
of the existing aggregate token-savings card rendered with the same 28-hit audit
subset. These are isolated component previews, not the full live Report. The
existing page's CSS, `card`, `fmt`, and escaping functions are used by `preview.mjs`.
The proposed wording and coverage rows exist only in the preview. Generate both
pages with `THINKER_TEST=1 node research/cache-hit-sizing/preview.mjs /tmp/thinker-savings-preview`.
No production UI or accounting change is included. Shipping still requires shared
lifetime accounting for the report/footer and an explicit fallback for sessions
without the request evidence this diagnostic used.

The current cache-hit estimate omits discovery and the repeated input from keeping
discovered context in later prompts. That makes it incomplete, but does **not**
establish that its final number is too low. It also counts entire dependency files
where an agent might need only a few lines, and treats acting on a note as evidence
of an avoided read. The assessment explicitly allows confirmation when the agent
reads the files the note names.

The earlier conversation's proposed **18× token / 2.2× cost correction is not
supported**. It combined unrelated populations and treated estimated context carry
as measured avoided input. Do not apply those factors to the cards. This research
changes no production calculation, default, learning prompt, or serving behavior.

## What was audited

Read-only local diagnostics of existing production logs and three source
transcripts; no model calls, agent experiments, benchmarks, or new cache building.
The log window is 2026-09-30 05:00 UTC through 2026-10-30 05:00 UTC, end exclusive.
Scripts require `THINKER_TEST=1`, do not instantiate a Store, and do not refresh
production state. JSON artifacts contain aggregates and source references, not
transcript excerpts. Source hashes record the inputs; those private local inputs
are not committed, so an outside checkout cannot reproduce the observed numbers
without equivalent data.

| Population / candidate | Count | Mean tokens | What it means |
| --- | ---: | ---: | --- |
| All positive logged serving estimates | 1,185 | 9,439 | Repeated deliveries, whether assessed or not |
| Confirmed distinct session–note uses | 117 | 11,467 | The named-session cohort credited by the estimator |
| Confirmed uses with an earlier distillation in the window | 67 | 11,566 | Same logged estimator, on a matched subset |
| Assigned trace share for those same 67 uses | 67 | 2,954 | Distiller's selected input / notes saved or merged |

The 117 confirmed uses total 1,341,593 estimated tokens and 317 file reads. All have
logged estimates. There are 812 distinct named session–note pairs overall, of
which 534 have no verdict in this window. Pending is unknown; it cannot simply be
credited as savings. This audit uses latest in-window verdict and first serving
estimate per session–note, matching `usage.js:summarize` for named sessions. It
does not claim to reproduce the dashboard's holdout-based branch or every card.

Of 699 distillations with `traceChars`, 398 saved or merged a note. The earlier
~2,805 trace-share average reproduces approximately (2,807), but **457 of 526
`evidence` calls are already between 11,000 and 12,000 characters**.
`learning-evidence.js:evidencePacket` caps the selected packet at 12,000 characters,
prioritizing the prompt, final answer, failures, corrections, and recent tools.
`distill.js:condense` also truncates individual results. This mostly measures the
packet budget, not how much code the original agent needed to understand.

Only 52 of the 117 confirmed uses have a note still present in the inspected
checkout's shared/local note tiers. The other 65 may have been retired or may live
in another checkout. Log-based joins still recover earlier distillations for 67
uses. Retroactive provenance cannot assume that today's note or dependencies are
the version that was served then.

## Why the previous multiplier does not follow

1. `tool-outputs.js:sessionOutputs` estimates result size as characters / 4 and
   retention from remaining tool calls scaled to model calls. It stops at recorded
   compactions; it does not consume proxy clearing records. Its `input / tokens`
   ratio is modeled carry, not a provider measurement attributable to each result.
2. The earlier 9,436-token average was over all positive servings, not the
   confirmed session–note cohort. The tool averages were over different sessions
   again. Repeated deliveries, long sessions, and tool mix affect those weights.
3. A dependency is a freshness anchor, not an observed rediscovery plan. A note can
   save a search, prevent a mistake, or direct the agent to a read it still makes.
   `distill.js:ASSESS_RULES` calls the last case confirmed too.
4. The full file can exceed the needed excerpt. Different notes can also share a
   file: the current-file diagnostic finds four confirmed sessions with overlap,
   taking 813,594 summed per-note tokens to 771,594 under a per-session file union.
   These use surviving notes and current file sizes, not historical corrections.
5. A note itself is injected and carried. A net carry estimate must subtract its
   lifetime, not just count hypothetical avoided output. `u.saved.net` currently
   subtracts injected text once; the headline fallback is gross reading avoided.
6. Money depends on the receiving model, cache reads/writes, TTL and rewrites.
   A single read-rate assumption cannot price every model. Do not multiply the
   existing dollar card by a global carry ratio. No current price claim is made here.

The cached output diagnostic separates recorded model names. For confirmed-use
sessions, the modeled reading-tool carry is approximately 187 for Opus 5.5, 93
for Fable 5.1, and 167 for Opus 5. Each remains an estimate for **all selected
reading tools in those sessions**, not reads avoided by their notes. This is not a
comparison of model performance. The reader classifier covers Claude-style tools;
zero rows for other clients or incomplete traces are not evidence of zero reading.

## Testing the user's source-context idea

`source-context.mjs` traces three deliberately selected, surviving agent notes to
their original Claude transcript. It counts only timed reading/search calls made
before note creation whose input names a current dependency path. Each result is
counted once even if the command names multiple dependencies; characters / 4 is an
estimate, and repeated or overlapping results are not deduplicated.

| Note topic | Candidate calls | Candidate result tokens | Current file estimate |
| --- | ---: | ---: | ---: |
| CLI/UI synchronization assertions | 11 | 17,313 | 18,000 |
| Proxy must preserve a person's route | 10 | 10,311 | 20,577 |
| Report savings from kept session rows | 7 | 11,833 | 12,000 |

This demonstrates recoverability, not necessity or representativeness. A command
can print unrelated output alongside a named file; indirect reads can be missed.
Dependencies can have changed. The original session may have inherited the answer
from an earlier note, or needed exploration only because it was implementing the
feature for the first time. The final answer can state the fact without showing
how it was established. None of these totals is an avoided-work measurement.

The useful next step is **evidence attributed to each note**, rather than dividing
a session's or a distillation's total by its note count:

1. Give raw source events stable references and retain them through selection.
   Record source session, event/result hashes, available byte or line ranges,
   timestamps, and whether output was clipped. Existing `[event n]` packet labels
   alone are insufficient: offsets refer to the current learning slice.
2. Have distillation cite the events supporting each claim. Validate that the
   references exist and predate the note. Expand to relevant raw ranges locally;
   keep direct excerpts, searches, failed attempts, and user-provided constraints
   as separate categories. A citation is evidence, not proof of minimal context.
3. Store this with the note's version. Merge shared evidence by its identity so it
   is counted once; invalidate or replace provenance when the claim changes.
   Keep unmapped and clipped evidence explicitly unknown. Use the same path for
   CLI-backed and queued desktop learning.
4. Present the initial metric as **source context behind this note**. Keep it out
   of savings totals until calibrated. Model a receiving session's avoided work
   only after accounting for files it still read, previously available context,
   other served notes, and the lifetime/cost of the note itself.

A possible future estimate is the union of attributed discovery evidence that
the recipient did not need to reacquire, minus note-injection overhead. Raw context,
modeled cumulative input, and monetary cost must remain distinct. Searches and
avoided failures should be added only with their own evidence, not a multiplier.

## Validation needed before changing savings

An Artemis plan should compare shipped estimation and the proposed estimator on
the **same paired agent tasks**, using the same exact model and reasoning effort
in every phase. Build historical caches only through approved product paths at
valid anchors. Compare notes withheld versus supplied, correctness, actual reads,
provider input/output/cache usage, and latency. Evaluate error and coverage of the
estimates, including negative savings; never tune only for a larger headline.
Use held-out tasks for calibration, and separate proxy-on/off cohorts or model
their interaction explicitly so avoided reading and measured clearing do not get
counted twice. Same-session turn holdouts can carry notes from earlier served
turns; they are not independent no-note sessions for lifetime attribution.

No Artemis plan was submitted or experiment started. Plans need owner approval
under AGENTS.md; an offline diagnostic does not authorize a default-on change.
The immediate recommendation is to retain the shipped figures as estimates and
collect per-note evidence before choosing a replacement. Whole-session input,
capped distillation input, and a global carry multiplier are all poor substitutes.

## Reproduction

From an isolated worktree with dependencies installed:

```sh
THINKER_TEST=1 node research/cache-hit-sizing/audit.mjs \
  /path/to/thinker /path/to/.thinker/log.jsonl 2026-10-30T05:00:00.000Z

THINKER_TEST=1 node research/cache-hit-sizing/source-context.mjs \
  /path/to/thinker /path/to/claude/project-transcripts \
  cli-ui-sync-test-asserts-page-html-server-js-strings-match-c \
  context-proxy-must-never-take-over-a-route-that-is-not-its-o \
  report-savings-are-computed-from-per-session-rows-kept-in-th
```

The audit reads the named repository's notes and existing `tool-outputs.json`
cache without modifying them. Log timestamps are bounded; current note/file state
and cached transcript aggregates are explicitly separate diagnostics. Cache rows
are selected by transcript mtime, as in the existing session-window approach;
they may include earlier activity within a long session and omit one modified
after the cutoff. They must not be used to price the confirmed cohort directly.

Token units also differ: shipped estimates use file bytes / 3.6; the earlier
trace-share calculation uses characters / 3.6; tool output uses characters / 4.
None is a tokenizer count. A calibrated replacement should use consistent units
and record the tokenizer or approximation used.

## Verification

Both diagnostic scripts ran successfully against the local inputs above.
`npm test -- --all`: 968 tests, 966 passed, 0 failed, 2 skipped. The completed
run required loopback access outside the sandbox; the sandbox run failed on
`listen EPERM`. The daemon restart also interrupted an earlier attempt, whose
partial output is not counted as a completed test result. No production files
were changed.
