#!/usr/bin/env node
// MCP server for thinker's own questions to the agent and the desktop app's learning queue (the notes go through the prompt hook). Started by mcp.js, which restarts it on the new code after an update.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, findRepoRoot } from './store.js';
import { ensureTelemetryScheduled, reportTelemetrySchedule } from './telemetry-schedule.js';
import { maybeCheckDailyUpdateInBackground } from './update.js';
import { maybeSendTelemetryInBackground, HOUR_MS } from './telemetry.js';
import { isDisabledRepo } from './repo-switch.js';
import { coveragePending, answerCoverage } from './coverage.js';
import { contextSuggestAwaiting, answerContextSuggestion } from './context-suggest.js';
import { queueDir, buildRunning, nextRequest, answerRequest, requestText } from './session-llm.js';
import { anyDesktopApp } from './app-host.js';

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
// `thinker mcp --enable <tools>` (an experiment arm's command) is still accepted: there are no agent tools to enable.
const pinned = process.env.THINKER_REPO;
let repo = pinned ? findRepoRoot(pinned) : checkoutOf(process.cwd()) || checkoutOf(process.env.CLAUDE_PROJECT_DIR);
// THINKER_MCP=off: the server starts but offers no tools and no instructions. For control arms of a
// benchmark when the agent's MCP registration is machine-wide and cannot be left out for one run.
// A repository switched off machine-wide (repo-switch.js) is served the same way: no tools, no notes.
const switchedOff = !!repo && isDisabledRepo(repo);
const off = process.env.THINKER_MCP === 'off' || switchedOff;
// Every git repository has a cache: a machine-wide registration starts one (empty, growing from the
// sessions) in the checkout the client runs in. Started outside one, the server binds late: to the
// repository of each call that names a directory in it (its `cwd`, or an absolute `file`).
let store = null, setUp = false;
const late = !off && !repo;
const stores = new Map();
function storeFor(r) {
  let s = stores.get(r);
  if (!s) { s = new Store(r); s.init(); stores.set(r, s); }
  return s;
}
async function bind(r) {
  repo = r; store = storeFor(r); setUp = true;
}
if (!off && repo) await bind(repo);

const server = new McpServer({ name: 'thinker', version: '0.1.0' }, switchedOff ? {
  instructions: 'thinker is switched off for this repository and serves nothing here.',
} : {});

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
    registerCoverageTool(); registerQueueTools();
    return { bound: true };
  }
  if (store) return { bound: false };
  return { reply: text('thinker is not bound to a repository yet: it was started outside a git checkout. Call again with cwd, the absolute path of your working directory.') };
}

const text = s => ({ content: [{ type: 'text', text: s }] });

const clientName = () => server.server.getClientVersion()?.name || 'mcp';

// The agent's own tools (orient, lookup, find, drilldown, remember, behavior, feedback) were taken out on
// 2026-10-22, at the owner's decision: the notes reach the agent through the prompt hook, and real sessions
// rarely called the tools (AGENTS.md, Serving). What is left answers thinker's own questions (the weekly context
// suggestion, coverage) and works the desktop app's learning queue (learn_next), each offered only while it has
// something to do.
function registerTools() {
  registerContextTool();
  registerCoverageTool();
  registerQueueTools();
}

// The answer to the weekly context suggestion (context-suggest.js:contextSuggestOffer): offered only while one waits
// for its answer here, like the coverage tool, and the way the harness question was answered until 2026-10-25. The
// agent asks the person with its own question tool and hands in what they chose; thinker resolves the numbers against
// the list it showed and makes the changes, so nothing depends on the agent composing a command line, and the answer
// is recorded whichever way it goes.
let contextTool;
function registerContextTool() {
  if (contextTool || !store || !contextSuggestAwaiting(store)) return;
  contextTool = server.registerTool('context', {
    title: 'Answer a context suggestion',
    description: 'Only when a thinker-context-suggestions notice tells you to: records the user\'s answer and makes the changes they chose to what loads into every session here.',
    inputSchema: {
      choice: z.string().describe('The numbers of the changes the user chose, comma-separated, as the suggestion listed them (a number may name another action after a colon, e.g. 3:remove); or none'),
      asked: z.enum(['picker', 'chat']).optional().describe('Where the user answered: your question tool (picker) or chat'),
      ...(late ? { cwd: z.string().optional().describe('Absolute path of the repository') } : {}),
    },
  }, async ({ choice, asked, cwd }) => {
    const { reply } = await ensureBound({ cwd }); if (reply) return reply;
    return text(await answerContextSuggestion(store, String(choice), { client: clientName(), asked: asked === 'chat' ? 'chat' : 'picker' }));
  });
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
        registerCoverageTool(); registerQueueTools();
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
