# thinker: think ahead. save context.

![Pixel-art blue sky with white clouds](docs/images/sky.png)

Every model call your coding agent makes re-reads the same things: the instruction file, the
skill list, every MCP server's tool definitions, every tool result so far. Most of it is never
acted on. `thinker` shows you where the context goes, part by part, and lets you cut the parts
your sessions do not use.

- **See it.** `thinker ui` opens on the Context page: input tokens a session, split into
  instruction files, skills, MCP servers, plugins, built-in tools and tool outputs, over the last
  7 or 30 days, for one repository or all of them. Each section, skill and tool beside what it
  costs and how often sessions acted on it, the waste flagged.
- **Cut it.** Compress or remove instruction sections as a pull request you review; switch unused
  skills and tools off from the next session, with a backup; compress long tool outputs before the
  agent reads them. Each cut is shown first and undone with one command.
- **See the trend.** The View Report tab: what a session costs here week by week, by part of the context
  and by model, in tokens or at list prices, with the actions you took and what the cache saved.
- **Remember instead.** The cache: what your agent works out in a session
  becomes a short note pinned to the code it describes, served on the requests it fits and re-checked
  when that code changes, so the agent reads less to find its way.

Website and docs: [zerotime.dev](https://zerotime.dev).

## Install

```bash
npx @zerotimedev/thinker
```

The installer wires thinker into the coding agents on the machine, then reads your recent sessions
from the agents' own transcripts and shows where their context goes and what to cut first, in the
browser, where the suggested savings come already checked for one Apply, or in the terminal, where
the suggestions are a list to pick from and apply at once; nothing else is needed. The cache grows
from your sessions in every git repository from then on ([setup](docs/setup.md)).

Requires git, Node 20+ and a logged-in coding agent: Claude Code, Codex, Cursor, Gemini CLI
and [others](docs/agent-integrations.md) (the table below says what works with each). `thinker update` keeps it current in the background.

## What works with which agent

Four things thinker does, and where each one reaches. "Automatic" means the installer wires it; "by hand" means
the agent can take it once you point it there; a blank means the agent gives thinker no way in.

| Agent | Tool output compression | Knowledge cache | Instruction file optimization | Token usage analytics |
| --- | --- | --- | --- | --- |
| Claude Code (CLI, VS Code, JetBrains) | automatic: the proxy clears old tool results; per-tool caps from the Find Savings page | yes: notes on each prompt and on the files being edited, learned from every session | yes: every section, nested file and rule measured; cuts as pull requests | yes: tokens by part and by model, week by week |
| Claude desktop app (Code tab) | per-tool caps only: Desktop sets its own API URL, so the proxy cannot sit in front of it | yes, through the session itself | yes | yes |
| Codex CLI and app | no: Codex speaks only OpenAI's API, and its hooks cannot rewrite a result | yes | the root AGENTS.md measured | yes |
| Cursor (editor and `agent` CLI) | no: calls go through Cursor's servers | yes (the CLI one tool call late) | the root AGENTS.md measured | partial: Cursor reports no token usage |
| Gemini CLI | no: Google's API only | yes | the root AGENTS.md measured | partial: tool outputs only |
| pi | automatic: the proxy, through `models.json` | yes | | |
| OpenCode, Kilo Code | automatic for OpenCode (`opencode.json`); Kilo's CLI by hand | yes | | |
| Factory Droid | by hand: a custom model with the proxy as its base URL | yes | | |
| Qwen Code | by hand, on an Anthropic model provider | yes | | |
| GitHub Copilot CLI, Copilot in VS Code | by hand (the CLI, with your own Anthropic key) | yes, one tool call late | | |
| Cline | by hand: the Anthropic provider's custom base URL | yes (the CLI one tool call late) | | |
| Kiro CLI | no: Kiro's own backend | notes on each prompt (V3 engine) | | |
| Windsurf Cascade | no: Windsurf's servers | no: its hooks only record, for learning | | |
| Auggie | no: Augment's servers | notes on the files being edited | | |
| Goose | by hand (`ANTHROPIC_HOST`) | no: its hooks only record, for learning | | |

The compression is the API clearing tool results the agent has finished with, through a local proxy thinker keeps
running (`thinker proxy status`, `thinker proxy off`); it reaches any agent that speaks the Anthropic Messages API at
a base URL you can set. A section cut benefits every agent that reads the file, whichever agent's sessions
measured it. Details and the hook events behind each cell: [docs/agent-integrations.md](docs/agent-integrations.md).

## Everyday commands

```bash
thinker ui              # local page: Find Savings (where the context goes, and the cuts), View Report (what a session costs, by week)
thinker context         # the Context page's report in the terminal (--days 7, --json)
thinker instructions    # compress or remove sections of AGENTS.md, as a pull request
thinker proxy status    # the context proxy: old tool results cleared from the context by the API
thinker harness         # the skills and tools loaded into every session, and what to switch off
thinker usage --here    # what the cache cost and what it saved
```

Otherwise, work with your agent as usual. Everything stays on your machine, in the repository's
`.thinker/` folder, and model calls go through the agent you already use.

## Uninstall

```bash
thinker uninstall --user --purge   # this repository's hooks and notes, and the machine-wide wiring
rm -rf ~/.thinker                  # the app, the ranking model and the usage log
```

To keep thinker but switch it off for one repository, run `thinker disable` there.

## Results

The cache is measured on real tasks from merged pull requests, same model with and without it:
18% fewer input tokens and 10% less wall time per task across Claude Fable, Gemini 3.8 Flash and
GPT-6 Astra, one run per arm, different tasks per model. Method, uncertainty and per-task results:
[research/bench-history/RESULTS.md](research/bench-history/RESULTS.md). The Context page's cuts are
measured on your own sessions, as the tokens they would save; no benchmark is claimed for them yet.

## Learn more

- [Where the context goes](docs/context.md): the Context page and `thinker context`, what each number is, every cut and its undo
- [Setup, updates and telemetry](docs/setup.md): the local page, updates, test mode, telemetry and opting out
- [Usage, savings and learning](docs/usage.md): `thinker usage`, the holdout comparison, how sessions are learned from
- [Skills](docs/skills.md): skill cards, the audit, what sessions say about a skill, duplicates
- [Delivery outcomes](docs/delivery-outcomes.md): `thinker impact`, tokens and fixes per merged PR
- [AGENTS.md](AGENTS.md): how thinker works inside, per-agent support, repository layout

## License

MIT. See [LICENSE](LICENSE).
