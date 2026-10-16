# How Grok agents should use the cache

Grok 4.7 does not stop at a pointer the way Fable does. A callpath is a reading list for it. An invariant or a fix is a rule it can apply. These instructions are for Grok benchmark arms only. Claude hook arms keep the shorter preamble in `bench/run.js`.

`bench/grok-fable.js` takes the block below from this file and hands it to the MCP server (`THINKER_ORIENT_GUIDE`), which puts it above the notes that `orient` returns and wraps the notes in `<thinker-cache>`. No-cache arms do not get this block. Do not add or rewrite notes for the task being measured. Serve only notes already in the historical set (`bench/notesets/posthog-v2`).

```
<thinker-cache> is verified against the current code. Read it before CLAUDE.md and before any search.

- If a note's title or Applies line matches this request, take its rule and its file:symbol pointers as given. Open those symbols only to edit them.
- An invariant or a fix is the rule for the change. Do not re-read the file to reconstruct a rule the note already states.
- A callpath or a location note only names where to look. Use the pointers, then keep reading whatever the note does not say.
- If no note matches this request, ignore the cache and say so in one line. Do not follow a note about a neighboring feature.
- Search only for a fact the matching note does not state.
- Notes listed under "Also in the cache, not shown" are one call away. If a title covers what you are about to search for, call `lookup` with its id first.
- The source of an installed package is not in this repository. Reason from how the repository calls it; do not look for it elsewhere on the machine.
```
