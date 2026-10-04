# Delivery outcomes

Thinker records the work behind a pull request and the defects its reviews helped
fix. `thinker impact` reports observed outcomes, with the evidence and missing
coverage beside them. It does not convert estimated reading savings into delivery
claims or claim that a merged PR would have failed without Thinker.

## Start with a repository

```sh
thinker impact sync --days 30
thinker impact
thinker impact --pr 142
thinker impact --pr 142 --json
```

Sync uses the existing `gh` login to read PR lifecycle, commits, and readiness events
from a github.com origin. It never posts comments or updates a PR. Use `--pr 142` to
sync an older PR. Reports are local and do not fetch in the background. Re-run sync
after a PR merges or gains a fixing commit.

The default report selects PRs merged in the last 30 days and unmerged PRs updated
in that period. For a merged
PR, token accounting includes all its recorded work, even work before the window.
Open and closed-unmerged PRs retain their known tokens. Repository overhead is
reported for the selected period. `--pr` displays the PR's full recorded history.

## Attribute sessions and reviews

New stop-hook session records retain the checkout's branch and commit alongside
cumulative usage. Prompt hooks also record commit observations. Session snapshots
replace earlier counters; they are not summed. A session links automatically only
when observed movement between commits fits exactly one synced PR (the first
observation may be its base). A matching branch name alone is insufficient.

Inspect `unassignedSessions` and `unassignedReviews` in `thinker impact --json`.
Supply or correct attribution explicitly:

```sh
thinker impact link --session SESSION_ID --pr 142
thinker impact link --session SESSION_ID --split 142:0.4,143:0.6
thinker review --base main --pr 142
thinker impact link-review REVIEW_RUN_ID --pr 142
```

A later link replaces the previous allocation. Shares must sum to one; the same
session is never charged in full to several PRs. Links work before PR metadata is
synced, but a PR is only counted as merged after sync provides that evidence.
Review records retain the reviewed SHA/scope, model, findings, notes and errors.
Repeated reviews count their actual model work, while identical findings retain a
single identity. Worktree/index review scopes are labeled: their HEAD alone does
not identify uncommitted content.

## Confirm findings and record fixes

The review output and per-PR impact report print finding IDs. Validity and
resolution are independent:

- Validity: `pending`, `confirmed`, `dismissed`, `duplicate`.
- Resolution: `open`, `fixed`, `accepted-risk`, `not-applicable`.

```sh
thinker impact finding FINDING_ID --pr 142 --validity confirmed \
  --evidence 'Reproduced the missing permission check with a regression test'

thinker impact sync --pr 142
thinker impact finding FINDING_ID --pr 142 --validity confirmed \
  --resolution fixed --fix COMMIT_SHA \
  --evidence 'Regression test fails before this commit and passes after it'

thinker impact finding FINDING_ID --pr 142 --validity dismissed \
  --evidence 'The caller validates this value before reaching this function'

thinker impact finding FINDING_ID --pr 142 --validity duplicate \
  --duplicate-of ORIGINAL_FINDING_ID --evidence 'Same defect with different wording'
```

Only unique confirmed findings fixed before merge count as **bugs caught and
fixed**. The fix must resolve to a local commit in the synced PR's commit list
(or its merge commit), dated no earlier than the finding and no later than merge.
Confirmation is human-reported, with the supplied evidence retained; Thinker does
not automatically execute or independently adjudicate a regression test.

A rerun with no finding, an automatically verified finding, or a resolved GitHub
thread is insufficient to count a fix. No GitHub-thread status is automatically
interpreted as human confirmation. Identical normalized message/evidence/file/note
content deduplicates across line movements. Different wording needs an explicit
duplicate decision. Cached note references support the separate cache-supported
count; they do not establish that a review without the cache would miss the bug.

## Understand token coverage

Agent input and output tokens come from transcript usage. Provider prompt-cache
reads/writes are retained; they are already part of normalized input tokens and
are not added twice. Repeated cumulative Codex snapshots replace earlier totals.
Claude message IDs deduplicate repeated usage for separate content blocks.
Missing counters remain unknown; partial recorded totals remain lower bounds.

PR review accounting uses the underlying model calls, including retries and
failures, once each. A review summary is not charged again. Shared initialization,
learning and maintenance remain repository overhead; no arbitrary share is silently
assigned to a PR. Estimated reading savings are never deducted from observed usage.

The median uses merged PRs with complete counters for their linked sessions and
reviews. This is **recorded-work coverage**, not proof that every collaborator or
subagent was captured. Imported machine exports can improve coverage. Subagent
transcripts are not discovered automatically; link separately recorded sessions
only when their counters are not already included in the parent. Thinker cannot
reconstruct missing historical outputs or identify every unobserved participant.

Opened-to-merged time uses GitHub timestamps. Ready-to-merged time is populated
only when a `ready_for_review` event is present, using the latest such event.
A PR created ready often has no event, so that metric remains unknown. These are
elapsed wall-clock times, not estimates of human effort or time saved.

## Transfer evidence from CI or another machine

```sh
thinker impact export > impact.json
thinker impact import impact.json
thinker impact import thinker-review.json
```

`thinker review --json` includes `impact.events`: the run and its underlying model
accounting. The review Action exposes the report path through its `report` output
for both runner and completed server reviews. Preserve that JSON with your
workflow's artifact upload step, including when review fails the check, then import
it locally. The Action does not upload artifacts automatically. Server reviews also
retain their journal on the server; export there to transfer all historical runs.

Exports carry repository identity and event UUIDs. Import rejects a different
repository and deduplicates repeated event IDs. Export includes cache-serving IDs
and assessments without prompts. Review evidence can contain source excerpts;
transfer it through the same trusted channels as the code. Recording and transfers
are independent of production telemetry.

By default, the append-only schema-1 journal is at
`~/.thinker/impact/<repository-hash>.jsonl`. `THINKER_HOME` relocates it;
`THINKER_LOG=local` uses `.thinker/impact/`, and a custom log path uses its sibling
`impact/` directory. `THINKER_LOG=off` disables recording. Read failures/corrupt
records are reported rather than interpreted as zero work. The journal directory excludes itself from git. This data is not shared
through the note cache or sent to the telemetry endpoint. Updated clients send only
numeric 30-day aggregates in `delivery` telemetry: merged PR observations, token
sums with complete-counter denominators, fixed bugs, decision counts, timing samples,
fixed token-distribution buckets, and coverage. Repository/PR identifiers, titles,
session IDs, paths, code, SHAs and finding evidence are never included. Existing
telemetry opt-outs apply. Metadata still needs `thinker impact sync` to stay current.
The Metabase **PR delivery & review** dashboard visualizes those summaries using
the latest snapshot per known device, falling back to installation identity. Counts
are observations, because several contributors can report the same team PR.

## Dashboard and comparison contract

`thinker impact --json` returns schema version 1 with `summary`, per-PR `sessions`,
`reviews`, `findings`, token completeness, `overhead`, unassigned work, and warnings.
All summaries are rebuilt from recorded events plus existing usage history; there
is no second set of dashboard-specific counters to drift from the CLI.

`summary.improvement` is currently null and the CLI says the baseline is not
established. Controlled work-item cache assignments, paired cache/no-cache review
experiments, uncertainty intervals, and linked post-merge regression outcomes are
future measurement work. They should account for model, contributor, task type,
and change size before claiming increased throughput. Existing session holdouts
remain available in `thinker usage`; they are not relabeled as PR-level causal
results. Website/dashboard hosting is a separate future step.
