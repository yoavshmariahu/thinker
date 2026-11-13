// The subagent definitions the delegation trigger hands work to (2026-11-12, the owner's call: native
// subagents in every harness).
//
// `delegate.js` denies a big read or a whole-suite run and its words tell the model to call the host's own
// subagent *by name*. The name has to resolve, so this is where thinker makes sure it does -- and only where
// the host has nothing suitable of its own:
//
// - **Claude Code** needs nothing written. `Explore` and `general-purpose` are built in and always there.
//   A user-scope `agents/Explore.md` overrides the built-in `Explore` and pins its model, which is what
//   explore-agent.js already writes; while the trigger is on, that file is written on `delegate.model`
//   (`clients.js`, through `delegateExploreModel`) so the exploration runs on Sonnet rather than the
//   conversation's own model. Nothing here duplicates that writer: two writers of one file is how a file
//   gets removed by the other (model-agents.js).
// - **OpenCode 2** has no built-in subagent at all: `subagent` resolves the name against the agents in the
//   config, and an unknown one is "Unknown agent: x" (read out of 2.2.7's own binary, 2026-11-12). So the two
//   agents the denial names are written here, as markdown with frontmatter, in the config directory OpenCode
//   scans (`{agent,agents}/**/*.md`).
//
// **No model is pinned on OpenCode**, and that is the point of the whole change. OpenCode names a model
// `providerID/modelID` from the person's own providers; on a vendor's cloud harness running the vendor's
// models thinker has no business choosing one, and `claude-sonnet-5-5` would not resolve. Omitting `model`
// makes a subagent run on the session's model, which still keeps the read out of the lead's context for the
// rest of the session -- the larger half of the saving, and the only half that does not depend on which
// models the person has.
//
// Every file carries a marker, so thinker only ever rewrites or removes its own; a person's own file of the
// same name is left alone and named once, as everywhere else.
import fs from 'node:fs';
import path from 'node:path';
import { OPENCODE_EXPLORE, OPENCODE_VERIFY, EXPLORER_PROMPT, VERIFIER_PROMPT, DELEGATE_DEFAULTS, delegateConfig, HOSTS } from './delegate.js';

export const DELEGATE_MARK = 'thinker-delegate';
const VERSION = 1;

export const isThinkerDelegateAgent = text => typeof text === 'string' && text.includes(`<!-- ${DELEGATE_MARK}`);
export const opencodeAgentDir = configDir => path.join(configDir, 'agent');
export const opencodeAgentFile = (configDir, name) => path.join(opencodeAgentDir(configDir), `${name}.md`);

/**
 * The model thinker pins the host's exploration agent to, or null. Only where the host lets it
 * (`HOSTS[client].subagent.pins`) and only while the trigger hands work over. Read by clients.js so
 * explore-agent.js stays the one writer of Explore.md.
 */
export function delegateExploreModel({ env = process.env, home, client = 'claude' } = {}) {
  const cfg = delegateConfig({ env, home });
  if (!cfg.enabled || !cfg.handoff) return null;
  return HOSTS[client]?.subagent?.pins ? cfg.model : null;
}

// The frontmatter is OpenCode's `Config.AgentEncoded`, and it is `additionalProperties: false` (read off the
// canonical schema, 2026-11-12): exactly `model`, `request`, `system`, `description`, `mode`, `hidden`,
// `color`, `steps`, `disabled`, `permissions`. **There is no `name`** -- the file's name is the agent's id, so
// `thinker-explore.md` is the `thinker-explore` the denial names -- and `permissions` is a list of
// `{action, resource, effect}` with all three required, not a map. A key outside that set fails the whole
// file, which would leave the denial naming an agent that does not resolve.
/** The two OpenCode agents, as the markdown OpenCode reads. No `model`: the host's own is right there. */
export function renderOpencodeAgent(kind, { lines = DELEGATE_DEFAULTS.reportLines } = {}) {
  const explore = kind === 'explore';
  const name = explore ? OPENCODE_EXPLORE : OPENCODE_VERIFY;
  // No ": " anywhere in a description. It is a plain YAML scalar, and a colon followed by a space inside one
  // makes the frontmatter a mapping and the file unreadable.
  const description = explore
    ? 'Read-only exploration of this codebase for a lead engineer who will not read the files. Finds the relevant definitions and reports them as path:line with what each one does. thinker hands a large read to this agent.'
    : 'Runs one test command for a lead engineer and reports the summary line verbatim with the failing tests. thinker hands a whole-suite run to this agent.';
  // `edit` deny makes it read-only and `task` deny stops it delegating again (OpenCode's own
  // `experimental.subagent_depth` is 1, so a nested subagent is refused anyway; this says so up front).
  // The same policy as Claude Code's Explore.md, which denies the writing tools and Agent and keeps the shell.
  const permissions = ['  - { action: edit, resource: "*", effect: deny }', '  - { action: task, resource: "*", effect: deny }'];
  return `---
description: ${description}
mode: subagent
permissions:
${permissions.map(l => l + '\n').join('')}---

<!-- ${DELEGATE_MARK} v${VERSION} kind=${kind}: written by thinker so its delegation trigger can hand work to one of OpenCode's own subagents instead of running a model process of its own. No model is set on purpose: this runs on your session's model. Your own ${name}.md here is never overwritten; THINKER_DELEGATE=off removes this one. -->

${(explore ? EXPLORER_PROMPT.replace('{N}', String(lines)) : VERIFIER_PROMPT)}
`;
}

/**
 * Write, rewrite or remove thinker's OpenCode delegation agents under a config directory. Returns one action
 * per file: { name, action: 'written' | 'unchanged' | 'removed' | 'absent' | 'kept', file }. 'kept' is a file
 * that is not thinker's and was left alone.
 */
export function installOpencodeAgents({ configDir, on = delegateConfig().enabled && delegateConfig().handoff } = {}) {
  const out = [];
  for (const kind of ['explore', 'verify']) {
    const name = kind === 'explore' ? OPENCODE_EXPLORE : OPENCODE_VERIFY;
    const file = opencodeAgentFile(configDir, name);
    let cur = null; try { cur = fs.readFileSync(file, 'utf8'); } catch {}
    if (cur !== null && !isThinkerDelegateAgent(cur)) { out.push({ name, action: 'kept', file }); continue; }
    if (!on) {
      if (cur === null) { out.push({ name, action: 'absent', file }); continue; }
      fs.rmSync(file, { force: true });
      out.push({ name, action: 'removed', file });
      continue;
    }
    const text = renderOpencodeAgent(kind);
    if (cur === text) { out.push({ name, action: 'unchanged', file }); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
    out.push({ name, action: 'written', file });
  }
  return out;
}

/** `thinker uninstall --user`: only thinker's own files go. */
export const removeOpencodeAgents = ({ configDir }) => installOpencodeAgents({ configDir, on: false });
