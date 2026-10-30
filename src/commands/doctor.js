// thinker doctor [--fix] [--json]: is thinker installed and wired correctly on this machine and in
// this checkout? Each check says ok, warn or fail; --fix repairs what thinker can repair itself with
// the steps the installer, `connect` and `rewire` take, and checks again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { thinkerHome, detectInstall, isScheduled } from '../update.js';
import { USER_SCOPE_CLIENTS, detectClients, inferWiring, refreshWiring, pruneInstalls, prunedLines, installClient, enableCodexSubagents, staleRepoInstructions, stripRepoWiring } from '../clients.js';
import { HOOKS } from '../git-hooks.js';
import { postCommitHook } from '../maintain.js';
import { gitHookPath } from '../store.js';
import { isTestMode } from '../test-mode.js';
import { hasBin } from './shared.js';
import { addToPath } from '../shell-path.js';
import { anyDesktopApp } from '../app-host.js';
import { recentAppSession, pendingJobs, RUN_EVERY_MS } from '../session-work.js';
import { queueDir, buildRunning, UNCLAIMED_MS, CLAIMED_MS } from '../session-llm.js';
import { repairNotice } from '../environment-repair.js';

const MIN_NODE = 20;
const MARK = { ok: '✓', warn: '!', fail: '✗' };
const realpath = f => { try { return fs.realpathSync(f); } catch { return f; } };

// Read actual app handoff evidence without starting model work or requiring a CLI login.
export function desktopLearningCheck(store, { now = Date.now() } = {}) {
  const dir = queueDir(store), jobs = pendingJobs(store), running = buildRunning(dir);
  let names = []; try { names = fs.readdirSync(dir); } catch {}
  let last = null; try { last = JSON.parse(fs.readFileSync(path.join(dir, 'last-answer.json'), 'utf8')).at; } catch {}
  const receipt = last ? `last app answer: ${last}` : 'no completed app model request recorded yet';
  const requests = names.filter(n => /\.(req|claimed)\.json$/.test(n)).flatMap(n => {
    try { return [{ claimed: n.endsWith('.claimed.json'), age: now - fs.statSync(path.join(dir, n)).mtimeMs }]; } catch { return []; }
  });
  const result = (status, detail) => ({ name: 'desktop learning', status, detail: `${detail}; ${receipt}` });
  if (requests.some(r => r.age >= (r.claimed ? CLAIMED_MS : UNCLAIMED_MS))) {
    return result('fail', 'an app model request has timed out waiting for its subagent; resume an app session in this repository and check .thinker/state/session-work.log');
  }
  const failed = jobs.filter(j => j.lastError);
  if (failed.length) return result('warn', `${failed.length} failed job(s) retained for retry; ${failed[0].lastError}; next attempt after ${failed[0].nextAttemptAt || 'the next app prompt'}`);
  if (!running && requests.length) return result('warn', 'the worker stopped with unanswered model requests; queued jobs resume on a later app prompt');
  if (requests.some(r => !r.claimed)) return result('warn', 'the worker is waiting for an app subagent to take its model request; check that the session started the learn_next loop');
  if (running) return result(last ? 'ok' : 'warn', 'the session worker is running; this does not confirm that a new note was learned');
  if (jobs.length) {
    const oldest = Math.min(...jobs.map(j => Date.parse(j.t)).filter(Number.isFinite));
    return result('warn', `${jobs.length} job(s) waiting${now - oldest > RUN_EVERY_MS ? ' beyond the normal 30-minute interval' : ''}; continue an app session in this repository to run them`);
  }
  return result(last ? 'ok' : 'warn', 'no queued learning jobs; learning runs through an active app session');
}

// Start the MCP server the way an agent does, ask for its tools, and stop it.
function probeMcp(mcpJs, repo, timeoutMs = 20_000) {
  return new Promise(resolve => {
    const p = spawn('node', [mcpJs], { cwd: repo, env: { ...process.env, THINKER_REPO: repo, THINKER_TELEMETRY: 'off' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', err = '', done = false;
    const finish = r => { if (done) return; done = true; clearTimeout(timer); try { p.kill(); } catch {} resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: `no answer in ${timeoutMs / 1000}s${err ? `: ${err.trim().split('\n').pop()}` : ''}` }), timeoutMs);
    const send = m => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => finish({ ok: false, error: e.message }));
    p.on('exit', code => finish({ ok: false, error: `exited with ${code}${err ? `: ${err.trim().split('\n').pop().slice(0, 200)}` : ''}` }));
    p.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          if (m.error) return finish({ ok: false, error: m.error.message });
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/list', params: {} });
        } else if (m.id === 2) finish({ ok: true, tools: (m.result?.tools || []).map(t => t.name) });
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'thinker-doctor', version: '1' } } });
  });
}

async function runChecks(ctx) {
  const { repo, store, HERE, learnOn } = ctx;
  const currentApp = anyDesktopApp();
  const home = thinkerHome();
  const cli = path.join(HERE, 'cli.js');
  const appDir = path.resolve(HERE, '..');
  const install = detectInstall(appDir, home);
  const checks = [];
  const add = (name, status, detail, fix) => checks.push({ name, status, detail, fix });
  const repair = repairNotice(home);
  if (repair) add('update repair', 'fail', repair, {
    what: 'retry environment repair (thinker rewire)',
    run: () => {
      const r = spawnSync(process.execPath, [cli, 'rewire', '--json', '--quiet'], { encoding: 'utf8' });
      if (r.error || r.status !== 0) throw new Error(r.error?.message || r.stderr || `rewire exited ${r.status}`);
    },
  });

  // Node
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= MIN_NODE ? 'ok' : 'fail', major >= MIN_NODE ? `v${process.versions.node}` : `v${process.versions.node}; thinker needs Node.js ${MIN_NODE} or newer (https://nodejs.org)`);

  // This copy of thinker
  const where = install.type === 'git' ? `git checkout on ${install.branch || 'detached'}` : `${install.ref || 'latest'}`;
  add('thinker', 'ok', `${install.version} (${where}${install.commit ? ` ${install.commit.slice(0, 7)}` : ''}) in ${appDir}`);

  // Dependencies: the MCP SDK and zod for the server, the ranking runtime for the hooks
  let deps = {};
  try { deps = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).dependencies || {}; } catch {}
  const missing = Object.keys(deps).filter(d => !fs.existsSync(path.join(appDir, 'node_modules', ...d.split('/'), 'package.json')));
  if (missing.length) {
    const lock = fs.existsSync(path.join(appDir, 'package-lock.json'));
    const args = lock ? ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'] : ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
    add('dependencies', 'fail', `missing in ${appDir}: ${missing.join(', ')}`, hasBin('npm') ? {
      what: `npm ${args.join(' ')} in ${appDir}`,
      run: () => { const r = spawnSync('npm', args, { cwd: appDir, stdio: 'inherit' }); if (r.status !== 0) throw new Error(`npm exited with ${r.status}`); },
    } : null);
  } else add('dependencies', 'ok', `${Object.keys(deps).length} installed`);

  // `thinker` on PATH, and which copy it runs
  const binDir = path.dirname(install.binPath);
  const found = spawnSync('sh', ['-c', 'command -v thinker'], { encoding: 'utf8' }).stdout.trim();
  // the files the installer writes (shell-path.js): the login shell's, and bash's, where agents run commands;
  // a missing line is added, not reported
  const added = fs.existsSync(install.binPath) ? addToPath(binDir) : [];
  const addedNote = added.length ? `; added to PATH in ${added.join(', ')}` : '';
  if (!found) {
    add('PATH', 'warn', fs.existsSync(install.binPath) ? `${binDir} is on PATH in your shell's startup files${addedNote}; open a new terminal` : '`thinker` is not on your PATH');
  } else {
    let text = ''; try { text = fs.readFileSync(found, 'utf8').slice(0, 4000); } catch {}
    const same = realpath(found) === realpath(cli) || text.includes(cli);
    add('PATH', same ? 'ok' : 'warn', same ? `${found}${addedNote}` : `\`thinker\` on your PATH (${found}) is another copy than this one (${cli})`);
  }

  // The agents on this machine: thinker's hooks and MCP server in their own settings
  const detected = detectClients().filter(c => USER_SCOPE_CLIENTS.includes(c));
  const unwired = [];
  for (const client of detected) {
    let w = null; try { w = inferWiring(null, client, { scope: 'user' }); } catch {}
    if (!w || (!w.hooks && !w.mcp)) { unwired.push(client); continue; }
    const parts = [w.hooks && 'hooks', w.mcp && 'MCP server', w.hooks && !w.learn && 'learning off'].filter(Boolean);
    if (w.hooks && w.mcp) { add(`agent ${client}`, 'ok', parts.join(', ')); continue; }
    const lacking = w.hooks ? 'the MCP server is not registered' : 'the hooks are not installed';
    // wired to another copy: that copy's doctor repairs it, so one agent never runs two copies
    const realApp = realpath(appDir) + path.sep;
    const otherCopy = [...w.scripts].find(sc => !realpath(sc).startsWith(realApp));
    if (otherCopy) { add(`agent ${client}`, 'warn', `${parts.join(', ')}; ${lacking} (the wiring runs ${otherCopy}; run its \`doctor --fix\`)`); continue; }
    add(`agent ${client}`, 'warn', `${parts.join(', ')}; ${lacking}`, {
      what: `${w.hooks ? 'register the MCP server' : 'install the hooks'} for ${client}`,
      run: () => {
        installClient(client, { scope: 'user', cli, mcpEntry: ctx.userMcpEntry(), hooks: true, learn: w.hooks ? w.learn : learnOn(), late: w.hooks ? w.late : true, mcp: true });
      },
    });
  }
  // Explicit doctor --fix can enable the subagents desktop cache learning needs; diagnosis never changes settings.
  if (ctx.flags?.fix && detected.includes('codex') && !unwired.includes('codex')) {
    let turned = []; try { turned = enableCodexSubagents(); } catch (e) { add('codex subagents', 'warn', `could not turn them on: ${e.message}`); }
    if (turned.length) add('codex subagents', 'ok', 'turned on ([features] multi_agent = true in ~/.codex/config.toml)');
  }
  if (unwired.length) {
    add('agents', 'fail', `thinker is not wired into ${unwired.join(', ')}`, {
      what: `wire thinker into ${unwired.join(', ')} (as \`thinker connect\` does)`,
      run: () => {
        for (const client of unwired) {
          installClient(client, { scope: 'user', cli, mcpEntry: ctx.userMcpEntry(), hooks: true, learn: learnOn(), late: true, mcp: true });
        }
      },
    });
  }

  // Wiring that runs another copy, a copy that is gone, or an older shape of this one
  const wiringCheck = (label, r, scope) => {
    let probe; try { probe = refreshWiring(r, { scope, cli, mcpEntry: scope === 'user' ? ctx.userMcpEntry() : ctx.mcpEntry(r), dry: true }); } catch (e) { add(label, 'warn', e.message); return; }
    const gone = probe.skipped.filter(s => /no longer there/.test(s.reason));
    const other = probe.skipped.filter(s => !/no longer there/.test(s.reason));
    for (const s of other) add(`${label} ${s.client}`, 'warn', s.reason);
    if (!probe.changed.length && !gone.length) { if (probe.clients.length || scope === 'repo') add(label, 'ok', 'current'); return; }
    const issues = [gone.length && `entries of a thinker copy that is gone (${gone.map(s => s.client).join(', ')})`, probe.changed.length && `out of date: ${probe.changed.join(', ')}`].filter(Boolean);
    add(label, 'fail', issues.join('; '), {
      what: `rewrite ${label === 'wiring' ? 'your agent settings' : 'this checkout\'s wiring'} for this copy`,
      run: () => {
        const pruned = gone.length ? pruneInstalls(r, { scope, cli, mcpEntry: scope === 'user' ? ctx.userMcpEntry() : ctx.mcpEntry(r), olderOnly: true }) : [];
        for (const l of prunedLines(pruned)) ctx.out(`    ${l}`);
        refreshWiring(r, { scope, cli, mcpEntry: scope === 'user' ? ctx.userMcpEntry() : ctx.mcpEntry(r) });
      },
    });
  };
  wiringCheck('wiring', null, 'user');

  // This checkout
  const isGit = fs.existsSync(path.join(repo, '.git'));
  if (!isGit) add('repository', 'warn', `${repo} is not a git repository; run doctor inside one to check its setup`);
  else if (!store.exists()) add('repository', 'ok', `no cache in ${repo} yet: one starts with the first agent session here`);
  else {
    let configOk = true;
    const cfg = path.join(store.dir, 'config.json');
    if (fs.existsSync(cfg)) { try { JSON.parse(fs.readFileSync(cfg, 'utf8')); } catch (e) { configOk = false; add('config', 'fail', `${cfg} is not valid JSON: ${e.message}`); } }
    let notes = [], bad = 0;
    try { notes = store.list(); } catch (e) { add('notes', 'fail', e.message); }
    try { for (const f of fs.readdirSync(store.notesDir)) if (f.endsWith('.json')) { try { JSON.parse(fs.readFileSync(path.join(store.notesDir, f), 'utf8')); } catch { bad++; } } } catch {}
    add('repository', 'ok', `set up in ${repo}`);
    add('notes', bad ? 'warn' : 'ok', `${notes.length} note${notes.length === 1 ? '' : 's'}${bad ? `; ${bad} file${bad === 1 ? '' : 's'} in ${store.notesDir} unreadable` : notes.length ? '' : ' (the cache grows from your sessions)'}`);
    if (configOk) wiringCheck('checkout wiring', repo, 'repo');
    // the checkout's own CLAUDE.local.md still carries a workflow block the user's CLAUDE.md also carries
    const twice = staleRepoInstructions(repo);
    if (twice.length) add('instructions', 'fail', `${twice.map(f => path.relative(repo, f)).join(', ')} repeats thinker's workflow from your CLAUDE.md in an older text`, { what: 'take the checkout\'s copy out', run: () => stripRepoWiring(repo, { cli, clients: ['claude'] }) });
    // The hooks thinker installs (post-commit, post-merge). A hook that is not thinker's (git-lfs, husky,
    // a tracked core.hooksPath directory) is left alone by setup, so the advice is then to chain
    // thinker's line into it, not to run setup again.
    const ours = [], foreign = [];
    for (const h of HOOKS.filter(h => h !== 'pre-push' && h !== 'pre-commit')) {
      const f = gitHookPath(repo, h);
      if (f && fs.existsSync(f)) (fs.readFileSync(f, 'utf8').includes('# thinker:') ? ours : foreign).push({ h, f });
    }
    if (ours.length) add('git hooks', 'ok', ours.map(x => x.h).join(', '));
    else if (foreign.length) {
      const hooksPath = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const line = postCommitHook(cli, repo, learnOn()).split('\n').find(l => l.startsWith('nohup'));
      add('git hooks', 'warn', `the ${foreign.map(x => `${x.h} hook at ${x.f}`).join(' and ')} ${foreign.length === 1 ? 'is' : 'are'} not thinker's${hooksPath ? ` (core.hooksPath=${hooksPath})` : ''}, and setup leaves such hooks alone; to refresh the cache after commits, add this line to the post-commit hook: ${line}`);
    } else add('git hooks', 'warn', 'none: the cache is not refreshed on commit and merge (`thinker setup` installs them)');
    const mcp = await probeMcp(path.join(HERE, 'mcp.js'), repo);
    // no tools is how it starts outside a desktop app since 2026-10-22: the agent's tools went, and the rest are offered while they have work
    add('MCP server', mcp.ok ? 'ok' : 'fail', mcp.ok ? `starts${mcp.tools.length ? `; tools: ${mcp.tools.join(', ')}` : ''}` : `does not start: ${mcp.error}`);
    if (currentApp && mcp.ok && !mcp.tools.includes('learn_next')) {
      add('desktop queue tools', 'fail', 'the MCP server does not offer learn_next in this app; reconnect thinker and restart the host before learning can run');
    }
  }

  // The ranking model the hooks choose notes with
  if (!missing.includes('@huggingface/transformers')) {
    const { rankerStatus, fetchRanker } = await import('../dense.js');
    const st = await rankerStatus();
    if (!st.runtime) add('ranker', 'warn', `runtime does not load (${st.error}); notes are ranked by words alone`);
    else if (!st.model) add('ranker', 'warn', `model not fetched; notes are ranked by words alone`, { what: `fetch ${st.modelName} (about 23 MB)`, run: () => fetchRanker() });
    else add('ranker', 'ok', st.modelName);
  }

  // The model behind distilling, verifying, PR mining and skills: which provider answers first, and
  // whether it does (a short call, with the fallback off so the answer is about that provider). Under
  // test the call is made only when THINKER_LLM names the provider.
  const app = currentApp || recentAppSession(store);
  if (app) {
    add('model', 'ok', `${app}: background learning uses the app session via learn_next; no CLI login or model probe required`);
    if (ctx.NO_LEARN || !ctx.sessionLearning()) add('desktop learning', 'warn', 'learning from sessions is disabled');
    else checks.push(desktopLearningCheck(store));
  } else {
    const llm = await import('../llm.js');
    const have = llm.available();
    if (!have.length) add('model', 'warn', 'none: install the claude, codex, gemini or cursor CLI, or set THINKER_LLM_BASE_URL (an OpenAI-compatible endpoint), ANTHROPIC_API_KEY or THINKER_LLM_CMD; distilling, verifying and PR mining need one');
    else {
      let order = [];
      try { order = llm.getFallbackOrder(); } catch (e) { add('model', 'fail', e.message); }
      if (order.length) {
        const p = order[0];
        const then = order.length > 1 ? `, then ${order.slice(1).join(', ')}` : '';
        if (isTestMode() && !process.env.THINKER_LLM) add('model', 'ok', `${p}${then} (not probed under test)`);
        else {
          const saved = { THINKER_LLM: process.env.THINKER_LLM, THINKER_QUIET: process.env.THINKER_QUIET };
          process.env.THINKER_LLM = p; process.env.THINKER_QUIET = '1';
          const t0 = Date.now();
          try {
            const r = await llm.complete({ prompt: 'Reply with the single word ok and nothing else.', model: 'haiku', maxTokens: 20, timeoutMs: 90_000 });
            add('model', 'ok', `${p} answers (${r.model || p}, ${((Date.now() - t0) / 1000).toFixed(1)}s)${then}`);
          } catch (e) {
            add('model', 'fail', `${p} does not answer: ${String(e.message || e).replace(/\s+/g, ' ').slice(0, 220)}${then ? `; a model call would then try ${order.slice(1).join(', ')}` : ''}`);
          } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
        }
      }
    }
  }

  // The parser comes with the dependencies; scheduled updates are optional
  const { initAst } = await import('../ast.js');
  const ast = await initAst();
  add('tree-sitter', ast.available ? 'ok' : 'warn', ast.available ? ast.grammars.join(', ') : process.env.THINKER_AST === 'off' ? 'off (THINKER_AST=off), symbols found by regex' : `not loaded${ast.error ? ` (${ast.error})` : ''}, symbols found by regex (\`thinker ast install\`)`);
  if (install.type !== 'git') add('auto-update', isScheduled(home) ? 'ok' : 'warn', isScheduled(home) ? 'scheduled every 4 hours' : 'not scheduled (`thinker update --schedule`)');

  return checks;
}

async function doctorCommand(ctx) {
  const { flags, out } = ctx;
  // with --json the repairs are told on stderr, so stdout stays one JSON document
  const say = flags.json ? s => process.stderr.write(s + '\n') : out;
  ctx = { ...ctx, out: say };
  let checks = await runChecks(ctx);
  // one repair can show the next (taking out a gone copy's entries leaves the agent without hooks;
  // wiring cursor leaves the checkout's rule behind), so fix and check again, a few rounds at most
  for (let round = 0; flags.fix && round < 3; round++) {
    const fixable = checks.filter(c => c.status !== 'ok' && c.fix);
    if (!fixable.length) break;
    for (const c of fixable) {
      say(`fixing ${c.name}: ${c.fix.what}`);
      try { await c.fix.run(); } catch (e) { say(`  failed: ${e.message}`); }
    }
    checks = await runChecks(ctx);
  }
  if (flags.fix) say('');
  if (flags.json) { out(JSON.stringify(checks.map(({ fix, ...c }) => ({ ...c, fixable: !!fix })), null, 2)); }
  else {
    out('thinker doctor\n');
    const w = Math.max(...checks.map(c => c.name.length));
    for (const c of checks) out(`  ${MARK[c.status]} ${c.name.padEnd(w)}  ${c.detail}${c.status !== 'ok' && c.fix && !flags.fix ? '  [--fix]' : ''}`);
    const fails = checks.filter(c => c.status === 'fail').length, warns = checks.filter(c => c.status === 'warn').length;
    const fixable = checks.filter(c => c.status !== 'ok' && c.fix).length;
    out('');
    if (!fails && !warns) out('everything is in place.');
    else out(`${fails} problem${fails === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}${fixable && !flags.fix ? `; run \`thinker doctor --fix\` to repair ${fixable === 1 ? 'the one marked [--fix]' : `the ${fixable} marked [--fix]`}` : ''}.`);
  }
  if (checks.some(c => c.status === 'fail')) process.exitCode = 1;
}

export const commands = { doctor: doctorCommand };
