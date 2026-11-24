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

Open your local dashboard from any directory:

```bash
thinker ui
```

To open **View Report** directly in your browser:

```bash
thinker ui --tab report
```

Thinker also runs in the background:

- **Thinker finds what your agents load and never use, and asks before it
  cuts it**: a change has to save $5 a day or more, and the ones that do go
  together as one batch. Once a week at most your agent asks you, in a
  session, which to ship: one pull request for your instruction files, which
  a person merges. Nothing changes without your yes. Set it to Automatic
  (`thinker settings`) and it ships them itself, then checks each change a
  week later and takes back what did not pay.
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
- `--no-auto-update`: skip scheduling the background check for a new release (a release it finds is asked about,
  not installed).
- `--uninstall`: take the machine-wide wiring out again.
