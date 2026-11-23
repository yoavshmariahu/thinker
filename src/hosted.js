// thinker's hosted models: a subagent thinker runs itself, in OpenCode, on a model thinker serves.
//
// The delegation trigger (delegate.js) hands a big read to a subagent, and until now the subagent was always
// the host's own, on a model of the person's own provider. This is the other way to run it: thinker starts the
// subagent itself, in OpenCode -- the one harness that takes any OpenAI-compatible endpoint and runs the same
// read-only tools on it -- against thinker's inference endpoint, which relays to open models (DeepInfra) and
// charges the org's credits for what each call cost. The report comes back as the denied call's result, which
// is delegate.js's `report` mode with another runner under it.
//
// **Who may use it: a machine that is logged in.** The key is the fleet's own (`thinker config set api-key`,
// fleet.js:fleetKey); there is no second login and no second key. The endpoint knows the org from the key and
// the org's balance from its books, and answers 402 to an org with none -- which, until credits are granted,
// is every org. So nothing here decides who may spend: the server does, on every call.
//
// **Off by default**, and never a default model: `delegate: { hosted: "<model id>" }` in
// `<THINKER_HOME>/config.json` turns it on for reads, on the model named (an id from the endpoint's
// `GET /v1/models`). No model has been measured as an explorer on real handoffs yet, and an unmeasured strategy
// ships off. The suite run is not sent here at all: it is pinned to a model that was measured on it.
//
// **When it cannot run, the read goes where it went before.** No key, no credits, no `opencode` on the
// machine, a run that failed or timed out: `runHosted` answers `{ error }`, the row says which, and
// delegate.js hands the read to the host's own subagent as if this were off. A person never waits on it
// twice: an org with no credits is asked once in ten minutes (`HOSTED.creditsMs`), not once a read.
//
// **What the run may touch.** It is a private OpenCode server (`--standalone`) with a config directory of its
// own and the project's config switched off, so none of the person's OpenCode plugins, agents, MCP servers or
// providers load -- thinker's own plugin included, and `THINKER_IN_LLM` keeps any hook quiet besides. The one
// agent it has may read, glob and grep; editing, the shell, the web and subagents are denied to it. A small
// open model reading a repository's files is exactly where an instruction planted in a file would land, and
// with no shell and no network tool there is nothing for one to do.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { thinkerHome } from './update.js';
import { fleetKey, redactKey } from './fleet.js';
import { readMachineConfig } from './repo-switch.js';
import { parseModelList } from './providers.js';
import { findBin } from './llm.js';

export const HOSTED = Object.freeze({
  url: 'https://inference.thinker.sh/v1',
  provider: 'thinker',              // the provider's id inside the run's own OpenCode config, nowhere else
  agent: 'thinker-hosted-explore',
  timeoutMs: 2000,                  // the two questions asked of the endpoint before a run: credits, prices
  creditsMs: 10 * 60_000,           // how long an answer about credits stands, a refusal included
  modelsMs: 24 * 3600e3,            // how long the price list stands
});
export const HOSTED_BINS = ['opencode'];
// OpenCode on this machine: on the PATH, or where its own installer puts it. A hook started by a desktop app
// has the app's PATH, which is a login shell's without the lines the installer added to a profile.
export function hostedBin() {
  const found = findBin(HOSTED_BINS);
  if (found) return found;
  const own = path.join(os.homedir(), '.opencode', 'bin', 'opencode');
  try { fs.accessSync(own, fs.constants.X_OK); return own; } catch { return null; }
}

/** The model a read is sent to on thinker's hosted models, or null: `delegate: { hosted: "<id>" | { model } }`. */
export function hostedModel(cfg = {}) {
  const h = cfg.hosted;
  const id = typeof h === 'string' ? h : h && typeof h === 'object' && h.enabled !== false ? h.model : null;
  return typeof id === 'string' && /^[\w.:@/-]{1,120}$/.test(id.trim()) ? id.trim() : null;
}
/** The endpoint's base, `/v1` included. `fleet: { inference }` in the machine config names another (a local one). */
export const hostedUrl = ({ home = thinkerHome() } = {}) => {
  let url = null;
  try { url = readMachineConfig(home).fleet?.inference || null; } catch {}
  return String(url || HOSTED.url).replace(/\/+$/, '');
};

/**
 * Whether the hosted agent could read these files at all: each inside the project, and none an `.env`. The run
 * refuses both (`hostedConfig`), and a report that says "permission denied" is worse than no report, so such
 * a read is never sent: it goes to the host's own subagent.
 */
export function hostedCanRead(files = [], cwd) {
  if (!cwd || !files.length) return false;
  return files.every(f => {
    const rel = path.relative(cwd, path.resolve(cwd, f));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    const base = path.basename(rel);
    return !/^\.env(\..*)?$/.test(base) || base === '.env.example';
  });
}

// What the endpoint last said, kept so a hook does not ask it again on every read.
const stateFile = home => path.join(home, 'state', 'hosted.json');
const readState = home => { try { return JSON.parse(fs.readFileSync(stateFile(home), 'utf8')) || {}; } catch { return {}; } };
function writeState(home, patch) {
  try {
    fs.mkdirSync(path.dirname(stateFile(home)), { recursive: true });
    const tmp = `${stateFile(home)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...readState(home), ...patch }));
    fs.renameSync(tmp, stateFile(home));
  } catch { /* a cache: the next read asks again */ }
}
async function ask(pathname, { key, home, fetchFn = fetch }) {
  const response = await fetchFn(hostedUrl({ home }) + pathname, { headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(HOSTED.timeoutMs) });
  let body = null; try { body = await response.json(); } catch {}
  return { status: response.status, body };
}

/**
 * What the org has left: `{ balance, at }` in dollars, or `{ error }` (`no-key`, `invalid-key`, `unreachable`).
 * An answer stands for `HOSTED.creditsMs`; `fresh` asks now.
 */
export async function hostedCredits({ home = thinkerHome(), env = process.env, now = Date.now(), fetchFn, fresh = false } = {}) {
  const found = fleetKey({ env, home });
  if (!found) return { error: 'no-key' };
  const held = readState(home).credits;
  if (!fresh && held && typeof held.balance === 'number' && now - held.at < HOSTED.creditsMs && now >= held.at) return { ...held, cached: true };
  let answer;
  try { answer = await ask('/credits', { key: found.key, home, fetchFn }); } catch { return { error: 'unreachable' }; }
  if (answer.status === 401) return { error: 'invalid-key' };
  if (answer.status !== 200 || typeof answer.body?.balance_usd !== 'number') return { error: 'unreachable' };
  const credits = { balance: answer.body.balance_usd, granted: answer.body.granted_usd ?? 0, spent: answer.body.spent_usd ?? 0, at: now };
  writeState(home, { credits });
  return credits;
}
/** The models that can be called and what each costs, dollars a million tokens (`providers.js:parseModelList`'s shape). */
export async function hostedModels({ home = thinkerHome(), env = process.env, now = Date.now(), fetchFn } = {}) {
  const held = readState(home).models;
  if (held && held.url === hostedUrl({ home }) && now - held.at < HOSTED.modelsMs && now >= held.at) return held.list;
  const found = fleetKey({ env, home });
  if (!found) return held?.list || {};
  try {
    const answer = await ask('/models', { key: found.key, home, fetchFn });
    if (answer.status !== 200) return held?.list || {};
    const list = parseModelList(answer.body);
    writeState(home, { models: { list, at: now, url: hostedUrl({ home }) } });
    return list;
  } catch { return held?.list || {}; }
}
/**
 * The run's OpenCode config, whole: one provider (the endpoint, under the machine's key), one model, one
 * agent. Written in the shape OpenCode has read since version 1 (`provider.<id>.npm`, `agent.<id>.permission`);
 * 2.2.7 takes it as it is and turns it into its own.
 *
 * The agent is denied everything and then allowed three tools, and that order is the point (checked on the
 * wire against 2.2.7, 2026-11-22). Denying the tools that write was not enough: OpenCode also hands every
 * agent `execute`, a JavaScript runtime with `fetch`, and puts the person's skills in the prompt -- a way
 * out to the network for whatever a file tells a small model to do, and 16k characters of somebody's skills
 * sent upstream on every call. With `*` denied the model is offered `read`, `glob` and `grep`, the prompt is
 * the explorer's own and a few lines of environment, a file outside the project is refused
 * (`external_directory`), and an `.env` is refused as OpenCode's own defaults would have asked about it.
 *
 * The model carries the endpoint's own price for it (`info`, from `hostedModels`), dollars a million tokens,
 * which is what makes the run's cost the harness's to report: OpenCode prices each step from this, as
 * `claude -p` reports a run's `total_cost_usd`, and thinker multiplies nothing itself. What the org is
 * charged is the server's figure either way; this one is for the log's row.
 */
export function hostedConfig({ url, key, model, system, info = {} }) {
  const price = info.price;
  const about = { name: model,
    ...(price ? { cost: { input: price.input, output: price.output, ...(price.cacheRead != null ? { cache_read: price.cacheRead } : {}) } } : {}),
    ...(info.context ? { limit: { context: info.context, output: Math.min(info.context, 32_000) } } : {}) };
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: { [HOSTED.provider]: { npm: '@ai-sdk/openai-compatible', name: 'thinker', options: { baseURL: url, apiKey: key }, models: { [model]: about } } },
    model: `${HOSTED.provider}/${model}`,
    small_model: `${HOSTED.provider}/${model}`,
    agent: { [HOSTED.agent]: { mode: 'primary', description: 'Read-only exploration for thinker, on one of thinker\'s hosted models.', prompt: system,
      permission: { '*': 'deny', read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow' }, glob: 'allow', grep: 'allow' } } },
    share: 'disabled', autoupdate: false,
  };
}

/**
 * What `opencode run --format json` printed, as the run's answer: one JSON event a line (read off 2.2.7:
 * `step_start`, `tool_use`, `text`, `step_finish` with the step's tokens, and `error` with the provider's
 * status -- the endpoint's 402 arrives as `{ type: "provider.quota", status: 402 }`). The report is the text of
 * the last step -- what the model said once it had finished reading -- and the usage and the cost are every
 * step's, added. `cost` is null where OpenCode priced nothing (it was given no price for the model).
 */
export function parseRun(stdout) {
  const usage = { input: 0, output: 0, cacheRead: 0 };
  let sessionId = null, steps = 0, tools = 0, error = null, status = null, text = [], cost = 0;
  for (const line of String(stdout || '').split('\n')) {
    if (!line.startsWith('{')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    sessionId = e.sessionID || sessionId;
    const part = e.part || {};
    if (e.type === 'step_start') text = [];
    else if (e.type === 'text' && typeof part.text === 'string') text.push(part.text);
    else if (e.type === 'tool_use') tools += 1;
    else if (e.type === 'step_finish') {
      steps += 1;
      usage.input += part.tokens?.input || 0; usage.output += (part.tokens?.output || 0) + (part.tokens?.reasoning || 0); usage.cacheRead += part.tokens?.cache?.read || 0;
      cost += typeof part.cost === 'number' ? part.cost : 0;
    } else if (e.type === 'error') {
      error = String(e.error?.message || e.error?.data?.message || e.error?.type || e.error?.name || 'error').slice(0, 300);
      status = Number.isInteger(e.error?.status) ? e.error.status : status;
    }
  }
  return { report: text.join('').trim(), usage, cost: cost > 0 ? cost : null, sessionId, steps, tools, error, status };
}

/**
 * Run one exploration on a hosted model; resolves to `{ report, usage, cost, ms, sessionId, model }` or
 * `{ error, ms }`, as `delegate.js:runSubagent` does. `system` is the explorer's standing instructions.
 */
export async function runHosted({ brief, cwd, cfg = {}, system, env = process.env, home = thinkerHome(), bin, fetchFn, now = Date.now() }) {
  const t0 = Date.now();
  const failed = error => ({ error, ms: Date.now() - t0 });
  const model = hostedModel(cfg);
  if (!model) return failed('no-model');
  const found = fleetKey({ env, home });
  if (!found) return failed('no-key');
  const command = bin || hostedBin();
  if (!command) return failed('no-opencode');
  // the books are the server's; this only saves starting a run the server would refuse on its first call
  const credits = await hostedCredits({ home, env, now, fetchFn });
  if (credits.error) return failed(credits.error);
  if (!(credits.balance > 0)) return failed('no-credits');

  const configDir = path.join(home, 'state', 'hosted-opencode');
  try { fs.mkdirSync(configDir, { recursive: true }); } catch {}
  // the key rides in the run's own environment, inside the config: the same account's processes can read it
  // there, as they can read the 0600 file it came from, and it is written nowhere
  const config = hostedConfig({ url: hostedUrl({ home }), key: found.key, model, system, info: (await hostedModels({ home, env, now, fetchFn }))[model] });
  const args = ['run', '--standalone', '--archived', '--format', 'json', '--agent', HOSTED.agent, '--model', `${HOSTED.provider}/${model}`, '--title', 'thinker: hosted read', brief];
  const ran = await new Promise(resolve => {
    let out = '', err = '', done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    let child;
    try {
      // OpenCode takes its project from $PWD, so both are set (seen 2026-11-15: a subprocess given only `cwd` ran in the parent's)
      child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PWD: cwd, THINKER_IN_LLM: '1', OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_CONFIG_DIR: configDir, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1' } });
    } catch (e) { return finish({ error: `spawn: ${e.message}` }); }
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} finish({ error: 'timeout' }); }, cfg.timeoutMs || 240_000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); finish({ error: `spawn: ${e.message}` }); });
    child.on('close', code => { clearTimeout(timer); finish({ code, out, err }); });
  });
  if (ran.error) return failed(ran.error);
  const run = parseRun(ran.out);
  if (!run.report) {
    const said = redactKey(run.error || (ran.err || ran.out).trim().slice(-300));
    // the balance ran out between the question and the run: remembered, so the next read does not start one
    if (run.status === 402 || /insufficient_credits/.test(said)) { writeState(home, { credits: { balance: 0, at: Date.now() } }); return failed('no-credits'); }
    if (run.status === 401) return failed('invalid-key');
    return failed(`exit ${ran.code}: ${said}`);
  }
  return { report: run.report, usage: { input_tokens: run.usage.input, output_tokens: run.usage.output, cache_read_input_tokens: run.usage.cacheRead },
    ...(run.cost != null ? { cost: run.cost } : {}), ms: Date.now() - t0, sessionId: run.sessionId, model, steps: run.steps, tools: run.tools };
}
