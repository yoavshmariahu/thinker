# Memory and experience reuse for coding agents: what has evidence (2026-10-10)

Desk survey compiled for the mem0 review. Each claim carries its source; items marked unverified
could not be confirmed from the primary text.

## DreamBench-SWE (arXiv 2608.20664)

Setup: 60 three-session sequences (sessions 1 and 2 set a "memory trap", session 3 is the test),
3 seeds, 180 cells per condition; Codex CLI on gpt-5.5; hand-built synthetic fixture repos across
five trap families (convention learning, generated files, stale architecture, reviewer preference,
flaky test). Session-3 tasks depend on random tokens that appear only in earlier-session event
text; hidden executable oracles check them byte for byte. The authors call it "mostly but not
entirely a recall-verbatim benchmark". https://arxiv.org/html/2608.20664v1

Pass@1 over 180 cells:

| condition | passed | rate |
|---|---:|---:|
| B0 no memory | 21 | 0.117 |
| B1 whole prior trajectory retrieved | 21 | 0.117 |
| B2 vector trace retrieval | 20 | 0.111 |
| B3 reflection-only vector retrieval | 67 | 0.372 |
| B4 untyped session summary | 21 | 0.117 |
| B5 one verbatim injected-event record per trajectory, gated, top-6 | 89 | 0.494 |
| reference probe, typed only | 80 | 0.444 |
| reference probe, raw only | 84 | 0.467 |
| reference probe, typed + raw | 95 | 0.528 |
| mem0 hosted 2.0.11, default extraction | 21 | 0.117 |
| mem0 hosted 2.0.11, inference off (sanitized raw event text) | 97 | 0.539 |

Mem0 read budget 1,200 tokens, top_k 6. Typed + raw against verbatim only is a null result
(clustered p = .518). The diagnosed extraction failure: a token `TOKEN-AAAA-BBBB` came back from
the fact store with its ASCII hyphen rewritten to U+2011, so the oracle rejected it. Retrieving
whole raw trajectories (B1) did nothing; one short gated record per episode (B5) did. Synthetic
repos, one model, tasks built to need verbatim recall.

## Named systems with coding-task evidence

- **ReasoningBank** (Google, arXiv 2509.25140). Strategy items (title, description, content)
  abstracted from both successful and failed trajectories after each task, judge-labelled;
  top-1 by embedding into the system prompt. SWE-bench Verified: Gemini 2.5 Flash 34.2 -> 38.8,
  Pro 54.0 -> 57.4, fewer steps. Raw-trajectory memory (Synapse) did nothing.
  https://arxiv.org/html/2509.25140v1
- **MemGuard** (arXiv 2608.21867). Records carry verifier descriptors; failure memories are
  stored as constraints and admitted only after re-verification. SWE-bench Verified with
  Qwen-3.5-Plus: no memory 81.9, Synapse 82.3, AWM 82.9, ReasoningBank 83.1, MemGuard 83.6.
  Terminal-Bench 2.0: 64.8 -> 67.4. With Gemini 3.1 Pro all memory methods are within one point
  of no memory. Removing failure memories: 67.4 -> 66.1, mostly steps.
  https://arxiv.org/html/2608.21867v1
- **Agent Workflow Memory** (arXiv 2409.07429): web evidence only; +0.5 to 1.0 on SWE-bench
  Verified in the MemGuard reproduction.
- **Dynamic Cheatsheet** (arXiv 2504.07952): literal code snippets plus strategies accumulated
  at test time; large gains on puzzles and AIME, no repo-level tasks.
- **ExpeL** (arXiv 2308.10144): offline insight extraction; adding Reflexion-style reflections to
  extraction lowered HotpotQA from 39% to 29%.
- **MemOp** (arXiv 2606.05646): a fine-tuned small model rewrites an abstract Memory.md after each
  task, given whole as context. SWE-bench Verified subset (100/100): +5.25 points single-episode,
  +3.0 cross-episode (Devstral-Small, Qwen3-Coder-30B).
- **Skill files**, the closest analogue to served notes. SWE-Skills-Bench (Claude Code, Haiku
  4.5, 565 tasks, 49 skills): 39 of 49 skills gave zero gain, mean +1.2 points, 3 hurt by up to
  10 points through stale concrete templates; token overhead -78% to +451%.
  https://arxiv.org/html/2603.15401v1 . Demystifying Agent Skills (Codex, Gemini CLI,
  Terminal-Bench 2.0): skills 61.9% vs 59.1%; retrieval precision 29.6% -> 3.3% as the pool grows
  from 5 to 100. https://arxiv.org/html/2608.14036v1 . Skill Issue (Claude Code, Sonnet 4.6):
  optimised repo skill +4.9 points, not significant at 20-26 tasks.
  https://arxiv.org/html/2609.12742v1
- **TOM-SWE** (arXiv 2510.21903): raw session logs plus user models, BM25 on demand;
  Stateful-SWE-bench 57.4% vs 13.5%, on a benchmark built to need it.
- Skipped as conversational-recall or tool-routing evidence only: Memento, Mem-alpha, MemTool,
  Hindsight (arXiv 2512.12818), Zep/Graphiti, A-Mem, LangMem, Cognee, Supermemory.
- Within-task context management, for the cost side: OpenHands condenser (54% vs 53%, up to half
  the cost per turn), SWE-MeM (arXiv 2606.28434, 51.6 -> 60.2 with a 30B model), Blast Radius
  (arXiv 2608.07440, 17-26% token savings, success unchanged).

## Failures versus successes

Every controlled comparison finds failure memories help by about one point and only when turned
into constraints or strategies: ReasoningBank success-only 46.5 vs with failures 49.7
(WebArena-Shopping); MemGuard -1.3 points when failure constraints are removed; U-Mem (arXiv
2602.22406) success-only 50.8, failure-only 51.6, hybrid 52.4 on HotpotQA. Counter-evidence:
ExpeL's reflection-derived lessons hurt, and SWE-Skills-Bench's harmful skills were stale
templates. No coding-specific head-to-head beyond MemGuard.

## Injection policy

- Evaluating AGENTS.md (arXiv 2602.11988; Claude Code, Codex, Qwen Code; SWE-bench Lite 300 +
  138): LLM-generated context files -0.5 to -2 points, developer-written +4, cost +19-23%;
  concrete build and test commands are followed, repository overviews do not reduce
  file-discovery time; where a repo has no docs, generated files help +2.7.
- Two-agent ablation (arXiv 2607.27250; 288 runs, 3 repos): no correctness effect; selective
  loading cut cache-creation tokens; a note about test runtime changed process (targeted tests,
  -24% wall-clock on one repo).
- Probe-and-Refine (arXiv 2606.20512; Qwen3.5-35B-A3B, 500 SWE-bench Verified): a tuned guidance
  doc of at most 3,000 characters, 25.5 -> 33.0% (static doc 28.3), +56% tokens; the mechanism is
  coverage (evaluable patches 41.7 -> 56.2%), not per-patch precision.
- How much: Proactive Memory Agent (arXiv 2607.08716; Terminal-Bench 2.0, Sonnet 4.5, 37.6 ->
  45.9) found exposing the whole memory bank 2.8 points worse than selective injection. GEPA
  prompts grown from 5 to 195 lines transferred negatively (arXiv 2607.14004). Skill-pool growth
  collapses retrieval precision (above).
- Tool versus push: a cross-scenario study (arXiv 2606.04315) found build-time schemas drop
  step and action details and that query-time retrieval under agent control ranked best.
  Anthropic's context-engineering post argues for just-in-time retrieval, no numbers.

## Coverage

- SWD-Bench (arXiv 2604.06793; SWE-agent, 57 instances): retrieved generated docs (4,096 tokens by
  issue text) lifted resolution 43.86% -> RepoAgent 52.63, DocAgent 49.12, AutoDoc 49.12, DeepWiki
  47.37.
- SWE-Explore (arXiv 2606.07297): oracle context 59.7% vs Claude Code's own exploration 48.0%;
  agents hit the right files (64-67%) but recall 15-18% of the needed lines; BM25 context 12.7%.
  Context discovery, not synthesis, is the bottleneck.
- PAST-Bench (arXiv 2608.04003): persistence gains +0.13 to +0.24 across models; procedural reuse
  weakest; typed facts with scope and expiry beat transcript fragments.
- No ablations published for Aider's repo map, Augment, Cody, or Codified Context (single
  developer case study, arXiv 2602.20478).

## Products

No memory-on/off coding numbers published for Claude Code auto memory (which explicitly skips
anything derivable from the codebase; https://code.claude.com/docs/en/memory), Codex memories
(background summaries after idle), Cursor memories (sidecar extraction with user approval),
Windsurf (legacy Cascade only), Letta Code, or OpenSage (SWE-bench Pro ablation figures not in the
text; unverified).

## Ranked mechanisms by evidence on coding tasks

1. Short verbatim event records, one per episode, hard-gated, top-6, about 1.2k tokens
   (DreamBench B5 0.494, mem0 inference off 0.539, vs 0.117 for extraction and for whole
   trajectories).
2. Generated per-module repo docs retrieved by issue text, 4k tokens (SWE-agent 43.9 -> 52.6, n=57).
3. One tuned operational guidance doc under 3k characters, always injected (25.5 -> 33.0 on a
   35B model, +56% tokens).
4. Distilled strategy items from judge-labelled successes and failures, top-1 (ReasoningBank
   +3.4 to +4.6; +0.5 to +1.2 when reproduced).
5. Verifier-gated memory with failure constraints (MemGuard, +1.7 and +2.6; about zero with a
   stronger model).
6. A fine-tuned memory model maintaining an abstract repo file (+3 to +5 on 100 tasks).
7. Selective timed reminders instead of full-bank exposure (+8.3 on Terminal-Bench 2.0; full
   bank 2.8 worse than selective).
8. Developer-written context files with concrete commands (+4, +19% cost); LLM-generated ones
   -0.5 to -2.
