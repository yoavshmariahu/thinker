# Future Research Ideas: Thinker Knowledge Engine

This document tracks hypotheses, research proposals, and future experimental directions for the Thinker knowledge engine.

---

## Selective section compaction

**Status:** Deferred for later exploration, 2026-11-04. The owner wants larger chunks and summaries of selected sections, without reaching far back into history and causing large cache rewrites. This records a direction, not an implementation or authorization to run an experiment.

### Proposed policy

- Select one contiguous section of completed work, roughly 100k–200k tokens, aligned to complete turns and tool interactions. Preserve the current turn and about 20k tokens of recent work.
- Summarize only that section into roughly 5k–8k tokens, subject to accuracy. Preserve exact constraints, decisions, unresolved questions, and references to immutable original outputs.
- Leave the older prefix unchanged. Insert the summary in place and freeze it; later sections move forward rather than revising earlier summaries. Skip sections that require reaching beyond the bounded recent window.
- Target at most 40k tokens rewritten after replacement. Price everything from the last reusable cache boundary through the new tail, not just the summary. Scattered edits inherit the rewrite boundary of the earliest edit.
- Establish a reusable cache boundary before the selected section as it grows. Unchanged text alone does not establish a cache hit. If the boundary is missing or expired, skip or price the larger rewrite; include the cost of establishing boundaries too.

Example: `[200k older prefix][200k selected section][20k recent work]` becomes `[same 200k prefix][8k frozen summary][same 20k recent work]`. The intended rewrite is 28k tokens, conditional on a usable cached prefix.

### Illustrative economics

Assume Sonnet 5.5 summarizes the full selected 200k tokens at $2/M input and $10/M output; Opus 5.5 continues at $0.20/M cached input and $8/M one-hour writes. These are list-price assumptions checked on 2026-11-04, not measured Thinker results; recheck before use ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)).

- Summary call: $0.48. First 28k-token cache write: $0.224.
- Remove 192k tokens: save $0.0384 per later cached model request, including tool-loop steps.
- Break-even: about 19 requests, accounting for the cached read replaced on the rewrite request. If the older 200k prefix also rewrites, about 59 requests.
- Formula: `net = N * removed * read_rate - summary_cost - rewritten * (write_rate - read_rate) - extra_work_cost`, with rates per token. Assumes subsequent cache hits, equal task performance, and otherwise equal work. Include extra reasoning/output tokens, retrieval, retries, and boundary setup in actual accounting.
- Compare against shipped deterministic clearing, not only the untouched transcript. If clearing removes most of the same content, the incremental summary may not repay.

### Questions to resolve when resumed

1. Can the provider and harness retain the intended prefix in actual sent requests? Verify API cache-read/write usage and request bytes. Claude uses previously written prefix entries and bounded lookup; adding a marker does not prove reuse ([caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).
2. Can a middle section be replaced without breaking tool pairs, role structure, or retained thinking? Native prefix compaction is not proof of arbitrary section support; validate provider-specific constraints ([Claude preserved thinking](https://platform.claude.com/docs/en/build-with-claude/compaction-thinking-blocks)).
3. Can selection reduce the summarizer's input without dropping needed facts? Compare a separate call with a call that reuses the working model's cache; a cheaper model can lose on uncached input.
4. Measure missed constraints, exact-answer correctness, rereads, total billed cost, and latency against shipped clearing in matched sessions. Future experiments use Artemis with approved plans; any strategy starts off by default. Cover desktop sessions without CLI login as well as proxy/CLI paths.

Bounded forward compaction delays context exhaustion; it does not eliminate eventual window pressure from retained older history and accumulated summaries.

---

## 1. Cache Bootstrapping and Distillation with Claude Opus

**Status:** Proposed / Backlog  
**Target Benchmarks:** Grafana (`bench/tasks/grafana-hard.json`), PostHog (`bench/tasks/posthog.json`)  
**Command:** `thinker setup --model opus` / `thinker seed --model opus`

### Context & Motivation

Thinker bootstraps a repository's persistent knowledge cache during onboarding through two primary operations:
1. **Area Exploration & Distillation (`seed`)**: Discovers architectural subareas, generates targeted exploratory queries, executes an agent session, and distills the session trace into structured notes (`callpath`, `location`, `convention`, `gotcha`, `rationale`, `overview`).
2. **PR Mining (`mine-prs`)**: Analyzes merged pull requests with diffs and review discussions to synthesize conventions, invariants, and bug fixes.

By default, Thinker uses Sonnet-tier models:
- **Claude:** `claude-sonnet-5` (`sonnet`)
- **Gemini:** `gemini-3.8-flash-high`
- **Codex:** `gpt-6-luna`

Sonnet-tier models offer fast execution and cost-effective bootstrapping (~$0.45 per exploration area, ~$0.06 per mined PR). However, cache construction is an **upfront, amortized investment** performed once per codebase. The resulting notes are repeatedly served to dozens or hundreds of downstream developer and agent sessions.

Frontier models like **Claude Opus** (`claude-opus-5`) provide substantially higher reasoning depth, broader contextual integration, and superior fidelity when tracing multi-hop dependencies across decoupled architectural layers.

### Core Hypotheses

1. **Hypothesis 1: Higher Structural Fidelity in Cross-Module Callpaths**
   - *Premise:* In complex, polyglot codebases (e.g. Grafana's Go backend with React frontend, or PostHog's Django + ClickHouse pipelines), control flows cross network, serialization, or plugin boundaries.
   - *Expectation:* Opus will construct richer and more precise `callpath` notes with exact `file:symbol` coordinates, avoiding the shallow "file description" summaries that mid-tier models occasionally produce.

2. **Hypothesis 2: Higher Signal-to-Noise in Gotchas & Architectural Rationale**
   - *Premise:* Mining PR review comments and diffs requires separating transient review feedback (formatting, nitpicks) from durable system constraints (rejected architectures, performance traps, race conditions).
   - *Expectation:* Opus will demonstrate higher precision in identifying true `gotcha` and `rationale` notes, with significantly fewer false positives or hallucinated constraints.

3. **Hypothesis 3: Dependency Invalidation Half-Life and Verification Endurance**
   - *Premise:* Thinker invalidates notes using symbol-level content hashing (`deps: [{path, symbol?}]`). Notes referencing coarse or extraneous symbols frequently go stale on unrelated edits.
   - *Expectation:* Opus will isolate the minimal, necessary symbol dependencies, resulting in fewer false-positive invalidations and longer note half-lives across subsequent commits.

4. **Hypothesis 4: Net Amortized Efficiency (ROI)**
   - *Premise:* An Opus-bootstrapped cache will cost ~4–5× more initially (~$2.25/area vs. ~$0.45/area; ~$0.30/PR vs. ~$0.06/PR; total setup ~$40–$50 vs. ~$9).
   - *Expectation:* Because higher-quality notes reduce downstream agent confusion, backtracking, and external search turns, the downstream savings in wall time and token consumption will pay back the initial setup cost within the first 10–20 downstream tasks.

### Experimental Design

#### Experimental Arms
- **Arm A (Baseline - Sonnet Tier):**
  - Cache generated with `thinker setup --model sonnet` (using `claude-sonnet-5`, or fallback to `gemini-3.8-flash-high` / `gpt-6-luna`).
- **Arm B (Experimental - Opus Frontier):**
  - Cache generated with `thinker setup --model opus` (`claude-opus-5`).

#### Evaluation Protocol
1. **Retrieval Benchmark (`bench/retrieval.js`):**
   - Measure ground-truth recall and precision against task sets without running downstream agents.
2. **End-to-End Agent Benchmark (`bench/runner.js`):**
   - Evaluate across the hard task suites (`grafana-hard.json`, `posthog.json`).
   - Assess:
     - Strict pass rate (100% test pass).
     - Essential criteria compliance.
     - Wall-clock runtime per task.
     - Tool call count and token expenditure.
3. **Live Loop Attestation Tracking:**
   - Over 10 sequential tasks, track note attestation transitions:
     - `confirmed` rate (agent verified and acted on the note).
     - `contradicted` rate (evidence showed note was inaccurate).
     - `unused` decay rate.

### Configuration & CLI Support

Opus is integrated into Thinker's model tier mapping:
- CLI flag: `thinker setup --model opus` or `thinker seed --model opus`
- Environment variable: `THINKER_LLM_MODEL=opus`
- Resolver mapping: `resolveModel('claude', 'opus')` -> `'claude-opus-5'`
- Fallbacks: If Claude encounters rate or session limits during exploration, the system automatically falls back through the provider chain (`claude` ──► `gemini` ──► `codex`), ensuring uninterrupted cache construction.
