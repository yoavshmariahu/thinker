// Instructions shared by the MCP server and the GPT benchmark. Keep this short enough
// to be useful at the start of a task, where every line competes with the request.
export const CACHE_USAGE_GUIDE = `Use thinker as a map to the relevant code, then do the work.

0. If thinker's tools are listed as deferred names rather than offered as callable tools, their schemas are not loaded and calling one fails: load them in a single call first, ToolSearch with query \`select:mcp__thinker__orient,mcp__thinker__lookup,mcp__thinker__find,mcp__thinker__drilldown\`. Do this before the first grep, not after. Where the tools are already callable, skip this step.
1. If this turn already contains a <thinker-cache> bundle for the request, read it first. That replaces only the initial orient call, not the rest of this workflow. Otherwise call orient once with the actual task; include a file when you know it. A second orient call is useful only for a distinct part of a multi-part task that the first result missed.
2. Keep notes whose title and content answer this request. Ignore neighboring topics even if they rank highly. A fresh note means its tracked code dependencies match the working tree; it does not prove the note is complete or that its proposed approach fits this change. Check STALE claims against code.
3. Use a matching note's file:symbol pointers to open the small code region you need to change. The code behind the main pointers is inlined under the notes; for other pointers call drilldown with them (several at once), which returns each definition whole with its lines, for one pointer also its callers and callees, and the notes on the code, instead of reading the file and grepping for the name. Apply stated invariants and rules as checks on the patch. Do not search or read broadly just to rediscover a fresh note's map.
4. Call lookup for one specific unanswered question, or for a listed note whose title directly covers that question. Do not fetch every listed note. When no note says where something is, call find with the words the code would use (or an identifier): it lists the definitions that carry them, with their lines, to drilldown next. Fall back to ordinary search/read tools when unavailable, insufficient, or contradicted by the code. Direct reads of known non-code files and exact-text searches remain appropriate.
5. Once you know the entry point, affected paths, and constraints, edit and verify the behavior. Treat notes delivered after an edit as checks on that edit, not as a new reading list.`;

// Benchmark runs expose only orient and lookup, so keep the learning tools separate.
export const CACHE_LEARNING_GUIDE = `If a note was wrong, call feedback with its id and the correction. Save a reusable call path, rule, or gotcha with remember as soon as substantial investigation establishes it, while the evidence is in context. Include the reason, constraints, and concrete file:symbol dependencies. This is the primary learning path; background learning sees only selected evidence and may miss the discovery. Do not save a one-off task summary.`;

export const MORE_NOTES_INTRO = 'Other cached titles. Use lookup only if one directly answers a question still open for this task:';

// Short, persistent workflow for native instruction files and CLI-only adapters.
// Keep the decisions identical across transports; never name an unavailable tool.
export function agentWorkflow({ cli, repo, mcp = true, learn = true } = {}) {
  const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
  const command = cli ? `node ${quote(cli)}` : 'thinker';
  const suffix = repo ? ` --repo ${quote(repo)}` : '';
  const call = (name, args = '') => mcp ? `\`${name}\`` : `\`${command} ${name}${args ? ' ' + args : ''}${suffix}\``;
  return `## Using Thinker while working

Apply this workflow only in a repository set up with Thinker (.thinker/ exists). Respect disabled-tool and learning controls, including THINKER_MCP=off and THINKER_NO_LEARN=1.

${mcp ? 'Use the Thinker MCP tools. If deferred, discover/load them with the host tool-search facility before code exploration. If unavailable, continue with ordinary tools.' : `Use the Thinker CLI commands below. If unavailable, continue with ordinary tools.`}

- Read relevant injected <thinker-cache> notes first; otherwise call ${call('orient', '"<task>"')} once for the task. An injected bundle replaces that call, not the rest of this workflow.
- Use ${call('lookup', '"<specific question or note id>"')} for a specific unanswered question. Ignore unrelated notes; verify STALE claims against code.
- Follow known file:symbol pointers with ${call('drilldown', '"path:Symbol"')}. When no note maps the code, use ${call('find', '"<code terms or identifier>"')} and then drilldown before broad code searches or file reads. Fall back to ordinary search/read tools when unavailable, insufficient, or contradicted by the code. Direct reads of known non-code files and exact-text searches remain appropriate.
- Once the entry point and constraints are clear, edit and test. Do not keep retrieving notes just to increase tool use.
${learn ? `- Save reusable discoveries as soon as investigation establishes them, while the evidence is available: ${mcp ? 'call `remember`' : `use ${call('add', '"<note.json>" --source agent')}, with JSON containing title, kind (map/howto/rule), answers, body and deps`}. Include the reason, constraints and concrete file:symbol dependencies. Do not save task summaries or rely on background distillation to capture everything.
- When evidence contradicts a note, ${mcp ? 'call `feedback` with its id, useful: false and the corrected body' : `use ${call('feedback', '"<feedback.json>"')}, with JSON containing id, useful: false and correction (the corrected body)`}.` : '- Learning is disabled for this integration; do not save notes or feedback.'}`;
}
