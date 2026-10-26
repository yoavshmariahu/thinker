# Find Savings

See which instructions, skills and tools consume your coding agent's context without helping
its sessions. Review the suggested cuts, then track the change in **View Report**.
Back to the [README](../README.md).

Open it with `thinker ui`, or from the link in thinker's weekly suggestion in your session: about once a
week your agent passes on a few lines from thinker naming the changes worth making, and you can approve them
there by number or review them here. Over every repository at first; pick one from the list.

Start with a costly item your sessions rarely use. Preview the change before applying it;
[the action table](#what-you-can-cut) explains what changes and how to undo it.

## What it shows

**Input tokens over time.** Stacked columns by day or week, total or per session, split into the
parts the agent reads on every model call:

| part | what it is | read from |
|---|---|---|
| Instruction files | `AGENTS.md`, or `CLAUDE.md` where there is no `AGENTS.md`, section by section | Claude Code, Codex, Cursor and Gemini CLI sessions |
| Custom tools | the skills listed in every session, MCP servers and plugins, with their descriptions and tool definitions | Claude Code in full; Codex's skill catalog and MCP namespaces; Cursor's MCP servers |
| Built-in tools | the agent's own tool definitions, re-sent with every call | Claude Code |
| Tool outputs | what each tool's results added to the conversation, re-read by every call after them | Claude Code |

One rule: a part sits in the prompt, so it costs its size in every model call that carries it. **Per
prompt** is that size — a prompt being one call to the model, as the Report counts it. **Needed** is the
share of those prompts where the agent acted on it: called the tool, invoked the skill, touched the files,
commands or code the section names, read the output again before moving on. **Over N days** is per prompt
times every prompt that carried it in the window, what the page sorts by. **Wasted** is that times the share
of prompts that did not need it, the most that cutting the part could save. These are input tokens read: a
definition at the stable front of the prompt is served from the prompt cache on most calls, at a tenth or
less of the input price, and the Report prices the token types as the model reported them.

**One part at a time, as cards.** Each instruction section, skill and tool beside:

- *Cost*: per prompt, the share of prompts that needed it, the total over the window, and the waste.
- *Used* (the page's Sessions used): how often the sessions acted on it. A section is *applied* when a session touched its
  files, ran its command or read the code it names, free, from the transcript. *Relevant* and
  *followed* come from a model reading one session against the sections and saying which bore on
  the work and whether the agent followed them; that costs a model call, so it runs on a 25% sample of
  sessions as they end (`instructions: { value: { judge: false } }` in `.thinker/config.json` turns it
  off, `share` changes the sample). Once five sessions
  are judged the share shown is the judged sessions that followed the section. The **?** beside the
  column header says how each kind is counted. A skill is *read* when a session opened it,
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
name, each cost summed over the repositories and read against all their prompts together.

## What you can cut

Every action shows what it will do before it does it, and each one can be undone from the page.

| cut | on the page | undo |
|---|---|---|
| Shorten an instruction section | pick sections, **Compress**, Apply: in the background a model rewrites them to about a third, keeping the rules, commands and paths, and a pull request opens with the change; the page says once that it started, the row says *Compressing…* while it runs, and Recent activity follows it | close the unmerged PR (**Close PR** under Recent activity); revert a merged change |
| Drop an instruction section | pick sections, **Remove**, Apply: a pull request opens with the change in a moment | close the unmerged PR; revert a merged change |
| Switch a skill, MCP server or plugin off | pick them, **Switch off**: off for this repository from the next session, in the agent's own settings, with a backup; a skill switched off still runs as `/name` | **Turn back on** |
| Switch a built-in tool off | the same, under Built-in tools (their rows in bold): Apply asks first, naming the tools, where the switch is written and how they come back | **Turn back on**, or **Revert** under Recent activity |
| Compress tool outputs | per tool, **Compress** or **No compression**: a whole-file read becomes the lines around what the session searched for, a test run its counts and distinct failures, a big search its hits per file, long output cut to a cap of about 3k tokens; Claude Code only, through its tool hook | **No compression** |

A tool whose compression you set is measured afresh from that moment: its row counts the sessions since
the setting alone, and says so (*moderate compression since Oct 22, 15 sessions*). Its measurement from
before stays as a second, muted row (*measured with no compression, 203 sessions*), with no action, sorted
after every current row whatever the order, so a tool is never ranked by what it cost before it was
compressed. Each row's detail compares the two: tokens a call and a prompt under each setting. The
settings' dates come from the log of every setting made (`diet-settings`), so a setting the log never saw
(a config edited by hand) counts from the last one it did.

Each view opens with a **Potential savings** card: for sections, skills and tools, what the flagged rows cost in the sessions that did not use them (at most); for outputs, what the cap alone would have cut (at least); All sums them.

Compress and Remove run in the background and make a pull request: Apply records the decision and
starts the work detached, so nothing holds your attention while the model works; the change is one commit on a branch of its own, built from the default branch and pushed
to the origin, and nothing in your working tree changes, whatever branch it is on. You read the diff in
the pull request. Without a GitHub origin or `gh` logged in, the file in your working tree is rewritten
instead, uncommitted, for `git diff`. Switching a tool off writes one key in the agent's own settings
for that repository, after backing the file up; **Turn back on** restores it.

## Recent activity

The page's third view, **Recent activity** (the tab at the right of the nav),
lists every decision taken, newest first, with what came of it, and counts on its badge what is not
complete: a change still running, one that **Failed** (the reason is in the row, and **Retry** runs the same
command again), and a pull request **PR pending** until you merge it (**Close PR** closes it and deletes
its branch; closed without merging, the decision is **Rejected** and the sections are suggested again,
since nothing was followed through on). A card at the top names what needs you. **Revert** is there too:
a switched-off skill or tool back on, an output's compression back, a section's file written back as it
was. Sections changed together are a row each but one change: a Retry, Revert or Close PR on one takes
the others with it.

## What the numbers are

Tokens are counted from the transcripts: the text of what each session loaded, at about four
characters a token, times the model calls the transcript records. The outputs' cost is each result's
tokens times the model calls left after it, and a compaction, which drops old results, is not seen,
so that part is an upper estimate. The waste flags and the savings are measurements of use, not a
promise: cutting a section saves its tokens, and whether the agent then misses it is what the
*followed* and *missed* columns are there to show. No benchmark is claimed for the cuts; the
[benchmark results](../research/bench-history/RESULTS.md) are about the cache.

## The Report beside it

The page's other view, View Report (the first view is Find Savings), is the same measurement over time: what a session
costs here, week by week over the last six, as the average over each week's sessions. One table by
type of token (input read fresh, input written to the prompt cache, input read back from it, output), one by
part of the context (the instruction files, custom tools, built-in tools, tool outputs, the rest of the
input, the output), one by model under its provider with subtotals, the same whole-session total under each. In the table by part,
each of the four parts Find Savings controls is green, yellow or red by its tokens a prompt against a Good and a Bad figure shown
beside it (instruction files 8k and 20k, custom tools 3k and 10k, built-in tools 15k and 25k, tool outputs 20k and 50k): green at
or under Good, red at or over Bad, yellow between, whatever the cell shows; the other rows and the other two tables take no
colour. A toggle shows each week's sum instead of the average per prompt, another every row but the whole-session total as its
share of that total. A toggle prices the same tokens at the
providers' list rates, so a switch of model shows in the trend. Under the tables: the actions taken on
Find Savings in those weeks, by date, to read the weeks against, and the cache's four numbers, its saving in
dollars first. The report is kept in the checkout and made again in the background when it is older than ten
minutes: the page says when it was measured and shows
the newer figures when they are ready. The cache itself (the notes learned from your sessions, served to the agent as it works) looks after
itself; its numbers are under View Report, and how it learns is in [usage and learning](usage.md).
