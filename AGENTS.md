# thinker: internals and working context

Reference for agents and contributors working on this repository. The
user-facing summary is in `README.md`; benchmark results are in
`bench/RESULTS.md`.

```
agent session ──► distill ──► .thinker/notes/*.json ──► orient / lookup (MCP)
                                   │
                          deps + content hashes
                                   │
             commit / edit ──► stale ──► verify (small model) ──► fresh | updated | retired
```

## Working on this repository

Requires Node 20+. Tests: `npm test` (`node --test test/*.test.js`).

**No telemetry from tests or benchmarks (MANDATORY RULE):**
Always set `THINKER_TELEMETRY=off` when running tests, benchmarks, evaluation
harnesses, scratch experiments, or their setup/install steps. Ensure every child
process inherits it. Never send these runs to the production telemetry endpoint
or count them as real usage. Telemetry-specific tests may use mocked requests or
an isolated loopback server only; they must never contact production.

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
`agent`), so no extra credentials are needed.

| path | contents |
|---|---|
| `src/cli.js` | `thinker` command: `setup`, `init`, `distill`, `orient`, `lookup`, `check`, `verify`, `cochange`, `serve`, ... |
| `src/mcp.js` | MCP server exposing `orient`, `lookup`, `drilldown`, `remember`, `feedback` |
| `src/setup.js` | the guided `setup` flow: agent selection and login check, cache build with estimates, optional PR benchmark |
| `src/clients.js` | adapters for Claude Code, Codex, Gemini CLI and Cursor: config files and hook formats |
| `src/transcripts.js` | session transcripts of every agent as one event form; the hook-recorded trace; finding sessions |
| `src/prs.js` | mining merged pull requests into notes |
| `src/ops.js` | core operations on notes (serve, merge, assess, link) |
| `src/deps.js` | dependency extraction and symbol-level content hashing |
| `src/ast.js` | symbol boundaries by tree-sitter (Python, JS/TS, Go, Rust) when its grammars are installed (`thinker ast install`); `deps.js` falls back to regex heuristics |
| `src/codegraph.js` | one hop of the call graph: references and blast radius of a symbol (`fanout`), callers, callees, definitions, outlines; behind `drilldown` and the `[n call sites in m files]` tags on pointers. From the code graph when the checkout is indexed, else from `git grep` |
| `src/cbm.js`, `src/cbm-worker.js` | codebase-memory-mcp as the code-graph engine: install, index, and a synchronous bridge to the binary run as a child MCP server (`thinker cbm`) |
| `src/rank.js` | BM25 ranking, relevance gate, budget packing |
| `src/distill.js` | transcript → notes and per-note assessments |
| `src/cochange.js` | co-change mining from git history |
| `src/maintain.js` | background maintenance: re-verify stale notes, phrase new ones, refresh co-change, distill newly merged PRs, under a daily cap |
| `src/guard.js` | anchoring guard: names identifiers in the request that the served notes do not cover |
| `src/update.js` | CLI self-update and daily automatic background updates (LaunchAgent / cron / invocation) |
| `src/usage.js` | summary of the usage log and the estimate of saved calls and tokens |
| `src/store.js`, `src/llm.js` | note storage; model access through any installed agent |
| `test/` | unit tests (`node --test`) |
| `bench/` | benchmark harness, task sets, PR data, and `RESULTS.md` |
| `bench/retrieval.js` | what is served for each task's request and how much of it rests on a changed file; no agent runs, seconds per task set |
| `.thinker/` | thinker's own notes about this repo |

`bench/repos/` (clones of click, mitmproxy, PostHog) and `bench/runs/` (raw
run output) are not checked in. To run the benchmark, clone the target repo
into `bench/repos/<name>` first.

## What `setup` does

`thinker setup` (or the installer with `--build`):

1. mines co-change edges from git history;
2. distills up to 60 merged pull requests of the GitHub `origin` into fix
   records, invariants and conventions (`--prs n`; needs `gh`);
3. runs one exploration session per source area and distills it (`--areas n`,
   default 12);
4. links the notes and installs hooks and the MCP server for each agent
   (`--clients claude,codex,cursor,gemini`, `all`, or `auto`, the default).

Steps 2 and 3 run through an installed agent with its own login (`--agent`
picks one). Measured with Claude Sonnet: about $0.45 per area and $0.06 per
pull request, so roughly $9 with the defaults; other agents do not report
cost. The estimate is printed before anything runs; in a terminal `setup`
asks before spending (`--yes` skips the question). Hook and MCP files are
written for this checkout only and kept out of commits through
`.git/info/exclude`; pass `--shared` to write committable files instead.

To mine more pull requests later, run `thinker mine-prs` (or `thinker learn
--prs`, which distills new sessions first). With no arguments it takes the
GitHub `origin`, mines what was merged since the last run and then goes
further back in history, 20 at a time (`--limit n`). Every pull request it
has looked at is recorded in `.thinker/prs.json`, which is committed with the
notes, so none is distilled twice, by you or by a teammate. Pull requests merged
after thinker was set up are distilled by background maintenance (see [The
learning loop](#the-learning-loop)); `mine-prs` is for history before that.

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

Model work is also logged as `op: "model"`, with `purpose`, `phase` (init / learning /
maintenance), provider, resolved model, raw usage, normalized token counters and
reported cost. Input totals include provider cache reads and writes; these are separate
from thinker's own estimated savings. Operation summaries marked `metered` are not
charged again. `usage --json` exposes `spending` by phase, purpose, model and repository,
plus `saved.netAfterSpend` (estimated reading avoided minus notes injected minus reported
model tokens). Missing counters/costs stay unknown. Legacy logs lack setup exploration
and token counts, so this comparison is partial, not measured financial ROI. See
`src/model-usage.js` for provider normalization.

## What a note is

A note answers a recurring question, not "what this file does":

| kind        | answers                                                       |
|-------------|---------------------------------------------------------------|
| `callpath`  | how control/data flows across files for an operation          |
| `location`  | where a recurring concern is handled                          |
| `cochange`  | what must change together                                     |
| `howto`     | how to build / test / run / lint, with the non-obvious flags  |
| `convention`| local rules an agent would otherwise violate                  |
| `gotcha`    | a trap (similar names, ordering, caches)                      |
| `rationale` | why: rejected approaches, incident-driven constraints         |
| `overview`  | a compact map of a module area                                |

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
- Every `orient`/`lookup` re-hashes the deps of candidate notes against the
  working tree (cheap: a few files), so uncommitted edits are caught too.
  Stale notes are ranked lower and served with a `⚠ STALE` banner listing
  exactly which deps changed and how (symbol body changed / file removed /
  symbol not found).
- `thinker check` persists statuses; `thinker verify` sends each stale note, the git diff of
  its changed deps since `verifiedCommit`, and the current text of every dep
  to a small model (Haiku by default) which answers `still_valid` (re-hash,
  bump confidence), `update` (rewrite body, keep history) or `invalid`
  (retire).

## Capture

1. **Automatic**: `thinker distill <transcript.jsonl>` condenses a session
   (prompts, tool calls with truncated results, the agent's final answer)
   and asks a model for 0–4 notes with deps. The end-of-turn hook runs this
   incrementally in the background (on by default; see below). Near-duplicate
   notes (same kind, ≥0.5 Jaccard on title+answers) are merged, keeping
   history.
2. **Agent-authored**: the `remember` MCP tool, for agents that finish
   working something out.
3. **Human**: `thinker add note.json`.

## The learning loop

Each session both consumes and improves the cache:

1. `UserPromptSubmit` hook injects the orientation bundle and records which
   note ids were served in this session.
2. At `Stop`, the distiller sees the trace **and the injected notes**, and
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
4. `thinker cochange` mines git history for files that change together;
   `orient` appends "X usually changes with Y (80%, n=12)" lines for the
   files the served notes point at, so co-change rules do not depend on an
   agent having traced them.

5. Maintenance runs by itself (`maintain.js:maintain`): the catch-up run that
   the prompt hooks start at most every ten minutes ends with one maintenance
   run, and so does the git `post-commit` hook that `setup`, `init` and the
   installer put in place (`--no-git-hook` leaves it out). A run refreshes the
   co-change index when `HEAD` moved, re-verifies up to 10 stale notes (the
   most served first), writes phrasings for up to 8 notes that lack them, and
   distills up to 3 pull requests merged since maintenance first ran in the
   repository (older ones are `thinker mine-prs`). Reported model cost of
   learning and maintenance is summed from the machine's log and a run stops
   at `dailyCap` (default $1 a day). `maintain` in `.thinker/config.json`
   overrides `enabled`, `dailyCap`, `verifyPerRun`, `phrasePerRun`, `prs`,
   `prsPerRun`. What a run did is shown once at the end of the next turn
   (`maintain.js:maintenanceNotice`), through the same channel as the
   cache-hit notice. `thinker maintain [--dry]` is one run by hand;
   `THINKER_NO_LEARN=1` switches it off with the rest of learning.

Learning is on by default in `setup`, `init` and the installer. Evals keep
the cache fixed with `--no-learn` at install time, or `THINKER_NO_LEARN=1` in
the environment, which also silences hooks that are already installed.

Controls for experiments: `THINKER_NO_LINKS=1`, `THINKER_NO_COCHANGE=1`,
`THINKER_MCP=off` (the MCP server offers no tools),
`THINKER_NAIVE=1` (no invalidation), `THINKER_FORCE=1` (inject regardless
of relevance), `THINKER_RERANK=haiku`, `THINKER_MIN_COVER=body,question`
(the coverage floors below, a third value is the number of words for short
queries; `0,0` turns them off).

## Serving

- MCP server (`thinker serve`, registered in `.mcp.json` by `thinker init`)
  with tools `orient(task, file?, budget?)`, `lookup(query)`, `drilldown(pointer)`,
  `remember(...)`, `feedback(id, useful, correction?)`.
- Code behind the pointers: the MCP `orient` and `lookup` end with the
  definitions the served notes point at (`ops.js:codeSnippets`: up to two per
  note and four in all, each cut to 30 lines), in what is left of the note
  budget plus `SNIPPET_BUDGET` (600 tokens; `THINKER_SNIPPET_BUDGET`). The
  hooks do not add them (`thinker orient --snippets` does). `THINKER_SNIPPETS=off`
  or `snippets: false` in `.thinker/config.json` turns them off. Measured
  against Qartez on click, the agent spent its advantage on reading whole
  files after orienting; this is what the snippets are for.
- `drilldown(pointer)` takes one `path:Symbol` (or a path, or a bare name,
  resolved through the notes' pointers and then the code) and returns the
  definition with its lines, one hop of callers (every reference, calls
  first) and callees (names the body calls that are defined in the
  repository), and the notes resting on that symbol or file
  (`ops.js:drilldown`, `codegraph.js`). Two engines answer, chosen per call
  by `cbm.js:codegraphEngine`: the code graph of codebase-memory-mcp when
  the checkout is indexed (below), else `git grep` over the language family
  of the file, which needs no index and is approximate; outside a git
  checkout it says so.
- Blast radius: a symbol pointer is served as `path:Sym:L12 [6 call sites in
  3 files]` (`[5 callers in 3 files]` from the graph). The count is made when
  the note is created and again for the symbols a verification found changed
  (`codegraph.js:annotateFanout`; `thinker rehash --fanout` redoes all),
  stored on the dep as `fanout`, and by `git grep` not made for names under
  four characters or common ones (`main`, `get`). `THINKER_FANOUT=off` skips
  both the counting and the tag.
- The code graph: [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)
  (CBM) is a single binary that indexes a repository with tree-sitter into a
  SQLite graph (`~/.cache/codebase-memory-mcp/`) and answers over MCP.
  `thinker cbm install` downloads the pinned release (`cbm.js:CBM_VERSION`,
  ~40 MB) into `~/.thinker/cbm` after checking its published SHA-256, and
  touches no agent configuration (CBM's own installer would); a binary on
  `PATH`, in `~/.local/bin` or named by `THINKER_CBM_BIN` is used too.
  `thinker cbm index` builds the graph of the checkout (CBM keys projects by
  real path, so a worktree is indexed on its own); maintenance re-indexes
  when `HEAD` moved (`maintain.js`, "code graph re-indexed"). `thinker cbm
  status` says which engine answers; `thinker cbm forget` drops the index.
  thinker runs the binary once per process as a child MCP server held by a
  worker thread and waits on it synchronously (`cbm.js:cbmCall`,
  `cbm-worker.js`), so `codegraph.js` keeps its synchronous API: the first
  question costs the binary's start (~2.5 s), later ones milliseconds. Asked
  of it: `search_graph` to resolve a pointer to a qualified name in its file,
  `trace_path` one hop both ways, `get_file_outline`; hashing, staleness and
  snippets stay on thinker's own parser or regex, which read the working
  tree. A symbol the graph knows but sees no caller of (a method called on an
  untyped instance, say) is counted by `git grep` instead. Controls:
  `THINKER_CODEGRAPH=git|cbm|auto` (auto: the graph when the checkout is
  indexed; `cbm` answers unknown rather than grep when it is not),
  `THINKER_CBM=off`. The live test needs `THINKER_CBM_TEST=1` and
  `THINKER_CBM_BIN` (it writes to CBM's index and removes its project after).
  `bench/cbm-compare.js`, `bench/cbm-pr-compare.js` and `bench/cbm-preflight.js`
  compare the arms `thinker` (notes, git grep), `cbm` (the graph alone, as the
  agent's MCP server) and `both` (notes with the graph as engine); the
  earlier comparison against Qartez is in `research/qartez-comparison/`.
- The prompt hooks serve two notes. When an agent calls `orient` with its own
  `budget`, up to five are served (past the second, a note must reach 0.7 of
  the best hit's relevance), a linked note is added instead of replacing a
  hit, and relevant notes that were not served are listed by title and id;
  `lookup` takes such an id (or a query, returning up to 3 notes by default).
  `THINKER_ORIENT_GUIDE` names a file whose text
  is put above the notes `orient` returns (per-model guidance).
- Prompt-time hook: injects the orientation bundle into every prompt
 automatically (no tool call needed). See [Supported agents](#supported-agents).
- What the user sees: the prompt hook shows the hits and what they stand for
 (`🧠 thinker: 2 cache hits (~7k tokens, ~8s saved)`), and the stop hook sums
 the turn, prompt-time and late notes together (`usage.js:cacheHitNotice`,
 `usage.js:turnNotice`). Tokens are one read per file a note rests on, time
 is `usage.js:SECONDS_PER_READ` per read; both are estimates, not
 measurements. Shown through `systemMessage` in Claude Code and Gemini CLI;
 Codex and Cursor have no channel for it from a stop hook. `THINKER_NOTICE=off`
 or `notice: false` in `.thinker/config.json` turns it off.
- Ranking: BM25 over title/answers/tags/deps/body with identifier splitting,
  plus path affinity to the current file, kind priors for orientation,
  confidence, and a stale penalty; greedy packing into the token budget
  (full note, else a one-line stub).
- Coverage floors: relevance is relative to the best note, so the best of a
  poor lot scores near 1. A note is served only if it also covers a share of
  the request's term weight: 0.10 with its body and pointers, 0.05 with its
  title, answers and tags (`rank.js:MIN_COVER`). A short query must be
  covered by more: the weight of about three of its words. This holds for
  the prompt hook, `orient`, `lookup` and late notes; a note on the current
  file is exempt. When nothing passes, nothing is served.
- The query: function words are dropped (`rank.js:STOP`), and so is what the
  request tells the agent not to do ("do not run the test suite"), which
  would otherwise bring up the notes on running tests (`rank.js:subject`).
- Phrasings: notes are written in the words of the code, requests in those
  of the product. `thinker phrase` adds to each note up to five lines of how
  a user would put it (`says`), written by a small model from the note alone;
  ranking counts them with the title and answers. Notes whose text changed
  since are done again; about $0.005 a note with Haiku.
- `THINKER_RERANK=haiku` (or `rerank` in `.thinker/config.json`) hands the
  eight best candidates to a small model, which keeps those that bear on the
  request, or none. Its choice is final: no linked note is added to it.
  Through an agent's CLI a call took 8 to 13 seconds and about $0.02, which
  is close to the 15 seconds a prompt hook is given, so it is off by default;
  with `ANTHROPIC_API_KEY` the call goes to the API directly.
- Team mode: notes are plain JSON under `.thinker/notes/`; commit them.
- Benchmark arm `live` runs the whole loop: the cache grows and
  self-corrects between tasks (`bench/RESULTS.md`, "Live loop").

## Supported agents

| agent | notes for the request | notes about files being read (`--late`) | MCP tools | written to |
|---|---|---|---|---|
| Claude Code | added to each prompt | yes | yes | `.claude/settings.local.json`, `.mcp.json` |
| Codex CLI | added to each prompt | yes | yes | `.codex/hooks.json`, `.codex/config.toml` |
| Gemini CLI | added to each prompt | yes | yes | `.gemini/settings.json` |
| Cursor | through the `orient` tool, and with the first tool result | yes | yes (approved by setup) | `.cursor/hooks.json`, `.cursor/mcp.json`, `.cursor/rules/thinker.mdc` |

- Cursor's prompt hook can allow or block a prompt but cannot add context, so
  thinker computes the notes at prompt time and hands them over with the first
  tool result. An always-applied rule also tells the agent to call `orient`.
- Codex reads a project's `.codex/` only once the project is trusted, runs a
  hook only once it is reviewed, and asks before each MCP tool call. `setup`
  and `init` take care of all three: the MCP server is registered with
  `default_tools_approval_mode = "approve"`, and the project and thinker's
  hooks are marked as trusted in Codex's own `config.toml` (`CODEX_HOME`,
  `~/.codex`). In a terminal they ask first; `--yes` skips the question,
  `--no-trust` leaves it to you, and without a terminal nothing is marked
  unless `--yes` is given. The hook entry is the hash Codex 0.157 stores
  (see [What Codex stores as trust](#what-codex-stores-as-trust)); if a later
  Codex changes it, Codex asks for the review as before. `uninstall` takes the hook entries out again.
- Cursor loads an MCP server only once it is approved; `setup` and `init`
  do that through Cursor's CLI when it is installed.
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
  Codex asks for a review again; `init` writes new entries when it is rerun.
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
- **When.** At the end of a turn (`Stop`, `AfterAgent`, `stop`), and by
  catch-up: `thinker learn` finds every session any of these agents ran in
  the repository and distills what is new. Hooks start it in the background
  at most every ten minutes, so modes that fire no end-of-session hook are
  covered too.
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
  (what `setup` and `init` now write), `codex exec` 0.157.1 loaded the
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
