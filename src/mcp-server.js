#!/usr/bin/env node
// MCP server exposing the knowledge cache for one repo. Started by mcp.js, which restarts it on the new code after an update.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { noticeCard } from './notice-card.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, findRepoRoot } from './store.js';
import { orient, lookup, drilldown, find, createNote, feedback, snippetsOn, KINDS, agentSession, holdoutTurn, peekTurn } from './ops.js';
import { listBehaviors, behaviorsSummary, addBehavior } from './behavior.js';
import { editBehavior, removeBehavior } from './behavior-workbench.js';
import { ensureTelemetryScheduled, reportTelemetrySchedule } from './telemetry-schedule.js';
import { maybeCheckDailyUpdateInBackground } from './update.js';
import { maybeSendTelemetryInBackground, HOUR_MS } from './telemetry.js';
import { initAst } from './ast.js';
import { cacheInstructions, disabledTools, MORE_NOTES_INTRO } from './cache-guidance.js';
import { isDisabledRepo } from './repo-switch.js';
import { coveragePending, answerCoverage } from './coverage.js';
import { harnessPending, answerHarness, switchedOffSkills, skillLines } from './harness.js';
import { queueDir, buildRunning, nextRequest, answerRequest, requestText } from './session-llm.js';
import { anyDesktopApp, ancestorPids } from './app-host.js';

// MCP-only installations need the same default OS schedule as CLI/hook users.
try { reportTelemetrySchedule(ensureTelemetryScheduled({ rootDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') })); }
catch (e) { reportTelemetrySchedule({ error: e.message }); }

// Which repository: THINKER_REPO when the entry pins one (a checkout's own .mcp.json), else the
// working directory the client started the server in (the user's machine-wide entry, every
// checkout), else the project directory the client's environment names. A container or a desktop
// app may start the server at / (2026-10-13: Claude Code in a docker container told its user that
// thinker "isn't serving any tools" while the hooks found the repository from their input), and
// Claude Code declares no MCP roots, so the server cannot ask. The tools are offered all the same,
// each taking `cwd`: the first call that names the agent's working directory binds the server to
// that repository (`bind`), and a client that declares roots is asked for them once connected.
const checkoutOf = d => {
  if (!d) return null;
  let p = String(d); try { if (/^file:/.test(p)) p = fileURLToPath(p); } catch { return null; }
  if (!path.isAbsolute(p)) return null;
  try { p = fs.realpathSync(p); } catch { return null; } // as process.cwd() names a directory: the real path
  const r = findRepoRoot(p); return fs.existsSync(path.join(r, '.git')) ? r : null;
};
// `thinker mcp --enable orient,find`: tools this one server offers though the repository's config switches
// them off (cache-guidance.js:SWITCHABLE_TOOLS), so an experiment arm can name its tools in its own command
// rather than in the checkout (an Artemis arm told to orient first, since orient went off by default).
const enabledHere = (() => { const i = process.argv.indexOf('--enable'); return i < 0 ? [] : String(process.argv[i + 1] || '').split(',').map(t => t.trim()).filter(Boolean); })();
const toolsOff = config => { const off = disabledTools(config); for (const t of enabledHere) off.delete(t); return off; };
const pinned = process.env.THINKER_REPO;
let repo = pinned ? findRepoRoot(pinned) : checkoutOf(process.cwd()) || checkoutOf(process.env.CLAUDE_PROJECT_DIR);
// THINKER_MCP=off: the server starts but offers no tools and no instructions. For control arms of a
// benchmark when the agent's MCP registration is machine-wide and cannot be left out for one run.
// A repository switched off machine-wide (repo-switch.js) is served the same way: no tools, no notes.
const switchedOff = !!repo && isDisabledRepo(repo);
const off = process.env.THINKER_MCP === 'off' || switchedOff;
// Learning off (THINKER_NO_LEARN=1): the agent's own learning tools, remember and feedback, are not offered,
// so their schemas cost nothing; behavior stays, since it acts only on what the person asks for.
const noLearn = /^(1|true|yes)$/i.test(process.env.THINKER_NO_LEARN || '');
// Every git repository has a cache: a machine-wide registration starts one (empty, growing from the
// sessions) in the checkout the client runs in. Started outside one, the server binds late: to the
// repository of each call that names a directory in it (its `cwd`, or an absolute `file`).
let store = null, setUp = false, astReady = false;
const late = !off && !repo;
const stores = new Map();
function storeFor(r) {
  let s = stores.get(r);
  if (!s) { s = new Store(r); s.init(); stores.set(r, s); }
  return s;
}
async function bind(r) {
  repo = r; store = storeFor(r); setUp = true;
  if (!astReady) { astReady = true; await initAst(); } // tree-sitter grammars when installed (`thinker ast install`); the regex otherwise
}
if (!off && repo) await bind(repo);

const server = new McpServer({ name: 'thinker', version: '0.1.0' }, switchedOff ? {
  instructions: 'thinker is switched off for this repository and serves nothing here.',
} : off ? {} : setUp ? {
  // Composed under the host's cap, never concatenated here: see cache-guidance.js:INSTRUCTIONS_LIMIT.
  instructions: cacheInstructions({ repo, disabled: toolsOff(store.config()) }),
} : {
  instructions: cacheInstructions({ intro: `thinker is a cache of notes per git repository from earlier sessions and humans. It was started outside one (${process.cwd()}): on the first call pass cwd, the absolute path of your working directory, and the tools bind to that repository.`, disabled: toolsOff({}) }),
});

// Bound late (see `late`): a call must name the repository first, and a later call from another
// window with its own `cwd` (or absolute `file`) switches the active repository to that checkout.
// Until one does, every tool answers with what it needs; the call that binds says so above its answer.
// Calls are handled concurrently, so one that arrives while the bind is under way waits for it.
let binding = null;
async function ensureBound(args) {
  if (binding) await binding;
  const r = !pinned ? (checkoutOf(args?.cwd) || checkoutOf(args?.file)) : null;
  if (r && r !== repo) {
    if (isDisabledRepo(r)) return { reply: text('thinker is switched off for that repository and serves nothing there.') };
    binding = bind(r); await binding;
    registerCoverageTool(); registerHarnessTool(); registerQueueTools();
    return { bound: true };
  }
  if (store) return { bound: false };
  return { reply: text('thinker is not bound to a repository yet: it was started outside a git checkout. Call again with cwd, the absolute path of your working directory.') };
}

const text = s => ({ content: [{ type: 'text', text: s }] });
// An empty cache is said outright, with its location: "nothing matches" reads as a miss and hides a server pointed at the wrong place.
const emptyCache = () => store.list().length ? '' : `The cache is empty: no notes in ${store.notesDir}. `;

// When no note answers a lookup, the definitions whose code carries its words, from `find`:
// in a week of real sessions `find` was never called (Claude Code defers MCP tools; agents grep
// instead), so a miss hands its first results over rather than naming the tool.
// It is `find`'s output, so it goes with `find`: off unless the repository turned that tool on.
const codeFallback = q => {
  const off = toolsOff(store.config());
  if (!String(q || '').trim() || off.has('find')) return '';
  try {
    const r = find(store, { query: q, limit: 6, client: 'mcp-fallback' });
    if (r.error || !r.hits?.length) return '';
    return `By text search instead (not notes; find takes the words the code would use${off.has('drilldown') ? '' : ', drilldown the pointers that fit'}):\n${r.text}\n\n`;
  } catch { return ''; }
};

const clientName = () => server.server.getClientVersion()?.name || 'mcp';

// The session and turn the agent's own orient and lookup belong to, from the link the prompt hook left
// (ops.js:agentSession): logged with the call, and a held-out turn is served nothing here either. {} where no
// hook ran (an MCP-only client, a benchmark arm with the hooks off): the call is served and logged as before.
let ancestors;
function agentTurn() {
  try {
    ancestors ||= ancestorPids(process.ppid);
    const session = agentSession(store, ancestors); if (!session) return {};
    const { turn, holdout } = holdoutTurn(store, session);
    return { session, turn: turn || undefined, holdout };
  } catch { return {}; }
}

function withNotice(result, included, turnContext) {
  const tracked = turnContext.session ? peekTurn(store, turnContext.session).map(id => store.get(id)).filter(Boolean) : [];
  const hint = noticeCard(store, { client: clientName(), ...turnContext, notes: [...tracked, ...included] });
  if (hint) result.content.push({ type: 'text', text: hint });
  return result;
}

function registerTools() {
  // a tool that is switched off is not offered at all: nothing can call it and fail (bound late, the
  // repository's own choice of code tools is not known yet: the defaults apply)
  const off = toolsOff(store ? store.config() : {});
  if (noLearn) for (const t of ['remember', 'feedback']) off.add(t);
  const cwd = { cwd: z.string().optional().describe('Absolute path of your working directory, once: the server binds to its repository (it was started outside one)') };
  let active = Promise.resolve();
  const retrieval = (name, spec, handler) => off.has(name) ? undefined : server.registerTool(name, late ? { ...spec, inputSchema: { ...spec.inputSchema, ...cwd } } : spec, (args, extra) => {
    const run = async () => {
      const { reply, bound } = await ensureBound(args); if (reply) return reply;
      const r = await handler(args, extra);
      if (bound) r.content.unshift({ type: 'text', text: `thinker is bound to the repository at ${repo} from here on.` });
      return r;
    };
    const next = active.then(run, run);
    active = next.catch(() => {});
    return next;
  });

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
    const reply = text;
    // the agent named a budget: let it decide how many notes are served, not the two-note default of the hooks
    const turnContext = agentTurn();
    const r = await orient(store, { task, file, client: 'mcp', ...turnContext, budget: budget || 1000, snippets: snippetsOn(store), ...(budget ? { maxNotes: 5, relFloor: 0.7 } : {}) });
    // no text search over the whole task on a miss: a sentence's words list unrelated code (mitmproxy, 2026-10-07:
    // ValueEditor.tsx and SaveHar for a binary-detection fix) that the agent then opens
    if (!r.included.length) return reply(`${emptyCache() || `No cached notes match this task (${store.list().length} notes in cache). `}Work from the code.`);
    const more = r.more?.length ? `\n\n${MORE_NOTES_INTRO}\n${r.more.map(n => `- [${n.kind}] ${n.title}  (id: ${n.id})`).join('\n')}` : '';
    const notes = `Cached knowledge for this task (${r.included.length} notes, ~${r.tokens} tokens):\n\n${r.text}${more}`;
    return withNotice(reply(notes), r.included, turnContext);
  });

  retrieval('lookup', {
    title: 'Look up cached knowledge',
    description: `One specific open question, or a note id listed by ${off.has('orient') ? 'a thinker-cache bundle' : 'orient'} (not every title). If no note answers, search the code. kind "behavior": the desired behaviors of the system; all of them with an empty query.`,
    inputSchema: {
      query: z.string().describe('Question, topic, or a note id; empty with kind behavior lists all'),
      kind: z.enum(KINDS).optional().describe('Only this kind'),
      budget: z.number().int().min(200).max(8000).optional(),
      maxNotes: z.number().int().min(1).max(10).optional().describe('Default 3'),
    },
  }, async ({ query, kind, budget, maxNotes }) => {
    const turnContext = agentTurn();
    const r = await lookup(store, { query: query || '', kind, client: 'mcp', ...turnContext, budget: budget || 2500, maxNotes: maxNotes || 3, snippets: snippetsOn(store) });
    // the switched-off skills the agent's words match, beside the notes (harness.js:switchedOffSkills; off by default)
    // with no kind, or asked for skills by kind: an agent told to look skills up asks with kind "skill"
    const skills = kind && kind !== 'skill' ? [] : await switchedOffSkills(store, query).catch(() => []);
    if (skills.length) {
      store.log({ op: 'harness-skill-lookup', client: 'mcp', query: String(query).slice(0, 200), skills: skills.map(c => c.id) });
      const found = `Switched-off skills for this:\n${skillLines(skills)}`;
      return r.included.length ? withNotice(text(`${found}\n\n${r.text}`), r.included, turnContext) : text(found);
    }
    if (kind === 'behavior' && !String(query || '').trim()) {
      const rows = listBehaviors(store);
      if (!rows.length) return text('No desired behaviors are written down for this repository yet (they come from the design documents checked in; when the person asks for one, the behavior tool adds it).');
      return text(`Desired behaviors of the system (${rows.length}; the code must uphold each):\n${behaviorsSummary(rows)}\n\n${r.text}${r.omitted?.length ? `\n\n(${r.omitted.length} more not shown for the budget; lookup by id for one)` : ''}`);
    }
    if (!r.included.length) return text(emptyCache() || `Nothing cached about that. ${codeFallback(query) || 'Try fewer or different words, or an identifier from the code. '}`);
    return withNotice(text(r.text), r.included, turnContext);
  });

  retrieval('find', {
    title: 'Find where something is defined',
    description: 'Lists the definitions whose name or body carry the words you give (an identifier, or what the code would call the thing), as path:Symbol:L12 pointers with their size and blast radius, plus the cached notes on them. Use it when you do not know where the code is; for one identifier the code of its top definition comes with the list. For what the notes say, use lookup.',
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
    description: `Takes pointers as ${off.has('orient') ? '' : 'orient, '}lookup and find print them (path:Symbol, path:Symbol:L12), a path, or a bare symbol name; several at once, separated by commas. Returns each definition whole with its exact lines (a long class as its head and the outline of its members), for a single pointer also one hop of callers and callees, and the cached notes resting on the code. Lines are numbered. Use it when you need a definition whole; a path alone lists what the file defines.`,
    inputSchema: {
      pointer: z.string().optional().describe('path:Symbol, path, or Symbol; several separated by commas or spaces'),
      pointers: z.array(z.string()).optional().describe('The same, as a list'),
      budget: z.number().int().min(300).max(12000).optional().describe('Max tokens to return (default 2500); the code gets most of it. Raise it for a long definition.'),
    },
  }, async ({ pointer, pointers, budget }) => {
    const r = drilldown(store, { pointer, pointers, client: 'mcp', budget: budget || 2500 });
    return text(r.error ? r.error : r.text);
  });

  // `review` was a tool here until 2026-10-06, then a command until 2026-10-11: on held-out bugs it never
  // beat the user's own coding agent reviewing with the cache alongside (research/regression-heldout).
  retrieval('remember', {
    title: 'Save a reusable note',
    description: 'Save what you had to work out and a future agent would re-derive: where something happens, a call path, what changes together, how to build/test/run, a convention, a gotcha, or why something is the way it is. Not a summary of a file. Name files and symbols, and list the files/symbols it depends on: the note goes stale when they change. Kinds: rule (an invariant, convention, trap, fix not to undo, or reason), map (where, call path, module map), howto, behavior (a desired behavior of the system; from an agent, a proposal until a person accepts it).',
    inputSchema: {
      title: z.string().describe('Short, specific title'),
      kind: z.enum(KINDS.filter(k => k !== 'skill')), // a skill card comes from its file (thinker skills scan)
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
      mutability: z.enum(['fixed', 'mutable']).optional().describe('fixed: never revised by a change; mutable (default): revised when merged code changes it'),
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
      id: z.string().describe(off.has('orient') ? 'Note id from a thinker-cache bundle or lookup' : 'Note id from orient or lookup'),
      useful: z.boolean(),
      correction: z.string().optional().describe('The corrected body, if wrong'),
    },
  }, async (input) => {
    const r = feedback(store, input);
    if (r.error) return text(r.error);
    return text(`Recorded. ${r.note.id} confidence now ${Math.round(r.note.confidence * 100)}%${input.correction ? ', body updated' : ''}.`);
  });

  registerCoverageTool(); registerHarnessTool();
  registerQueueTools();
}

// The answer to a coverage suggestion (coverage.js:coverageOffer): offered only while one waits for its answer
// here, so it costs nothing the rest of the time.
let coverageTool;
function registerCoverageTool() {
  if (coverageTool || !store || !coveragePending(store)) return;
  coverageTool = server.registerTool('coverage', {
    title: 'Answer a coverage suggestion',
    description: 'Only when a thinker-coverage-suggestion notice tells you to: records the user\'s answer and builds notes for the directories they chose, in the background.',
    inputSchema: {
      choice: z.string().describe('The directories the user chose, comma-separated, exactly as listed; or none; or never'),
      asked: z.enum(['picker', 'chat']).optional().describe('Where the user answered: your question tool (picker) or chat'),
      ...(late ? { cwd: z.string().optional().describe('Absolute path of the repository') } : {}),
    },
  }, async ({ choice, asked, cwd }) => {
    const { reply } = await ensureBound({ cwd }); if (reply) return reply;
    return text(await answerCoverage(store, String(choice), { client: clientName(), via: asked === 'chat' ? 'text' : 'picker' }));
  });
}

// The answer to a harness suggestion (harness.js:harnessOffer): offered only while one waits for its answer
// here, like the coverage tool.
let harnessTool;
function registerHarnessTool() {
  if (harnessTool || !store || !harnessPending(store)) return;
  harnessTool = server.registerTool('harness', {
    title: 'Answer a harness suggestion',
    description: 'Only when a thinker-harness-suggestion notice tells you to: records the user\'s answer and switches the chosen tools off for this repository.',
    inputSchema: {
      choice: z.string().describe('The names the user chose, comma-separated, exactly as quoted; or none; or never'),
      ...(late ? { cwd: z.string().optional().describe('Absolute path of the repository') } : {}),
    },
  }, async ({ choice, cwd }) => {
    const { reply } = await ensureBound({ cwd }); if (reply) return reply;
    return text(answerHarness(store, String(choice), { client: clientName(), via: 'picker' }));
  });
}

// Work read through this session (session-llm.js): in a desktop app, learning (session-work.js) or a coverage
// build (coverage.js). Its subagent works the queue through one tool, learn_next: each call hands in the answer to
// the request it took last (none on the first) and takes the next one, one call a request. Until 2026-10-22 this was
// two tools named after the warm-up, warmup_next and warmup_answer: two definitions in every desktop-app session and
// two calls a request. Offered in a desktop app from the start, bound or not, or while such work runs,
// so a subagent with its own server process finds them too. Each call reads the queue of the repository its
// `cwd` names: Cursor runs one server for every window (2026-10-16: started the day before in the home
// directory, bound to another repository), so the bound repository is only the fallback.
let queueTools, inApp;
const queueStore = cwd => { const r = checkoutOf(cwd); return r ? storeFor(r) : store; };
function registerQueueTools() {
  if (queueTools) return;
  inApp ??= anyDesktopApp();
  if (!(inApp || (store && buildRunning(queueDir(store))))) return;
  const noRepo = text('Pass cwd: the absolute path of the repository whose work you are answering.');
  queueTools = [server.registerTool('learn_next', {
    title: 'Work thinker\'s learning queue',
    description: 'Only for a subagent told to work thinker\'s queue: hands in the answer to the request it took last (none on the first call) and returns the next model request of thinker\'s background work.',
    inputSchema: {
      cwd: z.string().optional().describe('Absolute path of the repository'),
      id: z.string().optional().describe('The id of the request being answered; leave out on the first call'),
      answer: z.string().optional().describe('The answer to that request: one JSON object when the request gave a schema'),
    },
  }, async ({ cwd, id, answer } = {}) => {
    const s = queueStore(cwd); if (!s) return noRepo;
    let saved = '';
    if (id != null || answer != null) {
      if (id == null || answer == null) return text('Pass both id and answer to hand in an answer, or neither to take the next request.');
      const a = answerRequest(queueDir(s), id, answer);
      // refused: the same request stays taken, so the subagent answers it again rather than taking another
      if (a.error) return text(`Refused: ${a.error}. Answer request ${id} again with learn_next.`);
      saved = 'Saved. ';
    }
    // under the clients' tool timeouts (Codex: 60s), so an empty wait returns and is called again
    const r = await nextRequest(queueDir(s), { waitMs: 25_000 });
    if (r.error) return text(`${saved}The work could not start (${r.error}). Stop, and reply with that one line.`);
    if (r.request) return text(saved + requestText(r.request));
    if (r.waiting) return text(`${saved}Nothing has come yet: the work is still reading. Call learn_next again, with no answer.`);
    return text(`${saved}The work is done: the cache holds ${s.list().length} notes. Stop.`);
  })];
}

if (setUp || late) registerTools();
// unbound in a desktop app: the queue tools are listed from the start (registerQueueTools)
if (late) registerQueueTools();

// Started outside a repository: a client that declares roots (a workspace) is asked for them, and
// the first root that is a git repository binds the server. connect() only starts the transport;
// capabilities are available after the client completes initialization.
if (late) server.server.oninitialized = async () => {
  try {
    if (server.server.getClientCapabilities()?.roots) {
      const { roots = [] } = await server.server.listRoots();
      for (const root of roots) {
        const r = checkoutOf(root.uri);
        if (!r || isDisabledRepo(r) || store) continue;
        binding = bind(r); await binding;
        registerCoverageTool(); registerHarnessTool(); registerQueueTools();
        break;
      }
    }
  } catch {}
};

const transport = new StdioServerTransport();
await server.connect(transport);

// A client wired to this server alone (no hooks) never runs the CLI, which is where updates and reports
// start when the OS has no scheduler (containers: no cron, no systemd user manager). Check at start and
// hourly while the session lasts; the stamps keep it to one update check per 4 hours and one report an hour,
// and mcp.js restarts this server on the new code once an update lands.
const upkeep = () => {
  try { maybeCheckDailyUpdateInBackground(); } catch {}
  try { maybeSendTelemetryInBackground({ store: store || undefined }); } catch {}
};
upkeep();
setInterval(upkeep, HOUR_MS).unref();
