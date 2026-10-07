# Reliable PR mining and learning

Author: Codex · 2026-10-07

PR mining reached the writer, but grounding rejected every proposal in the stopped
efficiency canary. This work repairs that pipeline using PR evidence only. The
writer interprets the PR; Jev checks support, conflicts and reconciliation. Rejected
new discoveries get at most one writer revision against the original PR.

The efficiency canary remains stopped. These are reliability diagnostics, not
with/without-Thinker efficiency results. A nonempty retrievable cache is an
operational check, not proof of exhaustive learning, note quality or speedup.

## Baseline and causes

Inputs come from `research/pr-efficiency-canary`: Click task 3364, base
`8a2b48901a08b3d2ec3a9bbd151948a9765368c6`, cutoff
`2026-04-28T23:31:25-07:00`. The frozen corpus excludes the target fix and later
metadata. A content snapshot of that checkout resolves dependencies; its synthetic
diagnostic git commit does not replace the original ancestry check.

Replaying all 21 persisted proposals with the original judge accepted 0: 19
insufficient-support decisions and 2 source conflicts. The original malformed
`c4` answer was not reproduced; its raw response was not retained, so the precise
schema violation is unknown. Keeping complete evidence together alone still
accepted 0/21. The final implementation accepts 1/21 unchanged proposals: broad
unsupported prose does not become acceptable just because infrastructure works.

Distinct causes:

- Writers filled symptom/root-cause/constraint templates even when a PR established
  only a narrow mechanism, inventing explanations and scope.
- Arbitrary 10 kB slices separated related test setup, assertions and changed code,
  even when the complete request fit the service limit.
- Long three-way questions mixed support and contradiction. A probe accepted an
  explicitly reversed cleanup order; concise independent questions rejected it.
- Titles and scope fragments were treated as standalone source assertions. All
  factual lines could pass while a topic label failed.
- Malformed responses were terminal and lacked specific diagnostic reasons.
- One saved note let legacy source inference mark a partially failed PR as mined.
  Progress also concealed this partial failure.

## Changes

`src/prs.js` asks for narrow, supported notes with one to three body lines.
`minePrs` allows one revision of rejected new discoveries using the same evidence
and configured writer model. Revisions go through grounding and reconciliation
again. Existing-note contradictions are not automatically repaired, human behaviors
remain protected, and unavailable judges do not trigger content repair.

`prepareNotes` keeps complete evidence when the bounded request fits. Each body
claim requires support >= 0.9 and contradiction < 0.2, now independent Nouls rather
than a Choice distribution. Groups stay within 32 questions. Separate metadata
checks require misrepresentation/broadened-scope probability < 0.2. Empty optional
scope needs no model judgment. These are different questions: old/new probabilities
are not directly comparable calibrated scores.

Learning retries malformed JSON/schema responses and transient transport failures
once with the identical request/model. Valid negative or uncertain judgments,
authorization failures and external cancellation do not retry. Every attempt is
metered; the daily cap applies before retries. `learningAttempts: 1` disables them.
Logs include error code, question, reason and attempt, without source payloads or
credentials. PR receipts persist incompleteness before saving notes, retain retry
IDs after partial saves (including numeric-looking Git hashes), clear them
on success and show failures in progress. Other PRs continue processing.

## Validation protocol

Nine empty-cache builds: three repetitions each of `claude-opus-5-5`,
`gpt-6.1-sol` and `gemini-3.8-flash-high`, all high effort, with `jev-1.13.0`.
Each uses the same frozen Click PRs: #3151 (random testing), #3245 (editor/pager
arguments), #2991 (stream cleanup). These useful diagnostic examples were selected
before the final matrix; they are not a random sample of all PRs.

Each build uses normal `minePrs`, checks saved PR provenance/dependency anchors and
`orient`, then repeats mining and requires zero extra calls or notes. Retrieval is
capped at three notes. One job per provider runs concurrently; repetitions within
a provider are sequential. Timings are diagnostic, not a model speed comparison.
The existing `research/performance-canary/model-pins.patch` pins models/effort and
captures traces; that adapter is excluded from the product change. Builds have
600-second deadlines and process-group cleanup. Every child inherits test mode and
local logging. Jev uses an explicitly injected test inference transport. No
production telemetry, exploration or session distillation is involved.

`summary.json` retains all completed pilots and repeats. Archived unsuccessful
approaches include the pre-call ES-module shim failure, early Opus pilots, the first
matrix with an empty Gemini cache and its pause before a second Opus repetition.
They are not silently included in the final fixed-implementation cohort.

Final controls: 33 judgments over 11 fixtures repeated three times; 9 accepted
true facts, 3 false negatives on one compound dependency-group claim, and all 21
counterfactual/overbroad-metadata attempts rejected. Fixtures are never saved as
cache notes. These calibration controls are not an independent general accuracy
estimate. Indirect dependency-group membership remains a false-negative case.

## Evidence and reproduction

`THINKER_TEST=1 npm test` exercises real CLI orchestration with mocked providers:
one successful revision, a persistently rejected revision, and partial saving with
persistent malformed judgments while the next PR continues. Tests cover identical
request retries, malformed JSON, accounting, cancellation, caps, metadata, claim
bounds, protected behaviors and preservation of existing-note constraints.

Live scripts require existing CLI logins and a personal Jev key; credentials are
not copied. `summary.json` indexes the retained raw archive. The scripts record raw
requests/responses, model usage, source patches, notes and retrieval. Apply the
research adapter only in an isolated worktree and use new labels. Restore the
frozen input files and Click snapshot with `THINKER_TEST=1 python3
research/pr-mining-fix/prepare.py` before running. `inputs.json` verifies their
hashes and the reconstructed Git tree. The preparation script was also verified
in a separate worktree.

Future efficiency runs must still freeze the new revision, build every task/model
cache through the guarded PR-only harness, and pass all readiness checks before
coding. This work does not reopen the historical stopped batch or relax its
failed-call gate.

After the fixed matrix started, receipt handling was additionally hardened to
persist incompleteness before saving (covering interruptions) and handle numeric
Git hashes. These changes do not alter model inputs or decisions; the final
offline orchestration/full-suite checks cover them. Each matrix run retains its
exact source patch and hash.

References: [Jev 1.13](https://docs.typesafe.ai/model-jaggedness/jev-1.13),
[Noul](https://docs.typesafe.ai/primitives/noul),
[citation checks](https://docs.typesafe.ai/cookbooks/citation_check).

## Final results

| Writer (high effort) | Fresh-cache builds passed | Notes per repeat | Failed model calls |
| --- | --- | --- | --- |
| opus | 3/3 | 3, 2, 2 | 0 |
| sol | 3/3 | 3, 4, 5 | 0 |
| gemini | 3/3 | 2, 3, 3 | 0 |

All nine builds passed retrieval and idempotent reruns: 27 PRs processed and 27
notes saved in total. Some PRs produce no accepted note; others produce several.
This establishes repeated cache construction on these inputs, not perfect recall.
Final offline suite: **509 passed, 5 skipped** (four optional AST tests and Docker).
The suite ran without the model adapter on the latest main plus this product patch.
