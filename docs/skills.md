# Skills

A skill is a file (`SKILL.md`) an agent pulls into its context by name: how to run the tests here,
how to deploy, how to add a webhook. Its instructions rest on code that moves, so a skill decays
the way a note does. Thinker treats the skill files checked into a repository as cached knowledge:
each gets a card, the card is audited against the code, and the sessions that invoke the skill grade
it. Nothing here edits a skill file.

## Cards

A skill file under `.claude/skills`, `.agents/skills`, `.codex/skills`, `.cursor/skills`,
`.github/skills` or `skills/` gets a note of kind `skill`: a short card saying what the skill is
for, when to invoke it and what it prescribes, with `path:Symbol` pointers at the code it talks
about. The card is ranked like any note, and tells the agent to invoke the skill for the full
instructions. Its dependencies are the skill file itself and the code the skill names, so the card
goes stale when either changes.

A build cards them all, and maintenance cards new and changed skill files a few at a time where
`maintain: { skills: true }` is set in `.thinker/config.json` (off by default since 2026-10-21;
`skillsPerRun` sets how many a run). A changed file is read again and its card rewritten. A removed file retires its card.

## Audit

When code a skill talks about changes, the card is stale and waits for a maintenance run like any
note. The audit then reads the skill file against the current code and answers one question: does
the code contradict something the skill states? A path or definition that no longer exists, a
command or flag that is gone, a procedure the code no longer supports, a rule the code now does the
opposite of. A skill that is merely incomplete or silent about a change holds.

A skill the code contradicts is **out of date**. Each issue is recorded on the card (the claim,
what the code shows instead, where), and the note thinker adds at the end of your agent's next turn names
the skill. An out-of-date skill is not served, and it is not audited again: no model call is spent on it
until its file changes (someone fixed it; the card is rewritten and the skill is back).

## What the sessions say

When a session invokes a skill, the distillation of that session assesses the skill like an
injected note: confirmed when the agent followed its instructions and they worked, contradicted
when something the skill prescribes failed or the code the agent read disagrees with it, unused
when the agent took another route and nothing failed. A confirmation raises the card's confidence;
a contradiction records the issue and marks the skill out of date, as the audit would. A session
that ended before the skill's present text was committed saw another version of it and is not
counted against this one.

## Several skills for the same thing

The same skill in two roots (one for Claude Code, one for Codex), or two skills whose description
and card say the same, form a group. One is served; the others are archived as its duplicates and
restored if the choice changes. The choice, in order: a person's pin (`skills.prefer` in
`.thinker/config.json`), not out of date, more confirmations than contradictions from sessions, the root
the agents look in first, the newer file.

## What stays as it is

Whether a skill earns its place in every session's context is a separate question, answered on the
[Find Savings page](context.md): each skill is a row there with its tokens and how often sessions read it.

How-to notes are the cache's own skills, written from sessions and pull requests. They are not
turned into skill files, and skill files are not turned into how-to notes.

## Future work: ranking the list itself, not suggesting skills per file

Not built, and not planned work — a note of where the evidence points, so the next attempt does not
start from the one that failed.

Every skill a host knows about sits in the prompt as a name and a description, in every call of
every session. On PostHog under GPT-6 Astra that list was about **19% of input**: switching all 107
skills off cut input by that much at equal passes, but the agents then opened 0.6 skills a session
against 2.9 and broke more minor conventions (0.46 against 0.21 a session). So the list earns
something, and paying for all of it in every call is what to attack — not whether to have skills.

What has already been tried, and what it measured:

- **Suggesting a skill per file** (removed on 2026-10-30). The tool hook names the
  skills past sessions read for files like this one. In a replay of the sessions that missed a skill
  it named the needed one in **1 of 19**. It leaves the list in the prompt untouched, so it cannot
  save anything either; it can only add.
- **Asking the model to find the skill** (`lookup` over the descriptions): right **42%** of the time.
- **Keeping the names and dropping the descriptions**: matched the unmodified harness at **12 of 15**
  passes in the offline comparison of 2026-10-19 — the strongest result of the three, and the one
  nobody has followed up. The names are a small fraction of the list's tokens; the descriptions are
  the bulk of it.

So the lever worth trying is the *shape of the list*, ranked: every skill keeps its name, and only
the skills this repository's sessions actually open keep a full description. The evidence for the
ranking was previously recorded in `.thinker/state/skill-evidence.json` as (area, skill) rows.
The recommender and its evidence collector were removed on 2026-10-30; this is historical research.

The open question is the mechanism, and it is the reason this is a note rather than a branch. A host
reads a skill's description from its own file, so thinker would have to change those files, and that
is a person's repository: the only acceptable shape is the one Find Savings already uses for an
instruction section — a diff, in a pull request, reversible ([context.md](context.md)) — never a
quiet rewrite. Before any of that is worth building, two things need settling, both cheap:

1. Does shortening a description actually shrink what the host puts in the prompt, per host? Measure
   it the way the built-in tool definitions were measured (`claude -p`, count the prompt), not from
   the file sizes.
2. Does the 12-of-15 names-only result hold when the *ranking* decides which descriptions stay,
   rather than dropping all of them? One offline comparison on 15 tasks is where that number comes
   from, and every lever in this project that looked good offline has since come back worse live.
