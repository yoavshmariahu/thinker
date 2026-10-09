// thinker doctor [--fix] [--json]: is thinker installed and wired correctly on this machine and in
// this checkout? Each check says ok, warn or fail; --fix repairs what thinker can repair itself with
// the steps the installer, `connect` and `rewire` take, and checks again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { thinkerHome, detectInstall, isScheduled } from '../update.js';
import { USER_SCOPE_CLIENTS, detectClients, inferWiring, refreshWiring, pruneInstalls, prunedLines, installClient, trustCodexUser } from '../clients.js';
import { HOOKS } from '../git-hooks.js';
import { gitHookPath } from '../store.js';
import { hasBin } from './shared.js';

const MIN_NODE = 20;
const MARK = { ok: '✓', warn: '!', fail: '✗' };
const realpath = f => { try { return fs.realpathSync(f); } catch { return f; } };

// The line the installer (install.sh:add_to_path) puts in the user's shell startup file.
function pathLine(dir) {
  const shell = path.basename(process.env.SHELL || '');
  const home = os.homedir();
  if (shell === 'zsh') return { rc: path.join(process.env.ZDOTDIR || home, '.zshrc'), line: `export PATH="${dir}:$PATH"` };
  if (shell === 'bash') return { rc: path.join(home, process.platform === 'darwin' ? '.bash_profile' : '.bashrc'), line: `export PATH="${dir}:$PATH"` };
  if (shell === 'fish') return { rc: path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'fish', 'conf.d', 'thinker.fish'), line: `fish_add_path "${dir}"` };
  return null;
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
  const home = thinkerHome();
  const cli = path.join(HERE, 'cli.js');
  const appDir = path.resolve(HERE, '..');
  const install = detectInstall(appDir, home);
  const checks = [];
  const add = (name, status, detail, fix) => checks.push({ name, status, detail, fix });

  // Node
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= MIN_NODE ? 'ok' : 'fail', major >= MIN_NODE ? `v${process.versions.node}` : `v${process.versions.node}; thinker needs Node.js ${MIN_NODE} or newer (https://nodejs.org)`);

  // This copy of thinker
  const where = install.type === 'git' ? `git checkout on ${install.branch || 'detached'}` : `${install.ref || 'main'}`;
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
  if (!found) {
    const pl = fs.existsSync(install.binPath) ? pathLine(binDir) : null;
    const already = pl && fs.existsSync(pl.rc) && fs.readFileSync(pl.rc, 'utf8').includes(pl.line);
    add('PATH', 'warn', already ? `${binDir} is added in ${pl.rc}; open a new terminal` : `\`thinker\` is not on your PATH${fs.existsSync(install.binPath) ? ` (it is in ${binDir})` : ''}`,
      pl && !already ? { what: `add ${binDir} to PATH in ${pl.rc}`, run: () => { fs.mkdirSync(path.dirname(pl.rc), { recursive: true }); fs.appendFileSync(pl.rc, `\n# thinker\n${pl.line}\n`); } } : null);
  } else {
    let text = ''; try { text = fs.readFileSync(found, 'utf8').slice(0, 4000); } catch {}
    const same = realpath(found) === realpath(cli) || text.includes(cli);
    add('PATH', same ? 'ok' : 'warn', same ? found : `\`thinker\` on your PATH (${found}) is another copy than this one (${cli})`);
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
        if (client === 'codex') trustCodexUser();
      },
    });
  }
  if (unwired.length) {
    add('agents', 'fail', `thinker is not wired into ${unwired.join(', ')}`, {
      what: `wire thinker into ${unwired.join(', ')} (as \`thinker connect\` does)`,
      run: () => {
        for (const client of unwired) {
          installClient(client, { scope: 'user', cli, mcpEntry: ctx.userMcpEntry(), hooks: true, learn: learnOn(), late: true, mcp: true });
          if (client === 'codex') trustCodexUser();
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
  else if (!store.exists()) add('repository', 'warn', `not set up in ${repo}: thinker serves nothing here until \`thinker setup\` runs`);
  else {
    let configOk = true;
    const cfg = path.join(store.dir, 'config.json');
    if (fs.existsSync(cfg)) { try { JSON.parse(fs.readFileSync(cfg, 'utf8')); } catch (e) { configOk = false; add('config', 'fail', `${cfg} is not valid JSON: ${e.message}`); } }
    let notes = [], bad = 0;
    try { notes = store.list(); } catch (e) { add('notes', 'fail', e.message); }
    try { for (const f of fs.readdirSync(store.notesDir)) if (f.endsWith('.json')) { try { JSON.parse(fs.readFileSync(path.join(store.notesDir, f), 'utf8')); } catch { bad++; } } } catch {}
    add('repository', 'ok', `set up in ${repo}`);
    add('notes', bad ? 'warn' : 'ok', `${notes.length} note${notes.length === 1 ? '' : 's'}${bad ? `; ${bad} file${bad === 1 ? '' : 's'} in ${store.notesDir} unreadable` : notes.length ? '' : ' (the cache grows from your sessions, or build it with `thinker setup --build`)'}`);
    if (configOk) wiringCheck('checkout wiring', repo, 'repo');
    const gitHooks = HOOKS.filter(h => h !== 'pre-push').filter(h => { const f = gitHookPath(repo, h); return f && fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('# thinker:'); });
    add('git hooks', gitHooks.length ? 'ok' : 'warn', gitHooks.length ? gitHooks.join(', ') : 'none: the cache is not refreshed on commit and merge (`thinker setup` installs them)');
    const mcp = await probeMcp(path.join(HERE, 'mcp.js'), repo);
    add('MCP server', mcp.ok && mcp.tools.length ? 'ok' : 'fail', mcp.ok ? (mcp.tools.length ? `starts; tools: ${mcp.tools.join(', ')}` : 'starts but offers no tools') : `does not start: ${mcp.error}`);
  }

  // The ranking model the hooks choose notes with
  if (!missing.includes('@huggingface/transformers')) {
    const { rankerStatus, fetchRanker } = await import('../dense.js');
    const st = await rankerStatus();
    if (!st.runtime) add('ranker', 'warn', `runtime does not load (${st.error}); notes are ranked by words alone`);
    else if (!st.model) add('ranker', 'warn', `model not fetched; notes are ranked by words alone`, { what: `fetch ${st.modelName} (about 23 MB)`, run: () => fetchRanker() });
    else add('ranker', 'ok', st.modelName);
  }

  // Optional: tree-sitter grammars, scheduled updates
  const { initAst } = await import('../ast.js');
  const ast = await initAst();
  add('tree-sitter', ast.available ? 'ok' : 'warn', ast.available ? ast.grammars.join(', ') : 'off, symbols found by regex (optional: `thinker ast install`)');
  if (install.type !== 'git') add('auto-update', isScheduled(home) ? 'ok' : 'warn', isScheduled(home) ? 'scheduled daily' : 'not scheduled (`thinker update --schedule`)');

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
