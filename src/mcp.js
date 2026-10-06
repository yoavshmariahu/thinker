#!/usr/bin/env node
// MCP server exposing the knowledge cache for one repo.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, findRepoRoot } from './store.js';
import { orient, lookup, drilldown, find, createNote, feedback, snippetsOn, KINDS } from './ops.js';
import { listBehaviors, behaviorsSummary } from './behavior.js';
import { initAst } from './ast.js';
import { review, renderReview, resolveScope } from './review.js';
import { startVerification, readVerification, renderVerification, taskContext } from './verification.js';
import { CACHE_USAGE_GUIDE, CACHE_LEARNING_GUIDE, MORE_NOTES_INTRO } from './cache-guidance.js';

// Which repository: THINKER_REPO when the entry pins one (a checkout's own .mcp.json), else the
// working directory the client started the server in (the user's machine-wide entry, every
// checkout). Outside a git repository there is none: the server offers nothing, and asks the
// client for its workspace roots once connected, since a desktop app may start servers elsewhere.
const inRepo = d => fs.existsSync(path.join(findRepoRoot(d), '.git'));
const pinned = process.env.THINKER_REPO;
let repo = pinned ? findRepoRoot(pinned) : inRepo(process.cwd()) ? findRepoRoot(process.cwd()) : null;
// THINKER_MCP=off: the server starts but offers no tools and no instructions. For control arms of a
// benchmark when the agent's MCP registration is machine-wide and cannot be left out for one run.
const off = process.env.THINKER_MCP === 'off';
// A repository where `thinker setup` has not run has no cache: the server offers no tools there and
// creates nothing, so a machine-wide registration does not start a cache in every checkout.
let store = off || !repo ? null : new Store(repo);
let setUp = !!store && store.exists();
if (setUp) { store.init(); await initAst(); } // tree-sitter grammars when installed (`thinker ast install`); the regex otherwise

const server = new McpServer({ name: 'thinker', version: '0.1.0' }, off ? {} : setUp ? {
  instructions: `thinker is a cache of notes about this repository (${repo}) from earlier sessions and humans.\n\n${CACHE_USAGE_GUIDE}\n\n${CACHE_LEARNING_GUIDE}`,
} : repo ? {
  instructions: `thinker is installed but not set up for this repository (${repo}): no notes are served or learned here. To use it, run \`thinker setup\` in the repository.`,
} : {
  instructions: `thinker was started outside a git repository (${process.cwd()}) and serves nothing here: it serves notes only inside a repository set up with \`thinker setup\`. If this client names its workspace through MCP roots, the tools appear once it has.`,
});

const text = s => ({ content: [{ type: 'text', text: s }] });
// An empty cache is said outright, with its location: "nothing matches" reads as a miss and hides a server pointed at the wrong place.
const emptyCache = () => store.list().length ? '' : `The cache is empty: no notes in ${store.notesDir}. `;

// When no note answers, the definitions whose code carries the words of the request, from `find`:
// in a week of real sessions `find` was never called (Claude Code defers MCP tools; agents grep
// instead), so a miss hands its first results over rather than naming the tool.
const codeFallback = q => {
  if (!String(q || '').trim()) return '';
  try {
    const r = find(store, { query: q, limit: 6, client: 'mcp-fallback' });
    if (r.error || !r.hits?.length) return '';
    return `By text search instead (not notes; find takes the words the code would use, drilldown the pointers that fit):\n${r.text}\n\n`;
  } catch { return ''; }
};

function registerTools() {
  const retrieval = server.registerTool.bind(server);

  retrieval('orient', {
    title: 'Orient in this repo',
    description: 'Call once at the start of a task unless a thinker-cache bundle for this request is already present. Returns notes with file:symbol pointers (each with its blast radius) and the code behind the main pointers, so the files need not be read for that. Call again only for a distinct task part the first result missed; confirm STALE claims against code.',
    inputSchema: {
      task: z.string().optional().default('').describe('What you are about to do, in one or two sentences (the user request is fine).'),
      file: z.string().optional().describe('Path of the file you are currently in or about to edit, if known.'),
      budget: z.number().int().min(200).max(8000).optional().describe('Max tokens of notes to return (default 1000); the code behind the pointers may add up to about 600.'),
    },
  }, async ({ task = '', file, budget }) => {
    if (!task.trim() && !file) return text('orient needs the task. Call it again with {"task": "<the user request, in one or two sentences>"}.');
    // the agent named a budget: let it decide how many notes are served, not the two-note default of the hooks
    const r = await orient(store, { task, file, client: 'mcp', budget: budget || 1000, snippets: snippetsOn(store), ...(budget ? { maxNotes: 5, relFloor: 0.7 } : {}) });
    if (!r.included.length) return text(`${emptyCache() || `No cached notes match this task (${store.list().length} notes in cache). `}${codeFallback(task)}Explore from there, then call remember with what you learn.`);
    const more = r.more?.length ? `\n\n${MORE_NOTES_INTRO}\n${r.more.map(n => `- [${n.kind}] ${n.title}  (id: ${n.id})`).join('\n')}` : '';
    const notes = `Cached knowledge for this task (${r.included.length} notes, ~${r.tokens} tokens):\n\n${r.text}${more}`;
    return text(notes);
  });

  retrieval('lookup', {
    title: 'Look up cached knowledge',
    description: 'Use for one specific unanswered question, or a listed note id that directly covers it. Do not fetch every title returned by orient. If no note answers the question, search the code. With kind "behavior" it returns the desired behaviors of the system (rules a person wrote that the code must uphold; a review checks changes against them): all of them with an empty query, or the ones about the query.',
    inputSchema: {
      query: z.string().describe('The question or topic, or a note id listed by orient. Empty with kind "behavior" lists every desired behavior.'),
      kind: z.enum(KINDS).optional().describe('Only notes of this kind; "behavior" for the desired behaviors of the system.'),
      budget: z.number().int().min(200).max(8000).optional(),
      maxNotes: z.number().int().min(1).max(10).optional().describe('Maximum number of notes to return (default 3)'),
    },
  }, async ({ query, kind, budget, maxNotes }) => {
    const r = await lookup(store, { query: query || '', kind, client: 'mcp', budget: budget || 2500, maxNotes: maxNotes || 3, snippets: snippetsOn(store) });
    if (kind === 'behavior' && !String(query || '').trim()) {
      const rows = listBehaviors(store);
      if (!rows.length) return text('No desired behaviors are written down for this repository yet (a person adds them with `thinker system add`).');
      return text(`Desired behaviors of the system (${rows.length}; the code must uphold each; a review checks changes against them):\n${behaviorsSummary(rows)}\n\n${r.text}${r.omitted?.length ? `\n\n(${r.omitted.length} more not shown for the budget; lookup by id for one)` : ''}`);
    }
    if (!r.included.length) return text(emptyCache() || `Nothing cached about that. ${codeFallback(query) || 'Try fewer or different words, or an identifier from the code. '}`);
    return text(r.text);
  });

  retrieval('find', {
    title: 'Find where something is defined',
    description: 'Lists the definitions whose name or body carry the words you give (an identifier, or what the code would call the thing), as path:Symbol:L12 pointers with their size and blast radius, plus the cached notes on them. Use it instead of grepping for a word and reading around each hit; then drilldown the pointers you need. For what the notes say, use lookup.',
    inputSchema: {
      query: z.string().describe('Words the code would use (e.g. "flag default parser", "invite existing member"), or one identifier.'),
      path: z.string().optional().describe('Keep only paths containing this (e.g. "src/click", "api/"), or a glob (e.g. "**/*.py").'),
      limit: z.number().int().min(1).max(40).optional().describe('How many definitions to list (default 12).'),
    },
  }, async ({ query, path, limit }) => {
    const r = find(store, { query, path, limit: limit || 12, client: 'mcp' });
    return text(r.error ? r.error : r.text);
  });

  retrieval('drilldown', {
    title: 'Read one or more definitions by pointer',
    description: 'Takes pointers as orient, lookup and find print them (path:Symbol, path:Symbol:L12), a path, or a bare symbol name; several at once, separated by commas. Returns each definition whole with its exact lines (a long class as its head and the outline of its members), for a single pointer also one hop of callers and callees, and the cached notes resting on the code. Use it instead of reading the file and grepping for the name; a path alone lists what the file defines.',
    inputSchema: {
      pointer: z.string().describe('path:Symbol, path, or Symbol; several separated by commas or spaces'),
      budget: z.number().int().min(300).max(12000).optional().describe('Max tokens to return (default 2500); the code gets most of it. Raise it for a long definition.'),
    },
  }, async ({ pointer, budget }) => {
    const r = drilldown(store, { pointer, client: 'mcp', budget: budget || 2500 });
    return text(r.error ? r.error : r.text);
  });

  retrieval('review', {
    title: 'Review a change against the cache',
    // Not for the agent's own initiative: "during implementation, supply task context" had Gemini call it at the
    // end of every run and lose three minutes to each call that outran the client's tool timeout (bench/RESULTS.md,
    // "Tool intro"). It is called when a person asks for a review, and says how long it takes.
    description: 'Only when the user asks for a review or verification of a change; do not call it on your own to check work in progress, it is slow (several model calls over the whole change, minutes, longer than some clients allow a tool call) and its findings need a person to act on. Supply the task context you were given. Action start freezes a snapshot, runs the repository\'s verification contract in Docker and reviews asynchronously; status with runId returns structured failures and human evidence once, when the user asks for the result, not by polling. Default assess checks the change against the desired behaviors of the system (rules a person wrote; the code must uphold them: a violation of a fixed one is an error, a mutable one may be revised only by a change that edits its note) and against the cached notes that rest on the changed code or bear on it (invariants, conventions, traps). Reports violations and bugs with file:line and evidence, every behavior in play with its outcome (upheld, violated, revised), and removed symbols still referenced. With kinds ["behavior"] only the desired behaviors are consulted, one call per behavior in play. Notes that were already stale are reported as cache drift, not as faults of the change. Default scope: the working tree against HEAD.',
    inputSchema: {
      action: z.enum(['assess', 'start', 'status']).optional().describe('assess: inspect code now. start: freeze a snapshot, run the base verification contract in Docker and review asynchronously. status: retrieve structured results and human evidence.'),
      runId: z.string().optional().describe('Run id for status.'),
      previous: z.string().optional().describe('Previous verification run; carries task context forward and compares failures.'),
      task: z.object({ request: z.string(), criteria: z.array(z.object({ text: z.string(), source: z.enum(['user', 'agent']).optional(), checks: z.array(z.string()).optional(), tests: z.array(z.object({ check: z.string(), name: z.string(), file: z.string().optional() })).optional() })).optional(), intendedChanges: z.array(z.string()).optional(), rationale: z.string().optional(), questions: z.array(z.string()).optional() }).optional().describe('Relevant task context. Link criteria to exact tests with check id, name, and repository-relative file. Attribution and links are not execution evidence.'),
      paths: z.array(z.string()).optional().describe('Limit the review to these paths.'),
      staged: z.boolean().optional().describe('Review the index instead of the working tree.'),
      base: z.string().optional().describe('A branch or commit: review everything since the merge base with it (e.g. "origin/main").'),
      state: z.boolean().optional().describe('No change: audit the current code of the paths against the notes resting on it.'),
      max: z.number().int().min(1).max(30).optional().describe('Maximum notes to assess with the model (default 12).'),
      kinds: z.array(z.string()).optional().describe('Consult only notes of these kinds, e.g. ["behavior"] for the desired behaviors alone.'),
    },
  }, async ({ action = 'assess', runId, previous, task, paths, staged, base, state, max, kinds }) => {
    try {
      if (action !== 'assess') {
        if (paths?.length || state) throw new Error('Verification runs cover a full snapshot, not selected paths or state audits');
        const r = action === 'status' ? readVerification(store.repo, runId) : await startVerification(store, { task, previous, staged, base, caller: 'mcp' });
        return { content: [{ type: 'text', text: renderVerification(r) }], structuredContent: r };
      }
      const scope = resolveScope(store.repo, { base, staged, state });
      const r = await review(store, { scope, task: taskContext(task), paths: paths || [], max: max || 12, kinds });
      return text(renderReview(r));
    } catch (e) { return text(`review failed: ${String(e.message || e).slice(0, 300)}`); }
  });

  retrieval('remember', {
    title: 'Save a reusable note',
    description: `Save something you had to work out that a future agent would otherwise re-derive with several greps/reads. Good notes answer a recurring question: WHERE something happens, a CALL PATH across files, what must CHANGE TOGETHER, HOW TO build/test/run, a local CONVENTION, a GOTCHA, or WHY something is the way it is (rejected approaches, incident-driven constraints). Do NOT save plain summaries of what a file does. Be concrete: name files and symbols. Every note must list the files/symbols it depends on; the cache hashes them and flags the note stale when they change. Kinds: rule (what a change must respect: an invariant, a convention, a trap, a fix not to undo, a reason, what changes together and why), map (where something is handled, a call path, a module map), howto, behavior. A note of kind behavior is a desired behavior of the system the code must keep upholding (say where it is enforced); from an agent it is a proposal until a person accepts it with thinker system accept.`,
    inputSchema: {
      title: z.string().describe('Short, specific title, e.g. "How a CLI option value reaches the callback"'),
      kind: z.enum(KINDS),
      mutability: z.enum(['fixed', 'mutable']).optional().describe('For kind behavior: fixed (never revised) or mutable (revised only by a change that edits the note; the default).'),
      answers: z.array(z.string()).describe('Question forms this note answers, used for retrieval, e.g. ["where is option parsing", "how does type conversion happen for params"]'),
      body: z.string().describe('The note, 3-12 lines of markdown. Use file:symbol pointers. Include the non-obvious parts, not the obvious ones.'),
      applies: z.string().optional().describe('When this applies and when it does not (for gotchas, conventions, rationale).'),
      deps: z.array(z.object({ path: z.string().describe('repo-relative path'), symbol: z.string().optional().describe('function/class name inside the file, if the note depends on that symbol specifically') })).min(1),
      tags: z.array(z.string()).optional(),
      confidence: z.number().min(0).max(1).optional().describe('How sure you are (default 0.7). Use >=0.9 only if you verified by reading the code, not inferring.'),
    },
  }, async (input) => {
    const r = createNote(store, input, { source: { type: 'agent', ref: process.env.THINKER_SESSION || 'mcp' } });
    if (r.error) return text(`Not saved: ${r.error}. Dropped deps: ${JSON.stringify(r.dropped)}`);
    const warn = r.dropped.length ? ` (dropped/downgraded deps: ${r.dropped.map(d => `${d.path}${d.symbol ? ':' + d.symbol : ''} – ${d.reason}`).join('; ')})` : '';
    return text(`Saved note ${r.note.id} with ${r.note.deps.length} tracked dependencies${warn}.`);
  });

  retrieval('feedback', {
    title: 'Report whether a note was right',
    description: 'After using a cached note, report whether it was accurate. If it was wrong or outdated, give the corrected body so the cache improves. Wrong notes lose confidence and are eventually retired.',
    inputSchema: {
      id: z.string().describe('Note id as shown in the orient/lookup output'),
      useful: z.boolean(),
      correction: z.string().optional().describe('Corrected note body, if the note was wrong'),
    },
  }, async (input) => {
    const r = feedback(store, input);
    if (r.error) return text(r.error);
    return text(`Recorded. ${r.note.id} confidence now ${Math.round(r.note.confidence * 100)}%${input.correction ? ', body updated' : ''}.`);
  });
}

if (setUp) registerTools();

const transport = new StdioServerTransport();
await server.connect(transport);

// Started outside a repository: a client that declares roots (a workspace) is asked for them, and
// the first root that is a repository set up with thinker gets the tools, announced through
// tools/list_changed. A repository that is not set up gets nothing, as above.
if (!off && !repo) {
  try {
    if (server.server.getClientCapabilities()?.roots) {
      const { roots = [] } = await server.server.listRoots();
      for (const root of roots) {
        let p = root.uri; try { if (/^file:/.test(p)) p = fileURLToPath(p); } catch { continue; }
        if (!inRepo(p)) continue;
        const s = new Store(findRepoRoot(p));
        if (!s.exists()) continue;
        repo = s.repo; store = s; setUp = true; store.init(); await initAst();
        registerTools();
        break;
      }
    }
  } catch {}
}
