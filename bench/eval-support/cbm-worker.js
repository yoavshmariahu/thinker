// The thread that holds the connection to codebase-memory-mcp (cbm.js). It runs the binary as an
// MCP server over stdio once per process and answers tool calls from the main thread through a
// SharedArrayBuffer, so the synchronous code in codegraph.js can ask the graph without a 2.5 s
// start per question. Replies are JSON: {ok, text?, isError?, error?}.
import { parentPort, workerData } from 'node:worker_threads';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { bin, sab } = workerData;
const flag = new Int32Array(sab, 0, 2); // [0]: 1 when a reply is ready, [1]: its length
const buf = new Uint8Array(sab, 8);
let client = null, connecting = null;

async function connect() {
  const transport = new StdioClientTransport({ command: bin, args: ['--tool-profile=analysis'], stderr: 'ignore' });
  const c = new Client({ name: 'thinker', version: '1' });
  await c.connect(transport);
  transport.onclose = () => { client = null; connecting = null; };
  client = c;
}

function reply(obj) {
  let b = Buffer.from(JSON.stringify(obj));
  if (b.length > buf.length) b = Buffer.from(JSON.stringify({ ok: false, error: `reply of ${b.length} bytes does not fit` }));
  buf.set(b);
  Atomics.store(flag, 1, b.length);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
}

parentPort.on('message', async ({ id, name, args }) => {
  try {
    if (!client) await (connecting ||= connect());
    const r = await client.callTool({ name, arguments: { format: 'json', ...args } });
    reply({ id, ok: true, isError: !!r.isError, text: (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n') });
  } catch (e) {
    reply({ id, ok: false, error: String(e?.message || e) });
  }
});
