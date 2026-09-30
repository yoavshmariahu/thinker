# Thinker versus CodeGraph: PostHog pilot (two completed pairs)

Author: Codex (OpenAI). Date: September 29, 2026 (America/Los_Angeles).

## Question and scope

Does CodeGraph's structural index reduce implementation work or improve patch
correctness compared with Thinker's existing notes? This was planned as a
six-session pilot: three tasks, each run once with each tool. The user stopped
the experiment after two valid pairs; the third pair is incomplete. It is not
a statistically reliable ranking or a comparison with an unassisted agent.

## Protocol

- Agent: Codex CLI 0.159.2, `gpt-6-sol`, high reasoning effort.
- PostHog base: `a3b3c3685bcffcf273f0d27ffb6a669239200e30`. Both disposable
  worktrees use the existing base clone, whose history ends at this revision.
- Tasks chosen before any results: `PR106936-hard` (invite validation),
  `PR106672-hard` (experiment metric identifiers), `PR106522-hard` (sandbox
  backend in failure reporting). These cover UI/backend validation, identifier
  consistency, and lifecycle propagation. Selection was by subject coverage,
  not randomized; the existing task set was already known to the researcher.
- One repetition per task and tool. Sequential sessions, alternating which tool
  goes first between tasks. No outcome-dependent task replacement.
- Each task has the same 25-minute execution cap in the original harness.
  A timeout normally remains an outcome, with the saved partial patch graded
  separately. The host-sleep interruption below was excluded on independent
  environment evidence. Final token usage is unavailable when Codex emits no
  completed-turn usage.
- Thinker: repository revision `6faff5627539905d6b813d878d1aa8f5b24d383e`,
  frozen `posthog-v2` noteset (259 notes). MCP tools restricted to `orient` and
  `lookup`; learning and background verification disabled. Each session gets
  a fresh noteset copy. No selected evaluation PR appears in note provenance.
- CodeGraph: pinned npm release `1.6.1`. The complete initial graph is copied
  back before each session; its live watcher remains enabled during work.
  Direct MCP mode (`CODEGRAPH_NO_DAEMON=1`) avoids sharing daemon state.
- Separate Codex homes and project configurations expose only the assigned
  tool. Both use their supplied usage guidance. CodeGraph's shell alternative
  is removed from its guidance, and neither CLI is added to agent PATH.
  Both agents are told to use only the current checkout and their assigned MCP
  tool, and not to inspect other runs, sibling checkouts, or external notes.
- Identical original symptom-only prompts. Following those prompts, agents may
  add tests but may not install dependencies or run the application test suite.
- Gemini (`gemini-3.8-flash-high`) grades each patch on the existing calibrated
  behavioral criteria with up to 80 lines of surrounding code per hunk (full
  files when at most 300 lines). Treatment labels and author summaries are
  excluded from judge prompts. This is model grading, not executed acceptance
  testing. The judge has no access to the measured agent sessions.

Fable was the planned judge, but its CLI returned the account's weekly usage
limit before processing any tokens. No Fable grades were produced. The
Gemini judge was used consistently for the four completed patches; the original
criteria were not recalibrated for this judge.

The hypothesis is that CodeGraph reduces source discovery and relationship
tracing while Thinker's notes may help preserve cross-cutting requirements.
The recorded outcomes are essential-criteria coverage, strict pass, tool calls,
input/cached/output tokens, and wall time. Lower tool usage alone is not treated
as a correctness improvement.

## Setup and controls

CodeGraph's pristine index contains 927,722 nodes and 2,786,826 edges. Its
metadata accounts for 43,962 files; its CLI reports 43,951 indexed successfully.
The SQLite database is approximately 3.1 GiB. These are setup costs, excluded
from measured task wall time. Thinker's pre-existing notes likewise exclude
their historical construction cost, so this compares use of ready caches.
The index metadata records 15 size-limit warnings for files over 1 MiB,
including generated schemas, lockfiles and fixtures. Those defaults were kept;
agents could still read source directly. The full warning list is saved in
`index-statistics.json`.

An initial preflight in the outer tool sandbox caused CodeGraph's watcher to
report `EMFILE` and disable auto-sync. Raising the descriptor limit alone did
not fix it there. A second preflight outside that sandbox, with
`ulimit -n 65536`, returned 24,996 characters of source and relationships with
the watcher active. Both measured arms use that descriptor limit. Their
coding agents still use Codex's `workspace-write` sandbox. CodeGraph also uses
`CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS=0` to finish startup reconciliation before
answering. No measured task had started during these preflights.

Thinker project hooks were installed and their trust hashes registered. The
observed retrieval route must be taken from the per-session usage logs: MCP
calls lack a session field, whereas prompt/late hook serving records session
identifiers. Hook registration alone is not proof that hooks fired.

In all observed Thinker attempts, retrieval was through MCP; no prompt or
late-hook deliveries were recorded. Interpret this as observed MCP use, not a
measurement of Thinker's automatic hook delivery.

The first attempt at the metric-identifier CodeGraph task exposed no CodeGraph
MCP tool. The agent said so and completed a plain-search implementation. This
attempt was excluded before grading and retained under `excluded/`. Subsequent
sessions require their assigned MCP server to start successfully, and the
harness waits for any preceding direct graph writer to exit before replacing
the database. The exact cause of the missing tool was not established. This is
an infrastructure exclusion, not evidence about patch quality.

## Artifacts and reproduction

The saved experiment is stopped. Regenerating its summary reads local artifacts
only and makes no model calls:

```sh
node bench/codegraph-report.js
```

- [Harness](../../bench/codegraph-compare.js)
- [CodeGraph preflight](../../bench/codegraph-preflight.js)
- [Report generator](../../bench/codegraph-report.js)
- [Protocol, run records, patches, transcripts, and grades](../../bench/runs/posthog-thinker-vs-codegraph-3/)
- [Existing behavioral criteria](../../bench/tasks/posthog-hard.json)

Use an isolated Thinker worktree. Install CodeGraph under
`bench/worktrees/eval-support` with
`npm install --prefix bench/worktrees/eval-support --no-audit --no-fund @colbymchenry/codegraph@1.6.1`.
Create `bench/worktrees/posthog-thinker` and `posthog-codegraph` as detached
worktrees of the base-only PostHog clone at the pinned base above. Initialize
CodeGraph on its worktree and copy the closed `.codegraph/` directory to
`bench/worktrees/eval-support/codegraph-base`. Both databases must be closed
before copying. The harness restores that snapshot between tasks.

```sh
node bench/codegraph-compare.js prepare
ulimit -n 65536
node bench/codegraph-preflight.js
node bench/codegraph-compare.js run
node bench/codegraph-compare.js grade
node bench/codegraph-report.js
```

The run needs authenticated Codex and Gemini/Antigravity CLIs. Codex auth is referenced by
symlink inside the ignored support directory; no credentials are stored in
the result artifacts. `EVAL_AUTH` can name another existing auth file.
`EVAL_MODEL` changes the agent model and must be set identically for prepare
and run; this experiment uses the default shown above.

Input tokens include cached input in Codex's usage accounting. Fresh input is
`input_tokens - cached_input_tokens`; cached input must not be added twice.
Agent dollar cost is unavailable from this CLI output and is not estimated.
Tool calls count completed command executions, file changes, MCP calls, and
other tool items; agent messages and reasoning items are excluded. The report
also counts MCP response text characters, which are not resident-context tokens.

Repository verification: 120 tests passed. The first sandboxed test attempt
could not bind localhost; the successful rerun used the normal host environment.

## Results

Stopped at the user’s request. Two complete pairs are scored; the sandbox pair is
not included. Its interrupted Thinker attempt and user-cancelled CodeGraph patch
are retained under `excluded/` for audit. No replacement run or further judging
was performed after the stop request.

| Task | Tool | Essential criteria | Minutes | Calls | Input tokens (including cached) |
|---|---|---:|---:|---:|---:|
| Invite validation | Thinker | 6/6 | 11.47 | 134 | 5,975,790 |
| Invite validation | CodeGraph | 4/6 | 13.44 | 66 | 6,934,453 |
| Metric identifiers | Thinker | 6/7 | 5.30 | 50 | 2,271,597 |
| Metric identifiers | CodeGraph | 6/7 | 8.45 | 47 | 4,271,195 |

Across these two completed pairs, CodeGraph used 39% fewer tool calls,
but took 31% more wall time and consumed 36% more input tokens. Fresh input
was 302,480 for CodeGraph versus 201,819 for Thinker. Output tokens were
nearly equal (40,136 versus 40,159). Thinker met 12/13 essential criteria,
CodeGraph 10/13. These are selected-task pilot results, not evidence of
statistical superiority. There is no unassisted baseline, repetitions, or
executed acceptance-test validation. The observed Thinker treatment was MCP
retrieval, not automatic hooks. Dollar costs were unavailable.


### Invite-task trace review

Thinker received three notes: `onboarding-and-settings-invite-flows-share-invitelogic`,
`bulk-invite-partial-failure-semantics`, and
`invite-validation-errors-reach-ui-only-as-a-global-toast`. Their contents
explicitly identify the shared onboarding/settings validation rule, atomicity
problem in bulk invite creation, and global API-error handling in `initKea.ts`.
This is task-relevant prior knowledge, not merely a repository map.

Both patches addressed the bulk atomicity problem. The judge marked CodeGraph's
patch down for an inaccurate disabled-submit explanation for the user's own
email and for leaving expected existing-member errors in error tracking.
Source inspection confirmed the latter: the unchanged `shouldReportApiFailure`
reports a 400 `already_member` error and the global loader handler captures it.
Thinker's patch explicitly excludes that error. The notes overlap the observed
advantage, but this single trace does not establish that they caused it.

The optional invite criterion requiring a member-list fetch on form opening is
implementation-specific: both patches instead check individual emails. Both
lose that optional point. Essential scores are therefore more useful here than
the all-criteria score, and neither score substitutes for executed tests.

### Metric-task trace review

Both patches score 6/7 essential criteria and 7/8 overall. All collision-handling
code criteria passed, including links-only updates, primary and secondary
metrics, preservation of existing shared identifiers, and ordering maintenance.
Both updated agent guidance to remove an inline copy while attaching the shared
metric, but neither explicitly instructs omitting the copied UUID during shared
metric creation. The judge therefore rejected criterion c7 for both. This is
a documentation-specific miss; both new backend implementations independently
discard caller-supplied UUIDs. Do not describe these scores as evidence of a
remaining demonstrated collision bug.

### Host-sleep interruption and cancellation

The first Thinker sandbox attempt produced a patch meeting 5/5 essential criteria,
but the Mac entered clamshell sleep at 22:12:01 PDT, about five minutes into the
run, and did not fully wake until 22:47:24. The original 25-minute timeout fired
during this interval. The host power log independently establishes this
infrastructure interruption; it is not a valid latency or completion result.
The entire attempt, its partial-patch grade, and the power-log evidence are
preserved under `excluded/sandbox-thinker-host-sleep/`. A fresh replacement was
planned, but was never started because the user stopped the experiment. The
temporary idle-sleep assertion was released at cancellation.

Before discovering the sleep evidence, the timeout had provisionally been counted
as a measured outcome. That interpretation is withdrawn. Its missing usage event
also means the raw zero token counters are not valid usage measurements.

The interrupted attempt used Python 3.9 for a syntax check, which rejected an
existing `match` statement. An independent post-run AST check with Python 3.13
parsed its six changed Python files. This verifies syntax only, not behavior,
and has no bearing on inclusion in the benchmark.
