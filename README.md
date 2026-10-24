# thinker: cut wasted context

Thinker helps your coding agent use fewer tokens. Find what it loads but rarely uses,
review what to cut, and reuse what it learns about your code.

- **Find savings.** See which instructions, skills and tools consume context without helping your sessions.
- **Make the cuts.** Shorten instructions, switch off unused tools and compress long outputs. You review the changes.
- **Keep the knowledge.** Thinker learns from your sessions and brings relevant notes into future tasks, checking them as the code changes.

## Install

```bash
npx @zerotimedev/thinker
```

The installer connects your coding agents and shows suggested savings from your recent sessions.
Review them in your browser or terminal, then keep coding as usual.

Works with Claude Code, Codex, Cursor, Gemini CLI and [more](docs/agent-integrations.md).
Requires Node 20+, git and a supported agent. Free and open source.

[See how it works](https://zerotime.dev/docs#overview) · [Setup guide](docs/setup.md)

## Everyday commands

```bash
thinker ui              # Find Savings and View Report in your browser
thinker context         # find savings in the terminal
thinker report          # track tokens and costs week by week
thinker usage --here    # see what this repository's cache costs and saves
```

Reports and notes are stored locally. Learning uses your existing agent's model access.
See [setup and privacy](docs/setup.md) for details and telemetry controls.

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
[research/bench-history/RESULTS.md](research/bench-history/RESULTS.md). The Find Savings cuts are
measured on your own sessions, as the tokens they would save; no benchmark is claimed for them yet.

## Learn more

- [Where the context goes](docs/context.md): Find Savings and `thinker context`, what each number is, every cut and its undo
- [Setup, updates and telemetry](docs/setup.md): the local page, updates, test mode, telemetry and opting out
- [Usage, savings and learning](docs/usage.md): `thinker usage`, the holdout comparison, how sessions are learned from
- [Skills](docs/skills.md): skill cards, the audit, what sessions say about a skill, duplicates
- [Delivery outcomes](docs/delivery-outcomes.md): `thinker impact`, tokens and fixes per merged PR
- [AGENTS.md](AGENTS.md): how thinker works inside, per-agent support, repository layout

## License

MIT. See [LICENSE](LICENSE).
