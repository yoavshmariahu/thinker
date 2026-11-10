// Subagents on a model of the person's choosing (2026-11-10): how a subtask is sent to a specific model, safely.
//
// Claude Code runs a user-scope subagent (`<claude config dir>/agents/<Name>.md`) on the `model` its frontmatter
// names and sends that id upstream unchanged (checked live 2026-11-10), so a file whose model is `thinker/<alias>`
// puts every call of that subagent through the route (proxy-routing.js) while the main conversation stays on the
// person's own login. That is the whole mechanism, and what makes it safe is what it does not do: the provider's
// key never enters Claude Code's settings (the proxy adds it per request), a route nobody registered is a 400 on
// the subagent's first call rather than a forward to Anthropic, the `reader` template cannot write, and every
// call carries the route on its proxy log row so model-profile.js can read how it went.
//
// `Explore` is not written here: it has a writer of its own (explore-agent.js, `agents.explore` in the machine
// config), and two writers of one file is how a file gets removed by the other. `thinker models assign Explore …`
// sets that config instead. Every other name is thinker's own file, marked, and only a marked file is ever
// rewritten or removed; a person's own file of the same name is left alone and named once.
import fs from 'node:fs';
import path from 'node:path';

export const AGENT_MARK = 'thinker-agent';
const VERSION = 1;
export const TEMPLATES = {
  reader: {
    description: 'Read-only agent for a bounded question about the codebase: find files, symbols and mechanisms and report pointers, without changing anything.',
    frontmatter: ['disallowedTools: Write, Edit, MultiEdit, NotebookEdit, Agent'],
    body: `You are a read-only subagent for a lead coding agent. The lead delegates a bounded question to you so the files you read stay out of its context. Read, search and list; never edit, write, run tests or run anything that changes state. Prefer exact pointers (repo-relative paths, \`file:symbol\`, line numbers) over paraphrase, quote the exact lines where wording matters, and report as briefly as the question allows: the relevant files with one line each on why, the key facts with a pointer each, and what you could not find.`,
  },
  worker: {
    description: 'Agent for a bounded, well-specified task that may edit files: implement the change the lead describes, run what verifies it, and report what was done and what was not.',
    frontmatter: [],
    body: `You are a worker subagent for a lead coding agent. The lead hands you one bounded task with the files and the acceptance it has in mind. Do that task and nothing beyond it: make the edits, run the checks the lead named (or the project's usual ones), and stop. Never commit, push, or change files outside the task's scope. Report what you changed (repo-relative paths), what you ran and its result verbatim where it failed, and anything you left undone with the reason.`,
  },
};
export const isAgentName = name => /^[A-Za-z][\w-]{0,39}$/.test(String(name || '')) && String(name).toLowerCase() !== 'explore';
export const agentFile = (claudeDir, name) => path.join(claudeDir, 'agents', `${name}.md`);
export const isThinkerAgent = text => typeof text === 'string' && text.includes(`<!-- ${AGENT_MARK}`);

export function renderAgent({ name, model, template = 'reader', description }) {
  const t = TEMPLATES[template]; if (!t) throw Error(`template is one of ${Object.keys(TEMPLATES).join(', ')}`);
  if (!isAgentName(name)) throw Error('an agent name is a word of letters, digits, dashes and underscores (Explore is set through thinker models assign Explore, which writes agents.explore)');
  if (!model || /\s/.test(String(model))) throw Error('a model is one id');
  const desc = String(description || t.description).replace(/\s+/g, ' ').trim();
  return `---
name: ${name}
description: ${desc}
model: ${model}
${t.frontmatter.map(l => l + '\n').join('')}---

<!-- ${AGENT_MARK} v${VERSION} template=${template}: written by thinker so this subagent runs on ${model}. Your own ${name}.md here is never overwritten; thinker models assign ${name} --off removes this one. -->

${t.body}
`;
}

// Write every agent the registry names and remove thinker's own files it no longer names. Returns one action per
// file: { name, action: written|unchanged|removed|kept, file, model }. 'kept' is a file that is not thinker's.
export function installAgents({ claudeDir, agents = {} }) {
  const out = [];
  const dir = path.join(claudeDir, 'agents');
  const want = new Map(Object.entries(agents).filter(([n, a]) => isAgentName(n) && a?.model));
  for (const [name, a] of want) {
    const file = agentFile(claudeDir, name);
    let cur = null; try { cur = fs.readFileSync(file, 'utf8'); } catch {}
    if (cur !== null && !isThinkerAgent(cur)) { out.push({ name, action: 'kept', file, model: a.model }); continue; }
    const text = renderAgent({ name, ...a });
    if (cur === text) { out.push({ name, action: 'unchanged', file, model: a.model }); continue; }
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
    out.push({ name, action: 'written', file, model: a.model });
  }
  let names = []; try { names = fs.readdirSync(dir); } catch {}
  for (const f of names) {
    if (!f.endsWith('.md')) continue;
    const name = f.slice(0, -3); if (want.has(name)) continue;
    const file = path.join(dir, f);
    let cur = null; try { cur = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!isThinkerAgent(cur)) continue;
    fs.rmSync(file, { force: true });
    out.push({ name, action: 'removed', file, model: null });
  }
  return out;
}
// `thinker uninstall --user`: only thinker's own files go
export const removeAgents = ({ claudeDir }) => installAgents({ claudeDir, agents: {} });
