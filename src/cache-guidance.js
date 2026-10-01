// Instructions shared by the MCP server and the GPT benchmark. Keep this short enough
// to be useful at the start of a task, where every line competes with the request.
export const CACHE_USAGE_GUIDE = `Use thinker as a map to the relevant code, then do the work.

1. If this turn already contains a <thinker-cache> bundle for the request, read it first. Otherwise call orient once with the actual task; include a file when you know it. A second orient call is useful only for a distinct part of a multi-part task that the first result missed.
2. Keep notes whose title and content answer this request. Ignore neighboring topics even if they rank highly. A fresh note means its tracked code dependencies match the working tree; it does not prove the note is complete or that its proposed approach fits this change. Check STALE claims against code.
3. Use a matching note's file:symbol pointers to open the small code region you need to change. The code behind the main pointers is inlined under the notes; for another pointer call drilldown with it, which returns the definition with its lines, its callers and callees, and the notes on it, instead of reading the file and grepping for the name. Apply stated invariants and co-change rules as checks on the patch. Do not search or read broadly just to rediscover a fresh note's map.
4. Call lookup for one specific unanswered question, or for a listed note whose title directly covers that question. Do not fetch every listed note. If the cache has no relevant answer, a pointer is wrong, or the code disagrees, use a targeted code search and follow the code.
5. Once you know the entry point, affected paths, and constraints, edit and verify the behavior. Treat notes delivered after an edit as checks on that edit, not as a new reading list.`;

// Benchmark runs expose only orient and lookup, so keep the learning tools separate.
export const CACHE_LEARNING_GUIDE = `If a note was wrong, call feedback with its id and the correction. If you learned a reusable call path, rule, or gotcha through substantial investigation, call remember with concrete file:symbol dependencies. Do not save a one-off task summary.`;

export const MORE_NOTES_INTRO = 'Other cached titles. Use lookup only if one directly answers a question still open for this task:';
