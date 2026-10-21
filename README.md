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
- **Cut it.** Compress or remove instruction sections as a diff you apply; keep only the sections
  that matter in a trimmed copy for this checkout; switch unused skills and tools off from the next
  session, with a backup; compress long tool outputs before the agent reads them. Each cut is shown
  first and undone with one command.
- **Remember instead.** The cache behind the Cache tab: what your agent works out in a session
  becomes a short note pinned to the code it describes, served on the requests it fits and re-checked
  when that code changes, so the agent reads less to find its way.

Website and docs: [zerotime.dev](https://zerotime.dev).

## Install

```bash
npx @zerotimedev/thinker
```

The installer wires thinker into the coding agents on the machine and opens the local page. The
Context page reads your sessions from the agents' own transcripts; nothing else is needed. The
cache grows from your sessions in every git repository from then on, and `thinker warmup` reads a
repository's merged pull requests into it when you want a head start ([setup](docs/setup.md)).

Requires git, Node 20+ and a logged-in coding agent: Claude Code, Codex, Cursor, Gemini CLI
and [others](docs/agent-integrations.md). `thinker update` keeps it current in the background.

## Everyday commands

```bash
thinker ui              # local page: where the context goes, then the caches and their notes
thinker context         # the Context page's report in the terminal (--days 7, --json)
thinker instructions    # compress, remove or keep sections of AGENTS.md; a trimmed local copy
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
- [Setup, updates and telemetry](docs/setup.md): the local page, build depth and cost, updates, test mode, telemetry and opting out
- [Usage, savings and learning](docs/usage.md): `thinker usage`, the holdout comparison, how sessions are learned from
- [Skills](docs/skills.md): skill cards, the audit, what sessions say about a skill, duplicates
- [Delivery outcomes](docs/delivery-outcomes.md): `thinker impact`, tokens and fixes per merged PR
- [AGENTS.md](AGENTS.md): how thinker works inside, per-agent support, repository layout

## License

MIT. See [LICENSE](LICENSE).
