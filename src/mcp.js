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
import { listBehaviors, behaviorsSummary, addBehavior } from './behavior.js';
import { editBehavior, removeBehavior } from './behavior-workbench.js';
import { initAst } from './ast.js';
import { cacheInstructions, disabledTools, MORE_NOTES_INTRO } from './cache-guidance.js';

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
// Learning off (THINKER_NO_LEARN=1): the agent's own learning tools, remember and feedback, are not offered,
// so their schemas cost nothing; behavior stays, since it acts only on what the person asks for.
const noLearn = /^(1|true|yes)$/i.test(process.env.THINKER_NO_LEARN || '');
// A repository where `thinker setup` has not run has no cache: the server offers no tools there and
// creates nothing, so a machine-wide registration does not start a cache in every checkout.
let store = off || !repo ? null : new Store(repo);
let setUp = !!store && store.exists();
if (setUp) { store.init(); await initAst(); } // tree-sitter grammars when installed (`thinker ast install`); the regex otherwise

const server = new McpServer({ name: 'thinker', version: '0.1.0' }, off ? {} : setUp ? {
  // Composed under the host's cap, never concatenated here: see cache-guidance.js:INSTRUCTIONS_LIMIT.
  instructions: cacheInstructions({ repo, disabled: disabledTools(store.config()), learn: !noLearn }),
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
// It is `find`'s output, so it goes with `find`: off unless the repository turned that tool on.
const codeFallback = q => {
  const off = disabledTools(store.config());
  if (!String(q || '').trim() || off.has('find')) return '';
  try {
    const r = find(store, { query: q, limit: 6, client: 'mcp-fallback' });
    if (r.error || !r.hits?.length) return '';
    return `By text search instead (not notes; find takes the words the code would use${off.has('drilldown') ? '' : ', drilldown the pointers that fit'}):\n${r.text}\n\n`;
  } catch { return ''; }
};

function registerTools() {
  // a tool that is switched off is not offered at all: nothing can call it and fail
  const off = disabledTools(store.config());
  if (noLearn) for (const t of ['remember', 'feedback']) off.add(t);
  const retrieval = (name, ...rest) => off.has(name) ? undefined : server.registerTool(name, ...rest);

  retrieval('orient', {
    title: 'Orient in this repo',
    description: 'Notes with file:symbol pointers for a task, and the code behind the main ones. Call once at the start unless a thinker-cache bundle for this request is already present; again only for a distinct part it missed. Confirm a STALE claim against the code.',
    inputSchema: {
      task: z.string().optional().default('').describe('What you are about to do; the user request is fine'),
      file: z.string().optional().describe('The file you are in or about to edit, if known'),
      budget: z.number().int().min(200).max(8000).optional().describe('Max tokens of notes (default 1000)'),
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
    description: 'One specific open question, or a note id listed by orient (not every title). If no note answers, search the code. kind "behavior": the desired behaviors of the system a review checks changes against; all of them with an empty query.',
    inputSchema: {
      query: z.string().describe('Question, topic, or a note id; empty with kind behavior lists all'),
      kind: z.enum(KINDS).optional().describe('Only this kind'),
      budget: z.number().int().min(200).max(8000).optional(),
      maxNotes: z.number().int().min(1).max(10).optional().describe('Default 3'),
    },
  }, async ({ query, kind, budget, maxNotes }) => {
    const r = await lookup(store, { query: query || '', kind, client: 'mcp', budget: budget || 2500, maxNotes: maxNotes || 3, snippets: snippetsOn(store) });
    if (kind === 'behavior' && !String(query || '').trim()) {
      const rows = listBehaviors(store);
      if (!rows.length) return text('No desired behaviors are written down for this repository yet (they come from the design documents checked in; when the person asks for one, the behavior tool adds it).');
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

  // `review` was a tool here until 2026-10-06 and is now a mode of the command line instead.
  // Agents did not reach for it: 14 MCP calls of any kind against 2094 orients on the machine that
  // built it, while the 161 reviews that did run came from the CLI and the pull request action. It is
  // also the wrong shape for a tool call — several model calls over a whole change, minutes, longer
  // than some clients allow — and its findings need a person. `thinker review` has every capability
  // the tool had, verification runs included (--run, --start, --status). See "Reviewing a change"
  // in AGENTS.md and the README.
  retrieval('remember', {
    title: 'Save a reusable note',
    description: 'Save what you had to work out and a future agent would re-derive: where something happens, a call path, what changes together, how to build/test/run, a convention, a gotcha, or why something is the way it is. Not a summary of a file. Name files and symbols, and list the files/symbols it depends on: the note goes stale when they change. Kinds: rule (an invariant, convention, trap, fix not to undo, or reason), map (where, call path, module map), howto, behavior (a desired behavior of the system; from an agent, a proposal until a person accepts it).',
    inputSchema: {
      title: z.string().describe('Short, specific title'),
      kind: z.enum(KINDS),
      mutability: z.enum(['fixed', 'mutable']).optional().describe('kind behavior: fixed, or mutable (default)'),
      answers: z.array(z.string()).describe('Questions this note answers, for retrieval'),
      body: z.string().describe('3-12 lines with file:symbol pointers; the non-obvious parts'),
      applies: z.string().optional().describe('When it applies and when not'),
      deps: z.array(z.object({ path: z.string().describe('repo-relative path'), symbol: z.string().optional().describe('function/class name inside the file, if the note depends on that symbol specifically') })).min(1),
      tags: z.array(z.string()).optional(),
      confidence: z.number().min(0).max(1).optional().describe('Default 0.7; >=0.9 only when read in the code'),
    },
  }, async (input) => {
    const r = createNote(store, input, { source: { type: 'agent', ref: process.env.THINKER_SESSION || 'mcp' } });
    if (r.error) return text(`Not saved: ${r.error}. Dropped deps: ${JSON.stringify(r.dropped)}`);
    const warn = r.dropped.length ? ` (dropped/downgraded deps: ${r.dropped.map(d => `${d.path}${d.symbol ? ':' + d.symbol : ''} – ${d.reason}`).join('; ')})` : '';
    return text(`Saved note ${r.note.id} with ${r.note.deps.length} tracked dependencies${warn}.`);
  });

  // What the person asks their agent for is theirs: in force at once, as a behavior they wrote (the
  // same functions as `thinker ui` and `thinker system add|edit|rm`). An agent's own idea goes
  // through remember with kind behavior and waits for a person.
  retrieval('behavior', {
    title: 'Add, change or remove a system behavior',
    description: 'Only when the person asks you, in this conversation, to add, change or remove a desired behavior of the system: a rule every change must keep, which review checks changes against. It is in force at once, as theirs. Never call it on your own initiative: suggest a rule with remember, kind behavior. add: title, body, deps. edit: id and what changes. remove: id.',
    inputSchema: {
      action: z.enum(['add', 'edit', 'remove']),
      id: z.string().optional().describe('edit/remove: the behavior id'),
      title: z.string().optional().describe('The requirement as one sentence.'),
      body: z.string().optional().describe('The rule and where the code upholds it, with path:Symbol pointers'),
      mutability: z.enum(['fixed', 'mutable']).optional().describe('fixed: review blocks a breaking change; mutable (default): warns'),
      answers: z.array(z.string()).optional().describe('add: ways someone would ask about it'),
      deps: z.array(z.object({ path: z.string().describe('repo-relative path'), symbol: z.string().optional() })).optional().describe('For add: the definitions that uphold the rule.'),
    },
  }, async ({ action, id, title, body, mutability, answers, deps }) => {
    if (action === 'add') {
      if (!title || !body || !deps?.length) return text('Not saved: add needs title, body and deps (the code that upholds the rule).');
      const r = addBehavior(store, { title, body, answers: answers?.length ? answers : [title], deps }, { mutability });
      if (r.error) return text(`Not saved: ${r.error}.${r.dropped?.length ? ` Dropped deps: ${JSON.stringify(r.dropped)}` : ''}`);
      return text(`Saved behavior ${r.note.id} (${r.note.mutability}), in force now. The person can see and edit it in thinker ui.`);
    }
    if (!id) return text(`Not done: ${action} needs the behavior id (lookup with kind "behavior" lists them).`);
    if (action === 'edit') {
      if (!title && !body && !mutability) return text('Not done: edit needs a new title, body or mutability.');
      const r = editBehavior(store, id, { title, body, mutability });
      return text(r.error ? `Not done: ${r.error}.` : `Saved behavior ${r.note.id} (${r.note.mutability || 'mutable'}): ${r.note.title}`);
    }
    const r = removeBehavior(store, id);
    return text(r.error ? `Not done: ${r.error}.` : `Removed behavior ${id}${r.title ? `: ${r.title}` : ''}.`);
  });

  retrieval('feedback', {
    title: 'Report whether a note was right',
    description: 'After using a note: was it right? A wrong or outdated note gets the corrected body; wrong notes lose confidence and retire.',
    inputSchema: {
      id: z.string().describe('Note id from orient or lookup'),
      useful: z.boolean(),
      correction: z.string().optional().describe('The corrected body, if wrong'),
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
