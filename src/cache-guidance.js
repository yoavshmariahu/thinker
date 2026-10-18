// Instructions shared by the MCP server, the prompt hook and the GPT benchmark. Every line competes
// with the request, and a host may cut the text outright (see INSTRUCTIONS_LIMIT), so each decision
// gets one sentence: what to read first, what to keep, how to reach code, when to stop.
// The code tools an agent can be offered beside the notes. Both are off unless a repository turns
// them on (`thinker tools enable find drilldown`, kept as `disabledTools` in .thinker/config.json):
// on the held-out mitmproxy canary of 2026-10-10 an agent told to reach code through them made ten
// extra calls for three useful answers, and every call re-sends the conversation. A tool that is off
// is not registered by the server and is named nowhere in what the agent reads, so nothing calls it.
// Where they are on, they are offered beside the agent's own search, never ahead of it: in the 18
// Codex change-task sessions of 2026-10-07 told to "reach code through pointers before the first grep",
// every one started with them, added find→drilldown hops a batched grep does in one turn, and re-read
// the drilled code to edit it anyway (31→51 turns on mitmproxy, first edit 2–3 turns later).
export const SWITCHABLE_TOOLS = ['find', 'drilldown'];
export const DEFAULT_DISABLED_TOOLS = ['find', 'drilldown'];
export function disabledTools(config) {
  const named = config?.disabledTools;
  return new Set((Array.isArray(named) ? named : DEFAULT_DISABLED_TOOLS).filter(t => SWITCHABLE_TOOLS.includes(t)));
}
const offered = disabled => { const off = disabled instanceof Set ? disabled : new Set(disabled || DEFAULT_DISABLED_TOOLS); return { find: !off.has('find'), drilldown: !off.has('drilldown') }; };
// How to get from a note to the code, with the tools on offer; `call` renders a tool's name.
export function reachCode(disabled, call = name => name) {
  const on = offered(disabled);
  const by = [on.find && `${call('find')} when you do not know where the code is`, on.drilldown && `${call('drilldown')} when you need a definition whole`].filter(Boolean);
  return `A note's file:symbol pointers say where the code is: read it there with ordinary search and reads${by.length ? `. Beside them: ${by.join('; ')}; neither replaces one batched search or reading the file you will edit` : ''}`;
}

export function cacheUsageGuide({ disabled } = {}) {
  const on = offered(disabled);
  const names = ['orient', 'lookup', on.find && 'find', on.drilldown && 'drilldown'].filter(Boolean).map(n => `mcp__thinker__${n}`).join(',');
  return `Use thinker as a map to the code, then do the work.

1. Read the <thinker-cache> bundle in this turn if there is one. Call orient once with the task when there is none, or when nothing in it bears on the task.
2. Keep the notes that answer the request; ignore the rest. A fresh note is a map, not a plan, and a STALE claim is checked against the code.
3. ${reachCode(disabled)}.
4. lookup answers one question a note left open. Then edit and verify.

If these tools are listed as deferred names rather than callable tools, load them first (in Claude Code: ToolSearch \`select:${names}\`).`;
}
// As shipped: with the code tools off.
export const CACHE_USAGE_GUIDE = cacheUsageGuide();

// No text an agent reads asks it to call remember or feedback (the user's decision, 2026-10-08: "Note
// distillation should happen offline. Never on the critical path."). On the Click rerun of that day all
// six Opus arms ended with ToolSearch + remember, two turns the baseline never spent, because this
// guide asked for it. Learning is the stop hook's distillation; the tools stay for a person who asks.
export const MORE_NOTES_INTRO = 'Other cached titles. Use lookup only if one directly answers a question still open for this task:';

// Claude Code cuts an MCP server's `instructions` at exactly 2048 characters and appends
// "… [truncated]" (measured 2026-10-07 against 0.1.16: 2741 characters sent, so the
// tail of the usage guide never reached the model, and nothing logged the loss).
// Other hosts may cut lower or not at all. `cacheInstructions` composes the string so this cannot
// happen silently: it drops a whole trailing section rather than hand a host half a sentence, and
// the suite holds the total under the cap for a long repository path.
export const INSTRUCTIONS_LIMIT = 2048;

export function cacheInstructions({ repo, limit = INSTRUCTIONS_LIMIT, disabled, intro } = {}) {
  const sections = [
    intro || `thinker is a cache of notes about this repository (${repo}) from earlier sessions and humans.`,
    cacheUsageGuide({ disabled }),
  ];
  const text = () => sections.join('\n\n');
  while (sections.length > 1 && text().length > limit) sections.pop();
  return text().slice(0, limit);
}

// The header above the notes the prompt hook injects. It says what the agent must decide here and
// nowhere else: that an off-topic bundle is not an answer, and where to go for code it does not map.
export const cacheBundleIntro = ({ stale = false, disabled } = {}) => {
  const on = offered(disabled);
  const code = on.find ? ' find locates code no note maps, by the words the code would use.' : '';
  return `Notes about this repo from earlier sessions; their tracked dependencies were re-hashed just now${stale ? ', so check a STALE claim against the code' : ' and match the working tree'}. Use the pointers that fit this request and ignore neighboring topics; a fresh note is a map, not a plan. If none of them bears on the task, orient on it yourself.${code}`;
};

// Short, persistent workflow for native instruction files and CLI-only adapters.
// Keep the decisions identical across transports; never name an unavailable tool (`disabled`: the
// code tools that are off, both unless the repository turned them on).
// Every line here is read on every turn of every session in the checkout, so it holds the four
// decisions and nothing else. Until 2026-10-07 it opened by telling the agent to respect
// THINKER_MCP=off and THINKER_NO_LEARN=1 and to apply it only where .thinker/ exists: on the Click
// canary a Codex agent spent its first turn running `printenv THINKER_MCP THINKER_NO_LEARN; test -d
// .thinker` to comply. The hooks and the server enforce those switches; the agent never needs to.
export function agentWorkflow({ cli, repo, mcp = true, disabled } = {}) {
  const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
  const command = cli ? `node ${quote(cli)}` : 'thinker';
  const suffix = repo ? ` --repo ${quote(repo)}` : '';
  const call = (name, args = '') => mcp ? `\`${name}\`` : `\`${command} ${name}${args ? ' ' + args : ''}${suffix}\``;
  const tools = mcp ? 'the Thinker MCP tools (if they are listed as deferred, load them with the host\'s tool search)' : 'the Thinker CLI commands below';
  const reach = reachCode(disabled, name => call(name, name === 'find' ? '"<code terms or identifier>"' : '"path:Symbol"'));
  return `## Using Thinker while working

Use ${tools} as a map to the code, then do the work. If they are unavailable, continue with ordinary tools.

- Read an injected <thinker-cache> bundle first: keep the notes that answer the request, ignore the rest, and check a STALE claim against the code. When none was injected, or none bears on the task, ${call('orient', '"<task>"')} once.
- ${reach}. ${call('lookup', '"<question or note id>"')} answers one question a note left open.
- Then edit and test. Do not keep retrieving notes.`;
}
