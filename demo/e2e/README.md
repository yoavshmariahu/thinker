# The fleet e2e: three containers that are three machines

Three containers, each one a machine in the fleet: **OpenCode 2** with thinker installed and wired,
thinker's **proxy in the model path**, and a **loopback Messages API** in place of a provider, so a real
agent loop runs in each with no credentials. The collector (`demo/collector/`) runs on the host and is
the sink they ship their sessions to.

What is real and what is not, because a demo that blurs this is worth nothing:

| real | the agent, the hooks, the proxy, the cut, the session event, the settings coming back |
| real | the usage: measured from the request that actually arrived (`model.mjs`), priced by `prices.js` |
| not  | the model's judgement. The turns are scripted. Nothing here is a claim about an agent's quality. |

## Bring it back up

```bash
bash demo/e2e/demo.sh          # collector + three machines, with the data already on the page
open http://127.0.0.1:6896
```

The fleet's own database lives in `~/.thinker-fleet-demo/fleet.db`, outside every checkout and every
temporary directory, so the page comes back with its history. Each machine has a **pinned install id**
(`entry.sh`), so a container rebuilt from scratch rejoins as the machine it was rather than appearing
as a fourth.

## Run another round

```bash
bash demo/e2e/fleet.sh round 4            # one session on each machine, three prompts each
bash demo/e2e/fleet.sh policy 120000      # an operator moves the fleet's cut trigger
bash demo/e2e/fleet.sh round 5            # each machine takes it as its next session starts
bash demo/e2e/fleet.sh state              # what the dashboard reads
```

A setting lands on a machine's **next** session: the machine ships an event, the sink answers with the
settings, and the proxy is started from the merged config at the next session's start
(`proxy-service.js:serviceArgs`). Round 4 above will show `3 of 3 machines still to take this`; round 5
shows `every machine has taken this`, and the refusal reasons inside the containers move with it.

## From nothing

```bash
bash demo/e2e/fleet.sh clear    # empty the collector
bash demo/e2e/fleet.sh build    # ~2 min: OpenCode 2, thinker, npm ci
bash demo/e2e/fleet.sh up       # three machines
bash demo/e2e/fleet.sh run      # clear, push the working tree in, reset, two rounds and a policy change
bash demo/e2e/fleet.sh down     # remove the containers
```

`push` copies the working tree's `src/` into the running containers, which is how a fix is tried without
a rebuild. `reset` makes the machines forget their sessions and keeps their install ids.

## What it found

Four things, all of them invisible on a Claude Code machine, all of them written up in AGENTS.md under
*The fleet e2e, and the four things it found*: OpenCode's route had no `/v1` so the cut never fired; no
request was attributed to a session; no session event shipped at all; and the session that finally
shipped had no figures on it. Two more things it showed that are **not** faults: a one-prompt job never
gets a cut (the newest turn is kept whole), and `cleared` is cumulative over requests on purpose.
