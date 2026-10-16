// Draft acceptance criteria for loop experiments (bench/loop.js) from each task's request and the
// code at its base, never from the gold diff, gold files or tests: the solver is told which criteria
// fail, so criteria must not carry the answer. One read-only Claude Code session per task, in a
// checkout of the base outside the bench tree. Drafts are for a person to review before they are
// written into the task file.
// usage: node draft-criteria.mjs <tasks.json> <base checkout> <out.json> [--only id,id] [--model sonnet]
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';

const [tasksFile, base, outFile] = process.argv.slice(2);
const flag = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const only = (flag('only') || '').split(',').filter(Boolean);
const model = flag('model') || 'sonnet';
const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).tasks.filter(t => !only.length || only.includes(t.id));

const SCHEMA = { type: 'object', additionalProperties: false, required: ['acceptance'], properties: { acceptance: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'criterion', 'essential'], properties: { id: { type: 'string' }, criterion: { type: 'string' }, command: { type: 'string' }, essential: { type: 'boolean' } } } } } };
const ask = request => `You write the acceptance criteria for a change request in this repository (the working directory), as a careful reviewer would before anyone starts. A separate checker will later verify each criterion against a candidate change, by reading the code and running commands; the engineer doing the change will see these criteria.

Rules:
- 3 to 6 criteria. Each one observable: a behavior the request asks for, a case it names, or "existing tests of the touched area still pass" with the command that runs them.
- Derive them from the request and from how the code works today. Read the code to understand the behavior, but write each criterion as behavior a user or reviewer can observe: name no file, module, function, class, method or field unless the request itself names it. Finding where the change goes is the engineer's job; the criteria must not tell them. Only a command may name test files.
- Mark a criterion essential unless the request presents it as optional.
- A command, when you give one, runs from the repository root with exactly the test runner the request gives (never uv, pip or another environment); only existing test files, never tests that would have to be written.
- Return JSON {"acceptance":[{"id":"a1","criterion","command"?,"essential"}]} and nothing else.

REQUEST:
${request}`;

function claude(prompt, cwd) {
  const emptyNotes = fs.mkdtempSync(path.join(os.tmpdir(), 'criteria-empty-notes-'));
  const args = ['-p', '--output-format', 'json', '--model', model, '--permission-mode', 'plan', '--tools', 'Read,Glob,Grep',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--json-schema', JSON.stringify(SCHEMA)];
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env: { ...process.env, THINKER_NOTES_DIR: emptyNotes, THINKER_MCP: 'off', THINKER_NO_LEARN: '1', THINKER_LOG: 'off' } });
    let out = '', err = '';
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
    child.on('close', code => { fs.rmSync(emptyNotes, { recursive: true, force: true }); code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`)); });
    child.stdin.end(prompt);
  });
}

const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
await Promise.all(tasks.map(async t => {
  if (out[t.id]?.acceptance) return;
  try {
    const raw = JSON.parse(await claude(ask(t.prompt), base));
    const res = raw.structured_output || JSON.parse(String(raw.result).replace(/^```json\s*|```\s*$/g, ''));
    out[t.id] = { acceptance: res.acceptance, model, usage: raw.usage, cost: raw.total_cost_usd, turns: raw.num_turns };
    console.log(`${t.id}: ${res.acceptance.length} criteria, ${raw.num_turns} turns`);
  } catch (e) { out[t.id] = { error: e.message }; console.log(`${t.id}: ERROR ${e.message}`); }
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
}));
