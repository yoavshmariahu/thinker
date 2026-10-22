# Tool outputs: the cost is their lifetime, not their size (2026-10-22)

What is here: the measurement that redefined the Context tab's *Wasted* for tool outputs (PR #440), what it
says about compressing small, numerous outputs, the proxy policy built from it (`thinker proxy --keep turn`),
the offline replay of the policies, and **the experiment still to run**.

## The measurement

The owner was skeptical of the Context tab showing `sed` output as 17M tokens wasted of 277M. The column was
showing what the moderate compression cap (12k characters a result) would have cut; half of sed's results are
under 2.7k characters and only the part of a result past the cap counted. The redefinition: a result is wasted
from the agent's last use of it on, the last call of the same turn that edited with text copied from the result
or named a file the result's own call named (`src/tool-outputs.js:sessionOutputs`, `unneeded`); a result is
counted until the session ends or a compaction drops it (`parseTranscript().compactions`).

This repository's Claude Code sessions, 30 days to 2026-10-22, 212 sessions with tool calls:

| output | input tokens | after last use | moderate cap would cut |
|---|---|---|---|
| sed | 243M | 201M (83%) | 16M |
| grep | 114M | 97M (85%) | 4M |
| artemis MCP | 105M | 104M (99%) | 33M |
| cat | 89M | 76M (85%) | 12M |
| all outputs | 1.08B (1.25B when compactions were not counted) | 88% | |

75% of sed's cost comes after the user turn that fetched it has ended; the part a result is used again later
in its own turn is 8%. 98% of these sessions' input tokens are prompt-cache reads, so in billed terms the
waste weighs about a tenth of its token count.

What that says about compressing small outputs: a 1k-token sed result costs 1k once and about 118k over the
rest of the session. Any per-result shrink saves its share of the 243M, but the only safe shrink for shell
output is a length cap (whitespace or line-number trims break the agent's next edit, whose `old_string` must
match the text it saw), and the cap reaches 6% of sed. The lever is how long a result stays in the context:
clearing it after use (the proxy's server-side `clear_tool_uses`, below), compaction (14% of the work here,
no knob thinker holds), or reading less in the first place (guidance, unmeasured).

## The policy built: `--keep turn`

The server's `clear_tool_uses_20250919` edit clears the oldest tool results, keeping a count of the newest,
once the context passes `trigger` and the clearable results amount to `clear_at_least`. It cannot name
results, so "clear what the agent has finished with" has to be expressed as a count. `thinker proxy --keep
turn` (`src/proxy.js:turnToolUses`, `keepValue`) works the count out from the request's messages on every
call: the tool uses after the last user message that carries text and no tool result, never under
`--keep-min` (3). Only results fetched by earlier turns are ever cleared; the current turn's stay, whatever
its length. The shipped count (keep 3) clears results the agent may still be working from in a long turn,
and the pilot saw the model switch to `limit` reads after the placeholders appeared. The hypothesis: `turn`
clears a little less and costs the agent nothing.

## The replay (`thinker proxy replay`, `src/proxy-replay.js`)

Each session as the proxy sees it: every request's recorded usage, the tool results that entered the context
before it, the person's turns, the compactions. Billed-equivalent tokens: a cache read 0.1, a one-hour cache
write 2, an output token 5. Under a policy a clear writes the cache again from the first cleared result on,
the system prompt before it still read (the pilot of 2026-10-20: the request before the clear read 192.8k, the
clear read 11.8k and wrote 104.2k, 80.5k cleared), and every later request reads the cleared tokens no more.
Not in the replay: the model's reaction to the placeholders. `ceiling` is the reads after last use at the
cache-read weight, what a perfect policy with no cache penalty would save.

This repository, 227 Claude Code sessions, 30 days, 891M billed-equivalent tokens:

| policy | keep | trigger / clear at least | saving | sessions costlier | clears |
|---|---|---|---|---|---|
| shipped | 3 | 100k / 80k | 2.4% | 15 | 47 |
| turn-100k | turn (min 3) | 100k / 80k | 2.2% | 13 | 44 |
| turn | turn (min 3) | 60k / 60k | 1.9% | 26 | 84 |
| ceiling | | | 10.6% | | |

By length: under 60 requests nothing is saved (124 sessions, −0.3% to 0%); 60 to 119 requests is slightly
negative for every policy (the cache rewrite costs more than the clear saves before the session ends); 120
requests and over, 61 sessions holding 80% of the tokens, saves 2.6% to 3.0% against a ceiling of 11.7%.

So: offline, `turn` at the shipped trigger is level with `keep 3` (2.2% against 2.4%, two fewer sessions
costlier) and a lower trigger is worse. The gap to the ceiling is the price of a clear: writing a 100k+
prefix again at 2x against saving a tenth of 80k on each later request pays only with 20+ requests to go.
Whatever separates the two policies is the agent's reaction, which only a live run shows. The 2026-10-20
replay over 1,700 sessions machine-wide found 9.2% for `keep 3`; this repository's sessions carry smaller
tool results against their context (10.7M tokens of results in 212 sessions, contexts of several hundred
thousand tokens), so less is clearable here.

## The experiment to run (not run yet)

Through Artemis (its `run-evals` skill), with the owner's approval of the plan first.

- **Arms** (defined 2026-10-22, `define_arm`): `proxy-turn` (env `THINKER_PROXY_KEEP=turn`, keep-min 3,
  trigger 100k, clear 80k) and `proxy-keep3` (the shipped count), both bare agents behind
  `~/.artemis/scratch/proxy-arm/arm.sh`, which starts the thinker under test (`~/.artemis/config.json`
  `"thinker"`, `~/src/thinker-under-test`: **check out this branch, or main once merged, there before the
  run** and record the commit in the plan) on the port the arm's env names (`THINKER_PROXY_PORT`,
  `ANTHROPIC_BASE_URL`), plus the bare agent as the control. The old `proxy` arm pointed at a worktree that
  is gone and at port 6895, which the local page holds; use the two new arms.
- **Tasks**: long sessions, since nothing is saved under 60 requests: `posthog-hard-long-3` (the three
  posthog-hard-6 tasks on which bare Opus read the most), 2 reps each, or a longer set drawn the same way
  before any proxy session runs. Daily use on this machine is the other workload (holdout through
  `--holdout`), where sessions run to hundreds of requests.
- **Model**: one model and effort for all arms (Opus 5.5; the runner's `--model opus` was `claude-opus-5` on
  2026-10-18, check `results.actual_models`). Keep the machine awake: PR106522 was invalid in the pilot
  because the lid closed.
- **Measure**: billed-equivalent input (the arm report carries read, write, cleared and the keep values),
  turns and tool calls (does the agent read again what was cleared: count reads of files whose results
  were cleared, from the transcript against the proxy log), pass rate by the judge. Paired by task and rep.
- **Decision**: `turn` ships as the proxy's default if it is no worse on passes and turns than `keep 3` and
  cheaper than the bare agent on the long tasks; the proxy itself stays off until a holdout on daily use
  shows the same. If neither policy beats the bare agent on long tasks, the proxy's clearing is dropped and
  the lever left is compaction and reading less.
- **Pilot so far** (job 99, 2026-10-20, `posthog-long3-opus-proxy-2026-10-20`): 2 valid pairs. PR106936: one
  clear at request 84 of 112, about 1% net within the session, but 15 more turns (+13% billed). PR107042: no
  clear, results never reached 80k. Not a result either way.

Commands: `thinker proxy replay --days 30 --repo <checkout>` for the offline figures;
`thinker proxy --port $(~/.claude/bin/claude-port reserve thinker proxy) --keep turn` and
`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` for a session by hand; `thinker proxy report --json` for its log.
