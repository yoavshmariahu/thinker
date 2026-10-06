# Autoscaler historical regression review experiment

Codex research agents · 2026-10-05

## Result

Across the same ten historical Autoscaler fixes, all three note-backed review
cohorts caught three more known regressions than their matched no-cache arms.
These are **in-sample recall results**: each cache was built from the exact
fixes later reversed. They support the claim that notes can preserve past
failure knowledge for review; they do not measure detection of new bugs.

| Review model | No-cache hits | Note-backed hits | Review tokens, no-cache / notes | Note mining tokens |
| --- | ---: | ---: | ---: | ---: |
| [Claude Opus 5](cohorts/opus/README.md) | 7/10 | 10/10 | 153,141 / 170,951 | 69,709 |
| [GPT-6.1 Sol, high](cohorts/sol/README.md) | 6/10 | 9/10 | 184,927 / 191,053 | 177,637 |
| [Gemini 3.1 Pro High](cohorts/gemini/README.md) | 6/10 | 9/10 | 192,981 / 142,899 | 100,123 |

The net gain hides individual losses. Sol caught four cases only with notes
but missed one historical failure (#10349) that its no-cache arm caught.
Gemini missed #10001 in both arms after a future-looking clause in its mined
note led it to mark the note outdated. The [Sol note-text control](cohorts/sol/ablation/README.md)
kept the selected notes and code context fixed but redacted note titles, bodies,
IDs, and applicability text: it caught 4/10 instead of 9/10 with full notes.
All four Sol cache-only catches disappeared under redaction. One case moved in
the other direction, so this is evidence of note contribution and prompt
sensitivity, not deterministic proof of a population effect.

## Question

When a previous fix is later undone, does Thinker's note-backed review
pipeline catch the regression more often than its no-cache review pipeline?
The comparison uses the same code change, model, and reasoning setting within
each pair. The two product review modes use different prompt scaffolding and
code-context selection, so this is a pipeline comparison, **not** a pure
ablation of note text alone.

This is **historical fix recall**, not a prospective estimate of unknown-bug
detection. Each cached arm may consult a note mined from the very fix that is
reversed. The cached arm uses the product's related-note retrieval; a note
that is saved but not retrieved is a cache miss. The no-cache arm gets the
diff, changed code, and linked tests but no note text. The reverse diff also
removes the original regression tests, which can make the baseline easier
than an ordinary PR review.

## Cases and ground truth

The ten cases in `cases.json` were frozen before any model review results. At
Autoscaler commit `40889a675092c0939c59160fc5270273db4e0555`, select the
newest first-parent merge since 2026-05-01 with a fix-like branch name, 1–120
changed production Go lines, at most 200 total changed lines, at most ten files,
and a clean reverse patch. Apply the reverse of each merge's first-parent diff
to an isolated worktree at that fixed commit. The merged fix and its PR explain
the known failure restored by that reverse patch. There is no model judge.

## Scoring fixed before reading the frontier-model results

- **Actionable hit:** an error or warning in a changed production file, at or
  within six lines of the reverted fix, whose explanation identifies the
  historical failure mechanism. A finding about a deleted test alone is not a
  hit. A note marked outdated without an actionable finding is not a hit.
- **Qualitative review value:** whether the finding tells a human what behavior
  the change intended to preserve, why the change breaks it, and what evidence
  to inspect before approval. Record extra or speculative findings separately.
- **Efficiency:** review tokens and elapsed milliseconds per arm, with
  note-generation tokens and elapsed time reported separately. Do not combine
  these into a single score or hide note-generation work. Alternate arm order
  by case in the primary cohorts to reduce first-call timing bias; timing
  remains descriptive because model-service load is uncontrolled.
- **Validity:** both review arms must resolve to one call on the exact same
  provider/model and fixed reasoning setting. Note generation uses that model
  and setting too. A provider/model mismatch, missing model call, or tool error
  makes a pair invalid, not a miss. Cohorts for different models are separate.

One deterministic run per case is an illustration, not an estimate of a
population success rate. The sample is small and selected for reversible,
compact Go fixes; it does not cover arbitrary Autoscaler PRs.

## Reproduction and evidence

`select.mjs` and `cases.json` preserve the case-selection rule and exact
commits. Each model directory contains its note-mining and review scripts,
full note bodies, per-case scores, and structured review results. All scratch runs
used `THINKER_TEST=1`, telemetry off, no learning, local logs, and disabled
provider fallback. Each cohort used isolated Thinker and Autoscaler worktrees.
The Sol directory includes an experiment-only patch that pins Codex reasoning
effort and redacts note text for its control; it is not a product change.

The first Sonnet 5 run was stopped after seven pairs when the user requested
stronger models, and its results are excluded from the table. An initial Sol
probe with related-note retrieval disabled consulted zero notes on #10325
because its note named a broader symbol. It was discarded before the primary
run, which uses the product's default related-note retrieval.
