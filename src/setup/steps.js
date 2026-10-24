// The guided setup's one step: wiring the agents' hooks and MCP entries.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { installGitHooks } from '../git-hooks.js';
import { CLIENTS, USER_SCOPE_CLIENTS, detectClients, installClient, removeCursorRule, stripRepoWiring, trustCodex, trustCodexUser, markConnected } from '../clients.js';
import { thinkerHome } from '../update.js';
import { findBin } from '../llm.js';
import { c } from './ui.js';
import { enableProxyService, wiredLines } from '../proxy-service.js';
import { isTestMode } from '../test-mode.js';

// --- Step 1: Connect Harness CLIs --------------------------------------------

// Wire the agents into their own settings (user scope: read in every checkout, and by the desktop
// apps that read no project files), and, when `repo` is given, the checkout's own pieces: git
// hooks, Cursor's rule and Codex's trust in the project. Setup wrote per-checkout files until 2026-10-04; this copy's machine-local
// ones are taken out of the checkout, since the user's now run there.
export async function stepConnectClis({ repo = null, cliPath, mcpEntry, userMcpEntry, clients, hooks = true, learn = true, late = false, mcp = true, gitHook = true, noTrust = false, yes = false, proxy = true, out = console.log, home = thinkerHome() }) {
  const detected = detectClients();
  const targetClients = clients || detected;
  const userEntry = userMcpEntry || { command: mcpEntry.command, args: mcpEntry.args };

  const clientMeta = {
    pi: { name: 'Pi' },
    windsurf: { name: 'Windsurf Cascade' },
    copilot: { name: 'GitHub Copilot CLI' },
    opencode: { name: 'OpenCode' },
    droid: { name: 'Factory Droid' },
    qwen: { name: 'Qwen Code' },
    kiro: { name: 'Kiro CLI' },
    cline: { name: 'Cline' },
    kilo: { name: 'Kilo Code' },
    augment: { name: 'Augment (Auggie)' },
    goose: { name: 'Goose' },
    claude: { name: 'Claude Code', bin: 'claude', desc: 'Anthropic Claude Code CLI' },
    codex: { name: 'OpenAI Codex', bin: 'codex', desc: 'OpenAI Codex CLI' },
    cursor: { name: 'Cursor Agent', bin: 'agent / cursor', desc: 'Cursor Editor & Agent CLI' },
    gemini: { name: 'Gemini / Agy', bin: 'agy / gemini', desc: 'Google Antigravity & Gemini CLI' },
  };

  const results = [];

  for (const client of CLIENTS) {
    const isTarget = targetClients.includes(client);
    const isDetected = detected.includes(client);

    if (!isTarget && !isDetected) {
      continue;
    }

    if (!isTarget && isDetected) {
      results.push({ client, status: 'skipped', detail: 'Omitted from --clients selection' });
      continue;
    }

    // every client is machine-wide since 2026-10-15 (clients.js:USER_SCOPE_CLIENTS); kept for one added later
    if (!USER_SCOPE_CLIENTS.includes(client) && !repo) { results.push({ client, status: 'skipped', detail: 'wired per repository: run thinker setup inside one' }); continue; }
    try {
      const logs = USER_SCOPE_CLIENTS.includes(client)
        ? installClient(client, { scope: 'user', cli: cliPath, mcpEntry: userEntry, hooks, learn, late, mcp })
        : installClient(client, { scope: 'repo', repo, cli: cliPath, mcpEntry, hooks, learn, late, shared: false, mcp });
      if (repo && USER_SCOPE_CLIENTS.includes(client)) {
        const moved = stripRepoWiring(repo, { cli: cliPath, clients: [client] });
        if (moved.length) logs.push(`${(clientMeta[client]?.name || client)}: moved thinker's entries out of ${moved.join(', ')}: they run from your own settings now`);
        if (client === 'cursor') removeCursorRule(repo);
      }

      // Codex runs no hook it has not marked reviewed: the marks are written without asking (the
      // hooks are thinker's own, just installed); --no-trust leaves them to the person
      if (client === 'codex' && (hooks || mcp) && !noTrust) {
        if (repo) trustCodex(repo);
        trustCodexUser();
        logs.push(`Codex: ${repo ? 'project trust & ' : ''}reviewed hook hashes saved in ~/.codex/config.toml`);
      }

      // Special handling for Cursor MCP workspace approval
      if (client === 'cursor' && mcp && repo) {
        const agentBin = findBin(['agent', 'cursor-agent']);
        if (agentBin) {
          try {
            spawnSync(agentBin, ['mcp', 'enable', 'thinker'], { cwd: repo, encoding: 'utf8', timeout: 15_000 });
            logs.push('Cursor: workspace MCP server approved via agent CLI');
          } catch {}
        }
      }

      results.push({ client, status: 'connected', name: clientMeta[client]?.name || client, logs });
    } catch (e) {
      results.push({ client, status: 'error', detail: e.message });
    }
  }

  // offered: the daily rewire wires an agent installed later once (clients.js:connectDetected), and leaves
  // these alone, the ones left unticked here included
  try { markConnected(home, results.filter(r => r.status !== 'error' && USER_SCOPE_CLIENTS.includes(r.client)).map(r => r.client)); } catch {}

  // the context proxy (proxy-service.js): on by default since 2026-10-24; --no-proxy leaves it off, `thinker proxy off` later
  if (proxy && !isTestMode()) {
    try {
      const p = await enableProxyService({ cli: cliPath, home });
      results.push({ client: 'proxy', status: 'connected', name: 'Context proxy', logs: [`old tool results cleared from the context by the API (${p.url}${p.listening === false ? ', not listening yet: the next prompt starts it' : ''})`, ...wiredLines(p.wired, p.url)] });
    } catch (e) { results.push({ client: 'proxy', status: 'error', detail: e.message }); }
  }

  // Display clean CLI connection statuses
  for (const res of results) {
    const meta = clientMeta[res.client];
    const clientLabel = (meta ? meta.name : res.name || res.client).padEnd(20);

    if (res.status === 'connected') {
      out(`  ${c.green('✓')} ${c.bold(clientLabel)} Connected`);
      if (['pi', 'windsurf', 'copilot', 'opencode', 'droid', 'qwen', 'kiro', 'cline', 'kilo', 'augment', 'goose', 'proxy'].includes(res.client)) for (const line of res.logs) out(`    ${line}`);
    } else if (res.status === 'skipped') {
      out(`  ${c.gray('○')} ${c.dim(clientLabel)} ${c.dim(`Skipped · ${res.detail}`)}`);
    } else {
      out(`  ${c.red('✖')} ${c.bold(clientLabel)} ${c.red(`Failed · ${res.detail}`)}`);
    }
  }

  // a hook that is not thinker's is left alone, and said so: the doctor then names the line to add to it
  if (gitHook && repo) installGitHooks(repo, cliPath, learn, l => { if (l.startsWith('skipped git')) out(`  ${c.gray('○')} ${c.dim(`git hook · ${l.replace(/^skipped git /, '')}`)}`); });

  const connectedCount = results.filter(r => r.status === 'connected').length;
  out(`\n  ${c.cyan('Summary:')} ${c.bold(connectedCount)} of ${targetClients.length} selected agents connected.`);
  return results;
}

// Machine-local state in .thinker/ that no checkout should commit.
// The local page, opened once when setup first sets a repository up: a detached `thinker ui --from-setup`
// (commands/cache.js:uiCommand) that opens the browser itself and exits when nobody has used it for a while,
// so setup still finishes and returns the terminal (or the agent's command) at once.
export function openDashboard({ repo, cliPath, spawnFn = spawn }) {
  try {
    spawnFn(process.execPath, [cliPath, 'ui', '--from-setup', '--repo', repo], { cwd: repo, detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}

export function ignoreLocalState(dir) {
  const gi = path.join(dir, '.gitignore');
  const ignored = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const missing = ['log.jsonl', 'state/', 'benchmarks/'].filter(line => !ignored.split('\n').includes(line));
  if (missing.length) fs.writeFileSync(gi, ignored + (ignored && !ignored.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
}
