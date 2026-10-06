# thinker: internals and working context

Reference for agents and contributors working on this repository. The
user-facing summary is in `README.md`; benchmark results are in
`bench/RESULTS.md`.

```
agent session ──► distill ──► .thinker/local/notes/*.json ──► orient / lookup (MCP)
                                   │
                          deps + content hashes
                                   │
             commit / edit ──► stale ──► verify (small model) ──► fresh | updated | retired
```

## Working on this repository

**Pull requests in this repository (MANDATORY RULE):**
We use PRs here to exercise our own CI review against system behaviors. This is
a contributor workflow for thinker itself, not a product requirement. Teams using
Thinker may land direct commits or use any Git workflow; setup must not install
our repository policy guard or require PRs in their repositories.
- Push task branches and open a GitHub pull request targeting `main`. Never push
  commits directly to remote `main`, including fast-forward pushes.
- Run the test suite with telemetry disabled, wait for the PR's tests, and merge
  through GitHub. Bring local `main` up to date from the merged remote branch.
- Do not bypass a pre-push guard or disable hooks to push `main`.
- GitHub server-side enforcement for this private repository requires GitHub Pro
  (the API currently returns 403 on the account's plan). Until enabled, the local
  guard and this policy enforce the workflow on this checkout, not on every client.


Requires Node 20+. Tests: `npm test` (`node --test test/*.test.js`).

**No telemetry from tests or benchmarks (MANDATORY RULE):**
Always set `THINKER_TEST=1` when running tests, benchmarks, evaluation
harnesses, scratch experiments, or their setup/install steps (`npm test` sets it).
This single mode blocks production telemetry and automatic background work, keeps
default usage logs local, and silences machine-wide hooks. `THINKER_TELEMETRY=off`
remains a valid additional telemetry-only control. Ensure every child
process inherits it. Never send these runs to the production telemetry endpoint
or count them as real usage. Telemetry-specific tests may use mocked requests or
an isolated loopback server only; they must never contact production.

**Matched models in comparisons (MANDATORY RULE):**
Compare arms only with the same exact model and reasoning effort for each
corresponding phase (exploration, memory building, coding and any judging). Keep
agent configuration fixed except for the declared intervention being compared.
Record them before running, disable silent provider/model fallback, and report a
model mismatch as an invalid comparison. Prefer executable tests for correctness;
keep correctness, tokens and latency separate. Results from different models or
reasoning settings belong in separate cohorts, not one ranking.

**Agent concurrency and worktrees (MANDATORY RULE):**
All agents working on this repository MUST perform code changes, scratch experiments, and benchmark runs in isolated git worktrees to avoid collisions with other active agents or running benchmark jobs. Never edit directly in the primary working tree.
- **Create a worktree:** `git worktree add -b agent/<task-name> .worktrees/<task-name> HEAD` (or in `bench/worktrees/`; both are gitignored).
- **Work strictly within the worktree.**
- **Destroy on completion:** Once changes are committed/pushed/merged, or if the task is aborted or cancelled, always remove the worktree:
  ```bash
  git worktree remove --force <path-to-worktree>
  git branch -D agent/<task-name> # if no longer needed
  ```

Model calls go through the Anthropic SDK when `ANTHROPIC_API_KEY` is set,
otherwise through the first installed agent CLI (`claude`, `codex`, `gemini`,
`agent`), so no extra credentials are needed. `claude -p` is run with its
system prompt replaced (`--system-prompt`, `--setting-sources ''`,
`--disable-slash-commands`; `llm.js:viaCliOnce`): appended to, Claude Code's
own prompt added ~7k tokens to every call, written to the one-hour prompt
cache at twice the input price and never read again.

| path | contents |
|---|---|
| `src/cli.js` | the `thinker` command: argument parsing, the help text, the prelude every command shares (update notice, background update and telemetry, the not-set-up check, the parser), and a table of handlers |
| `src/commands/` | one module per group of commands, each handler taking the dispatcher's context (`store`, `repo`, `flags`, `pos`, `out`, …): `notes.js` (orient, lookup, find, drilldown, system, list, show, add, rm, archive, phrase, rehash, relink), `cache.js` (review, export, import, serve, health, stats, usage), `learn.js` (learn, maintain, distill, record, outcome, verify, check, seed, mine-prs, and the exploration and PR-mining helpers), `hooks.js` (the hook entrypoints and the background catch-up they start), `setup.js` (setup, uninstall, ast, update/upgrade/switch/branch), `telemetry.js`, `benchmark.js`, `shared.js` (helpers several of them need) |
| `src/mcp.js` | MCP server exposing `orient`, `lookup`, `find`, `drilldown`, `remember`, `feedback` |
| `src/setup.js`, `src/setup/` | the guided `setup` flow (`runSetup`), with its parts under `src/setup/`: `ui.js` (colors, boxes, the arrow-key menu), `agents.js` (which agent CLIs are installed and logged in, and the menu that picks one), `estimate.js` (what a cache build will cost), `steps.js` (wiring the clients, building the cache), `pr-benchmark.js` (the optional PR change benchmark); everything is re-exported from `setup.js` |
| `src/clients.js` | adapters for Claude Code, Codex, Gemini CLI, Cursor, Pi, Windsurf Cascade, Copilot CLI and OpenCode: config files and hook formats; native extension handlers in `src/integrations/`; coverage in `docs/agent-integrations.md` |
| `src/transcripts.js` | session transcripts of every agent as one event form; the hook-recorded trace; finding sessions |
| `src/prs.js` | mining merged pull requests into notes |
| `src/ops.js` | core operations on notes (serve, merge, assess, link) |
| `src/deps.js` | dependency extraction and symbol-level content hashing |
| `src/ast.js` | symbol boundaries by tree-sitter (Python, JS/TS, Go, Rust) when its grammars are installed (`thinker ast install`); `deps.js` falls back to regex heuristics |
| `src/codegraph.js` | one hop of the call graph: references and blast radius of a symbol (`fanout`), callers, callees, definitions, outlines, and `findSymbols` (the definitions carrying the words of a query); behind `find`, `drilldown` and the `[n call sites in m files]` tags on pointers. From the code graph when the checkout is indexed, else from `git grep` |
| `src/rank.js` | BM25 ranking, relevance gate, budget packing |
| `src/distill.js` | transcript → notes and per-note assessments |
| `src/maintain.js` | background maintenance: re-verify stale notes, phrase new ones, distill newly merged PRs, under a daily cap |
| `src/guard.js` | anchoring guard: names identifiers in the request that the served notes do not cover |
| `src/update.js` | CLI self-update and daily automatic background updates (LaunchAgent / cron / invocation) |
| `src/usage.js` | summary of the usage log and the estimate of saved calls and tokens, in tokens (never dollars) |
| `src/store.js`, `src/llm.js` | note storage; model access through any installed agent |
| `src/server/` | `thinker-server`, the team's central cache: HTTP API (`index.js`), per-repository stores with a change journal and a clone of the repository (`repos.js`), tokens (`auth.js`), the worker that reviews the pull requests CI asks about (`worker.js`); the server learns nothing itself |
| `action/` | GitHub Actions: `action.yml` sends a merged pull request to the server; `review/` has the server check a pull request against the desired behaviors and post the review (`src/review-post.js` renders and posts) |
| `infra/sync/` | the server on EC2: CloudFormation stack, bootstrap script, deploy script |
| `src/review.js` | `thinker review`, a mode of the command line (there is no MCP tool; see "Reviewing a change"): a change (or the current code) against the notes resting on it and bearing on it, with the cache's own staleness reported rather than trusted; removed symbols still referenced |
| `test/` | unit tests (`node --test`) |
| `bench/` | benchmark harness, task sets, PR data, and `RESULTS.md` |
| `bench/retrieval.js` | what is served for each task's request and how much of it rests on a changed file; no agent runs, seconds per task set |
| `bench/jev-eval/` | the Jev serving measurement: `hook-jev-arm.mjs` scores the labelled ranking tasks; `catalog-eval.mjs` tests full-corpus description search and note reconciliation (see `research/jev-note-catalog/`); the facet experiments were rejected (`bench/RESULTS.md`, "Serving: Jev") |
| `.thinker/` | thinker's own notes about this repo |

`bench/repos/` (clones of click, mitmproxy, PostHog) and `bench/runs/` (raw
run output) are not checked in. To run the benchmark, clone the target repo
into `bench/repos/<name>` first.

## What `setup` does

The installer (`install.sh`) installs the tool wherever it is run and wires
it into the agents on this machine (`thinker connect`, below). Inside a git
repository it also sets that repository up; anywhere else it says to run
`thinker setup` inside a repository. `setup` is the only command that sets a
repository up: `thinker init` was removed and says so. A repository where
`setup` has not run has no `.thinker/`, and the cache is not used there: the
CLI's cache commands stop with that message (`cli.js:CACHE_COMMANDS`), the MCP
server offers no tools and says so in its instructions, and the hooks are
quiet. Only the commands that build a cache (`setup`, `seed`, `mine-prs`,
`import`, `add`, `record`, `distill`) create one. That rule is what makes the
machine-wide wiring safe: the hooks and the MCP server are present in every
checkout and act only in one that is set up.

The wiring lives in the agents' own settings, once per machine, since
2026-10-04 (`clients.js:wiringFiles`, scope `user`): `~/.claude/settings.json`
and `~/.claude.json`, `~/.codex/hooks.json` and `~/.codex/config.toml`,
`~/.gemini/settings.json`, `~/.cursor/hooks.json` and `~/.cursor/mcp.json`.
`thinker connect [--clients …]` writes it and needs no repository; `setup`
runs it as its first step, and so does the installer. A hook there names no
`--repo` and reads the checkout from the agent's input (`cwd`, Cursor's
`workspace_roots`; `commands/hooks.js`); the MCP entry pins no `THINKER_REPO`
and the server takes the repository from the directory the client starts it
in, asking a client that declares MCP roots for its workspace when that
directory is not a repository (`mcp.js`). Before that, `setup` wrote the
hooks and the MCP entry into each checkout's own files, which the Codex
desktop app does not read (openai/codex#13025: it loads MCP servers from the
user's `config.toml` alone), and a fresh worktree had none of them. The
checkout's machine-local wiring of this copy is taken out by `setup` and by
the first hook at user scope that runs there (`clients.js:stripRepoWiring`),
named once at the end of the turn; committed wiring (`--shared`, `.mcp.json`)
stays, and a hook at user scope yields to a checkout whose own files run this
copy's hooks (`clients.js:repoWiredByCopy`), so nothing fires twice.
`thinker uninstall --user` removes the machine-wide wiring; the installer's
`--uninstall` does that outside a repository. A machine set up before this
needs no step: the `rewire` that `thinker update` runs wires the user's
settings for every agent the known checkouts wire to this copy, with the
options they were set up with (`clients.js:connectFromCheckouts`).

`thinker setup` connects the agents (above), adds the repository's own pieces
(git hooks, Cursor's always-applied rule, Codex's trust in the project,
`.thinker/`), and then asks whether to build
the cache from the code and the merged pull requests, since that is the only
step that spends anything (`setup.js:confirmCacheBuild`). The question defaults
to no; `--build` answers yes without asking (so does `--yes`, or naming
`--areas`/`--prs`/`--pr`), `--no-build` answers no and leaves a repository that
is set up and learns from sessions. Outside a terminal the answer is no.
Declining, or having no authenticated agent, no longer stops setup: step 1 has
already run and the footer says how to build later.

The build itself (`thinker setup --build`, or the installer with `--build`):

1. distills up to 60 merged pull requests of the GitHub `origin` into fix
   records, invariants and conventions (`--prs n`; needs `gh`);
2. runs one exploration session per source area and distills it (`--areas n`,
   default 12);
3. links the notes; the agents (`--clients claude,codex,cursor,gemini`, `all`,
   or `auto`, the default) were connected in step 1.

Steps 1 and 2 run through an installed agent with its own login (`--agent`
picks one). Measured on this machine's log: about 400k tokens per area (the
exploration and its distillation, most of them cached prompt reads) and 14k per
pull request, so roughly 5.5M tokens and twenty minutes with the defaults
(`setup/estimate.js:TOKENS_PER_AREA`, `TOKENS_PER_PR`). The estimate is printed
in tokens and minutes before anything runs, never in dollars: decided 2026-10-04,
since most agents run on subscriptions and a figure from API list prices told
people they would spend money they would not. In a terminal `setup`
asks before spending (`--yes` skips the question). The hooks and MCP entry live in the agents' own settings. Team wiring with
`--shared` is no longer supported.

To mine more pull requests later, run `thinker mine-prs` (or `thinker learn
--prs`, which distills new sessions first). With no arguments it takes the
GitHub `origin`, mines what was merged since the last run and then goes
further back in history, 20 at a time (`--limit n`). Without GitHub, or
with `--git`, it mines commits from git history; `--fixes` keeps only those
whose message says they fix something (`prs.js:FIX_LIKE`), the records
review draws on most; a repository whose work lands by direct commits has
few pull requests, and this one had 8 to mine against 17 fix commits. Every
pull request it
has looked at is recorded in `.thinker/prs.json`, which is committed with the
notes, so none is distilled twice, by you or by a teammate. Pull requests merged
after thinker was set up are distilled by background maintenance (see [The
learning loop](#the-learning-loop)); `mine-prs` is for history before that.

## Project cache builds

`thinker.project.json` at the repository root stores `{version: 1, name,
directories: [repo-relative paths]}`. `src/project.js` validates paths and reads
it for cache-building commands only. `thinker project init <dirs...> --name ...`
creates it without initializing a cache. Interactive setup (`src/setup/project.js`)
offers Full repo or Specify project directories before the usage estimate; `--yes`
reuses the file. `--project file` chooses another file; `--full-repo` overrides it
for one run. Choosing Full repo in the menu updates an existing default file to
`directories: ["."]`.

`discoverAreas` uses literal git pathspecs before clustering, and cannot widen a
selected deep directory into its parent. Setup passes the same directories to
estimates, exploration and PR mining. Scoped PR scans keep a directory-keyed
cursor; only successfully processed changes enter the global mined record, so
unrelated PRs remain available to other builds. Git history uses directory
pathspecs; GitHub uses the listed changed paths with bounded scans. All projects
share the repository's notes. Retrieval, review and automatic maintenance do not
load the project file; existing dependency paths provide retrieval relevance.

## Usage history

Every serving, assessment, distillation, verification and mining run is
appended to one file for the machine, `~/.thinker/log.jsonl` (under
`THINKER_HOME`). Each line names its repository by the origin in
`.git/config` (`github.com/owner/repo`), so worktrees and further clones of
a repository count as that repository; a checkout without an origin is
named by its path. `THINKER_LOG` changes
that: a path, `local` (the repository's own `.thinker/log.jsonl`) or `off`.
Runs with `THINKER_NOTES_DIR` set, which is how benchmark arms serve a
noteset, log locally by default, so experiments stay out of the machine's
history; a harness that installs real hooks should set `THINKER_LOG=local`.
The log holds the first 200 characters of each request.

`thinker usage [--here] [--days n] [--json]` summarizes it for every
repository on the machine, with a line per repository (`--here`: this
repository only). A repository's older local log is moved into the machine's
log the first time thinker runs there, and kept as
`.thinker/state/log-before-shared.jsonl`. The summary covers notes served and how, what the
sessions did with them, what was learned and what it cost, and an estimate of
the tool calls and tokens saved. The estimate counts only servings a session
was seen to act on (`confirmed`), as one read per file the note rests on (at
most 5) at the file's size (at most 6,000 tokens). It is not a measurement;
measured effects are in `bench/RESULTS.md`.

A dep that is not code a session would have read counts as nothing
(`usage.js:countsAsReading`): the agents' own configuration (`.claude/`,
`.codex/`, `.cursor/`, `.gemini/`, `.mcp.json`), git's internals, `.thinker/`
itself, and build or run output. Every note must rest on an existing file
(`ops.js:createNote`), so a note about the permission classifier or about
duplicate hooks rests on `.claude/settings.local.json` for want of anywhere
better; what it saves is a wrong action, not a read, and crediting it with the
size of that file made the turn notice claim reading nobody would have done.
Such notes keep their anchors and are ranked and served exactly as before —
only the estimate ignores them, and `cacheHitSavings` reports how many deps it
passed over as `uncounted`. The floor that gives a note whose files are missing
one read's worth is not applied when every dep was passed over this way, and
the turn notice then names the notes and stops rather than printing `~0 tokens
of code`. On this repository 29 of 754 deps stopped counting. The limit is that
nothing distinguishes a note *about* a file from a note about the behaviour
around it: a gotcha resting on a real 525-token script still counts as that
script's size.

Build and run output is refused as an anchor outright
(`deps.js:TRANSIENT`: `node_modules/`, `dist/`, `coverage/`, `.next/`,
`__pycache__/`, `bench/runs/`, `.thinker/`, `*.log`, `*.tmp`), since the next
run rewrites or removes it. One served note here rested on nothing but a
223-byte benchmark log that git ignores. The check is at creation only, so
notes already stored keep their deps — but `deps.js:checkNote` refuses to call
such a dep stale, re-hashing it in place instead: the next run rewrites the
file, so a changed hash says nothing about whether the claim still holds. The
two notes explaining that `.thinker/` files rewrite themselves were both
permanently stale, from `.thinker/` files rewriting themselves, and took a
verify slot each time. Agent configuration is a valid anchor and is not
covered: a note about what is in `.claude/settings.json` still goes stale when
that file changes; a note left with no other anchor is
refused with `no resolvable dependencies`. Agent configuration is deliberately
not refused — those notes are worth keeping.

Model work is also logged as `op: "model"`, with `purpose`, `phase` (init / learning /
maintenance), provider, resolved model, raw usage, normalized token counters and
reported cost. Input totals include provider cache reads and writes; these are separate
from thinker's own estimated savings. Operation summaries marked `metered` are not
charged again. `usage --json` exposes `spending` by phase, purpose, model and repository,
plus `saved.netAfterSpend` (estimated reading avoided minus notes injected minus reported
model tokens). Missing counters/costs stay unknown. Legacy logs lack setup exploration
and token counts, so this comparison is partial, not measured financial ROI. See
`src/model-usage.js` for provider normalization.

Nothing is given in dollars (decided 2026-10-04; `prices.js` and the dollar balance
went with it): the agents run on subscriptions as often as on metered keys, and a
figure from API list prices told most people what they would not pay. A cost the
provider itself reported stays in the log and in `usage --json` as data
(`spending.reportedCost`, `unknownCostCalls`), never estimated from tokens and never
shown. The end-of-session assessment still records the model the session ran on, read
from its transcript (`transcripts.js:parseTranscript` returns `model`: Claude Code's
`message.model`, Codex's `turn_context`, Gemini's message `model`; Cursor names none),
on the `attest` line; for assessments written before that, `usage` finds the transcript
by session id (`transcripts.js:sessionModel`); the saving is reported by model
(`saved.byModel`, `unknown` for sessions that named none). Every model answer carries
its normalized counters (`llm.js:executeProvider` adds `tokens`; `model-usage.js:tokensOf`),
which is what the commands print after a run (`~24k tokens`).

## What a note is

A note answers a recurring question, not "what this file does":

| kind       | answers                                                                 |
|------------|-------------------------------------------------------------------------|
| `map`      | where a recurring concern is handled, how control or data flows across files, the shape of a module area |
| `howto`    | how to build / test / run / lint, with the non-obvious flags            |
| `rule`     | what a change must respect: an invariant, a convention, a trap, a fix not to undo, a reason, what changes together and through which mechanism |
| `behavior` | a desired behavior of the system a person wrote; the code must uphold it (see [Desired behaviors](#desired-behaviors)) |

Until October 2026 there were eleven kinds (`location`, `callpath`, `overview`,
`invariant`, `convention`, `gotcha`, `rationale`, `fix`, `cochange`, `howto`,
`behavior`): nobody applied them consistently, the distiller included, and the
serving code had a branch for several. The old names are read as the new ones
wherever a note is read (`store.js:KIND_ALIAS`, `kindOf`), so committed notes,
benchmark notesets and a config written with them keep working; a file is
rewritten with the new kind when the note is next written. The measurements
quoted below with the old names are about those subkinds.

Each note stores: `title`, `answers` (question phrasings, for retrieval),
`body` (3–12 lines with `file:Symbol` pointers), `deps` (files/symbols it
rests on, each with a content hash), `source` (agent / human / pr / doc),
`verified`, `verifiedCommit`, `confidence`, `status` (fresh / stale / invalid).

## Dependency-keyed invalidation

- A dep is `{path, symbol?}`. With a symbol, thinker hashes just that
  definition's block; without, the whole file. A note about
  `Command.invoke` does not go stale because an unrelated function in the
  same file changed.
- The block is found by tree-sitter when its grammars are installed
  (`ast.js`; Python, JavaScript, TypeScript, Go, Rust) and otherwise by a
  language-agnostic definition regex with brace or indentation matching
  (`deps.js:findSymbol`). The regex is thrown off by braces in strings and
  regex literals and by `return foo(` lines; on this repository's own notes
  the two disagreed on 5% of symbol deps, the regex wrong each time. The
  parser is not a dependency (55 MB of wasm): `thinker ast install` puts
  `web-tree-sitter` and `tree-sitter-wasms` under `~/.thinker/ast`
  (`THINKER_AST_DIR` names another place; `thinker ast` shows which is in
  use; `THINKER_AST=off` disables it). A dep hashed by the parser carries
  `engine: "ast"` and, beside its hash, the regex hash of the same symbol
  (`hashRegex`). So the two kinds of checkout agree (`deps.js:checkNote`):
  where the parser arrives, a dep the regex hashed is not stale if the regex
  block is unchanged, and the parser's record replaces it (`upgraded`);
  where there is no parser, a dep a teammate's parser hashed is not stale if
  its `hashRegex` still matches, and the record is kept as it is. Installing
  the parser, or lacking it, marks no note stale.
- Pointers written in the body (`core.py:Command.main`, `Foo.bar`,
  `types.convert_type`) are extracted automatically and added as deps, so
  the tracked set matches what the note actually claims.
- Every `orient`/`lookup` re-hashes the deps of every note against the
  working tree, so uncommitted edits are caught too. A whole-file dep on a
  file the note also points into by symbol is dropped when the note is
  created or verified (`ops.js:dropShadowedFileDeps`). A whole-file dep on
  a code file whose definitions the body names becomes those symbol deps
  when the note is created (`deps.js:narrowAtCreation`; configs, scripts
  and documents stay whole), and the distiller is told to name the
  definition for a code file. Maintenance and `thinker check` judge a
  changed whole-file dep further (`deps.js:narrowFileDep`, `checkNote` with
  `narrow`): when the body names definitions in the file, the dep becomes
  those symbol deps, the note is stale only on the ones that changed since
  `verifiedCommit` (each carrying its hash from that commit, so the change
  stays visible), and the narrowed deps are persisted whether the note is
  fresh or stale, so the next check and the verification see symbols, not
  the file; when it names none and no changed line of the diff since
  `verifiedCommit` holds a term the note uses, the dep keeps the file and
  takes the new hash. `checkNote` returns deps that are safe to store in
  either case: a dep the change altered keeps its stored record. On this
  repository (two hundred commits a week) 74 of 137 stale notes rested on
  nothing but whole-file deps on hub files (`src/cli.js` in 48), and
  neither the term rule nor a line-anchored variant could clear them, since
  a week of diff to a hub file holds every word; anchoring to definitions
  is what helps, and it helps the next time, not retroactively.
  Stale notes are ranked lower and served with a `⚠ STALE` banner listing
  exactly which deps changed and how (symbol body changed / file removed /
  symbol not found).
- The `verify` log record names the deps that triggered it (`changed`).
- `thinker check` persists statuses; `thinker verify` sends each stale note, the git diff of
  its changed deps since `verifiedCommit`, and the current text of every dep
  to a small model (Haiku by default) which answers `still_valid` (re-hash,
  bump confidence), `update` (rewrite body, keep history) or `invalid`
  (retire). The answer is the verdict and one sentence, a body only for
  `update`, capped at 1,500 tokens (`ops.js:VERIFY_SCHEMA`,
  `VERIFY_MAX_TOKENS`): a week of verify calls here averaged 2,900 output
  tokens for verdicts that were 64% `still_valid`. A rewritten body that
  starts with the framing the model was shown (`NOTE (kind=…) "title"`, or
  the title) loses that line (`ops.js:cleanBody`).

## Capture

1. **Automatic**: `thinker distill <transcript.jsonl>` condenses a session
   (prompts, tool calls with truncated results, the agent's final answer)
   and asks a model for 0–3 notes with deps (`distill.js:MAX_NOTES`; the
   prompt expects 0 or 1, and rules out news of what changed, the state of
   one machine, and what the repository's own docs say). The hooks run this
   in the background once per session (on by default; see below). The
   distiller is shown the notes already resting on the files the session
   touched, and up to four on the topic of its requests by BM25
   (`distill.js:relatedNotes`), and may return one with `extends: <id>` and
   the merged body instead of a new note. Near-duplicate notes (same kind,
   ≥0.5 Jaccard on title+answers) are merged, keeping history. The distiller
   is told that a rule about things changing together must name the
   mechanism (a generator, registry, schema, mirror or test), not list the
   files one session touched, since git history holds that already.
2. **Agent-authored**: the `remember` MCP tool, for agents that finish
   working something out.
3. **Human**: `thinker add note.json`.

## The learning loop

Each session both consumes and improves the cache:

1. `UserPromptSubmit` hook injects the orientation bundle and records which
   note ids were served in this session.
2. Once per session, the distiller sees the trace **and the injected notes**, and
   returns new notes plus one assessment per injected note:
   `confirmed` (the agent acted on the pointer, nothing contradicted it:
   confidence +0.05), `contradicted` (the trace shows a claim is wrong:
   confidence −0.25, body replaced by the correction, history kept, retired
   below 0.3) or `unused` (after five unconfirmed servings, confidence decays
   towards 0.4). No judge or gold answer is involved; the signal comes from
   the transcript.
3. New notes are linked to existing ones that share a symbol-level dep (or
   several files); `orient` pulls one linked note in beside the best hit
   when it has relevance of its own.
4. Co-change is gone (2026-10-04). Co-change notes were acted on 0 of 5
   times they were served and were archived; the git-mined index that
   replaced them (edit-hook partner hints, the end-of-session nudge, the
   review hint, `thinker cochange`, the refresh in maintenance,
   `.thinker/cochange.json`) was never shown to be followed either, and was
   removed with the module. An older cache's `cochange.json` is ignored, and
   its `cochange` notes are read as rules (`store.js:KIND_ALIAS`).

5. Archiving (`ops.js:archiveNotes`, `thinker archive`): a note that the
   sessions showed is not worth serving leaves orientation, the edit hook,
   background verification and phrasing, and stays for `thinker review`,
   `drilldown`, `find` and `lookup` by id; `rank.js` scores it like an
   invalid note. Two rules, both free: the kinds named in the config (none
   by default since the collapse to four kinds; before it, location, fix,
   cochange and convention, which in a week on this repository were acted on
   0 of 6, 0 of 12, 0 of 5 and 0 of 3 times when served), and a note nobody
   was served in 30 days since it was made. `archived: {at, reason}` is this checkout's
   state (`store.js:LOCAL_FIELDS`), never shared or pushed; a shared note's
   committed file is untouched. Maintenance applies the rules on every run
   and names the count once; `archive` in `.thinker/config.json` sets
   `kinds` and `unservedDays` or is `false`. `thinker archive [--dry]`
   runs the rules by hand, `--list` shows the archive, `--restore [ids]`
   takes notes back, and ids archive any note by request.
6. Maintenance runs by itself (`maintain.js:maintain`): the catch-up run that
   the prompt hooks start at most every ten minutes ends with one maintenance
   run, and so do the git `post-commit` and `post-merge` hooks that `setup` and the
   installer put in place (`--no-git-hook` leaves it out). A batch runs at most
   once every four hours, on the next repository activity after
   it is due (including explicit `maintain`; `--dry` previews without waiting).
   Retrieval never spawns verification. A run re-verifies up
   to 10 stale notes, writes
   phrasings for up to 8 notes that lack them, and distills up to 3 pull
   requests merged since maintenance first ran in the repository (older ones
   are `thinker mine-prs`). Fixes come first (`prs.js:pickPrs`): a pull
   request whose title says it fixes something qualifies without a body and
   takes up to two thirds of a run's slots when other changes wait; a
   candidate the limit passes over is not recorded as mined and is offered
   again next run (`learn.js:minePrs`, `deferred`). The record of a fix is
   what a review draws on most: on 23 real PostHog regressions every bug the
   cache caught and the diff alone missed rested on a note mined from the fix
   (`bench/RESULTS.md`, "Real bugs on PostHog"). Re-verification ahead of time is for notes served in
   the last 14 days (`verifyServedDays`; 0: all), the most served first; a
   stale note nobody is reading waits until a later batch after it is served.
   Dependency hashes and git diffs since each note was verified identify the
   affected notes; unchanged dependencies cause no verification call. A note
   re-verified 3 times in a week (`verifyChurn`; 0: never) rests on code under
   active change: it is left stale, with its ⚠ banner, and named to the user
   once (`maintain.js:pickStale`), to narrow its pointers or retire it. In the
   week this was added, 28 of 80 notes maintenance verified had not been served
   at all, and one note was rewritten 8 times. The tokens the model calls of
   learning and maintenance reported are summed from the machine's log and a run stops
   at `dailyTokens` (default 2M tokens a day, about 80 distillations; until 2026-10-04
   the cap was `dailyCap` in dollars, a key now ignored except that 0 still means no
   cap). `maintain` in `.thinker/config.json`
   overrides `enabled`, `dailyTokens`, `verifyPerRun`, `verifyServedDays`,
   `verifyChurn`, `phrasePerRun`, `prs`, `prsPerRun`. What a run did is shown once at the end of the next turn
   (`maintain.js:maintenanceNotice`), through the same channel as the
   cache-hit notice. `thinker maintain [--dry]` is one run by hand;
   `THINKER_NO_LEARN=1` switches it off with the rest of learning.

Learning is on by default in `setup` and the installer. Evals keep
the cache fixed with `--no-learn` at install time, or `THINKER_NO_LEARN=1` in
the environment, which also silences hooks that are already installed.
`learn: {"sessions": false}` in `.thinker/config.json` switches off learning
from sessions alone (the session distill and the catch-up `learn`), while
learning from code changes goes on: pull requests and re-verification in
maintenance, `thinker distill <file>` by
hand. Each session distilled is a model call, about 10¢ with Sonnet, and in a
week on this repository 30% of them produced no note; without them there are
also no assessments, so `thinker usage` counts no servings as acted on. The
hooks skip a quiet session (`distill.js:quietSession`): nothing served in it
to assess, no edit, no failed tool call, no correcting prompt, and under eight
exploration calls; logged as `distill-skipped` with `reason: quiet`.
`learn.quietExplore` in the config moves the line (0: distill every session);
`thinker distill <file>` by hand distills regardless. The distiller is asked
only for the kinds worth a note here (`ops.js:distillKinds`): the kinds this
checkout serves, plus the kinds review reads from the archive (`REVIEW_KINDS`:
rule, behavior; behavior is never distilled). A note of a left-out kind that
comes back anyway is skipped by `saveNotes`.

Controls for experiments: `THINKER_NOTES_DIR` (a flat note store for a
benchmark arm), `THINKER_HOOKS=off` (the user's machine-wide
hooks do nothing; a checkout's own hooks are unaffected) and `THINKER_MCP=off` (the MCP server offers no
tools; the control arm of `thinker benchmark`), `THINKER_HOLDOUT`. The
switches of settled experiments were removed in October 2026 (early modes,
the router, forced or naive serving, links and co-change off, the guard off,
cover floors, pointer and snippet limits, the fanout tag, a per-model guide
above `orient`); what they measured is in `bench/RESULTS.md`, and what won is
the only behavior. A harness that needs the order alone passes `cover: {body:
0, question: 0}` to `rank` and `refreshFirst: false` to `orient`.

## Serving

- MCP server (`thinker serve`, registered in `.mcp.json` by `thinker setup`)
  with tools `orient(task, file?, budget?)`, `lookup(query)`, `find(query, path?)`, `drilldown(pointer)`,
  `remember(...)`, `feedback(id, useful, correction?)`.
- Code behind the pointers: the MCP `orient` and `lookup` end with the
  definitions the served notes point at (`ops.js:codeSnippets`: up to two per
  note and four in all, each cut to 30 lines), in what is left of the note
  budget plus `SNIPPET_BUDGET` (600 tokens). The hooks do not add them
  (`thinker orient --snippets` does); `snippets: false` in
  `.thinker/config.json` turns them off. Measured
  against Qartez on click, the agent spent its advantage on reading whole
  files after orienting; this is what the snippets are for.
- When `orient` or `lookup` over MCP finds no note, its answer carries the first
  six definitions `find` returns for the request (`mcp.js:codeFallback`, logged
  as `client: "mcp-fallback"`), and the prompt hook's bundle names `find`: in
  the week before, real sessions never called `find` (Claude Code defers MCP
  tools until searched for), only the benchmark arms did. Two weeks later the
  log held 3 `find` and 2 `review` calls over MCP against hundreds of hook
  orients, and sessions reported changes done without a review. Since
  2026-10-05 the first prompt of a session carries a `<thinker-tools>` intro
  (`ops.js:sessionIntro`): what `find` and `drilldown` do, for Claude Code
  the exact `ToolSearch select:…` that loads them; logged as `intro`. It does
  not name `review`: with one sentence saying it existed, the agent called it at
  the end of both reruns and lost three minutes to each timed-out call. A held-out session gets
  none of it. On two Grafana tasks under Gemini (`bench/RESULTS.md`, "Tool
  intro") the intro got `find` called where it never was. It first also told
  the agent to run `review` before reporting done, with a first-edit nudge
  repeating it; both went the same day at the user's decision, a review runs
  when asked for, and those runs had shown the agent polling a slow review for
  minutes instead of working. `git grep --untracked` behind `find`,
  `drilldown` and the reference counts reads into a checkout nested under the
  repository (a benchmark's clone under `bench/runs/`): on this repository
  `find` answered with PostHog's definitions. Lines under a directory holding a
  `.git` entry are dropped (`codegraph.js:gitGrep`), as are `coverage/`,
  `__pycache__/` and `.next/`.
- `find(query, path?, limit?)` answers "where is this defined / handled" when
  no note does: the definitions whose name or body carry the words of the
  query (`codegraph.js:findSymbols`), as `path:Symbol:L12` pointers with their
  size and, for the first three, blast radius, plus the notes resting on them.
  One `git grep -c -F -i` for the words over the source files (a second or
  two on PostHog), the lines of the 50 files with most mentions attributed to
  the enclosing definition through `outline` (parser, graph, or regex; a regex definition ends where its braces or indentation close, and no later than the next definition indented no deeper, so a one-line `const` is not credited with the text below it), and the
  graph's name search added when the checkout is indexed. A word in the name
  outweighs one in the body, which outweighs one in the path; words on many
  lines weigh less; a definition covering more of the words comes first; tests
  are scaled down; bodies over 1,500 lines are dropped. Scoring is heuristic,
  not BM25 over source. Measured against codebase-memory-mcp on click, the
  agent used that server's `search_graph` and `get_code_snippet` where thinker
  left it grepping and reading file ranges; `find` and the whole-definition
  `drilldown` below are what that showed thinker lacked.
- `drilldown(pointer)` takes `path:Symbol` pointers (or a path, or a bare name,
  resolved through the notes' pointers and then the code), several at once
  separated by commas, and returns each definition whole with its lines (the
  default budget of 2,500 tokens holds about 150 lines; a class that does not
  fit is shown as its head and the outline of its members), for a single
  pointer one hop of callers (every reference, calls first) and callees
  (names the body calls that are defined in the repository), and the notes
  resting on that symbol or file
  (`ops.js:drilldown`, `codegraph.js`). Everything is answered by `git grep`
  over the language family of the file: no index, approximate by design.
  Outside a git checkout it says so.
- Blast radius: a symbol pointer is served as `path:Sym:L12 [6 call sites in
  3 files]`. The count is made when the note is created and again for the
  symbols a verification found changed (`codegraph.js:annotateFanout`;
  `thinker rehash --fanout` redoes all), stored on the dep as `fanout`, and
  not made for names under four characters or common ones (`main`, `get`).
- The code graph that was: [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)
  (CBM), a binary that indexes a repository into a graph and answers over MCP,
  was an opt-in engine behind `drilldown`, `find` and the blast-radius counts
  for a while. Measured on click (`research/cbm-comparison/`) the graph-backed
  arm was marginally cheaper and no more accurate than thinker's own tools,
  so the engine, its `thinker cbm` command and its switches were removed in
  October 2026. CBM stays the comparison baseline of the benchmarks:
  `bench/eval-support/cbm.js` installs the pinned release and indexes a
  checkout, and `bench/cbm-compare.js`, `bench/cbm-pr-compare.js` and
  `bench/cbm-preflight.js` compare the arms `thinker` (notes, git grep) and
  `cbm` (the graph alone, as the agent's MCP server); the earlier comparison
  against Qartez is in `research/qartez-comparison/`.
- The prompt hooks serve two notes. When an agent calls `orient` with its own
  `budget`, up to five are served (past the second, a note must reach 0.7 of
  the best hit's relevance), a linked note is added instead of replacing a
  hit, and relevant notes that were not served are listed by title and id;
  `lookup` takes such an id (or a query, returning up to 3 notes by default).
- Prompt-time hook: injects the orientation bundle into every prompt
 automatically (no tool call needed). See [Supported agents](#supported-agents).
- What the user sees: the stop hook sums the turn, prompt-time and late notes
 together (`🧠 thinker: 2 notes this turn (pointing at 2 files, ~7k tokens of
 code)`, `usage.js:turnNotice`). The prompt hook says nothing to the user: a
 line at every prompt was noise. Tokens are one read per file a note rests on. The notice does not say "saved": at serve time nothing
 is known about whether the agent will act on a note, and in a week on this
 repository about 30% of servings were; what was saved is counted once the
 session is assessed, in `thinker usage`. Shown through `systemMessage` in Claude Code and Gemini CLI;
 Codex and Cursor have no channel for it from a stop hook. `THINKER_NOTICE=off`
 or `notice: false` in `.thinker/config.json` turns it off.
- Ranking: BM25 over title/answers/tags/deps/body with identifier splitting,
  plus path affinity to the current file, kind priors for orientation,
  confidence, what sessions did with the note when it was served
  (`attest.confirmed` against `attest.unused`, smoothed; up to ±0.1), and a
  stale penalty; greedy packing into the token budget
  (full note, else a one-line stub).
- Coverage floors: relevance is relative to the best note, so the best of a
  poor lot scores near 1. A note is served only if it also covers a share of
  the request's term weight: 0.20 with its body and pointers, 0.05 with its
  title, answers and tags (`rank.js:MIN_COVER`; on the benchmark task sets
  the body floor separates on-target from off-target servings, 0.10 did
  not). When the agent calls `orient` itself (up to five notes, a sentence
  as the request) the body floor is 0.30 (`MIN_COVER.agentBody`): on the
  offline sets this took grafana's agent-path precision from 0.12 to 0.17 and
  mitmproxy's from 0.56 to 0.64 with no task losing its on-target note,
  posthog unchanged at 0.80; 0.35 cost posthog a task. A short query must be covered by more: the weight of about three of
  its words. A request of two or three content words must share two of them
  with the note's title, answers or tags ("run the tests"); a request of one
  content word ("status?") is a turn of conversation and is served nothing.
  Words are stemmed conservatively (`rank.js:stem`: plurals, -ing, -ed,
  -ation); the earlier suffix list cut "notes" to the stop word "not". This holds for
  the prompt hook, `orient`, `lookup` and late notes; a note on the current
  file is exempt. When nothing passes, nothing is served.
- A request of one content word is not oriented on at all: `status?`,
  `merged?`, `ok good. pushed?`, `yeah just run it` are turns of a
  conversation, and any note holding the word would cover all of it
  (`ok`, `yeah`, `please` and the like are stop words). `lookup` by one word
  is still answered, and so is a note on the current file. In one week on this
  repository such turns took 20 of 111 servings, and the note holding the
  word *status* became the most served note of the week.
- The prompt hooks serve a note once per session (`orient`'s `once`): what
  was served on an earlier turn is in the agent's context, and serving it
  again on a follow-up adds tokens and a verdict of `unused`. `orient` called
  by the agent is a fresh question and may return it again.
- Holdout: the hooks serve nothing in a share of sessions, so that what the
  notes do can be measured on the machine's own work instead of estimated
  (`ops.js:holdoutSession`). Which sessions is a hash of the session id, so
  every hook of a session agrees without state and a session is held out for
  its whole length; `orient` with `holdout` ranks and packs as usual, logs
  what it would have served as `withheld` on the `orient` line, marks nothing
  served, and returns nothing; the edit hook serves nothing either. The agent's
  own `orient`, `lookup`, `find` and `drilldown` are not held out. At every
  stop the hook logs the session's cost so far from its transcript
  (`op: "session"`: tool calls, model turns, input tokens with cache reads and
  writes, model; `transcripts.js` `stats`, Claude Code, Cursor and Codex);
  the last line per session counts. `thinker usage` compares the two sides
  under "Holdout" (`usage.js:holdoutSummary`): medians of tool calls and
  input tokens over sessions that got notes against sessions that had notes
  withheld, per model; sessions with nothing to serve are on neither side,
  and under five sessions a side it says so rather than compare. The share
  is `holdout` in `.thinker/config.json` (default 0.15; 0 or false: none),
  `THINKER_HOLDOUT` overrides it (`off`, `0`, or a share; `1` holds out
  every session, for tests). Benchmarks pin their arms and should set it off.
- The prompt hooks serve no stale note (`orient`'s `freshOnly`). A stale
  note that would have been served is held back, logged as `held` on the
  `orient` line, and left for the next four-hour maintenance batch
  (`maintain.js:maintain`), and served on a later turn once it is fresh
  again; in the meantime it is listed by title, marked STALE, among the
  notes the agent can `lookup`. Over three days on this repository 43 of
  154 hook servings were stale: each took a slot and the tokens of a fresh
  note and put a claim in front of the agent that it had to check or ignore.
  `orient` and `lookup` called by the agent still return stale notes, with
  the ⚠ banner.
- The query: function words are dropped (`rank.js:STOP`), and so is what the
  request tells the agent not to do ("do not run the test suite"), which
  would otherwise bring up the notes on running tests (`rank.js:subject`).
- Phrasings: notes are written in the words of the code, requests in those
  of the product. `thinker phrase` adds to each note up to five lines of how
  a user would put it (`says`), written by a small model from the note alone;
  ranking counts them with the title and answers. Notes whose text changed
  since are done again; about 3k tokens a note with Haiku.
- `rerank: "haiku"` in `.thinker/config.json` hands the
  eight best candidates to a small model, which keeps those that bear on the
  request, or none. Its choice is final: no linked note is added to it.
  Through an agent's CLI a call took 8 to 13 seconds and about $0.02, which
  is close to the 15 seconds a prompt hook is given, so it is off by default;
  with `ANTHROPIC_API_KEY` the call goes to the API directly.
- The hooks' notes go through a local cross-encoder before they are served
  (`dense.js:ceRerank`, on by default): `Xenova/ms-marco-MiniLM-L-6-v2` (23 MB,
  ONNX) reads the request, cut to its first 120 tokens, together with each of
  the eight best lexically gated candidates and gives one relevance logit per
  pair; candidates under the floor are dropped and at most `maxNotes` are
  served in its order. When nothing clears the floor, the single best candidate is still
  served if it scores at least `fallbackFloor` (default −1; measured 23 tasks
  hit against 19 at precision 0.96). Defaults `floor: 0, maxNotes: 1,
  fallbackFloor: -1` (`dense.js:CE_DEFAULTS`),
  chosen on 54 tasks labeled by a Codex judge against the merged fixes
  (`bench/RESULTS.md`, "Ranking: labels"): 94% of served notes useful, 88%
  important, nothing served when nothing fits, a quarter of the tokens; the
  price is reach, 15 of 70 important notes at prompt time against 27, which
  the edit hook recovers in part (it reaches the important notes resting on
  the files the agent opens). `ce` in `.thinker/config.json` adjusts it
  (`{ enabled, floor, maxNotes, k, queryTokens, fallbackFloor }`, or `false`);
  `THINKER_CE=on|off`, `THINKER_CE_FLOOR`, `THINKER_CE_MAX`, `THINKER_CE_K`,
  `THINKER_CE_QUERY_TOKENS`, `THINKER_CE_FALLBACK` (a score, or `off`) override
  the config. The note side is its `search` text, written by
  `phraseNotes` beside the phrasings (3–6 sentences from the note alone:
  rule, constraints, tasks, identifiers; `phraseKey` is versioned so notes
  phrased before are done again); on raw note text the cross-encoder did
  not tell important notes from irrelevant ones, on this text it did. An
  agent's own `orient` (more than two notes) and `lookup` keep the lexical
  ranking. The runtime (`@huggingface/transformers`, ONNX; most of the installed
  dependencies' size) is a dependency; the model (23 MB) is fetched into
  `~/.thinker/models` (`THINKER_MODELS_DIR`) by the installer, `thinker
  update` and `thinker setup`, and by `thinker ranker fetch`; `thinker ranker`
  says whether both are in place. When either is missing the hook logs
  `ce-error` once and serves the lexical ranking.
  The hook goes from 0.7 s to about 1.0 s. `THINKER_DENSE=minilm` (bi-encoder
  embeddings blended into the score) is the measured negative kept beside
  it. Harness arms `hook-bm25` (CE off), `hook-ce1`, `hook-ce2`, `hook-minilm`.
- Jev (`jev.js:jevSearch`), hosted by default, searches all eligible notes for
  `orient` and query-based `lookup`, without BM25 candidate gating. `searchRecord`
  uses a current `search` description or falls back to the body, including scope
  and pointers. `note-search.js:phraseKey` hashes title, body, questions, scope
  and dependency paths/symbols; old length-based keys and equal-length edits
  cannot validate a description. Maintenance and `phrase` regenerate missing or
  obsolete descriptions. Up to two batches run concurrently, each at most 32
  questions and 30,000 UTF-8 bytes including the whole request. A five-second
  deadline covers the search; any failed batch discards the partial result.
  Invalid/archived notes are excluded; hooks additionally exclude stale or
  already-served notes. Exact IDs and kind-only lookup remain direct.
  `selectByJev` keeps those at or above `floor`, up to the caller's limit.
  The earlier reranker sent named fields (`noteRecord`), which beat one
  prose blob of the same note (false positives 8 to 5). There is no fallback
  below the floor: a Noul near 0 is the model saying the note does not bear on
  the request, and serving nothing was right on every labelled task that had
  nothing useful. Measured on all 54 labelled tasks, two runs, against the
  same `gpt-6-sol` labels (`bench/RESULTS.md`, "Serving: Jev"): 0.96 of served
  notes useful, 40 of 70 important notes reached and 33 of 54 tasks served
  something useful, against the cross-encoder's 0.96, 16 of 70 and 23 of 54 —
  2.5x the reach at the same precision, ~160 ms and ~10k tokens a prompt. Both
  runs were identical on the default arm. One judge, one prompt, and Jev was
  handed the labelled candidate pool.
  Hosted Jev is the default since 2026-10-06. Setup (`configureJev`) and first
  retrieval automatically enroll through `infra/jev-proxy/`, an API Gateway and
  Lambda service on AWS. Revocable client tokens live in `~/.thinker/jev-proxy.json`
  (mode 0600), expire after 30 days, and renew automatically on expiry. The proxy
  holds the upstream key in Secrets Manager, checks token validity and reserves
  minute/day/global request quotas atomically in DynamoDB, and never logs payloads
  or credentials. Anonymous enrollment is bounded by IP/day and service/day quotas;
  it is not proof of user identity. Prompt text and candidate note excerpts are
  sent to the proxy and TypeSafe for inference, separately from telemetry.
  An optional personal key (`THINKER_JEV_KEY`, `JEV_API_KEY`, `TYPESAFE_API_KEY`,
  or `~/.thinker/jev-key`) selects direct TypeSafe access. `thinker ranker --jev-key`
  stores one; `--no-jev-key` returns to hosted access. Secrets never belong in the
  repository config. `jev` in the config sets `{ enabled, floor, maxNotes, k,
  model, timeoutMs, searchTimeoutMs }` or is `false`; `enabled: "auto"` means hosted or direct
  Jev is enabled. `THINKER_JEV=off` selects local ranking. Other `THINKER_JEV_*`
  controls still apply, including `THINKER_JEV_TIMEOUT` (overrides both deadlines;
  default search deadline 5000 ms, individual legacy scoring calls 1500 ms).
  Any transport, quota, timeout or response-validation failure falls back to the
  local ranking (installed cross-encoder for hooks, lexical otherwise). A low relevance score is a valid decision to omit a
  note, not a service failure. Tests cannot call either production model path
  unless they explicitly inject a transport. `thinker ranker` reports the path,
  and the `orient` log line carries `jev` beside `ce`.
  A facet vector typed onto the notes was measured and rejected as a serving
  signal the same day (`bench/RESULTS.md`): every facet scored AUC ~0.50 against
  the notes' own attestation labels, and the `inert` flag would have suppressed
  notes sessions were confirmed to act on.
- Local storage: `.thinker/local/notes/` holds learned notes and is ignored by Git.
  Legacy `.thinker/notes/` files remain readable with local overlays, so upgrading
  does not discard existing notes or corrections. `transfer.js` backs up and
  restores effective notes locally. There is no note publishing or client sync.

## Internal review server

`src/server/`, `action/review/`, and `infra/sync/` remain internal infrastructure
for this repository's mandatory PR reviews. The server is excluded from public
release archives. Client sharing, sync, and staged-note repair were removed;
old client sync settings do nothing. Do not reintroduce team collaboration as
part of the product. Local review and personal backup/restore remain supported.

## Desired behaviors

Every other kind of note is a claim about the code, and when code and note
disagree the note yields: verification rewrites or retires it, a review calls
it `note_outdated`. A `behavior` note (`behavior.js`) is the other way round: a
person writes down what the system must do and where that is upheld, and from
then on a change must conform, or be called out for not conforming. The
rule since 2026-10-04: **before a merge the behavior is the truth, after it
the code is.** A pull request that stops upholding a behavior is told so, in
full and first (a fixed behavior loudly, see Review below); once the change is
merged on the default branch the behavior is revised to match the code, with
the old text in its history. Behaviors are never evaluated against a gold set;
the review's callout and the person's decision to merge are the check. `thinker system` is the view of them; the MCP
`lookup` with `kind: "behavior"` returns them to an agent (all of them with no
query); `thinker system md` writes them as `.thinker/SYSTEM.md` for people who
read the repository without the tool. Legacy committed behaviors remain
readable; new behaviors stay local.

- **Fields.** A behavior is an ordinary note (title, body with `file:Symbol`
  pointers, answers, deps) plus `mutability`: `fixed` (a review treats a
  change that stops upholding it as an error and requests changes, with the
  behavior quoted in full) or `mutable` (the default; a warning, and a pull
  request may revise it by editing the note itself). Both follow the code
  once a change is merged. `mutability` and `revised` ({at, commit, reason},
  set when the merged code rewrote it) are shared content; `violated` is this
  checkout's state (`store.js:LOCAL_FIELDS`).
- **Who writes one.** A person: `thinker system add file.json [--fixed]`, or
  `thinker system promote <id> [--fixed]` for a note that already states a
  rule (`thinker system propose` lists the rule notes, the ones the sessions
  acted on first). An agent may save one with
  `remember` (kind `behavior`); it is listed as *proposed* until `thinker
  system accept <id>`. Distillation and PR mining are not offered the kind
  (`distill.js:distillSpec`, `prs.js`), archiving never takes one
  (`ops.js:archiveReason`).
- **Build proposals.** `thinker setup --build` drafts up to twelve
  high-signal PR/document rule notes into desired behavior
  candidates in `.thinker/local/behavior-proposals.json`. The model sees each
  note's source and current symbol code; outputs are restricted to the note's
  existing symbol deps. `thinker system propose` shows drafts and their
  provenance; `thinker system accept proposal-<note-id>` creates an active
  behavior only after a person reviews it. The draft is not served or reviewed
  as a requirement. Acceptance refuses a changed source note or code. The
  stage runs on every cache build; it returns no drafts if no suitable source
  notes exist.
- **Verification** (`ops.js:verifyBehavior`, through `verifyNote`): when a dep
  changes the question is whether the code still upholds the behavior.
  `holds` re-baselines; `moved` re-points the deps at where the behavior is
  upheld now (history kept). `broken` depends on where the code is
  (`ops.js:onDefaultBranch`: the deps' files committed, and `HEAD` reached by
  origin's default branch, or a local `main`/`master` without a remote). Not
  merged (a working tree, a branch, unpushed commits): `status: violated`
  with the commit and the reason, deps re-hashed so the note reads as
  violated rather than stale until the code changes again, text untouched,
  named at the end of the next turn (`ops.js:noteUnreported`,
  `maintain.js:maintenanceNotice`) and served with a `⚠ VIOLATED` banner.
  Merged: the model is asked for the behavior as the code upholds it now, the
  body is replaced (pointers of the new text join the deps), `revised` records
  the commit and reason, the old body goes to `history`, the verdict is
  `revised`, the notice says so and `.thinker/SYSTEM.md` is rewritten. A
  behavior is never retired by verification, and never rewritten for code
  that is not merged. On the server the clone sits at the default branch, so
  the behaviors there follow every merge and sync out.
- **Review** (`review.js:assessBehavior`, and the holistic prompt): the
  verdicts are `violation`, `consistent`, `unrelated` and `revised`; `revised`
  only for a mutable behavior whose note file the change edits
  (`review.js:noteFileChanged`, in the scope under review), otherwise it is a
  violation. A violation without a placed finding gets one at the first
  definition the change touched. A finding on a fixed behavior is an error,
  on a mutable one at least a warning, so `--strict` exits 2 in CI. The
  posted pull request review (`review-post.js:buildReview`) opens with a
  violated fixed behavior before anything else: its title, its full text
  under "What it requires", what the change does instead (the model's
  reason), and what merging means (the code becomes the truth and the
  behavior is revised to match; restore the enforcement if that is not
  meant). A violated mutable behavior gets the same block under a quieter
  heading. `renderReview` says the same in one line for the CLI. The
  holistic call may not list a behavior under `outdated`: one it does is turned
  into a finding. The report carries `behaviors`, one line per behavior in
  play (`upheld`, `violated`, `revised`, `unrelated`, or `consulted` on a dry
  run) with whether it was already violated before the change, rendered under
  "Desired behaviors" and in `--json`.
- **This repository's own** (`thinker system`, `.thinker/SYSTEM.md`), written
  2026-10-03: a review never writes to the cache; verification never rewrites
  or retires a behavior; serving and assessment never rewrite a shared note's
  committed file; `THINKER_TELEMETRY=off` and test runs send no telemetry (all
  fixed); the prompt hooks serve no stale note (mutable).
- **Serving.** A behavior is served like an invariant: at orientation with a
  small kind prior, by the edit hook when a file it rests on is edited
  (`ops.js:lateNotes`, first among the rules), and in `thinker review`'s
  consulted set with the highest kind weight.

## Reviewing a change against the cache

`thinker review` (`review.js`) turns the cache around: instead of serving notes
to an agent about to make a change, it checks a change against them. The MCP
is a mode of the command line, not a tool an agent calls: the MCP tool was
removed on 2026-10-06 because agents did not reach for it (14 MCP calls of any
kind against 2094 orients on the machine that built it, while the 161 reviews
that ran came from the CLI and the pull request action) and because it is the
wrong shape for a tool call -- several model calls over a whole change, minutes,
longer than some clients allow -- with findings a person has to act on. An agent
working in a repository gets the cache through the serving path instead: the
prompt hook, `orient`, `lookup` and the edit hook's late notes. What review is for,
decided 2026-10-04 on real PostHog history (`bench/RESULTS.md`, "Real bugs on
PostHog"): regressions of a fix the cache holds a note about (caught 12 of 12,
including the ones the diff alone missed) and violations of written
conventions and behaviors; not bugs in new code, where neither the baseline
nor the cache caught any of 20 and the knowledge that would have was in no
note yet. Work on detection goes to coverage and fix mining, not to the
review prompt.

- **Scope** (`review.js:resolveScope`): the working tree against HEAD (default,
  untracked code files included as additions), the index (`--staged`), the
  branch since its merge base (`--base ref`), one commit (`--ref`, read from
  git alone), or `--state`: no change, the current code of the given paths
  against the notes resting on it. One reader per scope (`makeReader`) gives
  the text of a file before and after, so a review of a commit never looks at
  the working tree. `.thinker/` is never part of the change.
- **Exposure** (`noteExposure`): each dep of a note is hashed on both sides with
  `deps.js:hashText`. A dep whose hash differs between the sides is `touched`
  by the change; a dep whose stored hash already differs from the code
  *before* the change is `staleBefore`: drift of the cache, reported under
  "Cache state" and said to the model, never charged to the change. Notes with
  a touched dep are `direct`; up to six more are `related` by BM25 over the
  changed paths, the definitions touched (`changedSymbols`, by
  `codegraph.js:outlineText` on either side's text) and the most frequent
  identifiers in the added lines, needing two discriminative terms on the
  question side or three on the body side. Rules and traps weigh more than
  maps (`KIND_WEIGHT`). Among the direct notes, those resting on a definition
  the change altered come first, ordered by whether the changed lines inside
  that definition name what the note names and by how many of them there are
  (`review.js:specificity`; words a sixth of the cache's notes share do not
  count, `commonTerms`), then by kind and confidence; a note on a hub
  definition (`cli.js:main`) is touched by nearly every commit, and on the
  last ten commits here 30 to 60 notes were, with a dozen consulted per
  review. `toAssess` says why each was chosen. With a Jev key (`jev.js`) the
  BM25 pool is widened to twelve and `review.js:narrowRelated` keeps the notes
  that bear on the change, a Noul each, scored against named fields
  (`changeRecord`: the files touched, the definitions altered, the identifiers
  added) rather than the bag of words BM25 ranks on; the kept scores are
  `notes.relatedJev` in the report. BM25 fills all six slots whether or not
  anything fits: on 16 grafana regression cases every review consulted exactly
  six related notes and none carried the signal, since the note that catches a
  regression arrives `direct`, by dep hash, in 16 of 16. So this buys a smaller,
  truer prompt, not reach. A dry run and a failed call both keep BM25's choice.
  `thinker maintain --dry`
  persists no statuses.
- **Without a model** (`deterministicFindings`): a definition the change
  removes that is defined nowhere else and still referenced
  (`codegraph.js:references`; working tree and index only, since a commit
  cannot be grepped; a method's name is a warning, a top-level name an error).
  The co-change hint (a partner file of a changed file that is not in the
  change) went on 2026-10-03, and the rest of co-change on 2026-10-04.
- **Kinds** (`--kinds behavior`): only notes of
  those kinds are consulted. With the desired behaviors alone the default
  strategy becomes one call per behavior in play (`per-note`), which gives a
  verdict for each and leaves out the no-notes baseline, since only the rules
  are asked; `--mode` overrides it. This is what the pull request action runs
  (below). Measured once here on a planted violation: four behaviors in play
  (two of them pulled in by shared identifiers and found unrelated), $0.20,
  37 seconds.
- **With a model** (`assessNote`, one call per note, up to `--max`, four at a
  time): the note with its cache state, the diff of the files it rests on (the
  whole diff for a related note), and the code after the change behind each
  dep. The verdict is `violation` (findings with file, line, evidence and
  confidence), `note_outdated` (with a corrected body, reported, not applied),
  `consistent` or `unrelated`. Findings under 0.5 confidence are dropped;
  `category` is `violation` for a finding under a violation verdict, `bug`
  otherwise. The model is `reviewModel` in config, else `sonnet`; accounted as
  `purpose: review`, `phase: review`. Measured once on this repository through
  Claude Code's CLI: about $0.12 a note.
- **Nothing is written** to the cache by a review except the `review` log line;
  a note found outdated or stale is listed with the `thinker verify` command
  that re-checks it. The deletions of a diff are mapped to the line that now
  follows them (`parseDiff`: `removedAt`), and a deletion sitting at a
  definition's first line is not a change of that definition.
- Several notes often see the same problem at nearby lines of one function:
  findings in the same file within eight lines become one
  (`review.js:clusterFindings`), with the surest wording, the highest severity
  and every note named. Findings resting on a shared note at several files
  (the undone fix, the serializer that carried its field, the test that
  covered it, the document that described it) become one as well, placed
  where the model was surest, the rest kept as `locations`, rendered as
  "also at" and each posted inline when on a changed line
  (`review-post.js`). On the PostHog regressions the cache arms reported two
  findings a review against the baseline's one, and that was the same
  regression at each file it touched.
- When most of the changed code files carry no consulted note, the review says
  so first (`review.js:blindSpot`, under the header in the CLI and in the
  posted body): there the review is the model reading the diff alone, or
  nothing at all when only behaviors were consulted. "No findings" on such a
  change is not a clean bill. On 24 bug-introducing PostHog pull requests a
  note rested on the file holding the bug in one.
- Step gates (`gates.js`, with a Jev key): one call decides which of the review's
  optional steps this change is worth, instead of each being a flag that is on
  or off for every change alike. Speculative fan-out: every gate is asked in the
  same request, they cannot see one another, and code consumes the answers that
  apply. A gate only fills a flag the caller left unset, never overrides one it
  passed, never runs for the `nocache` baseline, and makes no call on a dry run.
  `worth_reviewing` (act 0.15) decides whether to ask a model anything;
  `callers` (0.5) and `verify` (0.6) set those strategy flags; `chunks` (0.6)
  splits a large change; `tests` (0.5) only reports that running the tests would
  settle it. The thresholds are not symmetric: skipping a step is invisible, so
  the bar to skip is high and an uncertain answer does the work, and any failure
  leaves every step where review has it without gates. Measured live on
  contrasting changes: a comment reflow scores 0.03 on `worth_reviewing` against
  0.96 for an off-by-one, `callers` 0.85 on a signature change against 0.13 on a
  local loop bound, `tests` 0.78 on a cache key against 0.03 on the reflow. The
  gates read `changeRecord`, which carries the changed lines themselves: without
  them `worth_reviewing` scored a comment reflow 0.61, since file names, counts
  and identifiers describe the shape of a change and not what it does.
- Strategies (`review.js:DEFAULT_STRATEGY`, the `strategy` option of
  `review()`; no longer on the CLI, kept for `bench/review-eval.js`): `holistic` is
  one call with every consulted note, `nocache` is the same model with no
  notes (the baseline), `ensemble` is both, `callers` adds one hop of callers
  of the touched definitions by text search, `triage` asks a small model
  whether a note bears on the change before the expensive call, `verify`
  re-checks every error and warning with a second call and drops what is not
  confirmed; `chunks` reviews a large change in chunks of files, each with the
  complete file inventory. The default is the ensemble: on 16 planted and
  reverted bugs in two repositories it caught 15, with no false positive on
  the controls reached, at $0.16 to $0.25 a review; one call per note (the
  first design) cost four to six times as much, caught fewer real bugs and
  raised more false positives (`bench/RESULTS.md`, "Review strategies").
- Evaluation: `bench/review-eval.js run --repo <checkout> --cases <json>
  --strategies a,b [--notes <noteset dir>] --out <dir>` reviews every case under
  every strategy and `report` tabulates hits, false positives, findings per
  review, cost and time. Cases (`bench/review-eval-cases*.json`): bugs planted
  by one-line edits, real fixes reverted onto the base (only fixes that are
  ancestors of the base apply; a fix merged after the base is already absent),
  behaviour-preserving refactors and real commits as controls. A hit is an
  error or warning within six lines of the bug; a hit resting on a note mined
  from the very PR being reverted is marked (`fromFixNote`): the cache
  remembering a fix, not reasoning about code. The harness pins
  `THINKER_LLM=claude`: after one provider failure `llm.js` keeps the fallback
  provider for the rest of the process, and a run labelled sonnet was otherwise
  answered mostly by Gemini (kept under `bench/runs/review-eval/*-mixed-provider`,
  not used). Each row records the provider and model that answered (`models`).
- **On pull requests** (`action/review/`, `server/worker.js:reviewPrs`): the
  composite action sends the pull request (`number`, `headSha`, `headRef`,
  `baseRef`, `baseSha`) to the team's server, `POST /v1/repos/:repo/reviews`,
  and polls `GET …/reviews/:number` until the record is `done` or `failed`
  (`send.mjs`; `wait` seconds, default 600). The worker fetches the head into
  the clone (`repos.js:fetchPrHead`: GitHub's `refs/pull/N/head`, then the
  branch, then the commit itself), reviews a commit scope from the merge base
  with the base branch against the clone's notes (the default branch's; the
  working tree is not touched), and posts one pull request review with the
  server's GitHub token (`THINKER_SERVER_GITHUB_TOKEN`, pull requests: write;
  the git token when unset; `THINKER_SERVER_GITHUB_API` points at another API,
  a local fake for testing). `review-post.js` is the rendering and the posting:
  findings on changed lines as inline comments, the rest and a table of the
  behaviors in play (upheld, violated, revised, unrelated) in the body, cache
  drift under a fold. An error finding (a fixed behavior violated) posts
  `REQUEST_CHANGES` and the record carries `fail`, so the action fails the step
  (`failOn: error | warning | none`); otherwise `COMMENT`, and nothing at all
  when there is nothing to report (`quiet: false` posts the table anyway). A
  request for changes from an earlier run is dismissed when a newer run posts,
  so the push that fixes the violation clears it; a line GitHub will not take
  a comment on (422) folds the inline findings into the body. One record per
  pull request number (`<repo>/reviews/N.json`): a head already reviewed is
  answered from the record, a new push replaces it, a failed one is asked
  again. The model is whatever the server has (`llm.js`): the API key, or an
  installed agent CLI with its login, so a local server reviews through
  `claude -p` with no key; the workflow needs no key and no write permission
  of its own. Defaults (since 2026-10-04): every note is consulted, the ensemble;
  `kinds: behavior` consults the desired behaviors alone. Measured on 23 real
  PostHog regressions (`bench/RESULTS.md`, "Real bugs on PostHog"): a review
  that consults behaviors alone is blind wherever none rests, and on the 11
  regressions the cache held no note for it found nothing through a note.
  Without a server the same action reviews on the runner with
  `anthropic-api-key` and `post.mjs` posts (`permissions: pull-requests:
  write`, `fetch-depth: 0`); telemetry and learning are off in that step. This
  repository runs the server mode on itself in
  `.github/workflows/thinker-review.yml` (needs the `THINKER_SYNC_TOKEN`
  secret). Tests: `test/server-review.test.js` runs the server in-process with
  the model and GitHub faked; `test/action-review.test.js` covers the poster.
- Fixed along the way: `deps.js:findSymbol` no longer reads an indented Python
  call (`validate(ctx)`) as a C-like method definition; the C-like alternative
  is left out for indentation-based languages. `llm.js:viaCli` retries at once
  when `claude -p` stops with `tool_use` although no tool is offered.

## Supported agents

| agent | notes for the request | notes about files being edited (installed by default; `--no-late` leaves it out) | MCP tools | written to (user scope) |
|---|---|---|---|---|
| Claude Code, and the Code tab of the Claude desktop app | added to each prompt | yes | yes | `~/.claude/settings.json`, `~/.claude.json` |
| Codex CLI and the Codex desktop app | added to each prompt | yes | yes | `~/.codex/hooks.json`, `~/.codex/config.toml` |
| Gemini CLI | added to each prompt | yes | yes | `~/.gemini/settings.json` |
| Cursor | through the `orient` tool, and with the first tool result | yes | yes (approved by setup) | `~/.cursor/hooks.json`, `~/.cursor/mcp.json`, and `.cursor/rules/thinker.mdc` in the checkout |
| Pi, Windsurf, Copilot CLI, OpenCode | see `docs/agent-integrations.md` | | | the checkout alone (an extension or rule file; nothing machine-wide), by `thinker setup` there |

- The desktop apps run the same engines as the CLIs and read the same user
  settings. The Claude desktop app's Code tab reads hooks and MCP servers from
  the user's and the project's files alike; the Codex desktop app reads MCP
  servers from the user's `config.toml` only (openai/codex#13025, open since
  2026-02), which is why the wiring is machine-wide. Whether it starts the MCP
  server in the thread's directory is not verified: if not, the server asks
  for MCP roots, and failing that offers nothing there.
- One copy of thinker per checkout (`clients.js:pruneInstalls`). A hook names
  the copy it runs (`node "<install>/src/cli.js" hook …`), and so does an MCP
  entry; two copies wired into one checkout (an install left behind, a smoke-test
  copy, hooks in both of Claude Code's settings files) both fire on every prompt,
  serve the notes twice and bring the old copy's notice and state format back.
  `setup` takes every other copy's hooks out of the files of the client
  they install and point its MCP entry at the new copy; for Claude Code the hooks
  live in one settings file, so installing `--local` empties the shared one and
  the other way round. The prompt hook does the same on every prompt for copies
  that are gone or older by their `package.json` than the one running
  (`olderOnly`): a copy of the same version is left, or two copies would take
  each other out, and a newer copy is left to do the cleaning. What was removed
  is logged (`op: "prune"`) and said once at the end of the turn through the
  maintenance notice. Only the entries go; the old copy's files are not deleted.
- The wiring follows the installed version (`clients.js:refreshWiring`). The
  hook and MCP entries are written in the shape the version that ran `setup`
  knew; a later version that adds an event (`SessionEnd` for the final distill
  of a session) or changes a command rewrites them from what is there:
  `inferWiring` reads from each client's files whether hooks, late notes,
  learning and the MCP entry were installed and which Claude settings file
  holds them, and `installClient` is run again with those options. Only
  entries that run this copy (by the script's install root) are rewritten;
  entries of another copy, alive (a development checkout) or gone (a deleted
  worktree: the benchmark checkouts pointed at one, and rewriting them would
  have given them live hooks), and hand-tuned commands (an env prefix, a
  `--budget`: a benchmark arm's) are left alone and named. Checkouts under the
  temp directory are not visited. Git hooks of this copy are rewritten the same way.
  `thinker update` runs `thinker rewire` from the new copy after an update, for
  every checkout the machine's log names that is still set up; the prompt hook
  runs it for its own checkout on every prompt (`mergeJson` and
  `installGitHooks` leave an unchanged file untouched, so a client watching its
  settings file sees nothing); `thinker rewire [--here] [--dry]` is the command
  by hand. Before 2026-10-04 nothing did this, and this repository ran without
  `SessionEnd` and `PostToolUse` hooks for weeks after both were added.
- Cursor's prompt hook can allow or block a prompt but cannot add context, so
  thinker computes the notes at prompt time and hands them over with the first
  tool result. An always-applied rule also tells the agent to call `orient`.
- Codex reads a project's `.codex/` only once the project is trusted, runs a
  hook only once it is reviewed, and asks before each MCP tool call. `setup`
  takes care of all three: the MCP server is registered with
  `default_tools_approval_mode = "approve"`, and the project and thinker's
  hooks are marked as trusted in Codex's own `config.toml` (`CODEX_HOME`,
  `~/.codex`). In a terminal they ask first; `--yes` skips the question,
  `--no-trust` leaves it to you, and without a terminal nothing is marked
  unless `--yes` is given. The hook entry is the hash Codex 0.157 stores
  (see [What Codex stores as trust](#what-codex-stores-as-trust)); if a later
  Codex changes it, Codex asks for the review as before. `uninstall` takes the hook entries out again.
- Cursor loads an MCP server only once it is approved; `setup` does that
  through Cursor's CLI when it is installed.
- Gemini CLI also drives agent mode in Gemini Code Assist, which reads the
  same MCP configuration. Google AI Studio is a web app and cannot run local
  hooks or MCP servers, so it is not supported.

### What Codex stores as trust

Codex has no command for this and does not document the format. What follows
was read from the `config.toml` that Codex 0.157 writes after a review in its
own interface, and checked by running `codex exec` 0.157.1 on entries that
thinker wrote. All of it is in Codex's own config (`$CODEX_HOME/config.toml`,
by default `~/.codex/config.toml`), never in the repository.

A trusted project is a table named by the real path of the repository:

```toml
[projects."/Users/me/src/repo"]
trust_level = "trusted"
```

A reviewed hook is a table per handler:

```toml
[hooks.state."/Users/me/src/repo/.codex/hooks.json:user_prompt_submit:0:0"]
trusted_hash = "sha256:6118…1471"
```

- The key is `<real path of hooks.json>:<event>:<group>:<handler>`: the event
  in snake case (`UserPromptSubmit` is `user_prompt_submit`), then the index
  of the group in the event's list and of the handler in the group's `hooks`,
  both from 0. A hook that moves in the file needs a new entry.
- The hash is SHA-256, in hex, of this JSON with no whitespace, keys in
  alphabetical order, and `async` written out as `false` when the hook does
  not set it:

  ```json
  {"event_name":"user_prompt_submit","hooks":[{"async":false,"command":"…","timeout":15,"type":"command"}]}
  ```

  So any change to the command or the timeout makes the entry void, and
  Codex asks for a review again; `setup` writes new entries when it is rerun.
- Checked: handlers of type `command` with a `timeout` and no `matcher`,
  which is what thinker writes, for `UserPromptSubmit`, `PostToolUse` and
  `Stop`. Not known: how a `matcher`, a `statusMessage` or a missing
  `timeout` enter the hash. `trustCodex` leaves a group with a `matcher`
  alone, and hooks that are not thinker's are never marked.
- `codex --dangerously-bypass-hook-trust` runs hooks without these entries
  for one invocation; thinker does not use it.

The code is `clients.js:codexHookHash` and `clients.js:trustCodex`; a hash
that Codex stored is held in `test/clients.test.js`.

### Learning from any agent

Learning works with all four agents, and with others through the generic
path below. Nothing in it is tied to one vendor:

- **Sessions.** `thinker distill` reads Claude Code, Codex, Cursor and Gemini
  CLI transcripts (and the streamed output of their headless modes) and maps
  them to one event form: prompt, tool call with result, agent message. Tool
  names are mapped to one vocabulary, so `read_file`, `Read` and a shell `cat`
  are all seen as reading.
- **When.** Once per session, not per turn: each call carries the prompt,
  schema and related notes whatever the size of the trace, and on 2026-10-03
  one session was distilled 13 times. At the end of a turn (`Stop`,
  `AfterAgent`, `stop`) the hook distills only a backlog near the trace limit
  (`distill --batch`, `distill.js:batchDue`, 45,000 condensed chars); the end
  of the session (Claude Code's `SessionEnd`, Cursor's `sessionEnd`) distills
  the rest. Catch-up covers agents that fire no end: `thinker learn` finds
  every session any of these agents ran in the repository and distills what
  is new in those quiet for 20 minutes (`cli.js:LEARN_IDLE_MIN`). Hooks start
  it in the background at most every ten minutes.
- **What the agent's record leaves out.** Where an agent gives no transcript,
  the hooks record the session themselves (`.thinker/state/trace-*.jsonl`).
  Cursor records tool calls without their output; reads and searches are
  repeated against the working tree when distilling.
- **Model.** Distilling, verifying, PR mining and the exploration sessions of
  `setup` run through whichever agent is installed, with the login it already
  has: `claude -p`, `codex exec`, `agent -p` (Cursor) or `gemini -p`. A
  session is distilled by the agent that ran it when possible. `THINKER_LLM`
  picks one (`claude`, `codex`, `cursor`, `gemini`, `anthropic`);
  `THINKER_LLM_MODEL` names a model for the non-Claude ones;
  `THINKER_LLM_CMD` is any command that reads a prompt on stdin and prints
  the answer.
- **Any other agent.** Pipe events to `thinker record <session>` as JSON lines
  (`{"t":"prompt","text":…}`, `{"t":"tool","name":…,"input":…,"result":…}`,
  `{"t":"say","text":…}`), then run `thinker learn`. Agents that speak MCP can
  also save notes with the `remember` tool.

### What was run live, on 2026-09-27

| | Claude Code | Codex CLI 0.157 | Cursor agent CLI | Gemini CLI |
|---|---|---|---|---|
| notes served in a session | yes | yes | yes | not installed here |
| session turned into notes | yes | yes (hooks, trace and distilling through Codex ran; the short test session produced no notes) | yes (4 notes from 2 sessions, distilled through Cursor) | not installed here |
| exploration for `setup` | yes | stopped by the account's usage limit | yes (4 notes from one area) | not installed here |

Gemini support follows its documentation and is covered by unit tests on
constructed input only. Seen in the live runs:

- Codex did not run hooks from a project's `.codex/hooks.json` in
  `codex exec` with only the project marked trusted, but ran the same hooks
  from the user-level `hooks.json`. With the hooks marked as reviewed too
  (what `setup` now writes), `codex exec` 0.157.1 loaded the
  project's MCP server, called `orient` without asking and ran the project's
  hooks.
- Cursor's CLI (`agent -p`) fires `sessionStart`, `postToolUse`,
  `afterShellExecution` and `sessionEnd`, but not `beforeSubmitPrompt` or
  `stop`, and `postToolUse` carries a summary of the tool's output, not the
  output. So thinker installs both the editor's and the CLI's events, takes
  shell output from `afterShellExecution`, re-reads files when distilling,
  and `setup` approves the MCP server (`agent mcp enable thinker`) so the
  agent can call `orient` at the start and `remember` at the end. In the
  test session it did both unprompted.
