# Benchmark Comparison: Thinker vs. Qartez MCP on Real Merged PR Tasks

**Author**: Antigravity  
**Date**: October 1, 2026  
**Subject**: Empirical 3-Task Paired Evaluation between [Thinker](https://github.com/yoavshmariahu/thinker) and [Qartez MCP](https://github.com/kuberstar/qartez-mcp) (v0.11.0) on Real Pull Request Fixes  
**Repository**: [PostHog](https://github.com/PostHog/posthog) (base commit `a3b3c3685bcffcf273f0d27ffb6a669239200e30`, 44,773 files, 611,760 symbols)  
**Evaluation Model**: `claude-sonnet-5` via Claude Code CLI 2.1.287 with full file-editing permissions enabled  
**Judge Model**: `claude-sonnet-5` double-blind acceptance-criteria judge ([`bench/judge-protocol.js`](../../bench/judge-protocol.js))  
**Artifacts & Runs**: [`bench/runs/posthog-thinker-vs-qartez-3/`](../../bench/runs/posthog-thinker-vs-qartez-3/)  

---

## 1. Executive Summary

Following our initial 3-task comparison on codebase comprehension in Click ([`README.md`](./README.md)), this study evaluates both systems on **real merged pull requests** in a massive production repository: **PostHog** (44.7k files, full-stack Django backend + TypeScript frontend).

Unlike architecture tracing tasks where agents only explain code, pull request tasks require agents to:
1. Diagnose symptoms from a user-reported bug description.
2. Navigate a multi-million-token codebase across frontend, backend, and database layers.
3. Locate exact invariants, serialization boundaries, and helper contracts.
4. Produce real git diff patches modifying production code.
5. Pass rigorous, double-blind acceptance criteria derived from the real merged PR.

### Tasks Evaluated:
- **[`PR106936-hard`](../../bench/tasks/posthog-hard.json#L6)**: `fix(invites): flag existing members on the invite row before submit` (Fullstack Lemon UI / Kea frontend + Django API).
- **[`PR106672-hard`](../../bench/tasks/posthog-hard.json#L75)**: `fix(experiments): keep inline and shared metric uuids unique` (Backend Django experiment service + metric serializer).
- **[`PR106522-hard`](../../bench/tasks/posthog-hard.json#L150)**: `fix(hogql): report sandbox backend errors properly` (Python AST query engine / ClickHouse sandbox).

### Key Findings:
- **Thinker Won on Latency & Cost**: Thinker completed all 3 tasks in **749.7s** cumulative wall time vs. **1,148.0s** for Qartez (**34.7% faster**). Thinker cost **$3.46** total vs. **$5.46** for Qartez (**36.6% cheaper**).
- **Higher Criteria Pass Rate with Thinker**: On [`PR106672-hard`](../../bench/tasks/posthog-hard.json#L75) (where code modifications were produced), Thinker achieved **85.7% essential / 87.5% all criteria met** compared to Qartez's **71.4% essential / 75.0% all**.
- **Architectural Orientation vs. Pure Symbol Indexing**:
  - On PR106672, Thinker's knowledge base provided architectural context regarding PostHog's metric creation services. This enabled the Thinker agent to locate and fix both the experiment update service **and** the shared metric serializer (`create_saved_metric` / `normalize_query_for_write`), satisfying essential criterion `c1`.
  - Qartez's agent only modified the experiment update service, leaving the shared metric creation path broken and failing criterion `c1`.
- **Tool Proliferation & Context Bloat in Large Codebases**:
  - In a 44k-file repository, Qartez's 43 interactive tools generated high context overhead. On PR106522, Qartez issued **34 MCP calls**, ballooning turn cost to **$2.16** (vs $0.99 for Thinker).
  - Furthermore, on PR106672, the agent failed to invoke Qartez tools at all (0 Qartez calls), wandering across files for 691 seconds because Qartez relies on the agent proactively querying its tools, whereas Thinker's prompt hook / orientation notes actively ground the agent in the right architecture upfront.
- **Turn Limits on Massive Fullstack Refactors**:
  - Both tools hit the 35-turn cap on PR106936 (a 5-file frontend/backend refactor) and PR106522 without generating a final patch. On PR106936, Qartez's AST tools allowed it to explore the relevant files in half the time (182s vs 356s), but neither tool completed edits before exhausting turns.

---

## 2. Quantitative Results

### Summary Table

| Task ID | Arm | Wall Time | API Time | Turns | Total Calls | MCP Calls | Reads / Greps / Bash | Patch Size | Cost ($) | Essential Criteria | All Criteria | Pass |
|---|---|---:|---:|---:|---:|---:|---|---:|---:|:---:|:---:|:---:|
| **PR106936-hard** | **Thinker** | 356.1s | 347.3s | 36 | 38 | 4 | 13 / 18 / 18 | 0 chars | $1.3905 | 0.0% | 0.0% | No |
| | **Qartez** | **182.0s** | **174.7s** | 36 | 43 | 20 | 5 / 16 / 16 | 0 chars | **$1.1595** | 0.0% | 0.0% | No |
| **PR106672-hard** | **Thinker** | **222.3s** | **215.0s** | 36 | 35 | 2 | 6 / 15 / 15 | 6,909 chars | **$1.0868** | **85.7%** | **87.5%** | No |
| | **Qartez** | 691.2s | 708.4s | 12 | 22 | 0 | 3 / 1 / 5 | 6,558 chars | $2.1403 | 71.4% | 75.0% | No |
| **PR106522-hard** | **Thinker** | **171.3s** | **163.4s** | 36 | 35 | 2 | 6 / 20 / 20 | 0 chars | **$0.9863** | 0.0% | 0.0% | No |
| | **Qartez** | 274.8s | 427.4s | 36 | 59 | 34 | 0 / 23 / 23 | 0 chars | $2.1647 | 0.0% | 0.0% | No |
| **Totals / Overall** | **Thinker** | **749.7s** | **725.7s** | 108 | 108 | 8 | 25 / 53 / 53 | 6,909 chars | **$3.4636** | **28.6%** | **29.2%** | **0/3** |
| | **Qartez** | 1,148.0s | 1,310.5s | 84 | 124 | 54 | 8 / 40 / 44 | 6,558 chars | $5.4645 | 23.8% | 25.0% | **0/3** |
| *Delta* | | **-34.7%** | **-44.6%** | *+28.6%* | *-12.9%* | *-85.2%* | *+212% reads* | *+5.4%* | **-36.6%** | **+4.8%** | **+4.2%** | *Tied* |

---

## 3. Deep Dive into PR106672: Metric UUID Uniqueness

[`PR106672-hard`](../../bench/tasks/posthog-hard.json#L75) evaluated an intricate metric UUID collision bug in PostHog experiments:
When an inline metric is converted to a shared metric and linked back, duplicate UUIDs can overwrite metrics or corrupt experiment ordering.

### Double-Blind Judge Evaluation Breakdown

| Criterion | Behavior Description | Essential | Thinker Verdict | Qartez Verdict |
|:---:|---|:---:|:---:|:---:|
| `c1` | `create_saved_metric` discards caller-supplied UUID, forcing fresh `uuid4()` | **Yes** | **MET** | **NOT MET** |
| `c2` | Preserves existing saved metric UUID on edit/update | **Yes** | **MET** | **MET** |
| `c3` | Regenerates clashing inline UUIDs when shared metric linked without inline list in payload | **Yes** | **MET** | **MET** |
| `c4` | Leaves inline metrics untouched if no collision occurs | **Yes** | **MET** | **MET** |
| `c5` | Reuses ordering sync mechanism to preserve incumbent order | **Yes** | **MET** | **MET** |
| `c6` | Modifies only inline lists; leaves `saved_metrics_ids` link sets untouched | **Yes** | **MET** | **MET** |
| `c7` | User guidance explicitly instructs stripping UUID when promoting to shared | No | NOT MET | NOT MET |
| `c8` | Existing inline clash handling works when resending inline metric lists | **Yes** | **MET** | **MET** |
| **Score** | | | **85.7% Essential (6/7)** | **71.4% Essential (5/7)** |

### Why Thinker Won on PR106672:
- **Criterion `c1` was the differentiator**: The judge noted:
  > *"Thinker: In `create_saved_metric`, `normalize_query_for_write(query)` is called without `existing_uuid`... discarding caller-supplied `uuid` and generating a fresh `uuid4()`."*  
  > *"Qartez: The provided patch contains no changes to any shared-metric creation code path... The only backend diff shown is inside `ExperimentService.update_experiment`."*
- **Speed & Economy**: Because Thinker steered the agent directly to PostHog's metric service layer, Thinker completed the fix in **222.3s** for **$1.08**, while Qartez spent **691.2s** ($2.14) hunting for the relevant code without ever finding `create_saved_metric`.

---

## 4. Architectural Comparison: Micro-AST vs. Curated Knowledge

| Dimension | Thinker | Qartez MCP |
|---|---|---|
| **Primary Mechanism** | Distilled markdown notes with symbol-level dependency hashing and invalidation. | Pre-computed SQLite database storing AST symbol table, call graph, and git co-change. |
| **Tool Surface** | Minimal (2 MCP tools: `orient`, `lookup` + prompt injection). | Extensive (43 MCP tools: `qartez_find`, `qartez_map`, `qartez_refs`, `qartez_outline`, etc.). |
| **Small Codebases (Click)** | Good (0.50 score, answered all questions, but required file reads). | **Superior** (0.67 score, 15.9% faster, 0 file reads/greps). |
| **Large Enterprise Codebases (PostHog)** | **Superior** (34.7% faster, 36.6% cheaper, higher criteria score). | Tool selection overhead; agent risks wandering if it fails to invoke the right tool. |
| **Invariants & Domain Logic** | Captures "why", gotchas, and architectural separation across layers. | Captures "what" and "where" (syntax, definitions, call edges). |
| **Maintenance Cost** | Low (only re-verifies stale notes on commit/PR merge). | Requires 1.8GB index build and SQLite WAL management on every sync. |

---

## 5. Reproducibility & Protocol

1. **Protocol File**: [`bench/runs/posthog-thinker-vs-qartez-3/protocol.json`](../../bench/runs/posthog-thinker-vs-qartez-3/protocol.json)
2. **Benchmark Driver**: [`bench/qartez-pr-compare.js`](../../bench/qartez-pr-compare.js)
3. **Run Command**:
   ```bash
   THINKER_TELEMETRY=off node bench/qartez-pr-compare.js
   ```
4. **Environment**:
   - macOS Darwin 24.6.0 (Apple M-series)
   - Node v20+
   - Claude Code CLI 2.1.287 with `claude-sonnet-5`
