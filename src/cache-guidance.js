// The text the agent reads from thinker: the line above the notes the prompt hook injects, the guide
// `thinker guide` prints, and which code tools a repository switched on (`thinker tools`).
// The code tools an agent can be offered beside the notes. Both are off unless a repository turns
// them on (`thinker tools enable find drilldown`, kept as `disabledTools` in .thinker/config.json):
// on the held-out mitmproxy canary of 2026-10-10 an agent told to reach code through them made ten
// extra calls for three useful answers, and every call re-sends the conversation. A tool that is off
// is not registered by the server and is named nowhere in what the agent reads, so nothing calls it.
// Where they are on, they are offered beside the agent's own search, never ahead of it: in the 18
// Codex change-task sessions of 2026-10-07 told to "reach code through pointers before the first grep",
// every one started with them, added find→drilldown hops a batched grep does in one turn, and re-read
// the drilled code to edit it anyway (31→51 turns on mitmproxy, first edit 2–3 turns later).
// orient is off unless a repository turns it on (`thinker tools enable orient`, kept as `enabledTools`
// in .thinker/config.json); where it is off, the server does not offer it and no text tells the agent to
// call it: the prompt hook's bundle is how notes arrive, and lookup stays for an id a bundle listed.
// Measured on the MLflow fair-11 set with GPT-6 Astra on 2026-10-18 (Artemis
// mlflow-fair11-astra-mined200-full-2026-10-18): the arm told to orient called it in every session, got
// nothing back in 12 of 22, and spent 43k more input tokens and 2.1 more tool calls than the bare agent;
// the hook alone was level with the bare agent and 41k tokens and 2 calls under the orient arm. It was on
// until the release after 0.1.65, and a `disabledTools` list written before (0.1.65 could switch it) does not
// keep it on: only `enabledTools` does, so every existing install turns it off on its next start.
// No client is told to orient, Windsurf and Copilot CLI included (the owner's decision, 2026-10-18: the value
// shown is the hooks'); Windsurf, which runs no prompt hook, reaches notes through the CLI lookup alone.
export const SWITCHABLE_TOOLS = ['orient', 'find', 'drilldown'];
export const DEFAULT_DISABLED_TOOLS = ['orient', 'find', 'drilldown'];
const CODE_TOOLS = ['find', 'drilldown'];
export function disabledTools(config) {
  const named = config?.disabledTools;
  const off = new Set((Array.isArray(named) ? named : CODE_TOOLS).filter(t => CODE_TOOLS.includes(t)));
  if (!(Array.isArray(config?.enabledTools) && config.enabledTools.includes('orient'))) off.add('orient');
  return off;
}

// What `thinker guide` prints (an experiment harness hands it to its agent): the hook's bundle is how notes arrive.
// The agent's own tools (orient, lookup, find, drilldown, remember, behavior, feedback) were taken off the MCP
// server on 2026-10-22, at the owner's decision, with the workflow block thinker wrote into the agents'
// instruction files: real sessions rarely called the tools (about 96 calls in this machine's real repositories from
// 2026-10-10 to 2026-10-22, against thousands of hook servings), and every line of the workflow was read on every turn.
export function cacheUsageGuide() {
  return `Use thinker's notes as a map to the code, then do the work.

1. Read the <thinker-cache> bundle in this turn if there is one. When there is none, or nothing in it bears on the task, work from the code.
2. Keep the notes that answer the request; ignore the rest. A note is a map, not a plan.
3. A note's file:symbol pointers say where the code is: read it there with ordinary search and reads. Then edit and verify.`;
}
export const CACHE_USAGE_GUIDE = cacheUsageGuide();

// The one line above the notes the prompt hook injects (2026-10-22: a sentence until then, written for a cache
// that also served stale notes and offered tools; the hooks serve fresh notes only, `orient`'s freshOnly).
export const cacheBundleIntro = () => 'Notes from earlier sessions, checked against the current code just now. Use what fits this request; a note is a map, not a plan.';
