# thinker: think ahead. save context.

![Pixel-art blue sky with white clouds](docs/images/sky.png)

Your coding agent rediscovers your codebase on every task: where things live, how the
parts connect, which change broke what last time. `thinker` remembers it instead.

- **Learns from your sessions.** What your agent works out in a session becomes a short
  note pinned to the exact code it describes; merged pull requests and skill files can be
  read in too, when you ask.
- **Serves only what fits.** Each request gets the notes that match it, with pointers into
  the code, so the agent starts in the right place.
- **Keeps itself fresh.** A note whose code changed is re-checked before it is served again;
  sessions confirm, correct or retire the notes they were shown.

<p align="center">
  <b>18% fewer tokens per task</b> &nbsp;·&nbsp; <b>10% less wall time per task</b><br>
  <sub>on real coding tasks from open-source repositories, same model with and without the cache</sub>
</p>

Website, docs and benchmarks: [zerotime.dev](https://zerotime.dev).

## Install

```bash
npx @zerotimedev/thinker
```

The installer wires thinker into the coding agents on the machine. From then on every git
repository has a cache that grows from your sessions; `thinker warmup` reads a repository's
merged pull requests into it when you want a head start ([how setup works](docs/setup.md)).

Requires git, Node 20+ and a logged-in coding agent: Claude Code, Codex, Cursor, Gemini CLI
and [others](docs/agent-integrations.md). `thinker update` keeps it current in the background.

## Uninstall

```bash
thinker uninstall --user --purge   # this repository's hooks and notes, and the machine-wide wiring
rm -rf ~/.thinker                  # the app, the ranking model and the usage log
```

To keep thinker but switch it off for one repository, run `thinker disable` there.

## Everyday commands

```bash
thinker ui              # local page: repositories, usage, the notes in each cache
thinker usage --here    # what the cache cost and what it saved
thinker skills          # the skill files as the cache sees them
thinker benchmark       # compare your agent with and without the cache
```

Otherwise, work with your agent as usual: the notes arrive on their own. Everything stays
in the repository's `.thinker/` folder, and model calls go through the agent you already use.

## Results

**Coding agents: input tokens and wall time per task.** Real tasks from merged pull requests,
same model with and without thinker.

```
Claude Fable       without thinker  ████████████████████  1.25M
                   with thinker     ████████████████░░░░  1.02M   18% less tokens

Gemini 3.8 Flash   without thinker  ████████████████████  16.6M
                   with thinker     ████████████████░░░░  13.4M   19% less tokens

GPT-6 Astra        without thinker  ████████████████████  473k
                   with thinker     ████████████████░░░░  384k    19% less tokens
```

```
Claude Fable       without thinker  ████████████████████  2.7 min
                   with thinker     █████████████████░░░  2.3 min  14% less time

Gemini 3.8 Flash   without thinker  ████████████████████  13.1 min
                   with thinker     ██████████████████░░  11.9 min 8.5% less time

GPT-6 Astra        without thinker  ████████████████████  152 s
                   with thinker     ███████████████████░  141 s    7% less time
```

Each model saw different tasks, so the rows are not a model ranking; one run per
arm. Bug detection is not claimed: on held-out bugs the cache did not change what a
reviewer caught (research/regression-heldout on the `agent/heldout-regression` branch). Method, uncertainty and per-task results: [research/bench-history/RESULTS.md](research/bench-history/RESULTS.md).

## Learn more

- [Setup, updates and telemetry](docs/setup.md): setting up on the local page, build depth and cost, large repositories, the local cache, updates, test mode, telemetry and opting out
- [Usage, savings and learning](docs/usage.md): `thinker stats` and `usage`, the holdout comparison, how sessions are learned from
- [Skills](docs/skills.md): skill cards, the audit, what sessions say about a skill, duplicates
- [Delivery outcomes](docs/delivery-outcomes.md): `thinker impact`, tokens and fixes per merged PR
- [ONBOARDING.md](ONBOARDING.md): setting up your local cache
- [AGENTS.md](AGENTS.md): how thinker works inside, per-agent support, repository layout

## License

MIT. See [LICENSE](LICENSE).
