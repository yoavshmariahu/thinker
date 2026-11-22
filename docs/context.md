# Context cuts

Which instructions, skills and tools consume your coding agent's context without helping its sessions, what
is cut, and how each cut is undone. Back to the [README](../README.md).

**thinker makes these cuts for you.** Between sessions it reads the same report and acts on the clearest
items itself, a few at a time: a section of an instruction file that nobody needs becomes a pull request for
you to merge, a tool nobody calls is switched off or moved out of the prompt. What it did is listed, a line
an action with what it saved, beside the chat on the page (`thinker ui`) and in `thinker activity`. Tell it in
the chat to do more, less or nothing; every action has an undo.

The measurement is yours to read whenever you want it: `thinker context` prints it for the repository you are
in, and `thinker context --machine` over the repositories your agents worked in lately. Thinker makes the changes
that clearly pay itself: each has to save $1 a day or more, they go out together as one batch once they come
to $5 a day (at most one batch a week in a repository), and a week later each is checked and taken back if it
did not pay. Skills it leaves alone unless you say otherwise. (Until 2026-11-21 this was a page, Find Savings,
and a weekly question in your session; thinker now makes the decisions they asked you to make.)

## What it shows

The parts the agent reads on every model call:

| part | what it is | read from |
|---|---|---|
| Instruction files | `AGENTS.md`, or `CLAUDE.md` where there is no `AGENTS.md`, section by section | Claude Code, Codex, Cursor and Gemini CLI sessions |
| Custom tools | the skills listed in every session, MCP servers and plugins, with their descriptions and tool definitions | Claude Code in full; Codex's skill catalog and MCP namespaces; Cursor's MCP servers |
| Built-in tools | the agent's own tool definitions, re-sent with every call | Claude Code |
| Tool outputs | what each tool's results added to the conversation, re-read by every call after them; reported, never a cut to decide on -- the clearing takes those out (see below) | Claude Code |

One rule: a part sits in the prompt, so it costs its size in every model call that carries it. **Per
prompt** is that size — a prompt being one call to the model, as the Report counts it. **Needed** is the
share of those prompts where the agent acted on it: called the tool, invoked the skill, touched the files,
commands or code the section names. **Over N days** is per prompt times every prompt that carried it in the
window. **Wasted** is that times the share of prompts that did not need it, the most that cutting the part
could save, said in dollars at what an input token cost those sessions at list prices. These are input tokens
read: a definition at the stable front of the prompt is served from the prompt cache on most calls, at a tenth
or less of the input price, and the Report prices the token types as the model reported them.

For each instruction section, skill and tool, `thinker context` prints:

- *Cost*: per call, the share of calls that needed it, and the waste.
- *Used*: how often the sessions acted on it. A section is *applied* when a session touched its
  files, ran its command or read the code it names, free, from the transcript. *Relevant* and
  *followed* come from a model reading one session against the sections and saying which bore on
  the work and whether the agent followed them. It is the same read every session gets when it
  ends, for the profile, shown the sections that could bear on the session, so it costs no call of its
  own (`instructions: { value: { judge: false } }` in `.thinker/config.json` turns it off, `share`
  shows the sections to a share of sessions instead of all). Once five sessions
  are judged the share shown is the judged sessions that followed the section. A skill is *read* when a
  session opened it, and the sampled outcome check says whether sessions that read it kept its rules, and
  how often one broke them without reading it. A tool is *used* when a session called it.
- *Wasted*: what the part cost in the sessions that did not use it -- what cutting it would save at
  most; a session that needed it would go without. High waste from 5% of what its kind costs, medium
  from 2%. A row used in under a tenth of its calls is marked `!!` at 5,000 tokens a call or more, `!`
  under that.

`thinker context --cards` says what each part is, why you would change it and what you would lose, in words.
`thinker context --machine` merges the most active repositories' reports: tools merged by name, each cost
summed over the repositories and read against all their prompts together.

## What you can cut

thinker makes the clearest of these itself. Each can also be made from the command line, and each can be
undone.

| cut | how | undo |
|---|---|---|
| Shorten an instruction section | `thinker context --approve <n>` where it is suggested, or `thinker instructions --compress <id> --pr`: in the background a model rewrites it to about a third, keeping the rules, commands and paths, and a pull request opens with the change; Recent activity follows it | close the unmerged PR (**Close PR** under Recent activity, or `thinker context --revert <n>`); revert a merged change |
| Drop an instruction section | `thinker context --approve <n>:remove`, or `thinker instructions --remove <id> --pr`: a pull request opens with the change in a moment | close the unmerged PR; revert a merged change |
| Switch a skill, MCP server or plugin off | `thinker context --approve <n>`, or `thinker context --switch-off "<name>"`: off for this repository from the next session, in the agent's own settings, with a backup; a skill switched off still runs as `/name` | `thinker context --revert <n>`, or `--switch-on <key>` |
| Move a built-in tool's definition out of the prompt | `thinker context --approve <n>` where it is suggested: a tool reference is created, the definition goes into a file the agent reads before its first call, and the tool can still be used | `thinker context --revert <n>`, or **Revert** under Recent activity |

`thinker context --history` lists every decision with its number.

**Tool outputs are not on this list, and that is the point.** thinker compresses them itself, on every
machine, with no setting to find: the clearing replaces the results the agent has finished with before the
request leaves for the model (`src/cutting.js`), which is where the cost actually is -- 88% of what output
costs a session is reading results again after the agent's last use of them. Per-tool compression
(`src/diet.js`) only shrinks what is still live: the moderate cap took 7.5% of output cost over 38 real
sessions here, and the one arm measured in agent sessions saved nothing at all, because an agent fetches
again what was trimmed from under it. So there is no cut for them, no question about one, and nothing
for anyone to switch: what each tool's output costs is still measured and still in the Report, under Cost
by context. `thinker context --output-compression <tools> [--level high]` still sets the diet by hand, for
an experiment arm.

Compress and Remove run in the background and make a pull request: the decision is recorded and the work
started detached, so nothing holds your attention while the model works; the change is one commit on a branch
of its own, built from the default branch and pushed to the origin, and nothing in your working tree changes,
whatever branch it is on. You read the diff in the pull request. Without a GitHub origin or `gh` logged in, the
file in your working tree is rewritten instead, uncommitted, for `git diff`. Switching a tool off writes one
key in the agent's own settings for that repository, after backing the file up.

## Recent activity

The page's **Recent activity** tab (`thinker ui`; `thinker context --history` in the terminal) lists every
decision taken, by thinker or by you, newest first, with what came of it and what it saved, and counts on its
badge what is not complete: a change still running, one that **Failed** (the reason is in the row, and
**Retry** runs the same command again), and a pull request **PR pending** until you merge it (**Close PR**
closes it and deletes its branch; closed without merging, the decision is **Rejected** and the sections are
suggested again, since nothing was followed through on). A card at the top names what needs you. **Revert** is
there too: a switched-off skill or tool back on, a section's file written back as it was (and an output's
compression back, for a decision made before those went). Sections changed together are a row each but one
change: a Retry, Revert or Close PR on one takes the others with it. Its second view, **PR savings**, lists the
merged pull requests with what each cost and what the clearing saved on it.

## What the numbers are

Tokens are counted from the transcripts: the text of what each session loaded, at about four
characters a token, times the model calls the transcript records. The outputs' cost is each result's
tokens times the model calls left after it, and a compaction, which drops old results, is not seen,
so that part is an upper estimate. The waste flags and the savings are measurements of use, not a
promise: cutting a section saves its tokens, and whether the agent then misses it is what the
*followed* and *missed* figures are there to show. No benchmark is claimed for the cuts; the
[benchmark results](../research/bench-history/RESULTS.md) are about the cache.

## The Report beside it

`thinker report` is the same measurement over time: what a prompt costs here at list prices, week by week
over the last six, as the average over each week's prompts. One table by type of token (input read fresh,
input written to the prompt cache, input read back from it, output), one by part of the context (the
instruction files, custom tools, built-in tools, tool outputs, the rest of the input, the output), one by
model under its provider with subtotals, the same whole-session total under each. In the table by part, each
row is marked against a Good and a Bad figure printed beside it, in dollars a prompt. `--total` shows each
week's sum instead of the average per prompt, `--share` every row but the whole-session total as its share of
that total. Under the tables: the decisions taken in those weeks, by date, to read the weeks against, and the
profile's own measure. The report is kept in the checkout and made again in the background when it is older
than ten minutes; the page's Factory and Recent activity read the same kept report, so their figures never
disagree with the command. (Until 2026-11-21 the page had a View Report tab showing these tables.) The profile
itself (learned from your sessions, put into each session's first prompt) looks after itself; how it learns is
in [usage and learning](usage.md).
