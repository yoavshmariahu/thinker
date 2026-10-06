# Audit of the five Sol finding-verification calls

Author/adjudicator: Codex. Requested by Yoav Shmariahu, 2026-10-06.
Method: manual comparison of each saved initial claim/evidence with the final
`verified` explanation in `evidence.tar.gz`, plus the inverse-fix patches and
source at the pinned autoscaler snapshot. No new model runs. This audits the
contribution visible in the record; it is not blinded independent adjudication.

## Finding

The extra checks were not uniformly redundant. Two explanations added a useful
failure detail, one explicitly limited the supported claim, and two mainly
repeated the existing evidence (one linked two already reported effects). None
withdrew a finding. The old records do not save original severity, so severity
changes cannot be measured. All checks re-read bounded code/diff context; none
executed a test or independently inspected downstream callers.

The result supports retaining thoroughness as a distinct review objective,
without assuming that every retained finding demonstrates benefit. Plausible
reasons for checking exist in these cases, but Jev returned only scores, so the
case-specific justifications below are this auditor's interpretation, not
recorded explanations from Jev. This sample cannot establish that its threshold
is optimal or that skipped checks were safe.

| Case / finding | What the second look added | Judgment and limit |
| --- | --- | --- |
| A-10325, stale quick OOM, line 123 | Explained why the remaining `ResourceDiff == 0` guard does not rescue eligibility: a nonzero change below `MinChangePriority` still passes. | Useful counterargument check. The initial evidence showed the removed age guard and quick-OOM bypass but did not discuss this remaining guard. This sharpens the explanation; it does not establish that new code was discovered. |
| A-10178, cleanup timestamp, line 159 | Repeated that the timestamp advances before collection, delaying retries after failure. | Confirmation with no distinct added evidence visible. Checking error propagation was plausible, but the initial finding already named ordering, loss of error return and suppressed retries. |
| A-10178, shared deadline, line 190 | Repeated the expired-context failure and connected it to the prematurely advanced timestamp. | Mostly repeated evidence plus synthesis of the other finding. Context lifetime makes checking plausible; no new test, caller or counterexample was supplied. |
| A-10141, DaemonSet size, line 151 | Confirmed the local return/error regression but explicitly stated that downstream recovery impact was not shown. | Useful limitation. The original finding claimed a recovery failure; this check supports the local defect while leaving that broader consequence unresolved. The main finding was retained unchanged, so the qualification needed to be surfaced to the human reviewer. |
| A-10349, AWS regex, line 223 | Explained that accepting a prefix also corrupts parsing because extraction assumes `aws:///` starts at offset zero. | Useful consequence clarification for the reported regex issue. The inverse patch restores fixed-offset slicing. It still did not catch the task's target bug: slashes inside placeholder names. Verifying one reported issue is not a search for every missed issue. |

All five findings were retained, with the same four of five target bugs detected.
That recall result does not measure false-alarm reduction. This set has no known
false-alarm finding removed by verification; we cannot infer the false-positive
benefit of checking from it. The unverified A-10258 case remains unaudited for
missed value; no counterfactual verification was run.

## Tracking from now on

[Review thoroughness records](../../docs/task-verification.md#checking-whether-extra-review-work-was-worthwhile)
now preserve before/after severity, initial evidence, the actual verification
input context, outcomes, model and usage. The same record is shown in CLI/PR/
proof reports and persisted in the local impact journal and verification run. Gate
policy and effective decisions are explicit; case-specific reasoning is not
invented from a score. Automatic value judgments remain `unassessed`.

For future comparisons, inspect the original finding and verifier explanation,
then record justification and contribution separately. Count useful limits and
severity corrections alongside withdrawn false alarms. Do not count a retained
finding automatically as a win, or extra tokens automatically as a loss.

Validation of tracking: telemetry-disabled full suite, 434 passed and 5 skipped. Focused report tests also passed after the final wording update. All model and execution calls in these tests were mocked; no new benchmark calls were made.
