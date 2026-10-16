#!/usr/bin/env node
// The MCP entry every agent runs (`node <install>/src/mcp.js`). An app keeps it for days: Cursor starts one
// for all its windows when it opens (2026-10-16: one started the day before still ran the code of before
// an update, and a warm-up handed to Cursor stalled on a fixed bug). Node loads code once, so this launcher
// stays small and runs the server (mcp-server.js) as a child, passing the newline-delimited JSON-RPC both
// ways. Before a request reaches it, the launcher checks whether the installed server changed (`thinker
// update` swaps the app directory: a new file at the same path) and, with nothing in flight, starts the new
// one, replays the client's initialize to it, and tells the client the tool list changed. The client keeps
// its connection and restarts nothing; a server that died is started again the same way.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-server.js');
const REINIT = 'thinker-launcher-reinit';
const stamp = () => { try { const s = fs.statSync(SERVER); return `${s.ino}:${s.mtimeMs}`; } catch { return null; } };
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');

let child = null, loaded = null, init = null, initialized = null, inputDone = false;
const pending = new Set();   // ids of the client's requests the server has not answered

function start({ replay = false } = {}) {
  loaded = stamp();
  const c = child = spawn(process.execPath, [SERVER, ...process.argv.slice(2)], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  c.stdout.setEncoding('utf8');
  c.stdout.on('data', d => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (c === child) fromServer(line); }
  });
  c.stdin.on('error', () => {});
  c.on('exit', code => { if (c !== child) return; child = null; pending.clear(); if (inputDone) process.exit(code ?? 0); });
  if (replay && init) {
    c.stdin.write(JSON.stringify({ ...init, id: REINIT }) + '\n');
    if (initialized) c.stdin.write(JSON.stringify(initialized) + '\n');
  }
}

function fromServer(line) {
  let msg; try { msg = JSON.parse(line); } catch { process.stdout.write(line + '\n'); return; }
  if (msg.id === REINIT && !msg.method) return;   // the replayed initialize: the client had its answer from the first server
  if (msg.id !== undefined && !msg.method) pending.delete(JSON.stringify(msg.id));
  process.stdout.write(line + '\n');
}

// the installed server changed (or died) and nothing is in flight: the next request goes to a new one
function refresh() {
  if (pending.size || !init) return;
  if (child && stamp() === loaded) return;
  if (!stamp()) return;   // mid-swap: the old one answers until the new file is there
  const old = child; child = null;
  if (old) { old.stdin.end(); old.kill(); }
  start({ replay: true });
  send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
}

function fromClient(line) {
  if (!line.trim()) return;
  let msg = null; try { msg = JSON.parse(line); } catch {}
  if (msg?.method === 'initialize') init = msg;
  else if (msg?.method === 'notifications/initialized') initialized = msg;
  else if (msg?.method && msg.id !== undefined) refresh();
  if (msg?.method && msg.id !== undefined) pending.add(JSON.stringify(msg.id));
  if (!child) start({ replay: msg?.method !== 'initialize' });
  child.stdin.write(line + '\n');
}

start();
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0;) { const line = buf.slice(0, i); buf = buf.slice(i + 1); fromClient(line); }
});
process.stdin.on('end', () => { inputDone = true; if (buf) fromClient(buf); if (child) child.stdin.end(); else process.exit(0); });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { child?.kill(sig); process.exit(0); });
