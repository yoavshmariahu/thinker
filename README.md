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
- Claude Code `UserPromptSubmit` hook: injects the orientation bundle into
  every prompt automatically (no tool call needed).
- Ranking: BM25 over title/answers/tags/deps/body with identifier splitting,
  plus path affinity to the current file, kind priors for orientation,
  confidence, and a stale penalty; greedy packing into the token budget
  (full note, else a one-line stub).
- Team mode: notes are plain JSON under `.thinker/notes/`; commit them.

## Status

Research prototype. The mechanism works end to end and is covered by unit
tests; the benchmark shows modest savings in turns and input tokens with
scores within noise of the no-cache baseline (see [Benchmark](#benchmark)).

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
| `src/cli.js` | `thinker` command: `init`, `distill`, `orient`, `lookup`, `check`, `verify`, `cochange`, `serve`, ... |
| `src/mcp.js` | MCP server exposing `orient`, `lookup`, `remember`, `feedback` |
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

## Quick start

```bash
cd your-repo
node /path/to/thinker/src/cli.js init --hooks --git-hook
# work with Claude Code as usual; notes accumulate in .thinker/notes/
node /path/to/thinker/src/cli.js list
node /path/to/thinker/src/cli.js orient "add rate limiting to the upload endpoint"
node /path/to/thinker/src/cli.js check && node /path/to/thinker/src/cli.js verify
```

LLM calls go through the Anthropic SDK when `ANTHROPIC_API_KEY` is set,
otherwise through `claude -p` (headless Claude Code), so no extra credentials
are needed.

## Benchmark

`bench/` runs real tasks on real repos with `claude -p`, with and without the
cache, and records turns, tool calls, tokens, wall-clock, cost and a judged
score against expert reference answers:

```bash
node bench/warmup.js click 2 sonnet          # learning tasks → notes
node bench/gold.js click opus                # reference answers
node bench/run.js --repo click --arm nocache,cache --conc 3 --tag v1
```

Headline numbers (Sonnet, 2 seeds; details and caveats in `bench/RESULTS.md`):

| setting | turns | input tokens | wall | success |
|---|---|---|---|---|
| click questions, no cache → hook | 4.4 → 3.6 | 74k → 67k | 15s → 14s | 0.86 → 0.83 |
| mitmproxy PR-body changes, no cache → hook | 6.9 → 6.3 | 154k → 134k | 21s → 19s | 0.98 → 0.97 (prompt-only control matches: instruction effect) |
| mitmproxy symptom-only changes, no cache → hook | 8.7 → 7.8 | 203k → 186k | 30s → 23s | 0.90 → 0.88 (prompt-only control does not match: content effect) |
| same, live loop pass 1 (cache fed by earlier tasks only) | 6.9 | 153k | 18s | 0.83 |

Lessons: inject via hook, not tool call; gate on relevance; keep a prompt-only control and an irrelevant-notes control; track per-note helped/hurt; stale notes rarely mislead an agent that re-reads code, so invalidation mostly protects commands and rules.
