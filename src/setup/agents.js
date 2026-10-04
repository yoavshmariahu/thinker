// The agent CLIs a cache can be built through: which are installed, whether they are logged in,
// and the menu that picks one.
import path from 'node:path';
import readlinePromises from 'node:readline/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { available, findBin, BINS } from '../llm.js';
import { c, selectMenu } from './ui.js';

export const hasBin = b => {
  try { execFileSync(b, ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
};

export function githubSlug(repo) {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
    return m ? m[1] : null;
  } catch { return null; }
}

// the agent that explores: THINKER_LLM if set, else first available
export function exploreAgent() {
  const agents = available().filter(p => ['claude', 'gemini', 'codex', 'cursor'].includes(p));
  return agents.includes(process.env.THINKER_LLM) ? process.env.THINKER_LLM : agents[0] || null;
}


// --- Agent Tools & Auth Verification -----------------------------------------

export const BUILD_AGENTS = ['claude', 'gemini', 'codex', 'cursor'];

export function getAgentDisplayName(agent, bin = null) {
  if (agent === 'claude') return 'Claude Code';
  if (agent === 'codex') return 'Codex CLI';
  if (agent === 'cursor') return 'Cursor Agent';
  if (agent === 'gemini') {
    if (bin && path.basename(bin) === 'agy') return 'Antigravity (agy)';
    return 'Gemini CLI';
  }
  return agent;
}

export function getAgentLoginCommand(agent, bin = null) {
  if (agent === 'claude') return 'claude auth login';
  if (agent === 'codex') return 'codex login';
  if (agent === 'cursor') return `${bin ? path.basename(bin) : 'agent'} login`;
  if (agent === 'gemini') {
    if (bin && path.basename(bin) === 'agy') return 'agy';
    return 'gemini';
  }
  return `${agent} login`;
}

export function getAgentLoginArgs(agent, bin = null) {
  if (agent === 'claude') return [bin || 'claude', 'auth', 'login'];
  if (agent === 'codex') return [bin || 'codex', 'login'];
  if (agent === 'cursor') return [bin || 'agent', 'login'];
  if (agent === 'gemini') {
    if (bin && path.basename(bin) === 'agy') return [bin || 'agy'];
    return [bin || 'gemini'];
  }
  return [bin || agent, 'login'];
}

export function checkAgentAuth(agent, { timeout = 5000, env = process.env, spawnFn = spawnSync } = {}) {
  const bin = findBin(BINS[agent] || [agent]);
  if (!bin) {
    return {
      agent,
      installed: false,
      authenticated: false,
      details: 'Binary not found',
      loginCmd: getAgentLoginCommand(agent),
    };
  }

  const loginCmd = getAgentLoginCommand(agent, bin);
  const opts = { encoding: 'utf8', timeout, env: { ...env, THINKER_IN_LLM: '1' } };

  try {
    if (agent === 'claude') {
      const r = spawnFn(bin, ['auth', 'status'], opts);
      if (r.error && r.error.code === 'ETIMEDOUT') {
        return { agent, installed: true, authenticated: false, details: 'Auth check timed out', loginCmd };
      }
      const output = ((r.stdout || '') + (r.stderr || '')).trim();
      try {
        const j = JSON.parse(r.stdout || output);
        if (j.loggedIn === true) {
          const account = j.email || j.orgName || null;
          return {
            agent,
            installed: true,
            authenticated: true,
            account,
            details: account ? `Signed in as ${account}` : 'Signed in',
            loginCmd,
          };
        } else if (j.loggedIn === false) {
          return {
            agent,
            installed: true,
            authenticated: false,
            details: 'Not signed in',
            loginCmd,
          };
        }
      } catch {}

      if (output.includes('"loggedIn":true') || output.includes('"loggedIn": true')) {
        return { agent, installed: true, authenticated: true, details: 'Signed in', loginCmd };
      }
      if (output.includes('"loggedIn":false') || output.includes('"loggedIn": false') || output.toLowerCase().includes('not logged in')) {
        return { agent, installed: true, authenticated: false, details: 'Not signed in', loginCmd };
      }
      if (r.status === 0 && !output.toLowerCase().includes('error')) {
        return { agent, installed: true, authenticated: true, details: 'Signed in', loginCmd };
      }
      return { agent, installed: true, authenticated: false, details: output || 'Not signed in', loginCmd };
    }

    if (agent === 'codex') {
      const r = spawnFn(bin, ['login', 'status'], opts);
      if (r.error && r.error.code === 'ETIMEDOUT') {
        return { agent, installed: true, authenticated: false, details: 'Auth check timed out', loginCmd };
      }
      const output = ((r.stdout || '') + (r.stderr || '')).trim();
      if (output.toLowerCase().includes('not logged in')) {
        return { agent, installed: true, authenticated: false, details: 'Not signed in', loginCmd };
      }
      if (output.toLowerCase().includes('logged in')) {
        return { agent, installed: true, authenticated: true, details: output, loginCmd };
      }
      if (r.status === 0 && !output.toLowerCase().includes('error')) {
        return { agent, installed: true, authenticated: true, details: output || 'Signed in', loginCmd };
      }
      return { agent, installed: true, authenticated: false, details: output || 'Not signed in', loginCmd };
    }

    if (agent === 'cursor') {
      const r = spawnFn(bin, ['status', '--format', 'json'], opts);
      if (r.error && r.error.code === 'ETIMEDOUT') {
        return { agent, installed: true, authenticated: false, details: 'Auth check timed out', loginCmd };
      }
      const output = ((r.stdout || '') + (r.stderr || '')).trim();
      try {
        const j = JSON.parse(r.stdout || output);
        if (j.isAuthenticated === true || j.status === 'authenticated') {
          const account = j.userInfo?.email || null;
          return {
            agent,
            installed: true,
            authenticated: true,
            account,
            details: account ? `Signed in as ${account}` : 'Signed in',
            loginCmd,
          };
        }
        if (j.isAuthenticated === false || j.status === 'unauthenticated') {
          return { agent, installed: true, authenticated: false, details: 'Not signed in', loginCmd };
        }
      } catch {}

      if (output.toLowerCase().includes('logged in as') || output.toLowerCase().includes('authenticated')) {
        return { agent, installed: true, authenticated: true, details: output, loginCmd };
      }
      if (output.toLowerCase().includes('not logged in')) {
        return { agent, installed: true, authenticated: false, details: 'Not signed in', loginCmd };
      }
      if (r.status === 0 && !output.toLowerCase().includes('error')) {
        return { agent, installed: true, authenticated: true, details: output || 'Signed in', loginCmd };
      }
      return { agent, installed: true, authenticated: false, details: output || 'Not signed in', loginCmd };
    }

    if (agent === 'gemini') {
      if (env.GEMINI_API_KEY) {
        return { agent, installed: true, authenticated: true, details: 'GEMINI_API_KEY set', loginCmd };
      }
      if (path.basename(bin) === 'agy') {
        const r = spawnFn(bin, ['models'], { ...opts, input: '' });
        if (r.error && r.error.code === 'ETIMEDOUT') {
          return { agent, installed: true, authenticated: false, details: 'Auth check timed out', loginCmd };
        }
        const output = ((r.stdout || '') + (r.stderr || '')).trim();
        if (output.includes('Please sign in') || output.includes('Error: Please sign in')) {
          return { agent, installed: true, authenticated: false, details: 'Not signed in', loginCmd };
        }
        if (r.status === 0 && (output.includes('gemini-') || output.includes('models'))) {
          return { agent, installed: true, authenticated: true, details: 'Signed in', loginCmd };
        }
        return { agent, installed: true, authenticated: false, details: output || 'Not signed in', loginCmd };
      } else {
        const r = spawnFn(bin, ['--version'], opts);
        if (r.status === 0) {
          return { agent, installed: true, authenticated: true, details: 'CLI detected', loginCmd };
        }
        return { agent, installed: true, authenticated: false, details: 'CLI error', loginCmd };
      }
    }
  } catch (err) {
    return {
      agent,
      installed: true,
      authenticated: false,
      details: err.message,
      loginCmd,
    };
  }

  return { agent, installed: true, authenticated: false, details: 'Unknown status', loginCmd };
}


export async function selectAndAuthenticateAgent({
  requestedAgent = null,
  clients = [],
  yes = false,
  out = console.log,
  checkAuthFn = checkAgentAuth,
  execFileFn = execFileSync,
  readlineFn = null,
  stdin = process.stdin,
  stdout = process.stdout,
  purpose = 'build the knowledge cache',
  actionName = 'subsystem exploration',
  allowSkip = false,
} = {}) {
  const installedAgents = BUILD_AGENTS.filter(ag => Boolean(findBin(BINS[ag] || [])));
  const isInteractive = !yes && (Boolean(readlineFn) || Boolean(stdin && stdin.isTTY));

  let selectedAgent = requestedAgent;

  if (selectedAgent) {
    const bin = findBin(BINS[selectedAgent] || []);
    if (!bin && !['anthropic', 'command'].includes(selectedAgent)) {
      out(`  ${c.red('✖')} Requested agent "${selectedAgent}" is not installed on this system.`);
      return { ok: false, agent: selectedAgent, error: 'not_installed' };
    }
  } else if (installedAgents.length === 0) {
    out(`  ${c.red('✖')} ${c.bold('No supported agent CLI found')} (claude, gemini, codex, cursor).`);
    out(`    Install at least one agent CLI to ${purpose}.\n`);
    return { ok: false, agent: null, error: 'no_agent' };
  } else if (installedAgents.length === 1) {
    selectedAgent = installedAgents[0];
    const bin = findBin(BINS[selectedAgent] || []);
    const name = getAgentDisplayName(selectedAgent, bin);
    out(`  ${c.cyan('•')} Using detected agent: ${c.bold(name)} (${selectedAgent})`);
  } else {
    // Multiple agents installed: allow user to choose based on tools they have
    const agentStatuses = installedAgents.map(ag => {
      const bin = findBin(BINS[ag] || []);
      const name = getAgentDisplayName(ag, bin);
      const auth = checkAuthFn(ag);
      return { agent: ag, bin, name, auth };
    });

    let defaultIdx = -1;
    if (clients && clients.length === 1 && installedAgents.includes(clients[0])) {
      defaultIdx = agentStatuses.findIndex(s => s.agent === clients[0]);
    }
    if (defaultIdx === -1) {
      const preferred = exploreAgent();
      defaultIdx = agentStatuses.findIndex(s => s.agent === preferred && s.auth.authenticated);
    }
    if (defaultIdx === -1) {
      defaultIdx = agentStatuses.findIndex(s => s.auth.authenticated);
    }
    if (defaultIdx === -1) defaultIdx = 0;

    if (!isInteractive) {
      selectedAgent = agentStatuses[defaultIdx].agent;
      out(`  ${c.cyan('•')} Selected agent: ${c.bold(agentStatuses[defaultIdx].name)} (${selectedAgent})`);
    } else {
      const items = agentStatuses.map((s, idx) => {
        const isDefault = idx === defaultIdx;
        const authTag = s.auth.authenticated
          ? c.green(`Signed in${s.auth.account ? ` (${s.auth.account})` : ''}`)
          : c.yellow('⚠ Not signed in');
        const recTag = isDefault ? c.dim(' [recommended]') : '';
        return {
          label: `${s.name.padEnd(20)} (${s.agent}) · ${authTag}${recTag}`,
          value: s.agent,
          key: String(idx + 1),
          name: s.name,
        };
      });

      const selectedItem = await selectMenu({
        header: `  ${c.bold(`Available agents to ${purpose}:`)}`,
        hint: 'Use ↑/↓ to navigate, Enter to select:',
        items,
        defaultIndex: defaultIdx,
        out,
        readlineFn,
        stdin,
        stdout,
      });

      selectedAgent = selectedItem ? selectedItem.value : agentStatuses[defaultIdx].agent;
      const chosenStatus = agentStatuses.find(s => s.agent === selectedAgent) || agentStatuses[defaultIdx];
      out(`  ${c.cyan('•')} Selected agent: ${c.bold(chosenStatus.name)} (${selectedAgent})\n`);
    }
  }

  // Check authentication for selected agent
  let auth = checkAuthFn(selectedAgent);
  const agentBin = findBin(BINS[selectedAgent] || []);
  const agentName = getAgentDisplayName(selectedAgent, agentBin);

  if (auth.authenticated) {
    out(`  ${c.green('✔')} ${c.bold(agentName)} is authenticated${auth.account ? ` (${auth.account})` : ''}.\n`);
    return { ok: true, agent: selectedAgent };
  }

  // Auth issue detected
  out(`\n  ${c.yellow('⚠')} ${c.bold(agentName)} is not authenticated.`);
  if (auth.details && auth.details !== 'Not signed in') {
    out(`    ${c.dim(auth.details)}`);
  }
  out(`    Sign-in command: ${c.cyan(auth.loginCmd)}\n`);

  if (!isInteractive) {
    if (allowSkip) {
      out(`  ${c.yellow('⚠')} ${agentName} is not signed in. Run '${auth.loginCmd}' to authenticate.`);
      out(`    Proceeding with ${actionName} skipped.\n`);
      return { ok: true, agent: selectedAgent, skipExploration: true, skip: true };
    }
    out(`  ${c.red('✖')} ${c.bold('Authentication required:')} The selected tool (${agentName}) is not signed in.`);
    out(`    Run '${c.cyan(auth.loginCmd)}' to authenticate, or run setup with another tool: thinker setup --agent <agent>\n`);
    return { ok: false, agent: selectedAgent, error: 'unauthenticated', loginCmd: auth.loginCmd };
  }

  // Interactive mode: ask user to sign in
  const rl = readlineFn ? readlineFn() : readlinePromises.createInterface({ input: stdin, output: stdout });
  const askSignIn = await rl.question(`  Would you like to sign in to ${agentName} now? [Y/n] `);
  rl.close();

  if (!/^n/i.test(askSignIn.trim())) {
    out(`\n  Launching: ${c.cyan(auth.loginCmd)} ...\n`);
    const loginArgs = getAgentLoginArgs(selectedAgent, agentBin);
    try {
      execFileFn(loginArgs[0], loginArgs.slice(1), { stdio: 'inherit' });
    } catch (err) {
      out(`  ${c.yellow('⚠')} Sign-in process exited: ${err.message}`);
    }

    auth = checkAuthFn(selectedAgent);
    if (auth.authenticated) {
      out(`\n  ${c.green('✔')} Successfully authenticated with ${c.bold(agentName)}!\n`);
      return { ok: true, agent: selectedAgent };
    } else {
      out(`\n  ${c.yellow('⚠')} Authentication still incomplete for ${agentName}.`);
    }
  }

  out(`\n  ${c.red('✖')} The selected tool (${c.bold(agentName)}) could not be authenticated.`);

  const otherAgents = installedAgents.filter(a => a !== selectedAgent);
  if (otherAgents.length > 0) {
    const agentStatuses = otherAgents.map(ag => {
      const aAuth = checkAuthFn(ag);
      const name = getAgentDisplayName(ag, findBin(BINS[ag] || []));
      return { agent: ag, name, auth: aAuth };
    });

    const items = [
      ...agentStatuses.map((s, idx) => {
        const authTag = s.auth.authenticated
          ? c.green(`Signed in${s.auth.account ? ` (${s.auth.account})` : ''}`)
          : c.yellow('⚠ Not signed in');
        return {
          label: `${s.name.padEnd(20)} (${s.agent}) · ${authTag}`,
          value: { action: 'switch', agent: s.agent },
          key: String(idx + 1),
          name: s.name,
        };
      }),
    ];

    if (allowSkip) {
      const skipLabel = actionName === 'subsystem exploration' || actionName === 'agent exploration'
        ? 'Proceed without agent exploration'
        : `Proceed without ${actionName}`;
      items.push({
        label: skipLabel,
        value: { action: 'skip' },
        key: 's',
        name: skipLabel,
      });
    }

    items.push({
      label: 'Exit',
      value: { action: 'exit' },
      key: 'e',
      name: 'Exit',
    });

    const selectedItem = await selectMenu({
      header: `\n  ${c.bold('Choose another tool or exit:')}`,
      hint: 'Use ↑/↓ to navigate, Enter to select:',
      items,
      defaultIndex: 0,
      out,
      readlineFn,
      stdin,
      stdout,
    });

    const choice = selectedItem ? selectedItem.value : { action: 'exit' };

    if (choice.action === 'skip') {
      out(`  Proceeding with ${actionName} skipped.\n`);
      return { ok: true, agent: selectedAgent, skipExploration: true, skip: true };
    }

    if (choice.action === 'exit') {
      const pausedPrefix = purpose === 'run the benchmark' ? 'Benchmark paused.' : 'Setup paused.';
      out(`\n  ${c.yellow('○')} ${pausedPrefix} Exit requested by user.\n`);
      return { ok: false, agent: selectedAgent, error: 'cancelled', exit: true };
    }

    if (choice.action === 'switch' && choice.agent) {
      out(`\n  Switched to ${c.bold(getAgentDisplayName(choice.agent))} (${choice.agent}).\n`);
      return selectAndAuthenticateAgent({
        requestedAgent: choice.agent,
        clients,
        yes: false,
        out,
        checkAuthFn,
        execFileFn,
        readlineFn,
        purpose,
        actionName,
        allowSkip,
        stdin,
        stdout,
      });
    } else {
      const pausedPrefix = purpose === 'run the benchmark' ? 'Benchmark paused.' : 'Setup paused.';
      out(`\n  ${c.yellow('○')} ${pausedPrefix} Exit requested by user.\n`);
      return { ok: false, agent: selectedAgent, error: 'cancelled', exit: true };
    }
  }

  if (allowSkip) {
    const rl3 = readlineFn ? readlineFn() : readlinePromises.createInterface({ input: stdin, output: stdout });
    const skipPrompt = actionName === 'subsystem exploration' || actionName === 'agent exploration'
      ? '  Proceed without agent exploration? [Y/n] '
      : `  Proceed without ${actionName}? [Y/n] `;
    const contAns = await rl3.question(skipPrompt);
    rl3.close();
    if (!/^n/i.test(contAns.trim())) {
      out(`  Proceeding with ${actionName} skipped.\n`);
      return { ok: true, agent: selectedAgent, skipExploration: true, skip: true };
    }
  }

  const pausedPrefix = purpose === 'run the benchmark' ? 'Benchmark paused.' : 'Setup paused.';
  const retryCmd = purpose === 'run the benchmark' ? 'thinker benchmark' : 'thinker setup';
  out(`\n  ${c.yellow('○')} ${pausedPrefix} Subsystem exploration requires an authenticated agent (Claude, Gemini/Agy, Codex, Cursor).`);
  out(`    Please sign in with '${c.cyan(auth.loginCmd)}' and run ${c.cyan(retryCmd)} again.`);
  out(`    ${c.dim('Tip: To build a basic cache without agent exploration, use: thinker setup --no-seed')}\n`);
  return { ok: false, agent: selectedAgent, error: 'unauthenticated', loginCmd: auth.loginCmd };
}
