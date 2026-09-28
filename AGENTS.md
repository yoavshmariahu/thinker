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

Model calls go through the Anthropic SDK when `ANTHROPIC_API_KEY` is set,
otherwise through the first installed agent CLI (`claude`, `codex`, `gemini`,
`agent`), so no extra credentials are needed.

| path | contents |
|---|---|
| `src/cli.js` | `thinker` command: `setup`, `init`, `distill`, `orient`, `lookup`, `check`, `verify`, `cochange`, `serve`, ... |
| `src/mcp.js` | MCP server exposing `orient`, `lookup`, `remember`, `feedback` |
| `src/clients.js` | adapters for Claude Code, Codex, Gemini CLI and Cursor: config files and hook formats |
| `src/transcripts.js` | session transcripts of every agent as one event form; the hook-recorded trace; finding sessions |
| `src/prs.js` | mining merged pull requests into notes |
| `src/ops.js` | core operations on notes (serve, merge, assess, link) |
| `src/deps.js` | dependency extraction and symbol-level content hashing |
| `src/rank.js` | BM25 ranking, relevance gate, budget packing |
| `src/distill.js` | transcript → notes and per-note assessments |
| `src/cochange.js` | co-change mining from git history |
| `src/guard.js` | anchoring guard: names identifiers in the request that the served notes do not cover |
| `src/usage.js` | summary of the usage log and the estimate of saved calls and tokens |
| `src/store.js`, `src/llm.js` | note storage; model access through any installed agent |
| `test/` | unit tests (`node --test`) |
| `bench/` | benchmark harness, task sets, PR data, and `RESULTS.md` |
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
notes, so none is distilled twice, by you or by a teammate. Nothing runs this
automatically.

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
  definition's block (found by a language-agnostic definition regex + brace
  or indentation block matching); without, the whole file. A note about
  `Command.invoke` does not go stale because an unrelated function in the
  same file changed.
- Pointers written in the body (`core.py:Command.main`, `Foo.bar`,
  `types.convert_type`) are extracted automatically and added as deps, so
  the tracked set matches what the note actually claims.
- Every `orient`/`lookup` re-hashes the deps of candidate notes against the
  working tree (cheap: a few files), so uncommitted edits are caught too.
  Stale notes are ranked lower and served with a `⚠ STALE` banner listing
  exactly which deps changed and how (symbol body changed / file removed /
  symbol not found).
- `thinker check` (wired to `post-commit` by `thinker init --git-hook`)
  persists statuses; `thinker verify` sends each stale note, the git diff of
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

Learning is on by default in `setup`, `init` and the installer. Evals keep
the cache fixed with `--no-learn` at install time, or `THINKER_NO_LEARN=1` in
the environment, which also silences hooks that are already installed.

Controls for experiments: `THINKER_NO_LINKS=1`, `THINKER_NO_COCHANGE=1`,
`THINKER_MCP=off` (the MCP server offers no tools),
`THINKER_NAIVE=1` (no invalidation), `THINKER_FORCE=1` (inject regardless
of relevance), `THINKER_RERANK=haiku`.

## Serving

- MCP server (`thinker serve`, registered in `.mcp.json` by `thinker init`)
  with tools `orient(task, file?, budget?)`, `lookup(query)`, `remember(...)`,
  `feedback(id, useful, correction?)`.
- The prompt hooks serve two notes. When an agent calls `orient` with its own
  `budget`, up to five are served (past the second, a note must reach 0.7 of
  the best hit's relevance), a linked note is added instead of replacing a
  hit, and relevant notes that were not served are listed by title and id;
  `lookup` takes such an id. `THINKER_ORIENT_GUIDE` names a file whose text
  is put above the notes `orient` returns (per-model guidance).
- Prompt-time hook: injects the orientation bundle into every prompt
  automatically (no tool call needed). See [Supported agents](#supported-agents).
- Ranking: BM25 over title/answers/tags/deps/body with identifier splitting,
  plus path affinity to the current file, kind priors for orientation,
  confidence, and a stale penalty; greedy packing into the token budget
  (full note, else a one-line stub).
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
  (`clients.js:codexHookHash`); if a later Codex changes it, Codex asks for
  the review as before. `uninstall` takes the hook entries out again.
- Cursor loads an MCP server only once it is approved; `setup` and `init`
  do that through Cursor's CLI when it is installed.
- Gemini CLI also drives agent mode in Gemini Code Assist, which reads the
  same MCP configuration. Google AI Studio is a web app and cannot run local
  hooks or MCP servers, so it is not supported.

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
