// Exploration subagents on Sonnet (2026-11-08, the owner's call).
//
// Claude Code's built-in Explore subagent runs on the main conversation's model, so on an Opus or Fable
// session every file search and read a delegated exploration makes is billed at that model's rates. A user
// or project subagent named `Explore` overrides the built-in one and keeps its own `model` field
// (code.claude.com/docs/en/sub-agents), so thinker writes one at user scope with `model: claude-sonnet-5-5`.
//
// Why Sonnet and not Haiku: 13 of this machine's own exploration turns replayed as an exploration subagent
// (research in the routing scratchpad, 2026-11-07): Sonnet 5.5 found the same files as Opus 5.5 on every
// task where it mattered (core recall 0.77 both, Sonnet ahead on precision) at 43% of the cost; Haiku 5.5
// was 7 points of recall behind both. The parent's saving is the same whichever model explores -- the
// results stay out of its prefix -- so the explorer only has to be good enough, and Sonnet removes the
// quality question.
//
// What is written: `<claude config dir>/agents/Explore.md`, a read-only exploration agent that starts
// without CLAUDE.md as the built-in does, carrying a marker so thinker only ever rewrites or removes its
// own file. A person's own Explore.md is left alone and named once; a project's `.claude/agents/Explore.md`
// wins over the user file in Claude Code's own order and is never touched. `thinker uninstall --user`
// removes the file. Off by default; on: `THINKER_EXPLORE_MODEL=on`, or `agents: { explore: true }` in the machine
// config (THINKER_HOME/config.json); either may name another model instead (`haiku`, a full id).
import fs from 'node:fs';
import path from 'node:path';
import { readMachineConfig } from './repo-switch.js';

// The full id, not the `sonnet` alias: on Claude Code 2.1.319 the alias resolved to claude-sonnet-5 (checked live
// 2026-11-08), and the replay that chose the model ran Sonnet 5.5.
export const EXPLORE_MODEL_DEFAULT = 'claude-sonnet-5-5';
export const EXPLORE_MARK = 'thinker-explore';
const VERSION = 1;

// The model the Explore agent should run on, or null when the override is off.
// Off by default (2026-11-08, the owner's call: not sure it should ship; the delegation test is still a todo).
// Nothing is written until a machine opts in: `THINKER_EXPLORE_MODEL=on` or `agents: { explore: true }` means
// EXPLORE_MODEL_DEFAULT; either may name a model instead. A machine that wrote the file while it was the default and
// then updates has it removed at the next connect or rewire, since the marker says it is thinker's.
export function exploreModel({ env = process.env, home } = {}) {
  const raw = env.THINKER_EXPLORE_MODEL ?? readMachineConfig(home).agents?.explore;
  if (raw === undefined || raw === null || raw === false || raw === '' || /^(off|false|0|no)$/i.test(String(raw))) return null;
  if (raw === true || /^(on|true|1|yes)$/i.test(String(raw))) return EXPLORE_MODEL_DEFAULT;
  return String(raw).trim();
}

export const exploreAgentFile = claudeDir => path.join(claudeDir, 'agents', 'Explore.md');
export const isThinkerExploreAgent = text => typeof text === 'string' && text.includes(`<!-- ${EXPLORE_MARK}`);

export function renderExploreAgent(model = EXPLORE_MODEL_DEFAULT) {
  return `---
name: Explore
description: Fast, read-only agent for searching and understanding the codebase. Use it to find files, symbols and mechanisms without making changes, so the results stay out of the main conversation. Specify thoroughness in the prompt: quick for a targeted lookup, medium for a balanced exploration, very thorough when several places or naming conventions have to be covered.
model: ${model}
disallowedTools: Write, Edit, MultiEdit, NotebookEdit, Agent
omitClaudeMd: true
---

<!-- ${EXPLORE_MARK} v${VERSION}: written by thinker so exploration runs on a cheaper model than the main conversation. Your own Explore.md here is never overwritten; THINKER_EXPLORE_MODEL=off, or a thinker update, removes this one. -->

You are an exploration subagent for a lead coding agent. The lead delegates a question about this codebase to you so the files you read stay out of its context. Your job is exploration only: find the files, functions and mechanisms relevant to the request, then report back so the lead can act without reading them again.

Rules:
- Read, search and list. Never edit, write, run tests or run anything that changes state.
- Match the thoroughness the lead asked for. Quick: answer from the first good hit. Very thorough: cover every location and naming convention that could be relevant.
- Prefer exact pointers over paraphrase: repo-relative paths, \`file:symbol\` and line numbers.

Report, as briefly as the question allows:
1. Relevant files, one repo-relative path per line, each with one line on why it matters.
2. The key facts the lead needs, each with a file:symbol pointer. Quote the exact lines when wording matters.
3. Open questions or things you could not find, if any.
`;
}

// Write, rewrite or remove thinker's Explore.md under the Claude config directory. Returns what happened:
// { action: 'written' | 'unchanged' | 'removed' | 'absent' | 'kept', file, model }. 'kept' means a file that is
// not thinker's sits there and was left alone.
export function installExploreAgent({ claudeDir, model = exploreModel() } = {}) {
  const file = exploreAgentFile(claudeDir);
  let cur = null; try { cur = fs.readFileSync(file, 'utf8'); } catch {}
  if (cur !== null && !isThinkerExploreAgent(cur)) return { action: 'kept', file, model };
  if (!model) {
    if (cur === null) return { action: 'absent', file, model };
    fs.rmSync(file, { force: true });
    return { action: 'removed', file, model };
  }
  const text = renderExploreAgent(model);
  if (cur === text) return { action: 'unchanged', file, model };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
  return { action: 'written', file, model };
}

// `thinker uninstall --user`: only thinker's own file goes.
export function removeExploreAgent({ claudeDir } = {}) {
  return installExploreAgent({ claudeDir, model: null });
}
