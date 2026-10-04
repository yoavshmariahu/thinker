// Instructions shared by the MCP server and the GPT benchmark. Keep this short enough
// to be useful at the start of a task, where every line competes with the request.
export const CACHE_USAGE_GUIDE = `Use thinker as a map to the relevant code, then do the work.

0. If thinker's tools are listed as deferred names rather than offered as callable tools, their schemas are not loaded and calling one fails: load them in a single call first, ToolSearch with query \`select:mcp__thinker__orient,mcp__thinker__lookup,mcp__thinker__find,mcp__thinker__drilldown\`. Do this before the first grep, not after. Where the tools are already callable, skip this step.
1. If this turn already contains a <thinker-cache> bundle for the request, read it first. Otherwise call orient once with the actual task; include a file when you know it. A second orient call is useful only for a distinct part of a multi-part task that the first result missed.
2. Keep notes whose title and content answer this request. Ignore neighboring topics even if they rank highly. A fresh note means its tracked code dependencies match the working tree; it does not prove the note is complete or that its proposed approach fits this change. Check STALE claims against code.
3. Use a matching note's file:symbol pointers to open the small code region you need to change. The code behind the main pointers is inlined under the notes; for other pointers call drilldown with them (several at once), which returns each definition whole with its lines, for one pointer also its callers and callees, and the notes on the code, instead of reading the file and grepping for the name. Apply stated invariants and rules as checks on the patch. Do not search or read broadly just to rediscover a fresh note's map.
4. Call lookup for one specific unanswered question, or for a listed note whose title directly covers that question. Do not fetch every listed note. When no note says where something is, call find with the words the code would use (or an identifier): it lists the definitions that carry them, with their lines, to drilldown next. Fall back to your own grep and reads only when find and drilldown come up empty or the code disagrees with a note.
5. Once you know the entry point, affected paths, and constraints, edit and verify the behavior. Treat notes delivered after an edit as checks on that edit, not as a new reading list.`;

// Benchmark runs expose only orient and lookup, so keep the learning tools separate.
export const CACHE_LEARNING_GUIDE = `If a note was wrong, call feedback with its id and the correction. If you learned a reusable call path, rule, or gotcha through substantial investigation, call remember with concrete file:symbol dependencies. Do not save a one-off task summary.`;

export const MORE_NOTES_INTRO = 'Other cached titles. Use lookup only if one directly answers a question still open for this task:';
