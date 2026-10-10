# What mem0 does that thinker does not, and whether it would help

Author: Claude with Yoav Shmariahu. 2026-10-10. Desk research plus free measurements on this
repository's cache and the ranking-lab labels; no model spend.

## The question

mem0 publishes large gains (LoCoMo accuracy, p95 latency, token use). thinker's own paired pilot
(`research/astra-mem0-real`, 2026-10-05, GPT-6 Astra medium, two Click tasks) saw Mem0 OSS 2.2.1
pass the same tests as the control with 48% more build-plus-solve tokens, and thinker with 19%
more. This note asks which of mem0's mechanisms thinker lacks entirely, and which of those would
move thinker's measured bottlenecks.

## What the published numbers compare against

- LoCoMo (paper, April 2025): Mem0 66.9 J, full-context 72.9. The "91% lower p95" and ">90%
  fewer tokens" are against full context, which beats Mem0 on accuracy by 4-6 points. The "26%"
  is against OpenAI's memory (52.9). Zep disputed the setup; a 2026-04 audit found 6.4% of LoCoMo
  answers wrong and the gpt-4o-mini judge accepting 63% of deliberately wrong answers.
- On coding tasks the only independent number found is DreamBench-SWE (arXiv 2608.20664, 60
  three-session sequences): hosted mem0 with default extraction scored 0.117, identical to
  no-memory; verbatim storage (`infer=False`) scored 0.539.
- mem0 itself changed design on 2026-04-14 (OSS 2.0 / Platform v3): the ADD/UPDATE/DELETE/NONE
  upsert is gone, replaced by a single ADD-only extraction pass with hybrid retrieval (vector +
  BM25 + spaCy-entity boost); graph stores were removed from OSS.

So the recall claims are conversational, disputed, and measured against a stronger baseline; the
one coding measurement says mem0's extracted facts are worth nothing and literal storage is worth
a lot.

## Mechanism by mechanism

| mem0 mechanism | thinker today | measured relevance here |
|---|---|---|
| Write-time upsert against top-k neighbours (ADD/UPDATE/DELETE/NONE; legacy) | `distill.js:saveNotes`: Jaccard >= 0.5 on title+answers, same kind, update-in-place or skip. The `remember` MCP path has no comparison at all (`mcp.js` -> `createNote`). | This repository's 182 notes: 0 pairs under the saveNotes rule, 4 pairs by title+body >= 0.4, 16 pairs sharing symbol deps. Built notesets (posthog-v3 259, grafana-v3 307, grafana-v2 692): 0-1 near-duplicate pairs each. Dedup would remove almost nothing. |
| Contradiction -> DELETE / Supersede (Platform "Dream") | Session `contradicted` verdicts are deferred to `learning-pending`; staleness comes from dep hashing and model verification. | 67 of 182 notes stale (37%); only 14 have a later fresh note on a shared symbol, and most of those are unrelated notes sharing a hub symbol. Write-time supersede would not clear the stale pile. |
| Hybrid retrieval: vector + BM25 + entity boost | BM25 over two fields + cross-encoder over the top 8, one note per hook. Dense bi-encoder probed in 2026-10: no gain (`ranking-dense-probe`). Path affinity plays the entity role. | Already explored; not a gap. |
| Memory decay / reinforcement (Platform, opt-in) | No recency or `uses` term in `rank()`; only the `attest` confirmed/unused ratio. | No offline labels carry usage, so untestable for free. Low prior: the hook's problem is misses, not stale favourites. |
| Session scope (`run_id`), last-10-message window in extraction | Evidence packet of selected passages; `once` and `servedIn` avoid re-serving in a session. | Equivalent. |
| Procedural memory: one document per agent run with exact commands and unaltered outputs | None. Distillation forbids one-machine state and "news of what changed"; max 3 notes per session, discovery only in `audit` (5%) and `evidence` modes. | This is the one thing thinker does not do at all, and the one thing DreamBench-SWE found to work. |
| Session-start injection of up to 5 memories (Claude Code plugin) | Prompt hook: at most one note per prompt, fresh only, after the cross-encoder. | Related to the miss rate below. |
| Feedback API, history table, expiration | `feedback`, `history` (last 5), archive, `invalid` kept on disk. | Equivalent. |

## What thinker's own logs say the bottleneck is

Orients in the last 30 days, machine-wide (`~/.thinker/log.jsonl`), excluding holdout sessions:

| client | prompts | served a note | served nothing |
|---|---:|---:|---:|
| claude (prompt hook) | 1,301 | 367 | 934 |
| codex | 347 | 104 | 243 |
| cursor | 120 | 99 | 21 |
| gemini | 82 | 44 | 38 |

Ranking-lab labels (Codex judge, 2026-10-04): grafana 13 of 28 tasks have no important note in
the pool at all; posthog 1 of 14. Where important notes exist they rarely overlap each other (6 of
67 posthog pairs), so consolidation is not the lever either. The lever is coverage: more of the
right notes exist, or they do not.

## Conclusion

mem0's distinctive machinery (write-time upsert, hybrid scoring, decay, graph) addresses
duplication, contradiction and recall ranking. thinker's caches have little duplication, the
ranking was tuned against labels in October, and the stale pile is a verification-throughput
matter mem0 has no analogue for. None of these would move the numbers above.

The one transferable finding is not a mem0 mechanism but a result about mem0: on coding tasks,
literal capture of prior sessions (exact commands, outputs, errors, paths) beat extracted facts
by a wide margin, and extracted facts did nothing. thinker currently extracts and discards the
literal layer. Whether a literal layer would help here is a paid experiment, not a desk conclusion.

## Pilot: a literal arm on the Astra tasks (run 2026-10-10)

Same protocol as `research/astra-mem0-real` (frozen source sessions, GPT-6 Astra medium, Codex CLI
0.162, upstream tests as the only judge, one run per arm). The new arm, `literal`, is mem0's
`infer=False` in thinker's terms: the condensed source session cut into paragraph-sized units
(one shell command with its output, one paragraph of the agent's answer), ranked by BM25 against
the task request and packed verbatim under the same 750-token prefetch budget. No model call to
build. Harness: `bench/astra-mem0-real/literal-retrieve.mjs`, `literal.py`; artifacts in
`research/astra-mem0-real/raw-evidence-literal.tar.gz` beside the original evidence.

| arm | tests | solver tokens | uncached input + output | build tokens | solver wall |
|---|---|---:|---:|---:|---:|
| control | 2/2 acceptance, 2/2 suite | 465,689 | 77,465 | 0 | 400 s |
| thinker notes | 2/2, 1/2 (pre-existing pager flake) | 521,939 | 55,123 | 33,074 | 399 s |
| mem0 OSS | 2/2, 2/2 | 641,785 | 77,689 | 47,261 | 535 s |
| **literal** | 2/2, 2/2 | 603,398 | 65,670 | 0 | 264 s |

Per task, uncached input plus output (the part prompt caching does not absorb):

| task | control | thinker | mem0 | literal |
|---|---:|---:|---:|---:|
| click-3364 | 32,686 | 18,290 | 32,241 | 21,144 |
| click-3391 | 44,779 | 36,833 | 45,448 | 44,526 |

Reading, with the one-run caveat: literal storage was free to build, passed everything, and ran
fastest in wall time (9 and 11 tool calls). On uncached tokens it sat between the control and the
notes: it saved 15% against no memory where the notes saved 29%. Counting the one-time build,
literal (65.7k) came in under notes plus build (88.2k) and under control (77.5k), but the build
amortises over later tasks, so per task the distilled notes remain the cheaper memory here. mem0's
extracted facts again bought nothing over no memory.

This does not say literal beats notes: one run each, and the gap is within the spread seen
between arms on the same task in earlier cohorts. It does say the literal layer is a usable memory
at zero build cost, which makes it a candidate for the case thinker handles worst today: the 72%
of prompts where no note matches and the hook serves nothing.

## What the wider evidence says (survey of 2025-2026 work on coding agents)

Full report with sources in `SURVEY.md`. The points that bear on thinker:

- **Extraction loses literals; granularity and gating decide whether literal memory works.** In
  DreamBench-SWE every extraction-only arm sat at the no-memory floor (0.117), but so did
  retrieving whole raw trajectories (B1, 0.117). What won was one short verbatim event record per
  episode, hard-gated, top-6, about 1.2k tokens (B5 0.494; mem0 with inference off 0.539). A typed
  layer on top of literal records added nothing measurable (0.528 vs 0.494, p=.52). The diagnosed
  failure was token corruption during extraction (a hyphen rewritten to U+2011). Synthetic repos
  built to need verbatim recall, one model; strong on "extraction loses literals", silent on
  whether abstractions help on real repos.
- **Distilled strategy memories help a little on SWE-bench and less under independent
  reproduction.** ReasoningBank: +4.6 and +3.4 points with Gemini 2.5 Flash and Pro, fewer steps;
  reproduced by MemGuard at +0.5 to +1.2 points, and near zero with Gemini 3.1 Pro. Failure-derived
  memories help only when stored as constraints, and by about one point.
- **Injected volume should stay small.** Every study that grew the injected text saw flat or
  worse accuracy with 15-50% more tokens: skill pools (39 of 49 skills gave zero gain, retrieval
  precision 30% -> 3% as the pool grew 5 -> 100), GEPA prompts grown 5 -> 195 lines (negative
  transfer), full memory banks (-2.8 vs selective), LLM-generated AGENTS.md (-0.5 to -2 points,
  +20% cost). Developer-written files with concrete commands gave +4 points; repository overviews
  did nothing for file discovery. thinker's one-note hook is on the right side of this.
- **Coverage is a context-discovery problem.** SWE-Explore: oracle context 59.7% vs the agent's
  own exploration 48.0%; agents find the right files but recall 15-18% of the needed lines.
  Retrieved module-level generated docs (4k tokens by issue text) lifted SWE-agent 43.9% -> 52.6%
  on 57 instances; a tuned 3k-char operational guidance doc lifted a 35B model 25.5% -> 33.0% by
  raising the share of evaluable patches, i.e. coverage, not per-patch precision.
- **Products publish no memory-on/off coding numbers** (Claude Code auto memory, Codex memories,
  Cursor, Letta Code, Augment). Claude Code's memory explicitly skips anything derivable from the
  codebase, which is the opposite bet from thinker's.

## Opportunities for thinker, ranked by evidence and cost

1. **Keep the literal layer, serve it on a miss.** Store sanitized per-event records from
   sessions (the command, the exact output or error, the identifiers), no model call, alongside
   notes. Serve one on the hook only when no note clears the cross-encoder, gated the same way.
   Evidence: DreamBench B5 and mem0-literal, this pilot (zero build, all tests pass, 15% fewer
   uncached tokens than no memory). Measurable with the holdout already in `thinker usage`
   without a new cohort. Risk: the pilot's literal chunks were mostly the earlier agent's prose;
   DreamBench's winning records were one short event each. Build the record small.
2. **Coverage through retrieved module docs, not overviews.** thinker's `map` kind and PR
   mining expand coverage along churn; the evidence favours per-module generated docs retrieved
   by request text (4k tokens) over any always-on summary. A cheap probe: for the 13 Grafana
   tasks with no important note, would a module doc for the gold files' directory have been
   retrieved by the request? Offline, no model spend beyond generating the docs once.
3. **Store failure constraints from sessions.** Notes today come from fixes and sessions'
   evidence packets; a session that went wrong leaves nothing unless distilled. Evidence is small
   (about one point) and only when re-verified before admission, which thinker's verify path
   already provides. Low priority, cheap.
4. **Not worth pursuing from mem0:** write-time upsert (no duplication to remove), hybrid
   dense scoring (probed, no gain), decay (no misses are caused by stale favourites), graph
   memory (path affinity and deps cover it), temporal reasoning (not a code concern).

## Sources

- mem0 paper: https://arxiv.org/abs/2504.19413
- mem0 v3 migration and ADD-only pipeline: https://docs.mem0.ai/migration/oss-v2-to-v3 ,
  https://github.com/mem0ai/mem0/pull/4805
- Dream (supersede/merge), decay, temporal: https://docs.mem0.ai/platform/features/dream ,
  https://docs.mem0.ai/platform/features/memory-decay
- Claude Code plugin: https://docs.mem0.ai/integrations/claude-code
- Zep rebuttal: https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/
- LoCoMo audit: https://penfieldlabs.substack.com/p/we-audited-locomo-64-of-the-answer
- DreamBench-SWE: arXiv 2608.20664
- thinker pilot: `research/astra-mem0-real/README.md`; labels: `bench/runs/ranking-lab-2026-10-04`
