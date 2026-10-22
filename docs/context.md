# Where the context goes

The Context page shows where your coding agents' context goes in a repository, part by part, with what
each part costs a session and how much the sessions used it, and lets you cut what they do not use.
Back to the [README](../README.md).

```bash
thinker ui                 # opens the local page on Context
thinker context            # the same report in the terminal
thinker context --days 7   # the last week; the page has 7 and 30 days, one repository or all
```

Everything is read from the agents' own session transcripts on this machine. Nothing is sent
anywhere, and the report changes nothing by itself: every cut below is a choice you make, shown
first, undone with one command.

## What it shows

**Input tokens over time.** Stacked columns by day or week, total or per session, split into the
parts the agent reads on every model call:

| part | what it is | read from |
|---|---|---|
| Instruction files | `AGENTS.md`, or `CLAUDE.md` where there is no `AGENTS.md`, section by section | Claude Code, Codex, Cursor and Gemini CLI sessions |
| Custom tools | the skills listed in every session, MCP servers and plugins, with their descriptions and tool definitions | Claude Code in full; Codex's skill catalog and MCP namespaces; Cursor's MCP servers |
| Built-in tools | the agent's own tool definitions, re-sent with every call | Claude Code |
| Tool outputs | what each tool's results added to the conversation, re-read by every call after them | Claude Code |

A part's cost a session is its tokens times the session's model calls: a 4k-token instruction file
read by 40 calls is 160k input tokens. That is the number the page shows and sorts by.

**One part at a time, as cards.** Each instruction section, skill and tool beside:

- *Cost*: tokens per call and input tokens a session.
- *Used* (the page's Sessions used): how often the sessions acted on it. A section is *applied* when a session touched its
  files, ran its command or read the code it names, free, from the transcript. *Relevant* and
  *followed* come from a model reading one session against the sections and saying which bore on
  the work and whether the agent followed them; that costs tokens, so it runs when you press
  **Judge 5 more sessions**, or on a sample of sessions as they end once you turn it on (`instructions:
  { value: { judge: true } }` in `.thinker/config.json`). A skill is *read* when a session opened it,
  and the sampled outcome check says whether sessions that read it kept its rules, and how often one
  broke them without reading it. A tool is *used* when a session called it.
- *Wasted*: what the part cost in the sessions that did not use it. For a tool output, what its
  results cost after the agent last used them: the last call of the same turn that edited with text
  copied from the result or touched the same file, an estimate from the transcript. High waste from 5%
  of what its kind costs, medium from 2%. For a section, skill or tool that is what cutting it would save
  at most; a session that needed it would go without. For an output it is the size of the problem, not
  of the saving: compression cuts only the part of a result past its cap, and the row's detail says how
  much that is.

**All repositories** merges every repository's report: the timeline side by side, tools merged by
name, averages weighted by sessions.

## What you can cut

Every action shows what it will do before it does it, and each one is a command too.

| cut | on the page | from the terminal | undo |
|---|---|---|---|
| Shorten an instruction section | pick sections, **Compress**: a model rewrites them to about a third, keeping the rules, commands and paths; the diff is shown, **Apply** writes it to the file in your working tree, uncommitted | `thinker instructions --compress <ids> [--apply]` | `git checkout` the file |
| Drop an instruction section | pick sections, **Remove**; the same diff and Apply | `thinker instructions --remove <ids> [--apply]` | `git checkout` the file |
| Give this checkout a shorter file | keep the sections that matter here; the team's file is untouched and the agents here read a trimmed local copy | `thinker instructions --core "Title, Title"` | **Remove the trimmed copy**, or `thinker instructions --off` |
| Switch a skill, MCP server or plugin off | pick them, **Switch off**: off for this repository from the next session, in the agent's own settings, with a backup; a skill switched off still runs as `/name` | `thinker harness --off "<label>"` | **Turn back on**, or `thinker harness --undo` |
| Switch a built-in tool off | the same, under Built-in tools | `thinker context --switch-off <labels> --builtin` | `thinker context --switch-on <keys>` |
| Compress tool outputs | per tool, **High**, **Moderate** or **No compression**: a whole-file read becomes the lines around what the session searched for, a test run its counts and distinct failures, a big search its hits per file, long output cut to a cap; Claude Code only, through its tool hook | `thinker context --output-compression <tools> --level high\|moderate\|off` | the same, `--level off` |

Compress and Remove edit the team's file in your working tree and nothing else: no commit, no pull
request, and Apply refuses when the file changed since the preview. Switching a tool off turns
thinker's harness on for that repository, which is what reads and writes the agent's settings
(`thinker harness` lists what is off and `--undo` restores every file from its backup).

## What the numbers are

Tokens are counted from the transcripts: the text of what each session loaded, at about four
characters a token, times the model calls the transcript records. The outputs' cost is each result's
tokens times the model calls left after it, and a compaction, which drops old results, is not seen,
so that part is an upper estimate. The waste flags and the savings are measurements of use, not a
promise: cutting a section saves its tokens, and whether the agent then misses it is what the
*followed* and *missed* columns are there to show. No benchmark is claimed for the cuts; the
[benchmark results](../research/bench-history/RESULTS.md) are about the cache.

## The cache beside it

The Cache tab holds thinker's other half: notes learned from your sessions and merged pull requests,
served to the agent as it works, so it reads less to find its way ([usage and learning](usage.md),
[setup](setup.md)). The two meet in the same number: the input tokens a session spends.
