// A switched-off tool keeps its definition on disk, and the prompt carries a pointer to it.
//
// Until 2026-11-06 switching a built-in tool off wrote its bare name into `permissions.deny`: the
// definition left every prompt, and so did the tool -- a request that needed it had nothing to call.
// Now the definition is written where the agent can read it (`<THINKER_HOME>/tools/<Name>.json`: the
// description and the schema of its input, as the session carried them) and the name goes into the
// registry (`<THINKER_HOME>/state/tool-stubs.json`). The tool stays callable; what the model sees of it
// is one sentence (`pointer`) that names the file, so it reads the definition before the first call and
// pays for it then, in that session alone, instead of in every prompt of every session.
//
// Two doors hold one policy, as the clearing's do (AGENTS.md): the proxy replaces the tool's entry in
// each request it forwards, description and schema both (`stubTools`, from proxy.js:transformRequest);
// the clearing mod inside a Claude Code session answers `tool.describe` with the same sentence, since a
// desktop session never reaches the proxy and a mod can rewrite a description but not a schema
// (src/integrations/claude-clear). The sentence is the same string in both; test/claude-clear.test.js
// holds the mod's copy to this one. Whichever door first sees the definition as the engine built it
// writes the file (`writeDefinition`): the switch itself writes what a transcript recorded, which is the
// description with an empty schema, so the proxy fills in the schema when a request shows it.
//
// The registry is the machine's, since the proxy is one per machine and the file is read by path.
import fs from 'node:fs';
import path from 'node:path';

export const TOOL_NAME = /^[\w.-]{1,80}$/;
export const stubsFile = home => path.join(home, 'state', 'tool-stubs.json');
export const toolsDir = home => path.join(home, 'tools');
export const toolFile = (home, name) => path.join(toolsDir(home), `${name}.json`);
// the definition the model is sent in place of the real one: the sentence, and a schema that refuses nothing
// (Claude Code checks the input against the tool's own schema when the call comes back, and says what was wrong)
export const POINTER_OPENS = 'thinker keeps this tool\'s full definition out of the prompt.';
export const pointer = (name, file) => `${name}: ${POINTER_OPENS} Before the first call to it in this session, read ${file} (what it does and the schema of its input), then call it as that file says.`;
export const isPointer = text => String(text || '').includes(POINTER_OPENS);
export const STUB_SCHEMA = { type: 'object', additionalProperties: true };
// about what the pointer costs a prompt, for the savings that count a stubbed tool as gone
export const STUB_TOKENS = 60;

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  fs.renameSync(tmp, f);
};

export function readStubs(home) {
  const j = readJson(stubsFile(home));
  return { tools: j && typeof j.tools === 'object' && j.tools ? j.tools : {} };
}
// The agent reads the file with its own Read tool, and outside the working directory Claude Code would ask the person
// first (seen live 2026-11-06: in a default-permission session the Read was refused and the model stopped there, as it
// should). The clearing mod grants that one read itself, from its `tool.check` hook, for a file right inside this
// directory (`isToolFile` in register.tsx); nothing is written into anyone's permission settings (the owner's call).
export const stubbedNames = home => new Set(Object.keys(readStubs(home).tools));

// The definition on disk: `{name, description, input_schema}`. A pointer is never written as a description
// (the mod rewrites what the engine sends, so the proxy may see the pointer where the definition was); where
// the file holds a real description and the schema is all that is new, the schema joins it.
export function writeDefinition(home, name, def) {
  if (!TOOL_NAME.test(String(name))) throw new Error(`not a tool name: ${name}`);
  const file = toolFile(home, name), cur = readJson(file);
  const description = isPointer(def?.description) ? null : String(def?.description ?? '');
  const schema = def?.input_schema && typeof def.input_schema === 'object' && Object.keys(def.input_schema).length ? def.input_schema : null;
  const next = { name, description: description ?? cur?.description ?? '', input_schema: schema ?? cur?.input_schema ?? {} };
  if (cur && cur.description === next.description && JSON.stringify(cur.input_schema) === JSON.stringify(next.input_schema)) return { file, written: false };
  if (!cur && description == null && !schema) return { file, written: false };
  writeJson(file, next);
  return { file, written: true };
}

// `thinker harness --off <tool>` (harness.js:apply): the file, then the name in the registry.
export function addStub(home, name, def, { at = Date.now() } = {}) {
  const { file } = writeDefinition(home, name, def || { name, description: '', input_schema: {} });
  if (!fs.existsSync(file)) writeJson(file, { name, description: String(def?.description ?? ''), input_schema: {} });
  const st = readStubs(home);
  st.tools[name] = { file, at: new Date(at).toISOString() };
  writeJson(stubsFile(home), st);
  return { file };
}
// `--undo`: the name out of the registry and the file gone; the next request carries the definition again.
export function removeStub(home, name) {
  const st = readStubs(home);
  if (!st.tools[name]) return false;
  const { file } = st.tools[name];
  delete st.tools[name];
  writeJson(stubsFile(home), st);
  try { fs.rmSync(file || toolFile(home, name), { force: true }); } catch {}
  return true;
}

// One tool's entry as the request will carry it: everything the agent set but the description and the
// schema (Claude Code puts `cache_control` on the last tool; that stays, so the cache boundary does too).
export const stubOf = (def, file) => ({ ...def, description: pointer(def.name, file), input_schema: STUB_SCHEMA });

// A request's `tools`, each registered one replaced; `seen` gets every registered tool's definition as the
// agent sent it, which is how the proxy writes the file. `chars` is what left the request.
export function stubTools(tools, stubs, { seen } = {}) {
  const names = stubs?.tools || {};
  if (!Array.isArray(tools) || !Object.keys(names).length) return { tools, replaced: [], chars: 0 };
  const replaced = [];
  let chars = 0;
  const out = tools.map(t => {
    const s = t && typeof t === 'object' && typeof t.name === 'string' ? names[t.name] : null;
    if (!s) return t;
    try { seen?.(t); } catch { /* the file is a convenience; the request is not */ }
    const stub = stubOf(t, s.file);
    const saved = JSON.stringify(t).length - JSON.stringify(stub).length;
    replaced.push({ name: t.name, chars: saved });
    chars += saved;
    return stub;
  });
  return { tools: replaced.length ? out : tools, replaced, chars };
}

// The proxy's reader: the registry re-read when its file changes (one stat a request), and the definitions
// written once per content for the life of the process.
export function stubReader(home) {
  let stamp = null, stubs = { tools: {} };
  const written = new Map();
  return {
    read() {
      let m = null;
      try { const s = fs.statSync(stubsFile(home)); m = `${s.mtimeMs}:${s.size}`; } catch { m = null; }
      if (m !== stamp) { stamp = m; stubs = m ? readStubs(home) : { tools: {} }; }
      return stubs;
    },
    seen(def) {
      if (!def?.name || !stubs.tools[def.name]) return;
      const key = JSON.stringify([def.description, def.input_schema]);
      if (written.get(def.name) === key) return;
      written.set(def.name, key);
      try { writeDefinition(home, def.name, def); } catch { /* unwritable home: the pointer still names the file */ }
    },
  };
}
