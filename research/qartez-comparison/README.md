# Benchmark Comparison: Thinker vs. Qartez MCP on Codebase Understanding Tasks

**Author**: Antigravity  
**Date**: October 1, 2026  
**Subject**: Empirical 3-Task Comparison between [Thinker](https://github.com/yoavshmariahu/thinker) and [Qartez MCP](https://github.com/kuberstar/qartez-mcp) (v0.11.0)  
**Evaluation Model**: `claude-sonnet-5` via Claude Code CLI 2.1.287  
**Artifacts**: [`bench/runs/click-thinker-vs-qartez-3/`](../../bench/runs/click-thinker-vs-qartez-3/)  

---

## 1. Executive Summary

This study evaluates two contrasting paradigms for agentic code intelligence:
1. **Thinker**: A human-and-agent distilled, dependency-hashed knowledge cache. Notes answer recurring questions, invariants, gotchas, and callpaths with exact `file:symbol` content-hash tracking for invalidation. Delivered via prompt/late hooks or `orient` / `lookup` MCP tools.
2. **Qartez MCP**: A pre-computed semantic code-intelligence server written in Rust. It builds an AST-level symbol table, import graph, PageRank, blast-radius analysis, cyclomatic complexity index, and git co-change graph, exposing 43 interactive MCP tools (`qartez_find`, `qartez_map`, `qartez_read`, `qartez_outline`, `qartez_impact`, `qartez_deps`, `qartez_refs`, `qartez_calls`, etc.).

We executed a controlled, 3-task paired comparison on the `click` repository across three distinct technical dimensions:
- **`E1-flag-parsing`**: Option parsing, flag determination, parser registration, and default value propagation.
- **`E2-option-kwarg`**: Cross-cutting change-surface and blast-radius analysis for parameter forwarding into `to_info_dict`.
- **`E5-runner-exit`**: Test isolation mechanisms (`StreamMixer`, `BytesIOCopy`), standard stream interception, and exception exit-code lifecycle.

### Key Findings:
- **Zero OS Tooling with Qartez**: Under Qartez, the agent made **zero `Read` calls, zero `Grep` calls, and zero `Bash` commands**. 100% of its discovery was fulfilled through Qartez's structured MCP tools (`qartez_find`, `qartez_read`, `qartez_outline`, `qartez_refs`). In contrast, under Thinker, the agent consulted notes first, then issued 4 file reads, 5 greps, and 5 shell commands to inspect code details not present in high-level notes.
- **Latency & Token Efficiency**: Qartez completed the 3 tasks in **112.9s** cumulative wall time vs. **134.2s** for Thinker (**15.9% faster**). Qartez required **14.6% fewer cache-read tokens** (1,374k vs 1,609k) and **22.0% fewer output tokens** (9,209 vs 11,814), resulting in a **7.9% lower total cost** ($0.8914 vs $0.9681).
- **Correctness & Accuracy**: Both tools attained **100% must-hit keyword/symbol coverage** (9/9). In double-blind grading against expert ground-truth references, Qartez achieved an average score of **0.67** (including 1 strict 1.0 pass on `E5`), while Thinker averaged **0.50** (0 strict passes), primarily because Qartez provided line-precise AST boundaries that enabled the agent to capture fine-grained internal mechanisms (e.g. `StreamMixer`, `_NamedTextIOWrapper`, and `_FDCapture`).

---

## 2. Experimental Setup & Controls

To eliminate confounding variables, both arms operated under strict experimental controls:
- **Worktree Isolation**: Runs executed in dedicated, disposable git worktrees (`bench/worktrees/click-eval-thinker` and `bench/worktrees/click-eval-qartez`).
- **Telemetry Disabled**: `THINKER_TELEMETRY=off` enforced on all processes.
- **Pre-indexing Excluded**: Both systems operated on pre-built indexes:
  - Thinker used the frozen `click-systematic` noteset (11 notes).
  - Qartez pre-indexed the repo offline (taking ~0.3s for 97 files, 1,999 symbols, 146 edges).
- **Alternating Execution Order**: Task order alternated (`Thinker` -> `Qartez` on T1, `Qartez` -> `Thinker` on T2, `Thinker` -> `Qartez` on T3) to prevent provider caching bias.
- **Disallowed Modifiers**: `--disallowedTools Edit,Write,NotebookEdit` enforced on Claude Code to restrict the evaluation strictly to codebase understanding and architecture tracing.
- **Double-Blind Judging**: Graded with Claude Sonnet using standardized grading criteria, scoring 1.0 (strict pass), 0.5 (main point right, minor omissions), or 0.0 (incorrect/contradictory).

---

## 3. Comparative Results

### Summary Table

| Task | Tool | Wall (s) | API (s) | Turns | Total Calls | MCP Calls | Reads / Greps / Bash | Cache Read Tokens | Output Tokens | Cost ($) | Must Hits | Score | Verdict |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|:---:|:---:|
| **E1-flag-parsing** | **Thinker** | 27.3s | 23.4s | 8 | 7 | 2 | 1 / 1 / 1 | 391,713 | 1,945 | $0.3285 | 3/3 | 0.5 | Partial |
| | **Qartez** | 28.0s | 24.4s | 8 | 7 | 6 | 0 / 0 / 0 | 380,461 | 1,728 | $0.2559 | 3/3 | 0.5 | Partial |
| **E2-option-kwarg** | **Thinker** | 78.4s | 74.3s | 16 | 15 | 3 | 2 / 3 / 3 | 922,063 | 7,453 | $0.4215 | 3/3 | 0.5 | Partial |
| | **Qartez** | **60.0s** | **56.4s** | 19 | 18 | 17 | 0 / 0 / 0 | **736,171** | **5,921** | **$0.4104** | 3/3 | 0.5 | Partial |
| **E5-runner-exit** | **Thinker** | 28.5s | 24.7s | 6 | 5 | 1 | 1 / 1 / 1 | 295,736 | 2,416 | $0.2181 | 3/3 | 0.5 | Partial |
| | **Qartez** | **24.9s** | **21.4s** | 6 | 5 | 4 | 0 / 0 / 0 | **257,739** | **1,560** | **$0.2251** | 3/3 | **1.0** | **Pass** |
| **Totals / Averages** | **Thinker** | 134.2s | 122.4s | 30 | 27 | 6 | 4 / 5 / 5 | 1,609,512 | 11,814 | $0.9681 | 9/9 | 0.50 | 0 Passes |
| | **Qartez** | **112.9s** | **102.2s** | 33 | 30 | 27 | **0 / 0 / 0** | **1,374,371** | **9,209** | **$0.8914** | 9/9 | **0.67** | **1 Pass** |
| *Difference* | | *-15.9%* | *-16.5%* | *+10%* | *+11%* | *+350%* | *-100%* | *-14.6%* | *-22.0%* | *-7.9%* | *0%* | *+34%* | *+1 Pass* |

---

## 4. Deep-Dive per Task

### Task 1: `E1-flag-parsing`
- **Objective**: Identify where Click determines that an option is a flag, how it affects parser registration, and how default values are resolved when the flag is absent.
- **Thinker**: The agent queried `orient` and `lookup`. While the cache held general command lifecycle notes, there was no dedicated note on `Option.__init__` flag auto-detection. The agent recognized the gap, used `Grep` and `Read` on `src/click/core.py`, and accurately answered the `Option.__init__` and `add_to_parser` mechanics.
- **Qartez**: The agent queried `qartez_find(name="Option")`, `qartez_outline(file="src/click/core.py")`, and `qartez_read(symbols=["Option.add_to_parser", "Option.get_default"])`. It reconstructed the exact constructor logic and const-action parser registration without reading arbitrary file chunks.
- **Judge Verdict**: Both received 0.5. Both correctly nailed `Option.__init__` and `add_to_parser`, but both omitted the deeper parser internals in `src/click/parser.py` (`_Option.takes_value`, `_Option.process`).

### Task 2: `E2-option-kwarg`
- **Objective**: Trace the addition of `sensitive=True` on `@click.option` into `to_info_dict`. Identify all necessary changes and explain why intermediate functions do not require modification.
- **Thinker**: Thinker's note on `parameter-type-conversion-and-validation-callpath` pointed the agent towards parameter initialization. The agent explored alternative design trade-offs (`Parameter` vs `Option`), running multiple greps and bash commands across `decorators.py` and `core.py`. Total time: 78.4s.
- **Qartez**: Qartez's `qartez_find` and `qartez_refs` allowed the agent to immediately trace how `Option` inherits from `Parameter`, how `to_info_dict` overrides the base implementation, and which callers exist. Total time: 60.0s (18.4s faster).
- **Judge Verdict**: Both received 0.5. Both accurately determined that `Option.__init__` and `Option.to_info_dict` are the essential code changes and ruled out `decorators.option`. However, both left out secondary conventions such as `tests/test_info_dict.py` fixture updates and `CHANGES.md`.

### Task 3: `E5-runner-exit`
- **Objective**: Explain how `CliRunner.invoke` captures `stdout` and `stderr` separately, how exit codes are determined for `SystemExit` vs other exceptions, and where the captured exception is stored on `Result`.
- **Thinker**: Thinker had a high-confidence note (`cli-command-testing-with-clirunner-and-isolated-streams`). The agent used `mcp__thinker__lookup` to fetch it and verified the implementation in `src/click/testing.py`.
- **Qartez**: The agent called `qartez_find(name="CliRunner")`, followed by targeted `qartez_read` on `StreamMixer`, `BytesIOCopy`, `_NamedTextIOWrapper`, and `CliRunner.invoke`.
- **Judge Verdict**:
  - Thinker scored 0.5: While identifying `StreamMixer` and `BytesIOCopy`, it omitted deeper details regarding `_NamedTextIOWrapper` fileno handling and `_FDCapture`.
  - Qartez scored **1.0 (Strict Pass)**: The agent gave an exhaustive breakdown of the three-stream mixer architecture, the fd-level duplication, the `SystemExit` code coercion rules, and the `Result.exception` / `Result.exc_info` field contracts.

---

## 5. Architectural & Design Comparison

| Attribute | Thinker | Qartez MCP |
|---|---|---|
| **Mechanism** | Architectural note cache with symbol hashes | Pre-computed AST & import graph (Tree-Sitter, PageRank, Leiden) |
| **Tool Count** | 4 tools (`orient`, `lookup`, `remember`, `feedback`) | 43 tools across 4 tiers (`Core`, `Analysis`, `Refactor`, `Meta`) |
| **Delivery Model** | Push (prompt hooks, late hooks) + Pull (`orient`) | Pull only (agent queries MCP tools interactively) |
| **Storage / Footprint** | JSON notes in `.thinker/notes/` (~a few KB to MBs) | SQLite DB in `.qartez/index.db` (~180KB for Click, 122MB for PostHog) |
| **Index Speed** | Incremental distillation during turns; no upfront walk | Fast Rust indexer (~0.3s for Click, ~45s for 45k PostHog files) |
| **Agent Tool Density** | Low (relies on cache, falls back to grep/read on gaps) | High (agent queries tools 15-20 times per complex task) |
| **Primary Strength** | Captures *why*: rejected approaches, invariants, gotchas | Captures *what*: symbols, exact AST spans, call graphs, blast radius |

---

## 6. Synthesis & Recommendations for Thinker

1. **AST-Precise Symbol Retrieval**: Qartez's ability to return exact symbol boundaries (`qartez_find` + `qartez_read`) completely eliminated file grep and read operations. Thinker can benefit by enhancing its symbol-level resolution in `orient`/`lookup` so agents do not need to issue subsequent file reads to locate symbol bodies.
2. **Complementary Synergy**: The two approaches solve different problems:
   - Qartez provides **structural mechanics** (who calls what, what imports what, exact AST locations).
   - Thinker provides **historical wisdom** (invariants, conventions, why a previous PR was reverted, edge-case gotchas).
   - A hybrid workflow where Thinker provides orientation notes at prompt time and Qartez provides graph queries on demand would combine the strengths of both tools.
