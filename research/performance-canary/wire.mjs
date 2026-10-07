// Wire one task checkout for the `thinker` arm through the product's own installClient, so the arm
// receives the shipped guidance (src/cache-guidance.js) instead of a transcription of it. Nothing
// machine-wide is written: Claude Code is wired at repo scope inside the checkout, Codex's MCP entry
// goes to the run's own CODEX_HOME. Repo scope also keeps the prompt hook alive, since test mode
// silences user-scope hooks alone (src/commands/hooks.js:38).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installClient, wiringFiles, trustCodex } from '../../src/clients.js';
import { cacheInstructions, agentWorkflow, CACHE_USAGE_GUIDE } from '../../src/cache-guidance.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const [client, repo, receipt] = process.argv.slice(2);
if (!['claude', 'codex'].includes(client)) throw new Error('wire.mjs claude|codex <checkout> <receipt.json>');
if (process.env.THINKER_TEST !== '1') throw new Error('THINKER_TEST=1 required');
if (!path.isAbsolute(repo) || !fs.existsSync(path.join(repo, '.thinker'))) throw new Error(`No mined cache in ${repo}`);
if (client === 'codex' && !process.env.CODEX_HOME) throw new Error('CODEX_HOME must be the run-local Codex home');

const cli = path.join(ROOT, 'src/cli.js');
// The repo-scope entry the product writes: this copy's server, pinned at the task checkout.
const mcpEntry = { command: 'node', args: [path.join(ROOT, 'src/mcp.js')], env: { THINKER_REPO: repo } };
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const done = [];

// late notes on, learning left to the product's own THINKER_NO_LEARN handling; nothing shared/committed.
done.push(...installClient(client, { scope: 'repo', repo, cli, mcpEntry, hooks: true, learn: false, late: true, shared: false, mcp: client === 'claude' }));
if (client === 'codex') {
  // Codex ran a project's hooks in `codex exec` only once they were marked reviewed, and reads an
  // MCP server from its own config.toml (AGENTS.md: "What Codex stores as trust").
  done.push(...installClient('codex', { scope: 'user', cli, mcpEntry, hooks: false, learn: false, late: false, mcp: true }));
  done.push(...trustCodex(repo));
}

// Codex's two scopes name the same keys (hooks, toml), so they are recorded under separate labels.
const label = (scope, entries) => Object.entries(entries).map(([k, f]) => [`${scope}.${k}`, f]);
const written = Object.fromEntries(label('repo', wiringFiles(client, { scope: 'repo', repo }))
  .concat(client === 'codex' ? label('user', wiringFiles('codex', { scope: 'user' })) : [])
  .filter(([, f]) => f && fs.existsSync(f)).map(([k, f]) => [k, { path: f, sha256: sha(f) }]));

fs.writeFileSync(receipt, JSON.stringify({
  client, repo, scope: 'repo', cli, mcpEntry, written, done,
  // What the server hands the host, and the persistent workflow text, as this revision composes them.
  instructions: cacheInstructions({ repo }),
  instructionsSha256: crypto.createHash('sha256').update(cacheInstructions({ repo })).digest('hex'),
  guidanceSha256: sha(path.join(ROOT, 'src/cache-guidance.js')),
  usageGuideSha256: crypto.createHash('sha256').update(CACHE_USAGE_GUIDE).digest('hex'),
  workflowSha256: crypto.createHash('sha256').update(agentWorkflow({ cli, repo })).digest('hex'),
}, null, 2) + '\n');
console.log(JSON.stringify({ receipt, written: Object.keys(written) }));
