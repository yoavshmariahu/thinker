# thinker: a knowledge cache for coding agents

![Pixel-art blue sky with white clouds](docs/images/sky.png)

Your coding agent rediscovers your codebase on every task: where things live, how the
parts connect, which change broke what last time. `thinker` remembers it instead.

- **It injects the right context and skills, as the agent works.** Thinker learns from
  your merged pull requests, your agent sessions and your skill files, and keeps short
  notes pinned to the exact code they describe. On each request it ranks them and serves
  only the ones that fit, with pointers into the code, so the agent starts at the right
  place instead of searching for it.
- **It keeps the cache fresh on its own.** Every session grades the notes it was served:
  a note the agent acted on gains confidence, a note the trace contradicts is corrected,
  an unused one decays. A note whose code changed is held back and re-verified before it
  is served again. New pull requests become notes as they merge.
- **Tasks finish faster, on fewer tokens, with fewer pitfalls.** The agent spends less of
  its budget rebuilding a picture of the repository, and the traps the history already
  knows about are in front of it before it touches the code.

<p align="center">
  <b>18% fewer tokens per task</b> &nbsp;·&nbsp; <b>10% less wall time per task</b><br>
  <sub>on real coding tasks from open-source repositories, same model with and without the cache</sub>
</p>

Website, docs and benchmarks: [zerotime.dev](https://zerotime.dev).

## Install

Run this in a terminal, inside your repository:

```bash
npx @zerotimedev/thinker
```

The installer comes in the
[`@zerotimedev/thinker`](https://www.npmjs.com/package/@zerotimedev/thinker) package on npm.

The installer wires thinker into the coding agents on the machine; from then on every git
repository has a cache that grows from your sessions. It offers to warm up
caches from merged pull requests on a local page in your browser, right there in the
terminal (the top five picked; arrows and Space change that, then choose a harness and model), or later with `thinker warmup`
([how setup works](docs/setup.md)).

Requires bash, git, curl, tar, Node 20+ and a logged-in coding agent. Works with Claude
Code, Codex CLI, Gemini CLI, Cursor, Pi, Windsurf Cascade, GitHub Copilot CLI and
OpenCode ([hook coverage and limitations](docs/agent-integrations.md)).

The installer fetches the [latest release](https://github.com/yoavshmariahu/thinker/releases)
(a tag `vX.Y.Z` with the archive, its `version.json` manifest and the installer attached)
and checks the archive against the manifest's SHA-256. `thinker update` does the same
daily in the background; `thinker update v0.1.34` pins a release.

## Uninstall

```bash
thinker uninstall --user --purge   # inside a repository: its hooks, MCP registration and notes, and the machine-wide wiring
rm -rf ~/.thinker                  # the app, the ranking model and the usage log
```

Then drop the `PATH` line the installer added to your shell startup file. To keep
thinker but switch it off for one repository with sensitive content, run `thinker disable` there.

## How it works

1. **It learns from your history.** Thinker reads your merged pull requests, fixes first, and your agent sessions. It writes short notes: what broke and why, what a later change must not undo, how the parts connect. Each note points at the exact code it describes.
2. **It hands your agent what fits.** When you give your agent a task, Thinker passes it the notes that fit, if any do, with pointers to the exact code. When the agent edits a file, it gets the rules that rest on that file.
3. **It keeps itself current.** When the code under a note changes, the note is checked again in the background; until it passes, it is never handed over as fact.
4. **It knows your skills.** Each skill file (`SKILL.md`) checked into the repository gets a card that is served like any other note and checked against the code it talks about. A skill the code contradicts is listed with its issues and not handed over until it is fixed or reviewed; among skills that do the same thing, the one the sessions confirm is the one served.

Everything stays in your repository's `.thinker/` folder. Model calls go through
the coding agent you already use, on its own login.

## Everyday commands

```bash
thinker ui                          # local page: set up repositories, usage, the notes in each cache
thinker skills                      # the skill files as the cache sees them: out of date, duplicates, evidence
thinker benchmark                   # compare your agent with and without the cache
thinker usage --here                # what the cache cost and what it saved
```

Otherwise, work with your agent as usual: the notes arrive on their own.

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
reviewer caught (research/regression-heldout on the `agent/heldout-regression` branch). Method, uncertainty and per-task results: [bench/RESULTS.md](bench/RESULTS.md).

## Learn more

- [Setup, updates and telemetry](docs/setup.md): setting up on the local page, build depth and cost, large repositories, the local cache, updates, test mode, telemetry and opting out
- [Usage, savings and learning](docs/usage.md): `thinker stats` and `usage`, the holdout comparison, how sessions are learned from
- [Skills](docs/skills.md): skill cards, the audit, what sessions say about a skill, duplicates
- [Delivery outcomes](docs/delivery-outcomes.md): `thinker impact`, tokens and fixes per merged PR
- [ONBOARDING.md](ONBOARDING.md): setting up your local cache
- [AGENTS.md](AGENTS.md): how thinker works inside, per-agent support, repository layout

## License

MIT. See [LICENSE](LICENSE).
