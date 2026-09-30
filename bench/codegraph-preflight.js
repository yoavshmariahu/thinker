#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root = process.cwd(), wt = path.join(root, 'bench/worktrees/posthog-codegraph');
const transport = new StdioClientTransport({ command: process.execPath,
  args: [path.join(root, 'bench/worktrees/eval-support/node_modules/@colbymchenry/codegraph/npm-shim.js'), 'serve', '--mcp', '--path', wt],
  cwd: wt, env: { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS: '0' }, stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', b => { stderr += b; process.stderr.write(b); });
const client = new Client({ name: 'eval-preflight', version: '1' }), start = Date.now();
try {
  await client.connect(transport, { timeout: 180000 });
  const listing = await client.listTools();
  const probe = await client.callTool({ name: 'codegraph_explore', arguments: { query: 'OrganizationInvite' } }, undefined, { timeout: 240000 });
  const text = probe.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  fs.writeFileSync('bench/runs/posthog-thinker-vs-codegraph-3/codegraph-preflight-host.json', JSON.stringify({ wall_ms: Date.now()-start, tools: listing.tools.map(t=>t.name), probe, stderr }, null, 2));
  console.log(`Query returned ${text.length} characters. ${text.slice(0, 200)}`);
  if (probe.isError || /auto-sync is DISABLED|cannot answer from this index/.test(text)) process.exitCode = 1;
} finally { await client.close(); }
