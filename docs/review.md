# Review and system behaviors

How `thinker review` checks a change against the cache, and how to write the behaviors it enforces. Back to the [README](../README.md).

## System behaviors and the local page

A system behavior is a rule every future change must keep, written by you and anchored
to the code that enforces it. `thinker review` flags a change that breaks one, and blocks
it when the behavior is **fixed**.

They start from the design documents checked into the repository: the READMEs beside the
code, and design, architecture and decision files. `thinker system docs` (the first step
of a cache build) reads each one and saves the rules it states as **mutable** behaviors,
each quoting the sentence it came from and pointing at the definitions that uphold it. A
rule is left out when the quote is not in the document or no definition near the document
enforces it. A document is read once per content, so a later run reads only new and
changed ones (`--dry` lists them without a model call). These behaviors are in force
without a further step; make one blocking, reword it or discard it in `thinker ui`.

The documents rarely say everything. The best way to write the rest is a conversation
with your own coding agent. `thinker system
define` (also offered at the end of `thinker setup`) prints a prompt and copies it to
your clipboard: paste it into your agent, and it reads the documents, goes through what
they state with you, then interviews you about each part of the
system, drafts each behavior against the code, and saves only the ones you approve.

```bash
thinker system docs     # behaviors from the READMEs and design documents checked in
thinker system define   # the interview prompt for your coding agent
thinker ui              # usage, the cache, and the behaviors: accept, edit or discard the ones waiting
```

`thinker ui` opens a local page with three views, each for one repository or all of
them: how the cache has been used (notes served, what agents acted on, what was learned,
the tokens it cost, and the holdout comparison), the notes in the cache (filter, search,
archive or restore), and the system behaviors, filtered by proposed, active, blocking,
warn only, or broken or unverified. Drafts from a build and behaviors an agent saved wait there until you
accept them as written, edit them, or discard them; until then review does not hold a
change to them. The page listens on 127.0.0.1 only and reads and writes nothing but
this machine's cache.

## Proof of correctness

Thinker can post a PR report connecting the requested behavior to executed test
results, code evidence, and the questions a reviewer still needs to resolve.
For example, a change that makes a running app's auto-pause react in two
seconds instead of five can show that `pauses within two seconds of a stop`
passed, while flagging that the filter it removed was the fix that stopped runs
pausing under bridges, where the GPS reports zero speed with no fix.

With a verification contract committed on the trusted base and acceptance
criteria linked to named tests in `task.json`, run:

```sh
thinker review --run --base origin/main --task task.json --pr 142 --post
```

This runs the required checks in Docker against a frozen snapshot, assesses the
code, and posts the report as a PR conversation comment through your `gh` login.
Run it from the PR's checkout; `--pr` selects the comment destination only.
The report distinguishes observed results from the model's reading of test
coverage, and identifies skipped tests, missing evidence, and changes that may
weaken verification. Full logs stay local.

A passing test establishes that its assertions passed on that snapshot; a human
still judges whether they cover the request. This is local execution evidence,
not a formal proof or signed CI attestation. Existing CI checks still apply.
See the [visual example](https://zerotime.dev/docs.html#proof-of-correctness)
and [setup and posting guide](task-verification.md#proof-of-correctness-on-a-pull-request).

## Review a change against the cache

For verification while an agent is implementing a task, use `thinker review
--start --base origin/main --task task.json`, then `thinker review --status
<run-id>`. It captures a snapshot, runs a trusted-base Docker contract, and
returns structured failures plus a human report showing task context, executed
checks, and changes that may weaken verification. See [task verification](task-verification.md)
for setup, MCP usage, and the limits of local evidence.

```bash
thinker review                      # the working tree against HEAD
thinker review --staged             # what is about to be committed
thinker review --base origin/main   # the branch since its merge base
thinker review --base origin/main --pr 123 --post  # comment using your gh login
thinker review --ref <commit>       # one commit, read from git alone
thinker review --state src/auth/    # no change: the current code against the notes on it
```

`--post --pr <number>` adds a new PR conversation comment using your authenticated
GitHub CLI (`gh auth login`), including findings, file locations, and desired
behaviors. It works on your own PRs and needs no bot or server. Each invocation
adds a comment, including when there are no findings. `--pr` alone only links the
review to usage history; it does not select or check out the PR, so run this from
the correct checkout and choose the review scope with `--base` or the other flags.
`--post --dry` is rejected. With `--json`, the result includes `comment.url`.

A review is for two things: a change that undoes a fix the team already made,
and a change that breaks a convention or a desired behavior the cache holds.
Measured on real PostHog history, it caught every regression of a fix the
cache held a note about, including the ones a plain reading of the diff
missed, and nothing in brand-new code beyond what the model finds unaided,
which on real new-code bugs was close to nothing. So it says up front when
most of the changed code carries no note: there it is only a model reading a
diff.

It makes two model calls and merges what they find: one sees the diff and the
code it touched, as any reviewer would; the other sees the notes resting on
the changed code and the notes that bear on it by the identifiers it writes
(a convention written against other files, say). Every finding carries a
file, a line, the evidence it rests on and the note it came from, when one
does; the same regression seen in the code, its test and its docs is one
finding with its other places listed:

```
thinker review: working tree against HEAD, 2 files; 3 notes consulted (2 on the changed code, 1 related), 3 assessed with sonnet (~60k tokens)

Findings: 1 error, 0 warnings, 0 info
  error    src/core.py:5  Command.invoke no longer calls validate(ctx); main dereferences ctx  [note validate-before-main, 90%]
           evidence: -        validate(ctx) | return self.main(ctx)
           also at: tests/test_core.py:12 (the test that covered the check was deleted)

Cache state:
  - 1 consulted note was already stale before this change (its claims were weighed accordingly): cli-and-core-change-together (src/cli.py:entry: symbol body changed)
  - re-check it: thinker verify cli-and-core-change-together
  - no cached knowledge rests on: src/new_module.py; the review is blind there
```

Desired behaviors are the exception. A `behavior` note is a rule a person
wrote down about what the system must do and where that is upheld (`thinker
system add`, or `thinker system promote <id>` for an invariant the cache
already holds); the code must conform to it, and a review never finds one
outdated. A `fixed` behavior is never revised and code that stops upholding it
is an error; a `mutable` one may be revised, but only by a change that edits
the note itself. Every behavior in play is listed in the report with its
outcome, and `thinker system` shows all of them with whether the code upholds
each (`thinker system md` writes them as `.thinker/SYSTEM.md`):

```
Desired behaviors (2 in play; thinker system lists them all):
  violated   [fixed] Every command validates its context before running (ctx-validated-before-main): fixed behavior ... is no longer upheld
  revised    [mutable] The CLI entry validates before invoking (entry-validates-too)  — the change edits the behavior note
```

Agents reach them through `lookup` with `kind: "behavior"`, which lists every
behavior (or the ones about a query) before a change is made.

The cache is treated as evidence, not truth. Before anything is assessed, each
consulted note is re-hashed against the code **before** the change: a note that
already disagreed with the code is reported as drift of the cache, the model is
told so, and a note the model finds wrong comes back as `note_outdated` instead
of a finding against the change. Two checks need no model and run even when no
provider is available or with `--dry`: a file that the git history says changes
along with a changed file and is missing from the change, and a definition the
change removes that the rest of the checkout still refers to. Nothing in the
cache is rewritten by a review; the change under review may never be merged.

Measured on planted and reverted bugs in two repositories ([bench/RESULTS.md](../bench/RESULTS.md),
"Review strategies"), this caught 15 of 16 bugs with no false positive on the
controls reached, in about 70k tokens and two minutes a review through
Claude Code's CLI. `--max n` caps the notes shown (default 12, the ones on the
changed code first), `--model` picks the model (`reviewModel` in
`.thinker/config.json`, default `sonnet`), `--chunks n` reviews a large change
in chunks of files, `--verify` re-checks every finding with a second call,
`--json` gives the report as data, and `--strict` exits 2 on an error-severity
finding, for CI.

Review is a mode you run, not a tool an agent calls: it makes several model
calls over the whole change, takes minutes, and its findings need a person. Ask
for it when you want it:

```
thinker review                      # the working tree against HEAD
thinker review --base origin/main   # everything on this branch
thinker review --staged             # what is about to be committed
thinker review --ref <commit>       # one commit, read from git alone
thinker review --state src/auth     # no change: today's code against the notes on it
thinker review --run                # the verification contract in Docker, then review a frozen snapshot
```

While you are *writing* the change, the cache reaches you another way and needs
no command: the prompt hook puts the notes resting on what you are working on
into each request, and the edit hook adds the rules resting on a file as you
edit it.

The notes a review draws on most are records of past fixes: what the symptom
was, where the root cause sat, what kind of change resolved it. `thinker
mine-prs` writes them from merged pull requests; a repository whose work lands
by direct commits has few of those, and `thinker mine-prs --git --fixes` mines
the commits whose message says they fix something instead.

`thinker setup --build` also drafts desired behaviors. After PR mining, a few
bounded model calls (four source notes each) turn up to twelve fresh PR or
document rule notes into candidate requirements. `thinker system propose
--refresh` runs this step alone: the retry when it failed during a build, with
no pull request mined again.
`thinker system propose` shows each draft's wording, source, code anchors and
reason; `thinker system accept <proposal-id>` makes a selected draft a mutable
behavior (`--fixed` is available for a deliberately permanent rule). Drafts
live in `.thinker/local/behavior-proposals.json` and do not affect serving or
review until accepted. This stage does not claim that a test establishes the
behavior; inspect the source and tests before acceptance.

Notes nobody was served in 30 days (and any kind named under `archive` in the
config) are archived
rather than served, and review still reads them: `thinker archive --list` shows them, `--restore` brings one
back, and `archive` in `.thinker/config.json` sets the rules or turns them
off.

## Optional review before committing

Enable staged code review for this checkout after running `thinker setup` with
an updated installation:

```sh
git config --local thinker.reviewBeforeCommit true
```

The pre-commit hook runs `thinker review --staged --strict` when enabled.
Error-level findings, fixed behavior violations, or failed assessments stop the commit;
warnings alone do not. Review uses your configured model and can add latency and token
usage to each commit. It checks the staged diff and refuses to proceed if the index
changes during review. `THINKER_NO_LEARN=1` skips note repair but does not skip an
enabled review. Disable the review with `git config --local thinker.reviewBeforeCommit false`.
This is opt-in and does not require pull requests or a GitHub App.

