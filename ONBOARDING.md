# Setting up Thinker

```bash
npx thinkersh
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

- **Thinker cuts what your agents load and never use, by itself**: a change
  has to save $1 a day or more, and the ones that do go out together as one
  batch, with one pull request for your instruction files that a person merges.
  A week later it checks each change and takes back what did not pay.
- **`thinker ui` opens the page** whenever you want it: a chat with thinker,
  what it did lately with what each action saved, the Factory and Recent
  activity, over every repository on the machine.

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
