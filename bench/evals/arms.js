// Arms defined as data: another tool run as an arm of an experiment, kept in the evals database
// rather than in a runner's code. A definition says what the agent session is given — MCP servers,
// hooks, system-prompt text, env — and what runs in the worktree before and after each session (an
// index build, its teardown), for the Claude Code runner (bench/run.js --arm-defs). `{cwd}` in any
// string is the session's worktree. A plan records the full definition of every arm it runs, so an
// experiment keeps what its arms were even after a definition changes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BASELINE_ARMS } from './normalize.js';

const NAME = /^[a-z][a-z0-9._-]{0,40}$/;
// the runners' own arms; a defined arm never shadows one
const RESERVED = [...BASELINE_ARMS, 'cache', 'hook', 'live', 'prompt', 'late', 'late+nudge', 'irrelevant', 'naive', 'full', 'thinker', 'after',
  'rerank', 'hook-bm25', 'hook-minilm', 'hook-ce', 'hook-ce1', 'hook-ce2'];
const RUNNERS = ['claude'];
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const strings = (v, what) => { if (!Array.isArray(v) || !v.length || !v.every(x => typeof x === 'string')) throw new Error(`${what} is a non-empty list of strings`); };

function checkStep(st, what) {
  if (st == null) return;
  if (!isObj(st)) throw new Error(`${what} is { command: [...], failIf?, timeoutMs? }`);
  strings(st.command, `${what}.command`);
  if (st.failIf != null) { try { new RegExp(st.failIf); } catch { throw new Error(`${what}.failIf is not a pattern`); } }
}

// Validate and store a definition. Throws with a message the caller shows.
export function defineArm(db, body) {
  const name = String(body.name || '');
  if (!NAME.test(name)) throw new Error('name: lowercase letters, digits, . _ -');
  if (RESERVED.includes(name)) throw new Error(`${name} is one of the runners' own arms`);
  const runner = String(body.runner || 'claude');
  if (!RUNNERS.includes(runner)) throw new Error(`defined arms run on ${RUNNERS.join(', ')} only`);
  const description = String(body.description || '').trim();
  if (!description) throw new Error('say what the arm is');
  if (typeof body.notes !== 'boolean') throw new Error("notes: true when the arm is served thinker's notes, false otherwise");
  for (const k of ['mcpServers', 'hooks', 'env']) if (body[k] != null && !isObj(body[k])) throw new Error(`${k} is an object`);
  if (body.env && !Object.values(body.env).every(v => typeof v === 'string')) throw new Error('env values are strings');
  if (body.system != null && typeof body.system !== 'string') throw new Error('system is text');
  if (body.exclude != null) strings(body.exclude, 'exclude');
  checkStep(body.before, 'before'); checkStep(body.after, 'after');
  const def = { description, notes: body.notes, mcpServers: body.mcpServers || {}, hooks: body.hooks || null, system: body.system || null,
    env: body.env || {}, before: body.before || null, after: body.after || null, exclude: body.exclude || [] };
  const arm = { name, runner, def, hash: createHash('sha256').update(JSON.stringify(def)).digest('hex').slice(0, 16), created_at: Date.now() };
  db.putArm(arm);
  return arm;
}

export const readArm = (db, name) => db.getArm(name);
export const listArms = db => db.listArms();

// Where a launched experiment's arm definitions are handed to the runner.
export const armDefsFile = (benchDir, tag) => path.join(benchDir, 'runs', tag, 'arm-defs.json');
export function writeArmDefs(benchDir, tag, defs) {
  const f = armDefsFile(benchDir, tag);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(defs, null, 2) + '\n');
  return f;
}
