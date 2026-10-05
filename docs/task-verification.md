# Review during a task

`thinker review --start` captures an immutable candidate, executes the repository's
required checks in Docker, and reviews the code against a frozen copy of the
notes and the task's context. The agent can continue working and retrieve the
result later. Humans get the same evidence in a Markdown report.

```sh
thinker review --start --base origin/main --task /tmp/task.json --json
thinker review --status <run-id>
thinker review --status <run-id> --json
thinker review --run --base origin/main --task /tmp/task.json --strict
```

`--run` waits for completion. `--start` returns a run id immediately. `--status`
returns completed checks even while other checks or the code assessment are
running. `--previous <run-id>` carries task context forward unless replaced and
compares the earlier failures with the new run. Normal `review` remains a code
assessment without test execution; it also reports gate-integrity signals.
Native Node test failures are persisted while the suite is still running, so an
agent can inspect and start addressing them before the complete check finishes.

MCP clients use the existing `review` tool:

```json
{
  "action": "start",
  "base": "origin/main",
  "task": {
    "request": "Change retry limits while preserving timeout handling",
    "criteria": [
      {"text": "Timeouts are still rejected", "source": "user", "checks": ["unit"]}
    ],
    "intendedChanges": ["Increase the retry limit"],
    "rationale": "Keep timeout handling on the existing path",
    "questions": ["Does the replacement test cover timeout exhaustion?"]
  }
}
```

Then call `review` with `{"action":"status","runId":"<id>"}`. The response
contains both human text and `structuredContent`. An ordinary assessment accepts
the same `task` object. The reviewer sees the task context and is instructed to
challenge unsupported assumptions; task claims cannot override fixed behaviors
or establish that a check executed. Source labels are caller attribution, not
authenticated user approval.

## The execution contract

Commit `.thinker/verification.json` on the trusted base before using required
verification. A candidate cannot replace the commands used to evaluate itself.
The contract is read from `--base` (HEAD when omitted), while review covers the
change since its merge base. Use an explicit base for branch work.

```json
{
  "version": 1,
  "image": "your-registry/verification@sha256:<64-character-image-digest>",
  "platform": "linux/amd64",
  "network": "bridge",
  "setup": "npm ci",
  "checks": [
    {
      "id": "unit",
      "command": "node --test --test-reporter=/thinker/reporter.mjs test/*.test.js",
      "reporter": "node",
      "timeoutSeconds": 600
    },
    {
      "id": "lint",
      "command": "npm run lint",
      "reporter": "exit-code",
      "timeoutSeconds": 120
    }
  ]
}
```

Replace the example image with an actual pinned digest. The image must contain
`/bin/sh`, `cp`, and all system tools required by setup and the checks. No image
build happens implicitly. `platform` defaults to `linux/amd64`; `network` defaults
to `none`. Use `bridge` only when setup/checks need network access. Each check
starts in a fresh container and repeats setup. All checks are required. Setup
failure, a missing Docker daemon, a timeout, or a missing/empty Node report is
incomplete. Exit 125 is reserved for setup/runner failure.

The runner mounts the candidate and its own Node reporter read-only. A writable
copy is made in `/workspace`; `/tmp` and `/root` are temporary. No host credentials,
agent configuration, or Docker socket are forwarded. CPU, memory, process, and
output limits apply. Checks always receive `THINKER_TEST=1`,
`THINKER_TELEMETRY=off`, and `CI=1`. Code assessment runs outside that container
through the configured model provider. Docker is required only for execution,
not ordinary review.

Optional `resources` sets `memoryMiB`, `workspaceMiB`, `tempMiB`, and `homeMiB`
(defaults: 2048, 2048, 512, 256; each 64–65536 MiB). Large install/archive tests
may need more temporary space. These limits are part of the base contract and its
identity, not a per-run override that silently changes the environment.

## Reading the evidence

Each run is stored under `.thinker/local/reviews/<run-id>/`:

- `run.json`: task, input identities, status, check results, failures, assessment,
  and gate-integrity observations.
- `report.md`: the human report, updated as checks complete.
- `<check-id>.log`: bounded full output, referenced by each failure.
- `inputs.json`: frozen notes and configuration used by the assessment.

Status is `queued`, `running`, `passed`, `failed`, `incomplete`, or `needs-review`.
`--status` separately compares the current worktree/index to the captured tree;
changed code is `superseded`. A commit-scoped run stays attached to its commit.
Moving the target reference or changing review knowledge, configuration, or the
verification engine also supersedes current evidence.
`--strict` exits 0 only for a completed passing run whose snapshot is current;
failed/needs-review exits 2, other unfinished or outdated evidence exits 1.
`--dry` skips model and check execution and therefore cannot yield a complete pass.

The report shows task criteria with their attributed source and linked checks,
actual execution, gate changes, code findings, open questions, and limitations.
Linked checks are supplied by the caller. A pass is evidence for an assessment,
not proof that an acceptance criterion is satisfied. There is no automatic task
completion verdict.

Node failures include the test name, location, expected/actual values when
available, and stack trace. The rerun command is the exact check command, not a
claimed minimal reproduction. Flake classification is `unknown`; suspected cause
is unset until evidence exists. Exit-code checks retain output but do not invent
individual test results. Reported skips/todos make the run need review.

An earlier test failure becomes `resolved` only when that same named test/file
is observed passing in a successful rerun. Removed, skipped, unobserved, or
renamed tests remain `not-rerun`. Other failures remain explicitly unconfirmed
until equivalent evidence is available.
If a passing rerun also changed the command or triggered a coverage-integrity
signal for that test/configuration, it is `coverage-changed`, requiring review.

## Gate integrity

Ordinary review and verification report added skips/only markers, common lint
suppressions, permissive failure handling, workflow filters/conditions, changed
verification configuration, removed test files, and removed/rewritten assertions.
The PR review renderer also displays these signals, even with no code findings.
Mechanical observations are distinguished from changes that need assessment of
replacement coverage. These signals require human review; they do not claim that
all weakened gates can be detected or that every test rewrite is wrong.

## Scope of this release

This is the first task-verification release. Results are local runner evidence,
not signed CI attestations. They bind a branch snapshot, target/base, image and
platform, contract, frozen notes, requested model, and engine content. The existing
GitHub gate does not yet accept these runs as substitutes for its own checks.

Ignored files are excluded; relevant new files are included. The user's index is
not changed. Blob materialization avoids checkout filters; submodules are
reported as unsupported rather than silently omitted. Run records remain after
temporary execution worktrees are removed. Local evidence can be modified by a
user with filesystem access, and native test output is not a cryptographic proof
against malicious candidate code.
Snapshot commits are retained under local `refs/thinker/reviews/<run-id>` so Git
garbage collection cannot erase the code behind a saved report. They are not
pushed by ordinary branch pushes.

Follow-up work is trusted remote receipts and CI consumption, synthetic merge
candidates, shared dependency caches, service/fixture orchestration, additional
native reporters, historical flake classification, equivalent-coverage analysis,
validated minimal repros, and dependency-supported selective reruns. Until those
are implemented, no claim is made that passing here guarantees the existing CI
workflow will pass.
