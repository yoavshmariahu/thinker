# Setting up Thinker

```bash
npx @zerotimedev/thinker
```

Run the installer anywhere. It wires your agents, asking nothing, then reads
the agents' own transcripts of the last 30 days in the repositories they worked
in most and shows where their context goes and what to cut first: the sections
of AGENTS.md, the skills and the tools that cost the most in the sessions that
did not use them. It asks where to see them: in the browser, on the local page
over every repository, or in the terminal, where the suggestions are a list to
pick from (compress or remove a section, switch off a skill or tool) and apply
at once.

Nothing is built: every git repository gets an empty cache with its first
session, and the cache grows from the sessions there. Notes are stored locally
and ranked on your machine; your configured agent writes them.

## After that

You don't run thinker by hand:

- **About once a week your agent passes on a suggestion from thinker**: a few
  lines naming what to cut and what it would save, with a link to the page.
  Reply with the numbers to approve, or "all", or review them on the page first.
- **`thinker ui` opens the page** whenever you want it: Find Savings, View
  Report and Recent activity, over every repository on the machine.

Learning, re-checking notes as the code changes, and updates run in the
background. [docs/setup.md](docs/setup.md) has the details.

## Installer options

- `--no-ui`: stay in the terminal. Over SSH or in CI the browser is not offered;
  with `--yes` or no terminal, the report is printed.
- `--clients claude,codex,cursor,gemini` (or `all`): which agents to wire; by
  default the ones found on the machine.
- `--no-learn`: wire the agents without learning from sessions.
- `--no-auto-update`: skip scheduling background updates.
- `--uninstall`: take the machine-wide wiring out again.
