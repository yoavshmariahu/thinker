// One question, once per machine: the context proxy is off here, and the fault that may be why is fixed.
//
// On 2026-10-28 the proxy was writing its URL into harnesses routed through a model server of their own, which
// sent that gateway's token to Anthropic and failed every model call (`proxy-route.js`). The people it happened
// to turned the proxy off -- `thinker proxy off`, or deleting the setting, or the stand-down doing it for them --
// and nothing would ever turn it back on: `off` is durable by design, and the hint a stand-down prints
// (`proxy-service.js:gatewayHint`) is said once, at the moment it happens, to someone whose session is already
// broken. So the machines that hit the fault are now the ones getting no clearing at all.
//
// This asks them, once. It is a second in-session question, which the rule of 2026-10-25 ("one suggestion, not
// three") otherwise forbids: owner-approved on 2026-10-28 as an exception, because it is a one-off repair of a
// fault thinker caused, not a recurring suggestion, and because a line in the weekly context message would wait
// up to seven days and only in a repository with ten sessions to read. Any answer closes it for good.
//
// The question is put through the agent's own question tool and answered through thinker's `proxy` MCP tool
// (`mcp-server.js`), as the coverage question is: nothing depends on the agent composing a command line, and a
// desktop app answers the same way. No model call anywhere in this file, so it works wherever no CLI is signed in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { thinkerHome } from './update.js';
import { serviceState, enableProxyService, isOwnRoute } from './proxy-service.js';
import { ownGateway, cloudOn, CLOUD_VARS } from './proxy-route.js';
import { QUESTION_TOOLS, MCP_CLIENTS, askThrough, askInChat } from './repo-onboard.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
// The release that stopped the proxy taking over someone else's route, and the pull request that did it.
export const FIXED_IN = '0.2.12';
export const FIX_PR = 'https://github.com/yoavshmariahu/thinker/pull/517';
// A question nobody answers does not keep thinker's `proxy` tool registered for ever
export const ANSWER_DAYS = 7;
// Agents with no way to put a question to the person
const SILENT = ['windsurf', 'goose', 'augment'];

// `0.2.11` is older than `0.2.12`; anything unparseable counts as older, since the record is only kept by
// versions that already behave
export function olderThan(a, b) {
  const part = v => String(v).split('.').map(n => Number.parseInt(n, 10) || 0);
  const [x, y] = [part(a), part(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0; }
  return false;
}

const stateFile = home => path.join(home, 'state', 'proxy-offer.json');
export function offerState(home = thinkerHome()) {
  try { return JSON.parse(fs.readFileSync(stateFile(home), 'utf8')) || {}; } catch { return {}; }
}
function save(home, st) {
  const f = stateFile(home);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(st, null, 2) + '\n');
}

// Who is asked, and what there is to offer them. null for everyone else.
//
// The cohort is a machine whose proxy is off and was once on, either before the fix shipped (so the fault was
// live when they turned it off) or by a stand-down, which only the fixed code does and only on the routed
// machines. Someone who turned it off yesterday on purpose, on a version that already behaves, is left alone.
// A cloud route (Bedrock, Vertex, Foundry) is never asked: the proxy cannot speak those formats, so there would
// be nothing to say yes to.
export function proxyOfferDue({ home = thinkerHome(), env = process.env, now = Date.now() } = {}) {
  const st = offerState(home);
  if (st.asked || st.answered || st.never) return null;
  const s = serviceState(home);
  if (s.enabled || !(s.off || s.standDown)) return null;
  const since = s.standDown?.at || s.off || null;
  // The fault was live on a machine while it ran a version without the fix, which the calendar says nothing
  // about: someone can hit it tomorrow on an old copy. So the question is which version turned the proxy off
  // (`disableProxyService` records it). No version recorded means it was turned off before thinker kept that
  // record -- the backlog this is for. A stand-down is only ever written by the fixed code, and only on the
  // machines that were routed, so it qualifies whatever the version.
  if (!s.standDown && s.offVersion && !olderThan(s.offVersion, FIXED_IN)) return null;
  for (const k of CLOUD_VARS) if (cloudOn(env[k])) return null;
  const gateway = ownGateway({ env, isOwn: u => isOwnRoute(u, home) });
  return { kind: gateway ? 'gateway' : 'plain', gateway: gateway || null, since, reason: s.standDown?.reason || null };
}

// Whether the answer is still awaited, so `mcp-server.js` offers the `proxy` tool while it is
export function proxyOfferPending(home = thinkerHome(), now = Date.now()) {
  const st = offerState(home);
  if (!st.asked || st.answered || st.never) return false;
  return now - Date.parse(st.asked) < ANSWER_DAYS * 86400_000;
}

const answerCommand = (via, client) => `"${process.execPath}" "${CLI}" proxy --answer <yes|no|never> --via ${via}${client ? ` --client ${client}` : ''}`;

// The prompt hook: the question, once, as an instruction to the agent to put it to the person.
export function proxyOffer(store, { client, home = thinkerHome(), env = process.env, now = Date.now() } = {}) {
  if (SILENT.includes(client)) return '';
  const due = proxyOfferDue({ home, env, now });
  if (!due) return '';
  save(home, { ...offerState(home), asked: new Date(now).toISOString(), kind: due.kind, gateway: due.gateway, client: client || null });
  store?.log?.({ op: 'proxy-offer', client, kind: due.kind, since: due.since });

  const when = due.since ? ` (off since ${due.since.slice(0, 10)})` : '';
  const what = `thinker's context proxy is off on this machine${when}, so nothing is clearing the old tool results out of long sessions here.`;
  const why = `It was turned off while a fault was live: the proxy wrote its own URL into harnesses routed through a model server of their own, which sent that server's token to Anthropic and failed every model call. That is fixed (${FIX_PR}), and thinker now leaves such a route alone.`;
  const offer = due.kind === 'gateway'
    ? `This machine routes Claude Code through ${due.gateway.url} (from ${due.gateway.where}). thinker can put the proxy in front of that instead of Anthropic's API: every request still ends up at the same place with the same credentials, and the clearing rides along, which is the only way it reaches a routed session at all.`
    : `Turning it back on clears tool results the agent has finished with out of long sessions, where most of a session's bill is re-reading what is already in the context.`;
  const tool = QUESTION_TOOLS[client];
  const options = due.kind === 'gateway'
    ? `"Yes, in front of my model server" / "No" / "Never ask again"`
    : `"Yes, turn it back on" / "No" / "Never ask again"`;
  const ask = tool && client !== 'codex'
    ? `Before you start on the request, ${askThrough(tool, "Turn thinker's context clearing back on?")}, with the options ${options}, and this message as the question's context.`
    : `Before you start on the request, ${askInChat('whether to turn it back on: yes, no, or never ask again.')}`;
  const after = MCP_CLIENTS.has(client)
    ? `Then call thinker's \`proxy\` tool with choice set to yes, no or never and asked "${tool ? 'picker' : 'chat'}"; if that tool is not available, run \`${answerCommand(tool ? 'picker' : 'text', client)}\`. Then go on with the task.`
    : `Then run \`${answerCommand('text', client)}\` with the answer. Then go on with the task.`;
  return `<thinker-proxy-offer>\n${what}\n${why}\n${offer}\n${ask}\n${after}\n</thinker-proxy-offer>`;
}

// The answer. Yes turns the proxy on -- in front of the person's own model server where that is what was offered
// (`enableProxyService` with `gateway`, the only thing that ever puts it there) -- and no and never both close the
// question for good: it is asked once, and asking twice is pestering someone thinker already broke once.
export async function answerProxyOffer(choice, { store, client, via = 'picker', home = thinkerHome(), env = process.env, now = Date.now(), cli = CLI, enableFn = enableProxyService } = {}) {
  const st = offerState(home);
  const raw = String(choice || '').trim();
  const never = /^never/i.test(raw);
  const yes = /^(y|yes|on|true|1)\b/i.test(raw);
  const answer = never ? 'never' : yes ? 'yes' : 'no';
  save(home, { ...st, answered: new Date(now).toISOString(), choice: answer, answeredBy: via === 'text' ? 'chat' : 'picker', answeredClient: client || null, ...(never ? { never: new Date(now).toISOString() } : {}) });
  store?.log?.({ op: 'proxy-offer-answer', client, via, choice: answer, kind: st.kind || null });
  if (!yes) return `Recorded: thinker's context proxy stays off on this machine${never ? ' and this is not asked again' : ''}. \`thinker proxy on${st.kind === 'gateway' ? ' --gateway' : ''}\` turns it on whenever you want it. Go on with the task.`;
  const p = await enableFn({ cli, home, env, force: true, gateway: st.kind === 'gateway' ? true : undefined });
  if (p?.stoodDown) return `thinker's context proxy stayed off: ${p.stoodDown}. Go on with the task.`;
  const where = p?.upstream ? ` and forwards to ${p.upstream}, the model server this machine already uses` : '';
  // What the wiring actually did, not what was asked for: Claude Code can still be left alone (a route the proxy
  // was not told to forward to, a settings file that does not parse), and saying "on" then would be a claim that
  // their sessions are being cleared when nothing of theirs was touched.
  const left = (p?.wired?.skipped || []).find(x => x.agent === 'claude');
  if (left) return `Context proxy on: ${p.url}${where}, but Claude Code was left as it is: ${left.reason}. Its sessions are not being cleared. Go on with the task.`;
  return `Context proxy on: ${p?.url}${where}. It clears old tool results from long sessions; \`thinker proxy off\` stops it, \`thinker proxy status\` says what it did. Go on with the task.`;
}
