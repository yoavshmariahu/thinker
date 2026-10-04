#!/usr/bin/env node
// thinker-server: the central cache a team syncs with. See index.js for the API.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { listen } from './index.js';
import { Repos } from './repos.js';
import { Tokens } from './auth.js';
import { provider } from '../llm.js';

const argv = process.argv.slice(2);
const cmd = argv.shift();
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; flags[k] = v; }
  else pos.push(argv[i]);
}
const data = path.resolve(flags.data || process.env.THINKER_SERVER_DATA || path.join(os.homedir(), '.thinker-server'));
const out = s => process.stdout.write(s + '\n');
const HELP = `thinker-server — the central thinker cache for a team

  start [--host h] [--port p] [--data dir]     serve (default 127.0.0.1:8787, data ~/.thinker-server)
  token create <name> [--repos a,b|*] [--scopes read,write]
  token list | token revoke <name>
  repo add <github.com/owner/repo> [--clone url] [--no-fetch]
  repo list | repo fetch <id>

Environment: THINKER_SERVER_DATA, THINKER_SERVER_PORT, THINKER_SERVER_HOST,
  THINKER_SERVER_ADMIN_TOKEN (the token that may do everything; generated into
  <data>/admin-token on first start when unset), THINKER_SERVER_GIT_TOKEN (to clone
  private repositories), THINKER_SERVER_GITHUB_TOKEN (to post pull request reviews;
  pull requests: write; the git token when unset), THINKER_SERVER_GITHUB_API (another
  GitHub API url, e.g. a local fake for testing), ANTHROPIC_API_KEY (the model that
  reviews pull requests; without it the first installed agent CLI with its login:
  claude, codex, gemini, agent), THINKER_SERVER_DAILY_TOKENS (tokens of model usage a day, default 2,000,000).
The server learns nothing itself: sessions are distilled on the checkouts and arrive
here as notes.
Commands other than start work on the data directory directly, so they can be run
beside a running server on the same machine.`;

function adminToken() {
  if (process.env.THINKER_SERVER_ADMIN_TOKEN) return process.env.THINKER_SERVER_ADMIN_TOKEN;
  const f = path.join(data, 'admin-token');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const t = 'tk_' + crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(f, t + '\n', { mode: 0o600 });
  out(`admin token written to ${f}`);
  return t;
}

async function main() {
  switch (cmd) {
    case 'start': {
      if (!process.env.THINKER_LOG) process.env.THINKER_LOG = 'local'; // each repository's model spend in its own log
      const host = flags.host || process.env.THINKER_SERVER_HOST || '127.0.0.1';
      const port = Number(flags.port || process.env.THINKER_SERVER_PORT) || 8787;
      const log = (where, msg) => process.stderr.write(`${new Date().toISOString()} [${where}] ${msg}\n`);
      const s = await listen({ host, port, data, adminToken: adminToken(), log });
      log('server', `listening on http://${host}:${s.address.port}, data in ${data}, ${s.repos.list().length} repositories, review model ${s.worker.hasModel() ? `available (${provider()})` : 'unavailable (set ANTHROPIC_API_KEY or install an agent CLI)'}, reviews ${s.worker.githubToken ? 'posted to GitHub' : 'not posted (set THINKER_SERVER_GITHUB_TOKEN)'}`);
      const stop = () => s.close().then(() => process.exit(0));
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      break;
    }
    case 'token': {
      const tokens = new Tokens(data, { adminToken: null });
      if (pos[0] === 'create') {
        const r = tokens.create({ name: pos[1], repos: flags.repos ? String(flags.repos).split(',').map(s => s.trim()).filter(Boolean) : ['*'], scopes: flags.scopes ? String(flags.scopes).split(',').map(s => s.trim()).filter(Boolean) : ['read', 'write'] });
        out(`token ${r.name} (${r.scopes.join(',')}; repos ${r.repos.join(',')}):\n${r.token}\nShown once. Clients: thinker sync login <url> --token ${r.token}`);
      } else if (pos[0] === 'list') { for (const t of tokens.list()) out(`${t.name.padEnd(24)} ${t.scopes.join(',').padEnd(18)} ${t.repos.join(',')}  created ${t.created.slice(0, 10)}${t.lastUsed ? ` used ${t.lastUsed.slice(0, 10)}` : ''}`); }
      else if (pos[0] === 'revoke') out(tokens.revoke(pos[1]) ? `revoked ${pos[1]}` : `no token named ${pos[1]}`);
      else out(HELP);
      break;
    }
    case 'repo': {
      const repos = new Repos(data);
      if (pos[0] === 'add') {
        const r = repos.get(pos[1], { create: true, clone: typeof flags.clone === 'string' ? flags.clone : undefined });
        if (!r) throw new Error('repository id: github.com/owner/repo');
        if (!flags['no-fetch']) { const f = await r.sync({ token: process.env.THINKER_SERVER_GIT_TOKEN }); out(f.ok ? `cloned ${r.meta().clone} at ${f.head.slice(0, 8)}` : `could not clone ${r.meta().clone}: ${f.error}`); }
        out(`registered ${r.id} in ${r.dir}`);
      } else if (pos[0] === 'list') { for (const r of repos.list()) { const s = r.status(); out(`${s.id.padEnd(44)} seq ${String(s.seq).padEnd(6)} ${s.notes} notes, ${s.pendingReviews} reviews pending, ${s.cloned ? `at ${(s.head || '').slice(0, 8)}` : `not cloned${s.cloneError ? ` (${s.cloneError})` : ''}`}`); } }
      else if (pos[0] === 'fetch') { const r = repos.get(pos[1]); if (!r) throw new Error('unknown repository'); const f = await r.sync({ token: process.env.THINKER_SERVER_GIT_TOKEN }); out(f.ok ? `fetched; head ${f.head.slice(0, 8)}` : `failed: ${f.error}`); }
      else out(HELP);
      break;
    }
    default: out(HELP);
  }
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
