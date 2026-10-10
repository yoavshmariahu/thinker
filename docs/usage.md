# Usage, savings and learning

What the cache costs, what it saves, and how it learns from your sessions. Back to the [README](../README.md).

## Cache usage and savings

Run `thinker stats` for a machine-wide dashboard of activity, agent usage,
learning, estimated reading avoided, and reported model tokens, with a breakdown
by repository and the current checkout's cache details. `--here` limits activity
to this repository, `--days 7` shows the last week, and `--json` includes the full
data (the original `repo`, `notes`, `status`, `kinds`, and `uses` fields still
describe the current checkout). Repositories are discovered from the configured
usage log; clones and worktrees sharing an origin are grouped together. Cache
counts are current, even when activity is filtered by date.

Run `thinker usage --here` to compare this repository's cache spending with its
estimated savings, or `thinker usage` for every repository on the machine.
`--days 7` limits the period; `--json` includes spending by operation, provider/model,
and repository.

One number in it is measured rather than estimated. The hooks serve nothing in
15% of sessions (chosen by a hash of the session id, so a session is held out
for its whole length; `holdout` in `.thinker/config.json` or `THINKER_HOLDOUT`
changes the share or turns it off), and the stop hook records what each session
cost by its own transcript: tool calls, model turns, input tokens. The
"Holdout" section of `thinker usage` compares the sessions that got notes with
the ones that had notes withheld, as medians per model, once five sessions
stand on each side. Sessions where nothing would have been served are on
neither side. Telemetry, unless you opted out, sends the totals behind this
comparison (session counts and summed tool calls, turns and tokens per side
and per model, over 30 days), nothing about the sessions themselves. This is what the notes do for your own work, on your own
repository, by your own agent, and it is the number to hold the cache's
spending against.

The report separates cache initialization (PR mining and phrasings; exploration in logs
from before it was removed), ongoing session distillation, and maintenance. It records reported
input/output tokens, provider prompt-cache reads/writes, and missing usage. Model calls that produce no notes, dry-run distillations, and
failed attempts count too. Tokens reported before an invalid model answer are retained;
failures without counters remain unknown. Nothing is given in dollars: the agents run on
subscriptions as often as on metered keys, so a price from an API list would mislead.

The token balance subtracts both injected notes and reported build/maintenance tokens
from estimated file-reading tokens avoided. Savings still require a session assessment
that the note was used. This is a token comparison: tokens of different models and of
cached input are counted alike. Older logs omitted tokens and setup exploration,
so historical totals cannot establish full payback. A limited date range also excludes
setup spending outside that period.

Session learning uses the working agent's `remember` and `feedback` tools first:
save a reusable finding while its evidence is already in context. Background
learning selects at most 12,000 characters of source evidence from the transcript:
the first request, the last answer, failures and corrections with what followed
them, and the most recent tool calls. Routine exploration and cache hits alone do not
trigger discovery. Notes are assessed only when discussed explicitly or when a
failure/correction touches their dependencies; omitted evidence stays unknown,
not “unused.” Only returned assessments are checkpointed as assessed.

`learn.auditRate` in `.thinker/config.json` selects a stable sample of sessions
(default 0.05) for the fuller, 70,000-character trace path. Set it to 0 to disable
sampling, or 1 to audit every eligible session. Small, uneventful sessions still
skip learning; `learn.quietExplore: 0` retains an explicit opt-in to processing
every eligible session. The log records `learningMode` (`evidence`, `assessment`,
`audit`, or `full`) and trace size so quality and spending can be compared.

`thinker distill <transcript> --dry --evidence` previews the compact path;
without `--evidence` or `--incremental`, an explicit distill retains the fuller
trace as its fallback when semantic selection is disabled or unavailable. Both dry runs call a model but save no notes. Compact discovery
requests at most 3,000 output tokens, assessment alone 1,500, and full distillation
6,000. Claude CLI receives these per-request output limits, disables optional
thinking, and limits structured-output attempts; provider retries can still add
usage. These bounds reduce input and output, not guarantee a measured saving or
identical note quality.

To evaluate a cheaper distillation model, compare the same transcripts with
`thinker distill <transcript> --dry --model <model>`, then inspect usage and note quality.
`--dry` still calls a model and records its usage, but does not save notes. The existing
`distillModel` setting in `.thinker/config.json` chooses the default distiller for session
learning and PR mining; an explicit `--model` or `THINKER_LLM_MODEL` takes precedence.
The report's no-new-note/no-merge counts help identify low-yield runs, though those runs
may still assess existing notes. Keep quality and downstream task correctness in the
comparison, not just note count.

