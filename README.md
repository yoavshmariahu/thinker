# thinker — a cache of understanding for coding agents

Coding agents re-orient in a repo every session: grep, read, trace imports,
figure out how X flows from A to B. `thinker` caches that understanding as
short, dependency-keyed notes and serves them back through MCP, so the next
agent (or the next person) starts from what the last one worked out.

```
agent session ──► distill ──► .thinker/notes/*.json ──► orient / lookup (MCP)
                                   │
                          deps + content hashes
                                   │
             commit / edit ──► stale ──► verify (small model) ──► fresh | updated | retired
```

## Set up a repository in one line

From inside the repository (the thinker repository is private, so this needs
`gh auth login` with access to it):

```bash
gh api repos/yoavshmariahu/thinker/contents/install.sh -H "Accept: application/vnd.github.raw" | bash -s -- --build
```

This installs the tool under `~/.thinker`, builds the cache and wires it into
the coding agents found on the machine:

1. mines co-change edges from git history;
2. distills up to 60 merged pull requests of the GitHub `origin` into fix
   records, invariants and conventions (`--prs n`; needs `gh`);
3. runs one exploration session per source area and distills it (`--areas n`,
   default 12);
4. links the notes and installs hooks and the MCP server for each agent
   (`--clients claude,codex,cursor,gemini`, `all`, or `auto`, the default).

Steps 2 and 3 use your Claude login through the `claude` CLI: about $0.45 per
area and $0.06 per pull request in earlier builds, so roughly $9 with the
defaults. The estimate is printed before anything runs. Hook and MCP files
are written for this checkout only and kept out of commits through
`.git/info/exclude`; pass `--shared` to write committable files instead.

With a thinker checkout, the same thing is `thinker setup` (it asks before
spending when run in a terminal; `--yes` skips the question). If a cache was
already built for the repository, use `--cache <file|url>` instead of
`--build`; see `ONBOARDING.md`.

## Benchmark

Real tasks taken from merged pull requests, run with and without the cache, graded on behavioural acceptance criteria calibrated against the merged patch. Full method, all arms and caveats are in `bench/RESULTS.md`.

### PostHog symptom tasks, Fable and Cursor Auto

Same 14 tasks, same notes (`bench/notesets/posthog-v2`), same arms (`nocache`, `hook`), graded by Sonnet on the calibrated criteria in `bench/tasks/posthog-hard.json`. Fable is `claude -p --model fable` (`bench/runs/posthog-fable`). Cursor Auto ran in isolated checkouts; the cached arm received the same `orient` bundle the hook injects, pasted at the start of the session. Auto has no token or dollar accounting. Its wall clock starts from a minute-resolution timestamp.

Fable, 40 of 40 runs graded, 20 complete pairs: 14 tasks at seed 0 and 6 of them again at seed 1.

| arm | calls | input | cost | time | essential met | strict pass |
|---|---|---|---|---|---|---|
| no cache | 18.1 | 1.25M | $2.72 | 2.7 min | 0.79 ±0.07 | 9/20 |
| cache | 14.9 | 1.02M | $2.45 | 2.3 min | 0.89 ±0.05 | 14/20 |

With the cache, Fable used 17% fewer calls, 18% fewer input tokens, 10% less cost ($0.28 ±0.12 per run, cheaper in 15 of 20 pairs) and 14% less time. Essential met moved +0.10 ±0.08 (better on 8 pairs, unchanged on 9, worse on 3), which is within noise at this sample size. This run had no prompt-only control, so the saving is not separated into instruction and content effects.

Cursor Auto has five finished pairs, all seed 0 (`bench/runs/posthog-auto`). Each cell is calls, essential met, and whether every essential criterion passed. Nine tasks are still incomplete. The stable-chunk cache arm (PR106564) has finished at 287 calls with essential met 0.00; its no-cache arm is not in yet. Fable on that task went from 0.80 to 1.00 with the cache.

| task | Fable, no cache | Fable, cache | Auto, no cache | Auto, cache |
|---|---|---|---|---|
| playground URL (PR106613) | 4 calls, 1.00, pass | 3 calls, 1.00, pass | 87 calls, 0.67, fail | 48 calls, 1.00, pass |
| shared-metric ids (PR106672) | 28 calls, 0.86, fail | 14 calls, 1.00, pass | 107 calls, 1.00, pass | 106 calls, 1.00, pass |
| stop a broadcast (PR106466) | 21 calls, 1.00, pass | 13 calls, 1.00, pass | 112 calls, 1.00, pass | 98 calls, 0.67, fail |
| invite existing member (PR106936) | 23 calls, 0.67, fail | 20 calls, 1.00, pass | 196 calls, 1.00, pass | 169 calls, 1.00, pass |
| insight layout (PR107042) | 17 calls, 1.00, pass | 20 calls, 0.80, fail | 178 calls, 0.60, fail | 179 calls, 0.80, fail |

Across these five, Fable went from 18.6 to 14.0 calls and from 3/5 to 4/5 strict passes with the cache. Auto went from 136 to 120 calls and stayed at 3/5 strict passes. The cache helped Auto on the playground rename and raised the insight-layout score from 0.60 to 0.80, still short of a strict pass. It did not change the shared-metric or invite outcome, both of which already passed. On the broadcast task it lowered essential met from 1.00 to 0.67.

### Across models, same PostHog symptom tasks

| model | cost per task without cache | tool calls without cache | effect of the cache |
|---|---|---|---|
| Fable | $2.72 | 18 | 18% fewer input tokens, 10% lower cost, essential met 0.79 → 0.89, strict passes 9/20 → 14/20 |
| Opus | $4.54 | 58 | no change in cost or success: notes cut exploration before the first edit by about a quarter, and Opus spends that on more edits and tests (7 tasks, 1 seed) |
| Sonnet | $0.41 | 13 | 2 to 9% fewer input tokens, success unchanged (14 tasks, 2 to 3 seeds) |

On the three tasks run on all models, Fable with the cache met every essential criterion at $2.27 per task; Opus without it met 0.95 at $4.26, and Sonnet with it 0.75 at $0.36.

These are vague, symptom-only requests, the harder case. On requests that name the code involved, Sonnet used 27% fewer turns and 32% fewer input tokens on PostHog with the cache at equal success, and a prompt-only control showed the saving comes from the notes.

### Earlier repositories (Sonnet, 2 seeds)

| setting | turns | input tokens | wall | success |
|---|---|---|---|---|
| setting | turns | input tokens | wall | success |
|---|---|---|---|---|
| click questions, no cache → hook | 4.4 → 3.6 | 74k → 67k | 15s → 14s | 0.86 → 0.83 |
| mitmproxy PR-body changes, no cache → hook | 6.9 → 6.3 | 154k → 134k | 21s → 19s | 0.98 → 0.97 (prompt-only control matches: instruction effect) |
| mitmproxy symptom-only changes, no cache → hook | 8.7 → 7.8 | 203k → 186k | 30s → 23s | 0.90 → 0.88 (prompt-only control does not match: content effect) |
| same, live loop pass 1 (cache fed by earlier tasks only) | 6.9 | 153k | 18s | 0.83 |

### Running the benchmark

`bench/` runs real tasks on real repos with `claude -p`, with and without the
cache, and records turns, tool calls, tokens, wall-clock, cost and a judged
score against expert reference answers:

```bash
node bench/warmup.js click 2 sonnet          # learning tasks → notes
node bench/gold.js click opus                # reference answers
node bench/run.js --repo click --arm nocache,cache --conc 3 --tag v1
```

Lessons: inject via hook, not tool call; gate on relevance; keep a prompt-only control and an irrelevant-notes control; track per-note helped/hurt; stale notes rarely mislead an agent that re-reads code, so invalidation mostly protects commands and rules.

## Supported agents

| agent | notes for the request | notes about files being read (`--late`) | MCP tools | written to |
|---|---|---|---|---|
| Claude Code | added to each prompt | yes | yes | `.claude/settings.local.json`, `.mcp.json` |
| Codex CLI | added to each prompt | yes | yes | `.codex/hooks.json`, `.codex/config.toml` |
| Gemini CLI | added to each prompt | yes | yes | `.gemini/settings.json` |
| Cursor | after the agent's first tool call | yes | yes | `.cursor/hooks.json`, `.cursor/mcp.json`, `.cursor/rules/thinker.mdc` |

- Cursor's prompt hook can allow or block a prompt but cannot add context, so
  thinker computes the notes at prompt time and hands them over with the first
  tool result. An always-applied rule also tells the agent to call `orient`.
- Codex runs project hooks only after you trust the project and review the
  hook; Cursor asks you to approve the MCP server.
- Gemini CLI also drives agent mode in Gemini Code Assist, which reads the
  same MCP configuration. Google AI Studio is a web app and cannot run local
  hooks or MCP servers, so it is not supported.
- Learning from sessions (`--learn`) and the usage-based feedback loop read
  Claude Code transcripts and work with Claude Code only. The other agents
  are served from the cache and can add notes through the `remember` tool.
- Tested: generated configuration, hook input and output for each agent, and
  the MCP server, by unit tests and a scratch-repo install. Not yet tested:
  live sessions in Codex, Gemini CLI and Cursor.

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

1. **Automatic**: `thinker distill <transcript.jsonl>` condenses a Claude
   Code session (prompts, tool calls with truncated results, the agent's
   final answer) and asks a model for 0–4 notes with deps. Claude Code's
   `Stop` hook runs this incrementally in the background
   (`thinker init --hooks`). Near-duplicate notes (same kind, ≥0.5 Jaccard on
   title+answers) are merged, keeping history.
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

Controls for experiments: `THINKER_NO_LINKS=1`, `THINKER_NO_COCHANGE=1`,
`THINKER_NAIVE=1` (no invalidation), `THINKER_FORCE=1` (inject regardless
of relevance), `THINKER_RERANK=haiku`.

## Serving

- MCP server (`thinker serve`, registered in `.mcp.json` by `thinker init`)
  with tools `orient(task, file?, budget?)`, `lookup(query)`, `remember(...)`,
  `feedback(id, useful, correction?)`.
- Benchmark arm `live` runs this whole loop: the cache grows and
  self-corrects between tasks (`bench/RESULTS.md`, "Live loop").
- Prompt-time hook: injects the orientation bundle into every prompt
  automatically (no tool call needed). See [Supported agents](#supported-agents).
- Ranking: BM25 over title/answers/tags/deps/body with identifier splitting,
  plus path affinity to the current file, kind priors for orientation,
  confidence, and a stale penalty; greedy packing into the token budget
  (full note, else a one-line stub).
- Team mode: notes are plain JSON under `.thinker/notes/`; commit them.

## Status

Research prototype. The mechanism works end to end and is covered by unit
tests; the benchmark shows savings that depend on the model and on how specific
the request is (see [Benchmark](#benchmark)).

## Install

Requires Node 20+ and, for LLM calls, either `ANTHROPIC_API_KEY` or a
logged-in `claude` CLI.

```bash
git clone https://github.com/yoavshmariahu/thinker.git
cd thinker && npm install
npm test
```

## Repository layout

| path | contents |
|---|---|
| `src/cli.js` | `thinker` command: `setup`, `init`, `distill`, `orient`, `lookup`, `check`, `verify`, `cochange`, `serve`, ... |
| `src/mcp.js` | MCP server exposing `orient`, `lookup`, `remember`, `feedback` |
| `src/clients.js` | adapters for Claude Code, Codex, Gemini CLI and Cursor: config files and hook formats |
| `src/prs.js` | mining merged pull requests into notes |
| `src/ops.js` | core operations on notes (serve, merge, assess, link) |
| `src/deps.js` | dependency extraction and symbol-level content hashing |
| `src/rank.js` | BM25 ranking, relevance gate, budget packing |
| `src/distill.js` | transcript → notes and per-note assessments |
| `src/cochange.js` | co-change mining from git history |
| `src/guard.js` | anchoring guard: names identifiers in the request that the served notes do not cover |
| `src/store.js`, `src/llm.js` | note storage, model access |
| `test/` | unit tests (`node --test`) |
| `bench/` | benchmark harness, task sets, PR data, and `RESULTS.md` |
| `.thinker/` | thinker's own notes about this repo |

`bench/repos/` (clones of click, mitmproxy, PostHog) and `bench/runs/` (raw
run output) are not checked in. To run the benchmark, clone the target repo
into `bench/repos/<name>` first.

## Quick start from a checkout

```bash
cd your-repo
node /path/to/thinker/src/cli.js init --hooks --git-hook --clients auto
# work with Claude Code as usual; notes accumulate in .thinker/notes/
node /path/to/thinker/src/cli.js list
node /path/to/thinker/src/cli.js orient "add rate limiting to the upload endpoint"
node /path/to/thinker/src/cli.js check && node /path/to/thinker/src/cli.js verify
```

LLM calls go through the Anthropic SDK when `ANTHROPIC_API_KEY` is set,
otherwise through `claude -p` (headless Claude Code), so no extra credentials
are needed.
