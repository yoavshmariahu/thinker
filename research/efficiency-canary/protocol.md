# Guarded efficiency canary protocol

Author: Codex with Yoav. Frozen October 6, 2026, before inference.

Run the three frozen Click tasks (3364, 3391, 3677) at Thinker revision 64bf220 with the reviewed `research/performance-canary/model-pins.patch`. Exact source hashes and upstream base/fixed commits are in execution.json and tasks.json. Use Opus claude-opus-5-5, Sol gpt-6.1-sol, and Gemini gemini-3.8-flash-high, all high effort throughout exploration, distillation and coding; Jev jev-1.13.0 for evidence/retrieval. No provider fallback or automatic retries. Telemetry disabled with THINKER_TEST=1 throughout.

Run frozen base/gold executable preflight first. Explore three tasks per model, in sequential task order within each of three concurrent cohorts. Build caches using the normal distillFile session-learning path, retaining source evidence, proposed notes, grounding decisions and errors. This measures session learning, not full repository setup or PR mining. A failed cache is a measured outcome: stop the batch and preserve it without injecting notes or weakening grounding.

Only if all nine caches build, remain fresh and serve relevant notes may the 18 paired coding runs begin. Each pair uses the same model and high effort; task/model parity alternates arm order. No efficiency claim without correct completed paired solutions. Report correctness, tokens, tool calls, setup time and coding latency separately by model. Missing usage remains unknown; shared-stop interruptions are distinct from the initiating failure.

Agent deadline: 600 seconds; cache builder: 3600 seconds; evaluator: 180 seconds. Pytest refuses stress tests, more than 2000 selected tests, or collection/execution beyond 120 seconds. Live process heartbeats and output are retained. Any invalid phase stops subsequent calls and supervised active work. No expansion beyond this canary.
