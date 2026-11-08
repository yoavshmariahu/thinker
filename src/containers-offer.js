// One question: thinker is on this machine but not in the container the agent runs in, and it can be put
// there now.
//
// Why a question of its own, against the rule of 2026-10-25 ("one suggestion, not three"): the owner's call
// on 2026-11-05, with the wording below theirs. The weekly context message is about what a repository loads
// into every prompt and is built from the sessions thinker can see -- and a session inside a container is
// exactly what it cannot see, so a line in it could never carry this. The machines this is for report an
// agent used every day and no request against the cache at all (telemetry.js:recentSessions,
// `sessionStore: 'missing'`): 13 of the 20 machines that used an agent on 2026-11-05.
//
// Shaped like the proxy repair offer (proxy-offer.js): put through the agent's own question tool, answered
// through thinker's `containers` MCP tool or the command, no model call anywhere, so it works in a desktop
// app with no CLI signed in. Where that offer closes for good on any answer, this one is a situation and not
// a one-off fault -- a container is rebuilt, another is started -- so a no waits `AGAIN_DAYS` and only never
// closes it. The yes installs at once (the owner's call): it is 8 seconds and no network, and an offer that
// only printed instructions would leave the sessions it is about exactly as they are.
//
// The docker probe is not run from the prompt hook. Maintenance records the candidate at most daily
// (`scheduleContainersOffer`), and the hook reads that file, so no prompt waits on `docker ps`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { thinkerHome } from './update.js';
import { findAgentContainers, installInContainer, containerSnippet, worktreeMounts } from './containers.js';
import { knownRepos } from './usage.js';
import { QUESTION_TOOLS, MCP_CLIENTS, askThrough, askInChat } from './repo-onboard.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
// How often the machine is looked at, how long a recorded candidate stands, how long an unanswered question
// keeps thinker's `containers` tool registered, and how long a no waits.
export const LOOK_EVERY_HOURS = 24;
export const CANDIDATE_HOURS = 48;
export const ANSWER_DAYS = 7;
export const AGAIN_DAYS = 30;
// Agents with no way to put a question to the person
const SILENT = ['windsurf', 'goose', 'augment'];
// The question, as the owner wrote it on 2026-11-05. The agent is told not to reword it, and
// test/cli-ui-sync.test.js holds this string, so a change to it is a change somebody made on purpose.
export const QUESTION = 'thinker is installed on your machine but not in the container. Install it here to get token cost savings on your sessions?';
export const OPTIONS = '"Yes" / "No" / "Never ask again"';

const stateFile = home => path.join(home, 'state', 'containers-offer.json');
export function offerState(home = thinkerHome()) {
  try { return JSON.parse(fs.readFileSync(stateFile(home), 'utf8')) || {}; } catch { return {}; }
}
function save(home, st) {
  const f = stateFile(home);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(st, null, 2) + '\n');
}

const fresh = (at, hours, now) => { const t = Date.parse(at || ''); return Number.isFinite(t) && now - t < hours * 3600_000; };

// Maintenance, at most every LOOK_EVERY_HOURS: is there a container on this machine running an agent that
// thinker is not in? Records it for the next prompt hook to ask about. Returns the candidate, or null.
//
// The probe costs a `docker ps`, an inspect and one `docker exec` per container, which is why it lives here
// and not in the hook. A machine with no docker is the common case and costs one failed `docker version`.
export function scheduleContainersOffer(store, { home = thinkerHome(), exec, now = Date.now() } = {}) {
  const st = offerState(home);
  if (st.never || st.asked || st.answered) {
    // a no waits, then the machine is looked at again; never and a waiting answer stop here
    if (st.never || st.asked) return null;
    if (!st.snoozedUntil || Date.parse(st.snoozedUntil) > now) return null;
  }
  if (fresh(st.lookedAt, LOOK_EVERY_HOURS, now)) return null;
  let repos = [];
  try { repos = knownRepos(store, { all: true }).flatMap(r => r.checkouts || []).filter(Boolean); } catch {}
  const found = findAgentContainers({ ...(exec ? { exec } : {}), repos, home });
  const pick = (found.containers || []).find(c => c.wirable) || null;
  save(home, {
    ...st, lookedAt: new Date(now).toISOString(), snoozedUntil: undefined,
    candidate: pick ? { id: pick.id, name: pick.name, image: pick.image, agents: pick.agents, inside: (pick.shared[0] || {}).inside || null, foundAt: new Date(now).toISOString() } : null,
  });
  if (pick) store?.log?.({ op: 'containers-found', agents: pick.agents.length, image: pick.image || null });
  return pick;
}

// What there is to ask about: a candidate recorded recently enough to still be running, and no answer yet.
export function containersOfferDue({ home = thinkerHome(), now = Date.now() } = {}) {
  const st = offerState(home);
  if (st.never || st.asked) return null;
  if (st.snoozedUntil && Date.parse(st.snoozedUntil) > now) return null;
  const c = st.candidate;
  return c && fresh(c.foundAt, CANDIDATE_HOURS, now) ? c : null;
}

// Whether the answer is still awaited, so mcp-server.js offers the `containers` tool while it is
export function containersOfferPending(home = thinkerHome(), now = Date.now()) {
  const st = offerState(home);
  if (!st.asked || st.answered || st.never) return false;
  return now - Date.parse(st.asked) < ANSWER_DAYS * 86400_000;
}

const answerCommand = (via, client) => `"${process.execPath}" "${CLI}" containers --answer <yes|no|never> --via ${via}${client ? ` --client ${client}` : ''}`;

// The prompt hook: the question, once, as an instruction to the agent to put it to the person.
export function containersOffer(store, { client, home = thinkerHome(), now = Date.now() } = {}) {
  if (SILENT.includes(client)) return '';
  const c = containersOfferDue({ home, now });
  if (!c) return '';
  save(home, { ...offerState(home), asked: new Date(now).toISOString(), askedFor: c.id, client: client || null });
  store?.log?.({ op: 'containers-offer', client, agents: c.agents.length });

  const where = c.name || c.id;
  const what = `thinker found a container on this machine, ${where}, running ${c.agents.join(' and ')}${c.inside ? ` on the checkout it mounts at ${c.inside}` : ''}. thinker is installed on the machine but not inside that container, and a container has its own home: the wiring here is not what the agent in there reads, so those sessions get no clearing and no profile, and nothing is learned from them.`;
  const offer = 'Saying yes copies this build in and wires the agents inside, which takes about 8 seconds and no network. The cache is the one in the checkout the container already mounts, so the profile and what it learns stay in the repository. A container rebuild wipes the install; thinker will print the lines that keep it.';
  const tool = QUESTION_TOOLS[client];
  const ask = tool && client !== 'codex'
    ? `Before you start on the request, ${askThrough(tool, QUESTION)}, with the options ${OPTIONS}, and this message as the question's context.`
    : `Before you start on the request, ${askInChat(`exactly this: "${QUESTION}" -- yes, no, or never ask again.`)}`;
  const after = MCP_CLIENTS.has(client)
    ? `Then call thinker's \`containers\` tool with choice set to yes, no or never and asked "${tool ? 'picker' : 'chat'}"; if that tool is not available, run \`${answerCommand(tool ? 'picker' : 'text', client)}\`. Pass on what it says in one line opening "🧠 thinker:". Then go on with the task.`
    : `Then run \`${answerCommand('text', client)}\` with the answer, and pass on what it says in one line opening "🧠 thinker:". Then go on with the task.`;
  return `<thinker-container-offer>\n${what}\n${offer}\n${ask}\n${after}\n</thinker-container-offer>`;
}

// The answer. Yes installs now, into the container the question was asked about -- found again, because the
// answer can arrive minutes later and a container can be gone by then.
export async function answerContainersOffer(choice, { store, client, via = 'picker', home = thinkerHome(), now = Date.now(), exec, installFn = installInContainer } = {}) {
  const st = offerState(home);
  const raw = String(choice || '').trim();
  const never = /^never/i.test(raw);
  const yes = /^(y|yes|install|true|1)\b/i.test(raw);
  const answer = never ? 'never' : yes ? 'yes' : 'no';
  const record = extra => save(home, {
    ...st, answered: new Date(now).toISOString(), choice: answer,
    answeredBy: via === 'text' ? 'chat' : 'picker', answeredClient: client || null,
    ...(never ? { never: new Date(now).toISOString() } : {}),
    // a no is about this container and this week, not for ever: the machine is looked at again later
    ...(answer === 'no' ? { snoozedUntil: new Date(now + AGAIN_DAYS * 86400_000).toISOString(), asked: undefined, candidate: null } : {}),
    ...extra,
  });
  store?.log?.({ op: 'containers-offer-answer', client, via, choice: answer });
  if (!yes) {
    record();
    return never
      ? 'Recorded: thinker will not ask about containers on this machine again. `thinker containers --install <name>` does it whenever you want it.'
      : `Recorded: the container stays as it is. thinker will not ask again for ${AGAIN_DAYS} days; \`thinker containers\` lists them and \`--install <name>\` wires one.`;
  }

  let repos = [];
  try { repos = knownRepos(store, { all: true }).flatMap(r => r.checkouts || []).filter(Boolean); } catch {}
  const found = findAgentContainers({ ...(exec ? { exec } : {}), repos, home });
  const wanted = (found.containers || []).find(c => c.id === st.askedFor || c.name === st.askedFor) || (found.containers || []).find(c => c.wirable);
  if (!wanted) { record({ installed: false, why: 'gone' }); return 'That container is no longer running, so thinker installed nothing. `thinker containers` lists what is running now.'; }
  if (!wanted.thinker && !wanted.wirable) { record({ installed: false, why: 'not wirable' }); return `thinker installed nothing in ${wanted.name || wanted.id}: ${wanted.reachable ? (wanted.node ? 'it works in no checkout this machine shares' : 'there is no node inside it to run thinker') : `it would not run a command (${wanted.why})`}.`; }
  if (wanted.thinker) { record({ installed: false, why: 'already' }); return `thinker is already inside ${wanted.name || wanted.id}; nothing to do.`; }

  const r = await installFn(wanted, { ...(exec ? { exec } : {}) });
  record({ installed: r.ok, container: wanted.name || wanted.id, steps: r.steps.map(s => ({ what: s.what, ok: s.ok })) });
  if (!r.ok) {
    const failed = r.steps.find(s => !s.ok);
    return `thinker could not finish installing in ${wanted.name || wanted.id}: ${failed?.what} failed (${failed?.detail || 'no reason given'}). Nothing in the container was changed beyond that step. \`thinker containers --install ${wanted.name || wanted.id}\` tries again.`;
  }
  const worktrees = worktreeMounts(wanted);
  return [
    `thinker is now in ${wanted.name || wanted.id} (${r.target}) and ${r.wired} read it from inside, serving from the checkout it already mounts.`,
    worktrees.length ? `One thing to know: ${worktrees.map(m => m.inside).join(', ')} is a git worktree, whose .git names a path on the host, so git cannot read it inside the container and thinker will find no repository there. Mount the main checkout instead, or clone inside.` : '',
    'A rebuild wipes it. To keep it, add this to the container:',
    containerSnippet(),
  ].filter(Boolean).join('\n');
}
