---
name: collaborative-research
description: >-
  Conduct hypothesis-driven, collaborative, and iterative research on complex codebase performance,
  algorithmic retrieval, or benchmark regressions. Use when investigating non-trivial regressions,
  evaluating experiments against baselines, and synthesizing findings into reproducible research documentation.
---

# Collaborative Iterative Research Skill

This skill guides agents through conducting structured, hypothesis-driven, and collaborative research with human engineers on complex codebase issues, benchmark regressions, or algorithmic optimizations.

---

## The 6-Phase Research Lifecycle

```
[Phase 1: Characterize] ──► [Phase 2: Diagnose] ──► [Phase 3: Align]
                                                          │
[Phase 6: Synthesize]   ◄── [Phase 5: Validate]  ◄── [Phase 4: Intervene]
```

### Phase 1: Problem Characterization & Baseline Anchoring
Never optimize or fix without quantitative baseline measurements.
1. **Gather Concrete Evidence**:
   - Extract raw data from summary logs, execution traces, or transcripts.
   - Separate wall time components: execution latency vs API streaming latency vs sleep/timeout intervals.
   - Measure tool call density, tokens (input/output/cached), and error rates.
2. **Identify the Deviation**:
   - Compare control (e.g. `nocache`) vs experiment (e.g. `cache`).
   - Pinpoint specific anomalies (e.g., wall time increasing while tool calls decrease).
3. **Check Constraints**:
   - Note budget, credit, or model constraints (e.g., Fable API limits vs Gemini CLI availability).

### Phase 2: Hypothesis Generation & Diagnostic Probing
Deconstruct the system into measurable stages and test individual hypotheses.
1. **Trace Decision Chains**:
   - Step through the code or scoring math (e.g., BM25 term weighting, IDF mass calculation, candidate filtering).
   - Replay actual inputs (task prompts, query tokens) against the ranking or scoring function in isolation.
2. **Inspect Corpus / Scale Interactions**:
   - Test whether scaling (e.g., small repo vs large repo, 100 notes vs 700 notes) alters threshold behavior.
3. **Formulate Falsifiable Hypotheses**:
   - Example: *"Dilution of $B_{\text{mass}}$ in 700-note corpora causes high-relevance notes to fall below the 0.15 body floor."*
   - Verify with targeted one-line probe scripts (`node -e "..."` or python snippets).

### Phase 3: Collaborative Alignment
Align with the human collaborator before making sweeping changes.
1. **Present Root Causes with Evidence**:
   - State the exact file, line, and mechanism responsible for the deviation.
   - Provide concrete examples showing what succeeded vs what was dropped.
2. **Offer Options with Trade-Offs**:
   - Provide 2–3 actionable recommendations (e.g., lowering static floors vs dynamic scaling, capping tool output).
   - Solicit guidance on preferences, constraints, and scope.

### Phase 4: Minimal Targeted Interventions & Unit Testing
Implement surgical fixes that preserve existing invariants.
1. **Surgical Code Edits**:
   - Modify only the isolated algorithms or configuration parameters identified in Phase 2.
2. **Regression Test Creation**:
   - Write comprehensive unit tests replicating the failure mode (e.g., 2-slot eviction, query capping, floor gating).
   - Run the full project test suite (`npm test`, `go test`, etc.) to guarantee zero regressions.

### Phase 5: Empirical Benchmark Validation
Validate the fix using the same evaluation harness and conditions.
1. **Run Under Matched Conditions**:
   - Use the same tasks, concurrency, and model configurations.
   - If model availability changed (e.g., using Gemini for judging instead of Fable), record that variable explicitly.
2. **Compare Multi-Dimensional Metrics**:
   - Wall time (seconds / minutes)
   - Tool call volume (reads, edits, bash commands)
   - Token consumption & cost
   - Acceptance criteria pass rate (essential % and strict pass)
3. **Iterate if Variance Occurs**:
   - Run multiple repetitions or inspect individual task differences if results fluctuate.

### Phase 6: Knowledge Synthesis & Research Documentation
Persist findings for the team and future agent sessions.
1. **Structure as a Research Document**:
   - Create or update a document in `research/` (e.g. `research/README.md` or `research/<topic>/README.md`).
   - Include:
     - **Title & Author**: Explicitly identify the authors and date.
     - **Executive Summary**: 2–3 paragraphs summarizing the problem, root cause, fix, and results.
     - **Problem & Baseline**: Tabular data showing the initial symptoms.
     - **Root Cause Analysis**: Code blocks, mathematical formulas, and mechanisms.
     - **Solution Architecture**: What was changed and why.
     - **Empirical Validation**: Side-by-side comparison tables before and after.
     - **Lessons Learned**: Principles that apply to future codebase decisions.
2. **Merge & Share**:
   - Commit cleanly to version control and push to the shared repository.
