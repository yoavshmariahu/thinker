# Astra: no-cache control and duplicate-serving investigation

Author: Codex, for Yoav Shmariahu. 2026-10-04 (America/Los_Angeles).

One run per condition on PostHog PR106936-hard, the invitation-validation task. The no-cache control uses the same GPT-6 Astra model, medium reasoning, PostHog base, task prompt, Codex CLI 0.160.0 and grading protocol as the preceding version comparison. It ran subsequently, not interleaved, so temporal and model variation remain possible. Quality is model-judged; no test suites ran. Both cached results predate the deduplication fix.

| Condition | Seconds | Tool calls | Input tokens | Cached input (subset) | Output tokens | Essential criteria |
|---|---:|---:|---:|---:|---:|---:|
| No cache | 237.8 | 22 | 1,236,546 | 1,156,096 | 6,505 | 5/6 |
| v0.1.6 (`2ba373a`) | 224.6 | 18 | 825,849 | 762,752 | 6,035 | 5/6 |
| v0.1.14 (`08a5ad4`) | 276.9 | 28 | 1,243,234 | 1,146,496 | 7,053 | 6/6 |

Latest used only 0.5% more input tokens than no cache, but 50.5% more than v0.1.6. It was 16.5% slower than no cache. All three input totals already include cache reads; do not add those again. Each model step rereads context, so aggregate input is not the amount of new code or notes delivered. Coding time includes CLI/MCP startup, excludes checkout preparation, the initial hook, and grading.

The no-cache patch missed essential c3: its onboarding disabled reason was generic rather than identifying existing-member emails. The baseline cache patch also missed c3; latest passed it. All missed optional c9, refreshing members after server rejection. The no-cache control has zero MCP calls, zero hook time, and no cache log. It copied no notes and configured no MCP server. TypeScript checking was attempted but blocked by the unprepared Flox environment, as in the cached runs.

## Where tokens went

The completed command outputs total 427,852 characters without cache, 336,776 for v0.1.6, and 310,170 for latest. Latest reduced shell-output volume by about 27.5% against no cache, but made additional retrieval calls. Its nine MCP responses total roughly 41k JSON characters. These character counts describe tool output, not tokenizer measurements or causal attribution of input usage.

Latest's initial hook returned no notes. Its orient returned five notes and snippets, then lookup returned three notes already in that orient, with snippets (about 2.3k reported tokens). A long benchmark framing prefix before the task can crowd the new cross-encoder's truncated query; this harness limitation was held constant between cached versions. One drilldown request asked for 14,000 tokens, exceeding the schema's 12,000-token limit, and was retried. Earlier reporting counted that response as successful because its transport error field was null; inspection of the response text shows the validation error. There were two successful drilldown calls, one rejected call, three find calls, orient, lookup, and feedback.

The supported conclusion is a quality gain at higher effort on this sample, not a general efficiency gain. Keep useful note coverage while removing repeated bodies/snippets and avoidable validation retries. Do not attribute the entire input difference to duplicate notes: most input is cached context reread across model steps.

## Artifacts and validation

The no-cache runner and manifest are under `bench/astra-control/`. Raw events, the patch, grading context and criterion evidence are preserved locally at `/private/tmp/thinker-astra-cache-control-20261004/artifacts/`; they are excluded from the source PR because reviewing the large generated traces stalls the current review implementation. The original paired cache results are preserved in local commit `029a66b` on `agent/astra-one-pair`. No credentials or Codex runtime homes are included. Telemetry was disabled for every run and subprocess.

The accompanying fix adds explicit prompt IDs, shared hook/MCP delivery state, concurrency protection and boundary tests; full note bodies are suppressed after delivery, while title-only and shortened previews remain expandable. Oversized drilldown budgets are capped rather than rejected. Any later patched model run must be reported separately; the numbers above do not measure the fix.
