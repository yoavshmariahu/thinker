// Instructions shared by the MCP server, the prompt hook and the GPT benchmark. Every line competes
// with the request, and a host may cut the text outright (see INSTRUCTIONS_LIMIT), so each decision
// gets one sentence: what to read first, what to keep, how to reach code, when to stop.
export const CACHE_USAGE_GUIDE = `Use thinker as a map to the code, then do the work.

1. Read the <thinker-cache> bundle in this turn if there is one. Call orient once with the task when there is none, or when nothing in it bears on the task.
2. Keep the notes that answer the request; ignore the rest. A fresh note is a map, not a plan, and a STALE claim is checked against the code.
3. Reach code through pointers before the first grep or file read: drilldown for a note's file:symbol pointers, find for code no note maps, with the words the code would use. Ordinary search and reads are the fallback, and stay right for known non-code files and exact text.
4. lookup answers one question a note left open. Then edit and verify.

If these tools are listed as deferred names rather than callable tools, load them first (in Claude Code: ToolSearch \`select:mcp__thinker__orient,mcp__thinker__lookup,mcp__thinker__find,mcp__thinker__drilldown\`).`;

// No guidance asks the agent to save or grade notes (decided 2026-10-08): learning happens offline,
// in the background distillation of the session, never on the critical path of the task. Until then
// the MCP instructions, the hook bundle and the workflow block all asked for `remember` and
// `feedback`, and on the Click rerun of that day every Opus arm ended by saving a note, two turns
// the baseline could not spend. The tools stay registered while learning is on, for an agent a
// person asks to save something; nothing prompts them.

export const MORE_NOTES_INTRO = 'Other cached titles. Use lookup only if one directly answers a question still open for this task:';

// Claude Code cuts an MCP server's `instructions` at exactly 2048 characters and appends
// "… [truncated]" (measured 2026-10-07 against 0.1.16: 2741 characters sent, so the tail of the
// usage guide and the whole learning guide never reached the model, and nothing logged the loss).
// Other hosts may cut lower or not at all. `cacheInstructions` composes the string so this cannot
// happen silently: it drops a whole trailing section rather than hand a host half a sentence, and
// the suite holds the total under the cap for a long repository path.
export const INSTRUCTIONS_LIMIT = 2048;

export function cacheInstructions({ repo, limit = INSTRUCTIONS_LIMIT } = {}) {
  const sections = [
    `thinker is a cache of notes about this repository (${repo}) from earlier sessions and humans.`,
    CACHE_USAGE_GUIDE,
  ];
  const text = () => sections.join('\n\n');
  while (sections.length > 1 && text().length > limit) sections.pop();
  return text().slice(0, limit);
}

// The header above the notes the prompt hook injects. It says what the agent must decide here and
// nowhere else: that an off-topic bundle is not an answer, and where to go for code it does not map.
export const cacheBundleIntro = ({ stale = false } = {}) =>
  `Notes about this repo from earlier sessions; their tracked dependencies were re-hashed just now${stale ? ', so check a STALE claim against the code' : ' and match the working tree'}. Use the pointers that fit this request and ignore neighboring topics; a fresh note is a map, not a plan. If none of them bears on the task, orient on it yourself. For code no note maps, find lists the definitions carrying the words the code would use and drilldown reads them, before the first grep.`;

// Short, persistent workflow for native instruction files and CLI-only adapters.
// Keep the decisions identical across transports; never name an unavailable tool.
// Every line here is read on every turn of every session in the checkout, so it holds the four
// decisions and nothing else. Until 2026-10-07 it opened by telling the agent to respect
// THINKER_MCP=off and THINKER_NO_LEARN=1 and to apply it only where .thinker/ exists: on the Click
// canary a Codex agent spent its first turn running `printenv THINKER_MCP THINKER_NO_LEARN; test -d
// .thinker` to comply. The hooks and the server enforce those switches; the agent never needs to.
export function agentWorkflow({ cli, repo, mcp = true } = {}) {  // `learn` is accepted and ignored: no line asks for notes
  const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
  const command = cli ? `node ${quote(cli)}` : 'thinker';
  const suffix = repo ? ` --repo ${quote(repo)}` : '';
  const call = (name, args = '') => mcp ? `\`${name}\`` : `\`${command} ${name}${args ? ' ' + args : ''}${suffix}\``;
  const tools = mcp ? 'the Thinker MCP tools (if they are listed as deferred, load them with the host\'s tool search)' : 'the Thinker CLI commands below';
  return `## Using Thinker while working

Use ${tools} as a map to the code, then do the work. If they are unavailable, continue with ordinary tools.

- Read an injected <thinker-cache> bundle first: keep the notes that answer the request, ignore the rest, and check a STALE claim against the code. When none was injected, or none bears on the task, ${call('orient', '"<task>"')} once.
- Reach code through pointers before the first grep or file read: ${call('drilldown', '"path:Symbol"')} for a note's file:symbol pointers, ${call('find', '"<code terms or identifier>"')} for code no note maps. Ordinary search and reads are the fallback. ${call('lookup', '"<question or note id>"')} answers one question a note left open.
- Then edit and test. Do not keep retrieving notes.`;
}
