# thinker versus codebase-memory-mcp on click, and what it changed in thinker

Date: 2026-10-03. Agent: Claude Code 2.1.288, `claude -p --model sonnet`, no edit tools, 30 turns.
Judge: Fable (`claude-fable-5-1`) against the expert reference answers of `bench/tasks/click.json`,
blind to the arm; 1.0 when every key fact is present, 0.5 when the main point is right but specifics
are missing, 0 when wrong. Harness: `bench/cbm-compare.js`; report: `bench/cbm-report.js`.
Runs: `bench/runs/click-thinker-vs-cbm` (v1) and `bench/runs/click-thinker-vs-cbm-v2`.

## Question

[codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) (CBM, 0.11.0) indexes a
repository with tree-sitter into a graph and gives the agent 17 MCP tools. The earlier Qartez study
(`../qartez-comparison/`) had shown a symbol-index server letting the agent answer without any
Read, Grep or shell call. Does CBM give the agent something thinker's notes do not, and if so, what
exactly, so that thinker can provide it itself?

## Arms

- **thinker**: the frozen `click-systematic` noteset (11 notes) served through thinker's MCP tools,
  learning off, `git grep` behind callers, callees and blast radius.
- **cbm**: CBM's own MCP server on a graph of the same checkout, no notes.
- **both**: thinker with CBM as the engine behind its tools (`THINKER_CODEGRAPH=cbm`). Reported for
  completeness; the decision after this study was to keep thinker's own engine (see below).

All 12 comprehension tasks of `bench/tasks/click.json`, one run per task and arm, arm order rotated
across tasks, one clean worktree per arm.

## What the transcripts showed (v1)

With CBM the agent called `search_graph` with a free-text query (a ranked list of definitions with
line ranges) and then `get_code_snippet(source_mode=full)` for each symbol it wanted, 4.3 snippets a
task, and read files on its own 0.7 times a task. With thinker it called `orient`, then `drilldown`
on one pointer, got the first ~87 lines of a 164-line method, and finished with `Read` at an offset
and `grep` (1.9 reads and 1.7 shell calls a task). Two things were missing from thinker:

1. a way to ask *where is the code about X* when no note answers it: `drilldown` needed a
   `path:Symbol` the agent already knew, `lookup` searched the notes only;
2. the whole definition: `drilldown` cut code at two thirds of a 1,500-token budget and took one
   pointer per call, so every second symbol cost another tool call or a `Read`.

Fable scored the v1 arms (E1–E12): **cbm 0.92, 10/12 passes; thinker 0.75, 6/12**, at the same
cost ($0.31 a task). The misses were depth, not direction: the thinker answers named the right
symbols and lacked the specifics inside them (an ordering condition, a backstop branch, the exact
exit path) that the CBM agent had read in full.

## What was built (commit 6eb31a8)

- `find(query, path?)`: the definitions whose name or body carry the words of the query, as
  `path:Symbol:L12` pointers with their size and blast radius, plus the notes resting on them. One
  fixed-string `git grep -c` over the source files, the lines of the 50 most-mentioning files
  attributed to the enclosing definition through the outline (parser, graph or regex), name matches
  above body mentions above path matches, common words weighted down, tests scaled down, bodies over
  1,500 lines dropped. 0.1 s on click, about 5 s on PostHog (44k files). No index.
- `drilldown` takes several pointers at once, returns each definition whole within the budget
  (default 2,500 tokens, about 150 lines), shows a class that does not fit as its head and the
  outline of its members, and keeps callers and callees for a single pointer.

## Results (v2: thinker arms rerun with the new tools; cbm unchanged)

| arm | n | wall s | calls | MCP calls | Reads | greps/shell | input ktok | cost $ | Fable score | strict pass |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| thinker (old tools, v1) | 12 | 43.1 | 7.2 | 2.5 | 1.3 | 1.7 | 510 | 0.311 | 0.75 ±0.08 | 6/12 |
| **thinker (find + whole drilldown, v2)** | 12 | 37.8 | 7.3 | 4.1 | 0.5 | 1.8 | 486 | 0.300 | **0.92 ±0.06** | **10/12** |
| cbm | 12 | 44.3 | 10.7 | 8.8 | 0.7 | 0.3 | 499 | 0.311 | 0.92 ±0.06 | 10/12 |
| both (v2, graph engine) | 12 | 35.9 | 6.1 | 3.6 | 0.4 | 0.8 | 420 | 0.276 | 0.88 ±0.07 | 9/12 |

Per task (Fable score / tool calls / cost):

| task | thinker old | thinker v2 | cbm |
|---|---|---|---|
| E1-flag-parsing | 0.5 / 8 / $0.40 | 0.5 / 6 / $0.35 | 0.5 / 5 / $0.25 |
| E2-option-kwarg | 0.5 / 14 / $0.42 | 1 / 9 / $0.37 | 1 / 17 / $0.42 |
| E3-help-default | 1 / 5 / $0.25 | 1 / 5 / $0.24 | 1 / 10 / $0.32 |
| E4-choice-completion | 0.5 / 12 / $0.43 | 1 / 10 / $0.34 | 1 / 16 / $0.34 |
| E5-runner-exit | 1 / 3 / $0.26 | 1 / 5 / $0.27 | 1 / 9 / $0.30 |
| E6-new-type | 0.5 / 15 / $0.44 | 0.5 / 19 / $0.48 | 1 / 20 / $0.44 |
| E7-chain-results | 1 / 3 / $0.21 | 1 / 4 / $0.22 | 1 / 5 / $0.23 |
| E8-usageerror-abort | 1 / 4 / $0.25 | 1 / 6 / $0.29 | 1 / 10 / $0.31 |
| E9-run-single-test | 0.5 / 3 / $0.22 | 1 / 5 / $0.24 | 0.5 / 2 / $0.19 |
| E10-prompt-hidden | 1 / 10 / $0.37 | 1 / 9 / $0.32 | 1 / 13 / $0.32 |
| E11-auto-envvar | 1 / 5 / $0.25 | 1 / 6 / $0.26 | 1 / 9 / $0.29 |
| E12-ctx-obj | 0.5 / 4 / $0.23 | 1 / 4 / $0.23 | 1 / 12 / $0.32 |

Tools the agent used, mean calls a task: thinker v2 `drilldown` 1.8, `find` 1.3, `orient` 1.0,
shell 1.8, `Read` 0.5; cbm `get_code_snippet` 4.3, `search_graph` 2.8, `trace_path` 0.9,
`search_code` 0.6, `Read` 0.8. In v2 the agent typically called `find` with the words of the task
scoped to `src/click`, then one `drilldown` with two or three pointers and a budget of 4,000 to
6,000 tokens, and answered.

Reading of the result: with `find` and whole-definition `drilldown`, thinker's score rose from 0.75
to 0.92 and equals CBM's, with 32% fewer tool calls (7.3 vs 10.7), 3% fewer input tokens, 4% lower
cost and 15% less wall time. The remaining two half-scores (E1, E6) are shared with or close to
CBM's own misses and are about specifics the reference answer lists (a backstop branch in
`Option.process_value`, a `tests/test_info_dict.py` fixture). With 12 tasks and one run each the
standard errors are ±0.06 to ±0.08, so "equal to CBM" is the claim, not "better".

## Decision

The graph-backed arm (`both`) was marginally cheaper ($0.276 vs $0.300) and not more accurate.
The decision was to keep thinker's own `git grep` engine behind `find` and `drilldown` and treat
CBM as a comparison baseline only, not a dependency: "close enough, and we would rather own all of
our tooling."

## Caveats

- The thinker arms run thinker's MCP server from the live worktree, so v1 thinker/both runs that
  started after the new code landed (E7-both onward, 06:27 UTC) used parts of it; the per-task table
  above keeps the v1 column as recorded. E5-runner-exit-both-0 in v1 is excluded: the agent used a
  subagent and its reply to the subagent was recorded as the answer (subagents are now disallowed).
- One run per task and arm; the judge is a model; the reference answers were written by one person.
- click is 27k lines of Python; `find`'s 5 s on PostHog is the cost to watch on large checkouts.
- The PostHog pull-request comparison (`bench/cbm-pr-compare.js`, thinker vs cbm, Fable judge) is
  in `bench/runs/posthog-thinker-vs-cbm`; see the section below once complete.
