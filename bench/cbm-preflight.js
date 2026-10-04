#!/usr/bin/env node
// Checks the codebase-memory-mcp arm before a paid comparison, with no model calls: the binary
// starts as an MCP server, the repository is indexed, and the graph answers the tool calls the
// agent would make. Also checks that thinker's own engine sees the same index (the `both` arm).
//
//   THINKER_TELEMETRY=off node bench/cbm-preflight.js [path-to-repo] [--symbol Name] [--reindex]
//
// Default repository: bench/repos/posthog-base, else this checkout.
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT, cbmBinary, ensureIndexed } from './cbm-arms.js';
import { cbmProject } from './eval-support/cbm.js';
import { fanout, references, outline } from '../src/codegraph.js';

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
const posthog = path.join(ROOT, 'bench/repos/posthog-base');
const REPO = path.resolve(args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--symbol') || (fs.existsSync(posthog) ? posthog : ROOT));
const SYMBOL = flag('symbol') || (REPO === posthog ? 'OrganizationInvite' : 'hashDep');

const bin = cbmBinary();
console.log(`binary: ${bin}`);
const project = ensureIndexed(REPO, { force: args.includes('--reindex') });
console.log(`project: ${project} (${REPO})`);

const transport = new StdioClientTransport({ command: bin, args: [], stderr: 'pipe' });
let stderr = ''; transport.stderr?.on('data', b => { stderr += b; });
const client = new Client({ name: 'cbm-preflight', version: '1' });
const start = Date.now();
const call = async (name, a) => { const t = Date.now(); const r = await client.callTool({ name, arguments: { format: 'json', ...a } }); const text = r.content?.[0]?.text || ''; console.log(`${name} (${Date.now() - t} ms): ${text.slice(0, 300).replace(/\n/g, ' ')}${text.length > 300 ? '…' : ''}`); return text; };
try {
  await client.connect(transport, { timeout: 30000 });
  const listing = await client.listTools();
  console.log(`connected in ${Date.now() - start} ms; ${listing.tools.length} tools: ${listing.tools.map(t => t.name).join(', ')}`);
  const found = JSON.parse(await call('search_graph', { project, name_pattern: `^${SYMBOL}$`, limit: 5 }));
  const first = found.groups?.[0]; const qn = first ? `${first.qn_prefix}.${first.rows[0][0]}` : SYMBOL;
  await call('trace_path', { project, function_name: qn, direction: 'both', depth: 1 });
  await call('get_code_snippet', { project, qualified_name: qn, max_lines: 20 });
  if (first?.file) await call('get_file_outline', { project, file_path: first.file, limit: 20 });
  // thinker's engine on the same index
  console.log(`CBM project for the checkout: ${cbmProject(REPO)}`);
  if (first?.file) {
    const dep = { path: first.file, symbol: first.rows[0][0] };
    console.log(`fanout(${dep.path}:${dep.symbol}):`, JSON.stringify(fanout(REPO, dep)));
    console.log(`references:`, JSON.stringify((references(REPO, dep.symbol.split('.').pop(), { file: dep.path, limit: 50 })?.lines || []).slice(0, 5).map(l => `${l.path}:L${l.line}`)));
    console.log(`outline(${dep.path}): ${(outline(REPO, dep.path) || []).length} definitions`);
  }
  console.log('preflight ok');
} catch (e) {
  console.error('preflight failed:', e.message, stderr.slice(-500));
  process.exitCode = 1;
} finally {
  await client.close();
}
