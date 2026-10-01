#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const QARTEZ_BIN = path.join(ROOT, 'eval-support/qartez-0.11.0-aarch64-apple-darwin/qartez');
const REPO = path.resolve(ROOT, '../../bench/repos/posthog-base');

const transport = new StdioClientTransport({
  command: QARTEZ_BIN,
  args: ['--root', REPO, '--db-path', '/tmp/qartez-posthog-test.db', '--no-watch'],
  cwd: REPO,
  stderr: 'pipe'
});

let stderr = '';
transport.stderr?.on('data', b => { stderr += b; });

const client = new Client({ name: 'qartez-preflight', version: '1' });
const start = Date.now();

try {
  await client.connect(transport, { timeout: 30000 });
  const listing = await client.listTools();
  console.log(`Connected in ${Date.now() - start}ms. Tools count: ${listing.tools.length}`);
  console.log('Tools:', listing.tools.map(t => t.name).join(', '));

  const probe = await client.callTool({
    name: 'qartez_find',
    arguments: { name: 'OrganizationInvite' }
  });
  console.log('qartez_find result:', JSON.stringify(probe, null, 2));

  const mapProbe = await client.callTool({
    name: 'qartez_map',
    arguments: { focus: 'invite' }
  });
  console.log('qartez_map result snippet:', JSON.stringify(mapProbe).slice(0, 300));
} finally {
  await client.close();
}
