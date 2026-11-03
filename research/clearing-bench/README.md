# Clearing bench: paired synthetic measurements of the context clearing

Why it exists: `thinker proxy replay` cannot see the two costs that decide whether clearing pays —
the model reading back what was cleared, and the cache writes a clear provokes on every later call.
These runs measure both, live, against a held-out arm of the same workload.

Each arm runs its own proxy on a reserved port with its own `THINKER_HOME` and log, reached through
`ANTHROPIC_BASE_URL`. The machine's own service, settings and log are never touched. `claude -p`
authenticates on whatever login is present; with no `ANTHROPIC_API_KEY` that is a subscription, so
the runs spend quota rather than money and the prices below are list-price arithmetic on measured
tokens, not a bill.

## Running one

```bash
export THINKER_SRC=~/src/thinker OUT=/tmp/clearbench
mkdir -p $OUT && (cd $OUT && python3 $THINKER_SRC/research/clearing-bench/gen-work.py work 18 34000)
# write $OUT/prompt.txt naming each file by absolute path, one Read per file, then N echo calls
PORT=$(~/.claude/bin/claude-port reserve thinker clearbench)
PORT=$PORT ./run-arm.sh clearing 0 3 $OUT/prompt.txt
PORT=$PORT ./run-arm.sh control  1 3 $OUT/prompt.txt
python3 analyse.py $OUT/log-clearing.jsonl $OUT/log-control.jsonl
~/.claude/bin/claude-port release thinker clearbench
```

Both arms must stay inside the context window: a control that auto-compacts is not a control.
Check for `native-compaction` in the logs before believing a pairing.

## Running a multi-turn one (the only shape that reaches the deep path)

`clearable` counts what sits *before* the current turn, so a one-prompt session has nothing there and the
ask never grows: a single-turn arm can only ever measure the floor. `run-turns.sh` resumes one Claude Code
session across N turns (`--session-id` then `--resume`), which is what the proxy needs to see a turn
boundary at all.

```bash
export THINKER_SRC=~/src/thinker OUT=/tmp/clearbench
mkdir -p $OUT && python3 $THINKER_SRC/research/clearing-bench/gen-turns.py $OUT/turns 9 2 34000 3
PORT=$(~/.claude/bin/claude-port reserve thinker clearbench)
PORT=$PORT ./run-turns.sh clearing 0 2 $OUT/turns --trigger 60000 --clear-at-least 30000
PORT=$PORT ./run-turns.sh control  1 2 $OUT/turns --trigger 60000 --clear-at-least 30000
python3 analyse.py $OUT/log-clearing.jsonl $OUT/log-control.jsonl
~/.claude/bin/claude-port release thinker clearbench
```

The trigger and the ask have to be low enough for `0.7 x clearable` to bind before the session ends;
at the shipped 140k/100k a nine-turn arm of this size never reaches a second decision.

Checked on the harness itself before spending on a pairing: one session id across every resumed turn,
`turn` on the row incrementing at each boundary and absent within a turn.

## Reading a refusal

Since #604 a turn boundary that declined to deepen carries `held` on its row (`dropped`, `recache`,
`cost`, `saving`, `need`, `have`), and every boundary carries `clearable`. `analyse.py` prints each
refusal with the arithmetic behind it. A row with `clearable` and no `held` is a boundary where the ask
would not have grown; one with `held` is a deepening the price refused. Before this, a log of refusals
was indistinguishable from a log of a policy that never considered deepening at all -- which is exactly
what the live log of 2026-11-03 could not resolve.

## What was measured (2026-11-02, Opus 5.5, 0.2.19)

| workload | clearing vs control (1h writes) | at 5m writes |
|---|---|---|
| 18 files read once, 20 `echo` calls, nothing re-read (3 reps) | **−10.5%** | −16% |
| the same, then 6 of the cleared files read back (2 reps) | −1.5% | −3% |
| the same, with a 52k instruction block above the cleared region (2 reps) | **+20.6%** | −2% |
| freeze against the fixed ask, both clearing, 13-use block, 9 turns (2 reps) | **+152%** | — |

One mechanism covers the first three: the benefit scales with the **clearable** share of the context,
the cost with the size of the **uncleared** prefix that every clear writes again. In the losing arm
`isRewrite` flagged a single call — the cost was in the write total (0.13M against 0.35M), not the
rewrite rate, so a rate alone is not a cost measure.

## What was measured (2026-11-02, evening, Opus 5.5, the one-policy clearing of #600 plus the exact gauge)

Two reps per arm, the control arms shared with the morning runs where the workload is the same.

| workload | clearing vs control (1h writes) | at 5m writes | server re-applications |
|---|---|---|---|
| 18 files read once, 20 `echo` calls (W1) | **−8.8%** | −22.6% | 3 |
| the same, six files read back (W2, first gauge) | +3.4% | −10.3% | 5 |
| the same, 52k instruction block above (W3, first gauge) | −18.0% | −27.8% | — |
| 9 turns of two files and three echoes, trigger 60k, ask 30k (W4) | **−4.1%** | −17.8% | 16 |

Read these beside the morning's: W1 came out **+21.3%** that morning on the same edit (the proxy sends keep 3,
ask 100k, trigger 140k to a single-turn session in every version since #582), and W3 had been +20.6% the day
before. Two reps do not settle a sign; what moves the number between runs is how many calls the model chose to
make in each arm. The first version of #600's gauge stopped both W4 sessions on their second cleared call
(+9.4%, a ratio heuristic taking a 21k file read into a 40k context for a rewrite); the exact gauge stopped nothing.

**The server's rule**, from three single-rep W1 runs with the trigger at 100k, 140k and 180k, identical to the
token: the API applies the edit only once at least `clear_at_least` of results have accumulated beyond what it
already cleared, and then clears everything but the keep (5 of 8 results at a raw prompt of 192k, 10 of 13 at
302k, 15 of 18 at 413k). The trigger plays no part once crossed; keep and trigger cannot hold the set;
`clear_at_least` is the interval between applications, each a rewrite of the post-clear context (~70k here).
Claude Code 2.1.316 sends no tool clearing of its own (captured: `clear_thinking keep: all` only).

## Caveats worth keeping

- The first workload is a best case by construction: every token is a clearable tool result and
  nothing is ever read again.
- The re-read workload re-reads the **oldest** files, which no recency keep could protect, so it is
  the worst case for re-reads rather than a typical one.
- The sign of the instruction-heavy result turns on the cache TTL, which the proxy log does not
  record. Treat the 1h column as the pessimistic bound.
- A single-turn session can never ask deep: `clearableBeforeTurn` counts what sits before the current
  turn, and a one-prompt session has nothing there. Forcing the deep path needs several turns
  (`claude -p --continue`) and a floor low enough for `0.7 × clearable` to bind.
- Two or three reps. The within-arm spread was small, but these are not powered samples.
