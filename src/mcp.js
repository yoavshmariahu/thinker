#!/usr/bin/env node
// MCP server exposing the knowledge cache for one repo.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import { Store, findRepoRoot } from './store.js';
import { orient, lookup, createNote, feedback, KINDS } from './ops.js';

const repo = findRepoRoot(process.env.THINKER_REPO || process.cwd());
// THINKER_MCP=off: the server starts but offers no tools and no instructions. For control arms of a
// benchmark when the agent's MCP registration is machine-wide and cannot be left out for one run.
const off = process.env.THINKER_MCP === 'off';
const store = off ? null : new Store(repo).init();

const server = new McpServer({ name: 'thinker', version: '0.1.0' }, off ? {} : {
  instructions: `thinker is a cache of distilled understanding about this repository (${repo}), written by previous agent sessions and humans. Call \`orient\` FIRST, before any grep/read, whenever you start a task in this repo: it returns notes about where things live, call paths, what must change together, how to build/test, and non-obvious rules. Notes come with file:symbol pointers so you can jump straight to the code. Notes flagged STALE had their dependencies change since verification; confirm them against the code. When you finish figuring something out that took several tool calls (a call path, a location, a co-change rule, a build/test recipe, a gotcha, a "why"), call \`remember\` so the next session can skip that work.`,
});

const register = off ? () => {} : server.registerTool.bind(server);

const text = s => ({ content: [{ type: 'text', text: s }] });
// THINKER_ORIENT_GUIDE: a file with instructions on how to use the notes, put above them (per-model guidance).
// An empty cache is said outright, with its location: "nothing matches" reads as a miss and hides a server pointed at the wrong place.
const emptyCache = () => store.list().length ? '' : `The cache is empty: no notes in ${store.notesDir}. `;
const guide = (() => { try { return process.env.THINKER_ORIENT_GUIDE ? fs.readFileSync(process.env.THINKER_ORIENT_GUIDE, 'utf8').trim() : ''; } catch { return ''; } })();

register('orient', {
  title: 'Orient in this repo',
  description: 'Call this first when starting a task in this repository. Returns cached, verified notes relevant to the task (locations, call paths, co-change rules, build/test recipes, conventions, gotchas) with file:symbol pointers, packed into a token budget. Prefer following these pointers over grepping from scratch. Notes marked STALE need confirmation against the current code.',
  inputSchema: {
    task: z.string().optional().default('').describe('What you are about to do, in one or two sentences (the user request is fine).'),
    file: z.string().optional().describe('Path of the file you are currently in or about to edit, if known.'),
    budget: z.number().int().min(200).max(8000).optional().describe('Max tokens of notes to return (default 1000).'),
  },
}, async ({ task = '', file, budget }) => {
  if (!task.trim() && !file) return text('orient needs the task. Call it again with {"task": "<the user request, in one or two sentences>"}.');
  // the agent named a budget: let it decide how many notes are served, not the two-note default of the hooks
  const r = await orient(store, { task, file, budget: budget || 1000, ...(budget ? { maxNotes: 5, relFloor: 0.7 } : {}) });
  if (!r.included.length) return text(`${emptyCache() || `No cached notes match this task (${store.list().length} notes in cache). `}Explore normally, then call remember with what you learn.`);
  const more = r.more?.length ? `\n\nAlso in the cache, not shown. Call lookup with the id before searching for what the title covers:\n${r.more.map(n => `- [${n.kind}] ${n.title}  (id: ${n.id})`).join('\n')}` : '';
  const notes = `Cached knowledge for this task (${r.included.length} notes, ~${r.tokens} tokens):\n\n${r.text}${more}`;
  return text(guide ? `${guide}\n\n<thinker-cache>\n${notes}\n</thinker-cache>` : notes);
});

register('lookup', {
  title: 'Look up cached knowledge',
  description: 'Ask the cache a specific question mid-task, e.g. "what do we know about the session middleware" or "how are migrations run". Returns matching notes with pointers. Cheaper than grepping when the answer has been learned before.',
  inputSchema: {
    query: z.string().describe('The question or topic, or a note id listed by orient.'),
    budget: z.number().int().min(200).max(8000).optional(),
  },
}, async ({ query, budget }) => {
  const r = lookup(store, { query, budget: budget || 2500 });
  if (!r.included.length) return text(emptyCache() || 'Nothing cached about that. Try fewer or different words, or an identifier from the code.');
  return text(r.text);
});

register('remember', {
  title: 'Save a reusable note',
  description: `Save something you had to work out that a future agent would otherwise re-derive with several greps/reads. Good notes answer a recurring question: WHERE something happens, a CALL PATH across files, what must CHANGE TOGETHER, HOW TO build/test/run, a local CONVENTION, a GOTCHA, or WHY something is the way it is (rejected approaches, incident-driven constraints). Do NOT save plain summaries of what a file does. Be concrete: name files and symbols. Every note must list the files/symbols it depends on; the cache hashes them and flags the note stale when they change. Kinds: ${KINDS.join(', ')}.`,
  inputSchema: {
    title: z.string().describe('Short, specific title, e.g. "How a CLI option value reaches the callback"'),
    kind: z.enum(KINDS),
    answers: z.array(z.string()).describe('Question forms this note answers, used for retrieval, e.g. ["where is option parsing", "how does type conversion happen for params"]'),
    body: z.string().describe('The note, 3-12 lines of markdown. Use file:symbol pointers. Include the non-obvious parts, not the obvious ones.'),
    applies: z.string().optional().describe('When this applies and when it does not (for gotchas, conventions, rationale, co-change rules).'),
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

register('feedback', {
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

const transport = new StdioServerTransport();
await server.connect(transport);
