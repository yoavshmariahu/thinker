# thinker: internals and working context

Reference for agents and contributors working on this repository. The
user-facing summary is in `README.md`; benchmark results are in
`bench/RESULTS.md`.

```
agent session ──► distill ──► .thinker/local/notes/*.json ──► orient / lookup (MCP)
                                   │ explicit share             ▲
                                   └──► .thinker/notes/*.json ───┘
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
| `src/mcp.js` | MCP server exposing `orient`, `lookup`, `find`, `drilldown`, `remember`, `feedback` |
| `src/setup.js` | the guided `setup` flow: agent selection and login check, cache build with estimates, optional PR benchmark |
| `src/clients.js` | adapters for Claude Code, Codex, Gemini CLI and Cursor: config files and hook formats |
| `src/transcripts.js` | session transcripts of every agent as one event form; the hook-recorded trace; finding sessions |
| `src/prs.js` | mining merged pull requests into notes |
| `src/ops.js` | core operations on notes (serve, merge, assess, link) |
| `src/deps.js` | dependency extraction and symbol-level content hashing |
| `src/ast.js` | symbol boundaries by tree-sitter (Python, JS/TS, Go, Rust) when its grammars are installed (`thinker ast install`); `deps.js` falls back to regex heuristics |
| `src/codegraph.js` | one hop of the call graph: references and blast radius of a symbol (`fanout`), callers, callees, definitions, outlines, and `findSymbols` (the definitions carrying the words of a query); behind `find`, `drilldown` and the `[n call sites in m files]` tags on pointers. From the code graph when the checkout is indexed, else from `git grep` |
| `src/cbm.js`, `src/cbm-worker.js` | codebase-memory-mcp as the code-graph engine: install, index, and a synchronous bridge to the binary run as a child MCP server (`thinker cbm`) |
| `src/rank.js` | BM25 ranking, relevance gate, budget packing |
| `src/distill.js` | transcript → notes and per-note assessments |
| `src/cochange.js` | co-change mining from git history |
| `src/maintain.js` | background maintenance: re-verify stale notes, phrase new ones, refresh co-change, distill newly merged PRs, under a daily cap |
| `src/guard.js` | anchoring guard: names identifiers in the request that the served notes do not cover |
| `src/update.js` | CLI self-update and daily automatic background updates (LaunchAgent / cron / invocation) |
| `src/usage.js` | summary of the usage log and the estimate of saved calls and tokens, in tokens and in dollars |
| `src/prices.js` | dollars per token by model: Anthropic's list prices, the user's for other vendors |
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

The same balance is given in dollars where the model is known (`prices.js`). The
end-of-session assessment records the model the session ran on, read from its
transcript (`transcripts.js:parseTranscript` returns `model`: Claude Code's
`message.model`, Codex's `turn_context`, Gemini's message `model`; Cursor names none),
on the `attest` line; for assessments written before that, `usage` finds the transcript
by session id (`transcripts.js:sessionModel`). Reading avoided and notes injected are
priced at that model's input price; a model record with tokens but no reported cost is
priced from its tokens (`spending.estimatedCost`). Anthropic's list prices are built in;
other vendors' go in `THINKER_HOME/prices.json` or under `prices` in
`.thinker/config.json` (`{"gpt-6-sol": {"input": 2, "output": 8}}`, dollars per million).
What has no model or price is counted and reported (`saved.unpricedServings`,
`injected.unpricedTokens`, `spending.unpricedCalls`), never taken as zero or as free.

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
- Every `orient`/`lookup` re-hashes the deps of every note against the
  working tree, so uncommitted edits are caught too. A whole-file dep on a
  file the note also points into by symbol is dropped when the note is
  created or verified (`ops.js:dropShadowedFileDeps`). Maintenance and
  `thinker check` judge a changed whole-file dep further
  (`deps.js:narrowFileDep`, `checkNote` with `narrow`): when the body names
  definitions in the file and none of them changed since `verifiedCommit`,
  the dep becomes those symbol deps; when it names none and no changed line
  of the diff since `verifiedCommit` holds a term the note uses, the dep
  keeps the file and takes the new hash. Either way the note stays fresh
  and the outcome is persisted, so the per-prompt check sees it. A
  `cochange` note's whole-file deps are existence-only: a partner file
  changing is what the note predicts.
  Stale notes are ranked lower and served with a `⚠ STALE` banner listing
  exactly which deps changed and how (symbol body changed / file removed /
  symbol not found).
- The `verify` log record names the deps that triggered it (`changed`).
- `thinker check` persists statuses; `thinker verify` sends each stale note, the git diff of
  its changed deps since `verifiedCommit`, and the current text of every dep
  to a small model (Haiku by default) which answers `still_valid` (re-hash,
  bump confidence), `update` (rewrite body, keep history) or `invalid`
  (retire).

## Capture

1. **Automatic**: `thinker distill <transcript.jsonl>` condenses a session
   (prompts, tool calls with truncated results, the agent's final answer)
   and asks a model for 0–4 notes with deps. The end-of-turn hook runs this
   incrementally in the background (on by default; see below). The distiller
   is shown the notes already resting on the files the session touched
   (`distill.js:relatedNotes`) and may return one with `extends: <id>` and
   the merged body instead of a new note. Near-duplicate notes (same kind,
   ≥0.5 Jaccard on title+answers) are merged, keeping history. A `cochange`
   note must name a mechanism (a generator, registry, schema, mirror or
   test); one that only lists the files a session touched is not saved
   (`distill.js:cochangeMechanism`), since git history holds that already.
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
4. `thinker cochange` mines git history for files that change together.
   The edit hook (`ops.js:lateNotes`) names the partners of each file the
   agent edits, once per file, leaving out those the session has edited
   ("X usually changes with Y (80%, n=12)"), and the end-of-session nudge
   repeats what is still untouched; so co-change rules do not depend on an
   agent having traced them. `cochange` notes are edit-time rules too: at
   orientation one is served only when the request names its files or
   symbols (`rank.js`, `ccNamed`).

5. Maintenance runs by itself (`maintain.js:maintain`): the catch-up run that
   the prompt hooks start at most every ten minutes ends with one maintenance
   run, and so do the git `post-commit` and `post-merge` hooks that `setup`, `init` and the
   installer put in place (`--no-git-hook` leaves it out). A run refreshes the
   co-change index when `HEAD` moved, re-verifies up to 10 stale notes, writes
   phrasings for up to 8 notes that lack them, and distills up to 3 pull
   requests merged since maintenance first ran in the repository (older ones
   are `thinker mine-prs`). Re-verification ahead of time is for notes served in
   the last 14 days (`verifyServedDays`; 0: all), the most served first; a
   stale note nobody is reading waits until it is served, when serving
   verifies it in the background anyway (`ops.js:scheduleVerify`). A note
   re-verified 3 times in a week (`verifyChurn`; 0: never) rests on code under
   active change: it is left stale, with its ⚠ banner, and named to the user
   once (`maintain.js:pickStale`), to narrow its pointers or retire it. In the
   week this was added, 28 of 80 notes maintenance verified had not been served
   at all, and one note was rewritten 8 times. Reported model cost of
   learning and maintenance is summed from the machine's log and a run stops
   at `dailyCap` (default $1 a day). `maintain` in `.thinker/config.json`
   overrides `enabled`, `dailyCap`, `verifyPerRun`, `verifyServedDays`,
   `verifyChurn`, `phrasePerRun`, `prs`, `prsPerRun`. What a run did is shown once at the end of the next turn
   (`maintain.js:maintenanceNotice`), through the same channel as the
   cache-hit notice. `thinker maintain [--dry]` is one run by hand;
   `THINKER_NO_LEARN=1` switches it off with the rest of learning.

Learning is on by default in `setup`, `init` and the installer. Evals keep
the cache fixed with `--no-learn` at install time, or `THINKER_NO_LEARN=1` in
the environment, which also silences hooks that are already installed.
`learn: {"sessions": false}` in `.thinker/config.json` switches off learning
from sessions alone (the end-of-turn distill and the catch-up `learn`), while
learning from code changes goes on: pull requests and re-verification in
maintenance, `share --repair-staged` at commit, `thinker distill <file>` by
hand. Each session distilled is a model call, about 10¢ with Sonnet, and in a
week on this repository 30% of them produced no note; without them there are
also no assessments, so `thinker usage` counts no servings as acted on.

Controls for experiments: `THINKER_NO_LINKS=1`, `THINKER_NO_COCHANGE=1`,
`THINKER_MCP=off` (the MCP server offers no tools),
`THINKER_NAIVE=1` (no invalidation), `THINKER_FORCE=1` (inject regardless
of relevance), `THINKER_RERANK=haiku`, `THINKER_MIN_COVER=body,question`
(the coverage floors below, a third value is the number of words for short
queries; `0,0` turns them off).

## Serving

- MCP server (`thinker serve`, registered in `.mcp.json` by `thinker init`)
  with tools `orient(task, file?, budget?)`, `lookup(query)`, `find(query, path?)`, `drilldown(pointer)`,
  `remember(...)`, `feedback(id, useful, correction?)`.
- Code behind the pointers: the MCP `orient` and `lookup` end with the
  definitions the served notes point at (`ops.js:codeSnippets`: up to two per
  note and four in all, each cut to 30 lines), in what is left of the note
  budget plus `SNIPPET_BUDGET` (600 tokens; `THINKER_SNIPPET_BUDGET`). The
  hooks do not add them (`thinker orient --snippets` does). `THINKER_SNIPPETS=off`
  or `snippets: false` in `.thinker/config.json` turns them off. Measured
  against Qartez on click, the agent spent its advantage on reading whole
  files after orienting; this is what the snippets are for.
- `find(query, path?, limit?)` answers "where is this defined / handled" when
  no note does: the definitions whose name or body carry the words of the
  query (`codegraph.js:findSymbols`), as `path:Symbol:L12` pointers with their
  size and, for the first three, blast radius, plus the notes resting on them.
  One `git grep -c -F -i` for the words over the source files (a second or
  two on PostHog), the lines of the 50 files with most mentions attributed to
  the enclosing definition through `outline` (parser, graph, or regex), and the
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
  (`ops.js:drilldown`, `codegraph.js`). Two engines can answer, chosen per
  call by `cbm.js:codegraphEngine`: `git grep` over the language family of
  the file, which needs no index and is approximate, is the default; the
  code graph of codebase-memory-mcp (below) answers only when
  `THINKER_CODEGRAPH=cbm` (or `auto`, when the checkout is indexed) asks for
  it. Outside a git checkout it says so.
- Blast radius: a symbol pointer is served as `path:Sym:L12 [6 call sites in
  3 files]` (`[5 callers in 3 files]` from the graph). The count is made when
  the note is created and again for the symbols a verification found changed
  (`codegraph.js:annotateFanout`; `thinker rehash --fanout` redoes all),
  stored on the dep as `fanout`, and by `git grep` not made for names under
  four characters or common ones (`main`, `get`). `THINKER_FANOUT=off` skips
  both the counting and the tag.
- The code graph (optional, off by default): [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)
  (CBM) is a single binary that indexes a repository with tree-sitter into a
  SQLite graph (`~/.cache/codebase-memory-mcp/`) and answers over MCP. It is
  kept as the comparison baseline of the benchmarks and as an opt-in engine;
  measured on click (`research/cbm-comparison/`) the graph-backed arm was
  marginally cheaper and no more accurate than thinker's own tools, and the
  decision was to own the tooling rather than depend on a second binary.
  `thinker cbm install` downloads the pinned release (`cbm.js:CBM_VERSION`,
  ~40 MB) into `~/.thinker/cbm` after checking its published SHA-256, and
  touches no agent configuration (CBM's own installer would); a binary on
  `PATH`, in `~/.local/bin` or named by `THINKER_CBM_BIN` is used too.
  `thinker cbm index` builds the graph of the checkout (CBM keys projects by
  real path, so a worktree is indexed on its own); when the engine is the
  graph, maintenance re-indexes when `HEAD` moved (`maintain.js`, "code graph
  re-indexed"). `thinker cbm
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
  `THINKER_CODEGRAPH=git|cbm|auto` (`git`, the default; `auto`: the graph
  when the checkout is indexed; `cbm` answers unknown rather than grep when
  it is not),
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
- What the user sees: the prompt hook names the notes and the size of the
 code they point at (`🧠 thinker: 2 notes (pointing at ~7k tokens of code)`),
 and the stop hook sums the turn, prompt-time and late notes together
 (`usage.js:cacheHitNotice`, `usage.js:turnNotice`). Tokens are one read per
 file a note rests on. The notice does not say "saved": at serve time nothing
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
  not). A short query must be covered by more: the weight of about three of
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
- The prompt hooks serve no stale note (`orient`'s `freshOnly`). A stale
  note that would have been served is held back, logged as `held` on the
  `orient` line, verified in the background as if it had been served
  (`ops.js:scheduleVerify`), and served on a later turn once it is fresh
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
  since are done again; about $0.005 a note with Haiku.
- `THINKER_RERANK=haiku` (or `rerank` in `.thinker/config.json`) hands the
  eight best candidates to a small model, which keeps those that bear on the
  request, or none. Its choice is final: no linked note is added to it.
  Through an agent's CLI a call took 8 to 13 seconds and about $0.02, which
  is close to the 15 seconds a prompt hook is given, so it is off by default;
  with `ANTHROPIC_API_KEY` the call goes to the API directly.
- Team mode: `.thinker/local/notes/` holds learned notes and ignores itself in git.
  `.thinker/notes/` holds committed content, written only by explicit `thinker share`
  (or `rm` / manual edits). `.thinker/local/shared/` holds per-checkout state and pending
  corrections for shared notes, tied to a content digest; pulled content supersedes old
  corrections and staleness. `Store.list/get` serve their union; shared IDs win.
  Untracked legacy notes migrate to local on first use; tracked files are left unchanged.
  A change pending here when a pull replaces the note is not dropped: it is kept in the overlay
  as `superseded` (`Store.superseded`), named by `thinker share [--dry]`, `thinker show` and the
  maintenance notice, and cleared when the note is shared again from here. Note files that
  cannot be read (a merge conflict, invalid JSON, an id that does not match the file name) are
  skipped by the store and named by `list`, `check` and `share` (`Store.unreadable`), so a
  conflicted note does not just vanish. Maintenance removes overlays of shared notes that no
  longer exist unless they hold unshared content (`Store.sweepOverlays`).
  `THINKER_NOTES_DIR` retains a flat store for benchmarks. Inventory of other checkouts
  uses `new Store(repo, { readonly: true })` and never migrates them.
- `thinker share [ids…] [--all] [--dry]` promotes fresh, valid notes from trusted sources
  (pr/human/doc or a confirmed session), pending updates, and locally retired shared notes.
  IDs / `--all` bypass only trust. Near-duplicates, invalid deps, common secret patterns,
  home paths and bodies over 12,000 bytes are rejected. Serving and assessment never
  rewrite shared files. Maintenance reconciles local duplicates and reports new ready
  notes once, only with a shared cache or `share: true` in config.
- `thinker share --check --base origin/main` reports note and dependency issues at
  HEAD for CI; `--ref` selects another commit. The command exits 0 by default;
  `--strict` opts into exit 2 for validation errors. `--pre-push` reads Git's
  ref lines and always exits 0 so no push is blocked. Git's pre-push snapshot
  cannot be rewritten safely, so the new `pre-commit` hook runs
  `thinker share --repair-staged` first. It reads code and notes from the index,
  fixes metadata, asks a small model about notes whose deps changed, and updates
  or removes bad notes in the index. Original bytes go to
  `.thinker/local/quarantine/`; unstaged working-copy edits are preserved.
  `init`/`setup` install pre-commit, pre-push, post-merge and post-commit through
  `git-hooks.js`, preserving custom hooks; uninstall removes only thinker hooks.
  `THINKER_NO_LEARN=1` disables background and pre-commit hooks for fixed-cache
  experiments. Rebase is covered by prompt catch-up.
- `share.js` owns promotion and commit validation; `deps.js:hashText/hashDepAt` reuse
  symbol hashing and parser/regex compatibility on commit content. `transfer.js` exports
  both effective caches and imports through the local store without touching shared files.
- Benchmark arm `live` runs the whole loop: the cache grows and
  self-corrects between tasks (`bench/RESULTS.md`, "Live loop").

## Supported agents

| agent | notes for the request | notes about files being edited (installed by default; `--no-late` leaves it out) | MCP tools | written to |
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
