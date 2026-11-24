// A new release is asked about before it is installed (the owner, 2026-11-24: "ask users to update instead of
// auto-updating"). Until then every install looked for a release every four hours and swapped it in unasked:
// thinker's own files replaced and its hooks rewritten under sessions that were running, and the person heard of
// it afterwards, on a terminal, if at all. This is the turn the weekly question took the day before
// (upkeep.js, `level: 'ask'`): thinker finds the thing, the person says yes.
//
//   the check      as before, on use and from the OS job, every UPDATE_EVERY_MS (update.js). What it finds is
//                  kept here (keepAvailable) and nothing is installed, unless the level is `auto`.
//   the question   put by the prompt hook's one-question chain (updateOffer), through the agent's own question
//                  tool: Update now, Not now, Always update automatically. One question at most every
//                  `askEveryDays` (7), about the newest release, whatever the last answer was: releases come out
//                  once or twice a day, so a question a release would be a question a day.
//   the answer     thinker's MCP tool `update`, or `thinker update --answer yes|no|always` (answerUpdateOffer).
//                  Yes starts the update in a process of its own (`update --background --apply`); always also
//                  sets the level to `auto`; no changes nothing. `thinker update` installs at any time.
//   a terminal     the next command typed there says a release is out, once a release (availableNotice).
//
// The level is the machine's setting `update.level` (settings.js): `ask` (the default), `auto` (installs as it
// did before), `off` (does not look). No model call anywhere, and nothing here reaches the network: the check is
// update.js's, and this file only keeps what it found.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { thinkerHome } from './update.js';
import { isTestMode } from './test-mode.js';
import { readMachineConfig, updateMachineConfig } from './repo-switch.js';
import { QUESTION_TOOLS, MCP_CLIENTS, askThrough, askInChat } from './repo-onboard.js';
import { SIGNATURE } from './harness.js';
import { thinkerVersion } from './error-report.js';
import { unattended } from './upkeep.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
const DAY = 86_400_000;

export const UPDATE_ASK = {
  level: 'ask',       // ask | auto | off
  askEveryDays: 7,    // one question at most this often, whatever was answered
  answerDays: 3,      // how long a question that was put waits for its answer (the MCP tool is offered meanwhile)
};
export const UPDATE_LEVELS = ['ask', 'auto', 'off'];

/** The machine's update settings: `update: { level, askEveryDays }` in config.json; `update: false` reads as off. */
export function updateSettings(home = thinkerHome()) {
  const u = readMachineConfig(home)?.update;
  const b = u === false || u === 'off' ? { level: 'off' } : u && typeof u === 'object' ? u : {};
  return {
    level: UPDATE_LEVELS.includes(b.level) ? b.level : UPDATE_ASK.level,
    askEveryDays: Number.isFinite(b.askEveryDays) && b.askEveryDays > 0 ? b.askEveryDays : UPDATE_ASK.askEveryDays,
  };
}
export const updateLevel = (home = thinkerHome()) => updateSettings(home).level;

// { available: { version, commit, from, at }, asked: { at, version, commit, client }, answered: { at, choice, version }, noticed }
export const updateAskFile = (home = thinkerHome()) => path.join(home, 'state', 'update-ask.json');
const read = home => { try { return JSON.parse(fs.readFileSync(updateAskFile(home), 'utf8')) || {}; } catch { return {}; } };
const write = (home, st) => {
  try { fs.mkdirSync(path.dirname(updateAskFile(home)), { recursive: true }); fs.writeFileSync(updateAskFile(home), JSON.stringify(st)); } catch {}
};
const keyOf = a => `${a.version || ''}@${a.commit || ''}`;
// A release is named by its version; a build that kept the version (a git checkout, a release cut again) by its commit.
const nameOf = a => (a.version && a.version !== a.from ? a.version : a.commit ? `build ${String(a.commit).slice(0, 7)}` : 'a new release');
const plural = n => (n === 1 ? 'a day' : n === 7 ? 'a week' : `${n} days`);

/** The check found a release (update.js:checkUpdate's answer). Kept for the question; true where it is news. */
export function keepAvailable(chk, { home = thinkerHome(), now = Date.now() } = {}) {
  const st = read(home);
  const found = { version: chk.latestVersion || null, commit: chk.latestCommit || null, from: chk.version || null, at: new Date(now).toISOString() };
  if (st.available && keyOf(st.available) === keyOf(found) && st.available.from === found.from) return false;
  write(home, { ...st, available: found });
  return true;
}

/** Nothing waits: the check found this copy current, or the release was installed. */
export function dropAvailable({ home = thinkerHome() } = {}) {
  const st = read(home);
  if (!st.available) return;
  delete st.available;
  write(home, st);
}

// The release that waits, unless this copy is it already (installed since by hand or by the installer, which
// tell nobody here; the next check drops the record).
const waiting = (st, version) => (st.available && !(st.available.version && st.available.version === version) ? st.available : null);

/** The release a question is due about, or null: the level is `ask`, one waits, and the last question is old enough. */
export function updateOfferDue({ home = thinkerHome(), now = Date.now(), version = thinkerVersion() } = {}) {
  // the one small file first: on most prompts nothing waits, and the settings are not read at all
  const st = read(home), a = waiting(st, version);
  if (!a) return null;
  const s = updateSettings(home);
  if (s.level !== 'ask') return null;
  if (st.asked && now - Date.parse(st.asked.at) < s.askEveryDays * DAY) return null;
  return a;
}

/** Whether a question was put and waits for its answer. */
export function updateOfferPending({ home = thinkerHome(), now = Date.now() } = {}) {
  const st = read(home);
  if (!st.asked || now - Date.parse(st.asked.at) > UPDATE_ASK.answerDays * DAY) return false;
  return !(st.answered && Date.parse(st.answered.at) >= Date.parse(st.asked.at));
}

/** What thinker's MCP tool for the answer is offered on: a question put, or one the next prompt will put, so a
 *  session whose server started before the question still has the tool. */
export const updateOfferWaiting = (opts = {}) => updateOfferPending(opts) || Boolean(updateOfferDue(opts));

/** The prompt hook: the question, once, as a block that has the person's agent ask them. Not put where nobody is
 *  at the session to answer (upkeep.js:unattended, the weekly question's rule). */
export function updateOffer(store, { client, home = thinkerHome(), now = Date.now(), env = process.env, cli = CLI, version = thinkerVersion() } = {}) {
  if (unattended(env)) return '';
  const a = updateOfferDue({ home, now, version });
  if (!a) return '';
  write(home, { ...read(home), asked: { at: new Date(now).toISOString(), version: a.version, commit: a.commit, client: client || null } });
  try { store?.log?.({ op: 'update-offer', version: a.version || undefined, client }); } catch {}
  const name = nameOf(a), runs = a.from || version;
  const tool = QUESTION_TOOLS[client];
  const question = `thinker ${name} is out${runs ? ` (this machine runs ${runs})` : ''}. Update now?`;
  const ask = tool
    ? `Before you start on the request, ${askThrough(tool, question)}, with the options "Update now", "Not now" and "Always update automatically".`
    : `Before you start on the request, ${askInChat(`whether to update thinker to ${name} now: yes, not now, or always update automatically; and wait for their answer.`)}`;
  const cmd = `"${process.execPath}" "${cli}" update --answer <yes|no|always>`;
  const after = MCP_CLIENTS.has(client)
    ? `Then call thinker's \`update\` tool with choice yes, no or always; if that tool is not offered, run \`${cmd}\`.`
    : `Then run \`${cmd}\`.`;
  return [
    '<thinker-update>',
    `thinker ${name} is out${runs ? ` and this machine runs ${runs}` : ''}. Nothing has been installed: thinker asks first. An update replaces thinker's own files and points its hooks in the agents' settings at the new copy, in the background, in about a minute; it changes nothing in any repository.`,
    `${ask} Do not decide for them, and do not run the update yourself.`,
    `${after} thinker does what they chose and tells you what it did; pass that on in one line opening "${SIGNATURE}:". Then go on with the task.`,
    '</thinker-update>',
  ].join('\n');
}

/** The update the person said yes to, in a process of its own: it replaces the files this one runs from. */
export function startUpdate({ cli = CLI, spawnFn = spawn, env = process.env, testMode = isTestMode() } = {}) {
  if (testMode) return { started: false, reason: 'a test run installs nothing' };
  try {
    const child = spawnFn(process.execPath, [cli, 'update', '--background', '--apply', '--quiet'], { detached: true, stdio: 'ignore', env: { ...env, THINKER_BACKGROUND_UPDATE: '1' } });
    child.unref();
    return { started: true };
  } catch (e) { return { started: false, reason: e.message }; }
}

/** The answer: yes (update now), no (not now), always (update now, and install later releases without asking). */
export function answerUpdateOffer(choice, { store, client, home = thinkerHome(), now = Date.now(), startFn = startUpdate, version = thinkerVersion() } = {}) {
  const raw = String(choice || '').trim().toLowerCase();
  const always = /^(always|auto)/.test(raw);
  const yes = always || /^(y|yes|update|now|ok|sure|on|true)/.test(raw);
  const said = always ? 'always' : yes ? 'yes' : 'no';
  const st = read(home), a = waiting(st, version);
  write(home, { ...st, answered: { at: new Date(now).toISOString(), choice: said, version: a?.version || null } });
  try { store?.log?.({ op: 'update-answer', choice: said, version: a?.version || undefined, client }); } catch {}
  if (always) updateMachineConfig(home, cfg => ({ ...cfg, update: { ...(cfg.update && typeof cfg.update === 'object' ? cfg.update : {}), level: 'auto' } }));
  const later = always ? ' From now on thinker installs new releases itself; `thinker settings set update.level ask` has it ask again.' : '';
  if (!yes) return `Recorded: thinker stays on ${a?.from || version || 'this release'}. It asks again in ${plural(updateSettings(home).askEveryDays)} if a release still waits; \`thinker update\` installs the latest at any time.`;
  const r = startFn({ home });
  if (!r?.started) return `The update could not be started (${r?.reason || 'unknown'}); run \`thinker update\`.${later}`;
  return `Updating thinker${a ? ` to ${nameOf(a)}` : ''} in the background; it takes about a minute. Restart open desktop apps afterwards to load changed settings.${later}`;
}

/** A terminal's line that a release is out, said once a release. Under `auto` the release installs itself, and
 *  under `off` nothing was looked for. */
export function availableNotice({ home = thinkerHome(), version = thinkerVersion() } = {}) {
  if (updateLevel(home) !== 'ask') return '';
  const st = read(home), a = waiting(st, version);
  if (!a || st.noticed === keyOf(a)) return '';
  write(home, { ...st, noticed: keyOf(a) });
  return `thinker ${nameOf(a)} is out${a.from ? ` (this machine runs ${a.from})` : ''}; \`thinker update\` installs it`;
}
