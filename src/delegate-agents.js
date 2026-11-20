// The subagent definitions the delegation trigger hands work to (2026-11-12, the owner's call: native
// subagents in every harness).
//
// `delegate.js` denies a big read or a whole-suite run and its words tell the model to call the host's own
// subagent *by name*. The name has to resolve, so this is where thinker makes sure it does -- and only where
// the host has nothing suitable of its own:
//
// - **Claude Code** needs nothing written for a read. `Explore` and `general-purpose` are built in and always
//   there. A user-scope `agents/Explore.md` overrides the built-in `Explore` and pins its model, which is what
//   explore-agent.js already writes; while the trigger is on, that file is written on `delegate.model`
//   (`clients.js`, through `delegateExploreModel`) so the exploration runs on the cheap model rather than the
//   conversation's own. Nothing here duplicates that writer: two writers of one file is how a file
//   gets removed by the other (model-agents.js).
//   The suite run is the one thing written here for it (2026-11-19, `installClaudeVerifier`): no built-in agent
//   has a model of its own to pin, so `general-purpose` ran the suite on the lead's model with every tool the
//   session has, and cost more than the lead running it (delegate.js:CLAUDE_VERIFY has the figures).
// - **OpenCode 2** has no built-in subagent at all: `subagent` resolves the name against the agents in the
//   config, and an unknown one is "Unknown agent: x" (read out of 2.2.7's own binary, 2026-11-12). So the two
//   agents the denial names are written here, as markdown with frontmatter, in the config directory OpenCode
//   scans (`{agent,agents}/**/*.md`).
//
// **No model is pinned on the two plain agents**, and that is the point of the whole change. OpenCode names a model
// `providerID/modelID` from the person's own providers; on a vendor's cloud harness running the vendor's
// models thinker has no business choosing one, and `claude-sonnet-5-5` would not resolve. Omitting `model`
// makes a subagent run on the session's model, which still keeps the read out of the lead's context for the
// rest of the session -- the larger half of the saving, and the only half that does not depend on which
// models the person has.
//
// **One more explorer per model family, pinned** (2026-11-15; `delegate.js:EXPLORER_FAMILIES`). A session on a
// gateway (OpenRouter) reaches every vendor with one key, so there the read can go to the lead's own family's
// cheap model -- `thinker-explore-anthropic` on Haiku for a Fable or Opus lead, `thinker-explore-openai` on Luna
// for Sol. The denial names one of these only for a lead on that gateway and in that family, so a file whose
// model the person cannot call is never the one asked for; everything else still gets the plain agent.
//
// Every file carries a marker, so thinker only ever rewrites or removes its own; a person's own file of the
// same name is left alone and named once, as everywhere else.
import fs from 'node:fs';
import path from 'node:path';
import { OPENCODE_EXPLORE, OPENCODE_VERIFY, EXPLORER_PROMPT, VERIFIER_PROMPT, DELEGATE_DEFAULTS, delegateConfig, HOSTS, EXPLORER_FAMILIES, FAMILY_PROVIDERS, familyAgent, CLAUDE_VERIFY } from './delegate.js';

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
export function renderOpencodeAgent(kind, { lines = DELEGATE_DEFAULTS.reportLines, model = null } = {}) {
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
${model ? `model: ${model}\n` : ''}description: ${description}
mode: subagent
permissions:
${permissions.map(l => l + '\n').join('')}---

<!-- ${DELEGATE_MARK} v${VERSION} kind=${kind}: written by thinker so its delegation trigger can hand work to one of OpenCode's own subagents instead of running a model process of its own. ${model ? `Pinned to ${model}, the cheap model of the lead's own family (delegate.js:EXPLORER_FAMILIES).` : 'No model is set on purpose: this runs on the model your session uses.'} thinker rewrites this file; delete it or set delegate: false in thinker's config to stop. -->

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
  // the two plain agents, then one pinned explorer a family (delegate.js:EXPLORER_FAMILIES) while pairing is on
  const families = on && delegateConfig().families !== false;
  const wanted = [
    { kind: 'explore', name: OPENCODE_EXPLORE, on }, { kind: 'verify', name: OPENCODE_VERIFY, on },
    ...EXPLORER_FAMILIES.map(f => ({ kind: 'explore', name: familyAgent(f.family), model: `${FAMILY_PROVIDERS[0]}/${f.explorer}`, on: families })),
  ];
  for (const { kind, name, model, on } of wanted) {
    const file = opencodeAgentFile(configDir, name);
    let cur = null; try { cur = fs.readFileSync(file, 'utf8'); } catch {}
    if (cur !== null && !isThinkerDelegateAgent(cur)) { out.push({ name, action: 'kept', file }); continue; }
    if (!on) {
      if (cur === null) { out.push({ name, action: 'absent', file }); continue; }
      fs.rmSync(file, { force: true });
      out.push({ name, action: 'removed', file });
      continue;
    }
    const text = renderOpencodeAgent(kind, { model });
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

// ---- Claude Code: the suite run's own agent ----
//
// Claude Code's frontmatter: `name` is the agent's id, `model` takes a full id (Explore.md's has since
// 2026-11-08), `tools` is the whole list it may call. A shell to run the command, the three reading tools to
// look at a failing test, and nothing else: no editing, no subagent of its own, none of the session's MCP
// tools, which is also what keeps its start-up context small. It starts without CLAUDE.md, as Explore does:
// it is told one command and runs it.
// The description is read by the lead, which sees every agent it may call: the first one written named only
// what the agent does, and a Sonnet lead asked to run a suite called it unprompted before any trigger fired
// (live on 2.1.329, 2026-11-19). The trigger decides what is handed over, so the description says so.
export const claudeVerifierPath = claudeDir => path.join(claudeDir, 'agents', `${CLAUDE_VERIFY}.md`);
export function renderClaudeVerifier(model = DELEGATE_DEFAULTS.model) {
  return `---
name: ${CLAUDE_VERIFY}
description: Runs one whole-suite test command and reports the summary line verbatim with the failing tests. thinker hands a whole-suite run to this agent. Call it only when thinker asks for it, and run every other test yourself.
model: ${model}
tools: Bash, Read, Grep, Glob
omitClaudeMd: true
---

<!-- ${DELEGATE_MARK} v${VERSION} kind=verify: written by thinker so a whole-suite test run its delegation trigger hands over runs on ${model} instead of the main conversation's model. thinker rewrites this file; \`delegate: false\` in thinker's config, or \`thinker uninstall --user\`, removes it. -->

${VERIFIER_PROMPT}
`;
}
/**
 * Write, rewrite or remove thinker's suite-run agent under the Claude config directory: `model` null removes it.
 * Returns { action: 'written' | 'unchanged' | 'removed' | 'absent' | 'kept', file, model }; 'kept' is a file of
 * that name that is not thinker's, left alone.
 */
export function installClaudeVerifier({ claudeDir, model = delegateExploreModel() } = {}) {
  const file = claudeVerifierPath(claudeDir);
  let cur = null; try { cur = fs.readFileSync(file, 'utf8'); } catch {}
  if (cur !== null && !isThinkerDelegateAgent(cur)) return { action: 'kept', file, model };
  if (!model) {
    if (cur === null) return { action: 'absent', file, model };
    fs.rmSync(file, { force: true });
    return { action: 'removed', file, model };
  }
  const text = renderClaudeVerifier(model);
  if (cur === text) return { action: 'unchanged', file, model };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
  return { action: 'written', file, model };
}
/** `thinker uninstall --user`: only thinker's own file goes. */
export const removeClaudeVerifier = ({ claudeDir } = {}) => installClaudeVerifier({ claudeDir, model: null });
