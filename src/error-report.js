// What broke, with the person's consent and nothing of the person in it.
//
// thinker swallows its own failures by design: a hook must never fail a tool call, so every one of
// them is wrapped in a bare `catch {}`, and a command that dies prints a stack to a terminal nobody
// reads again. So a fault that hits many machines is invisible here -- the Codex 404 of 2026-10-24
// ran for four days on the owner's own machine, and the installer leaving a shell with no working
// directory was found by reading a container log, not from a report. This records those failures
// locally, asks the person once whether to send them, and sends nothing until they say yes.
//
// Three rules the rest of this file exists to keep:
//   - a report carries the shape of the failure (which operation, which error, which of thinker's
//     own files) and nothing about the machine: no name, no repository, no URL, no credential;
//   - the question is asked once, and only when there is something to send;
//   - no answer means no send. Not a reminder, not a default yes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { thinkerHome } from './update.js';
import { isTestMode } from './test-mode.js';
import { isTelemetryEnabled, getTelemetryEndpoint, getInstallId, isTestTelemetryBlocked } from './telemetry.js';
import { QUESTION_TOOLS } from './repo-onboard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = path.resolve(HERE, '..');
const CLI = path.join(HERE, 'cli.js');

export const ERRORS = {
  keep: 20,           // records kept on the machine
  keepDays: 14,       // and for how long
  message: 500,       // characters of the message
  frames: 10,         // frames of the stack
  askAfter: 1,        // errors before the question is worth asking
};

export const errorsFile = (home = thinkerHome()) => path.join(home, 'state', 'errors.jsonl');
export const stateFile = (home = thinkerHome()) => path.join(home, 'state', 'error-report.json');

const readState = home => { try { return JSON.parse(fs.readFileSync(stateFile(home), 'utf8')) || {}; } catch { return {}; } };
const writeState = (home, s) => {
  try { fs.mkdirSync(path.dirname(stateFile(home)), { recursive: true }); fs.writeFileSync(stateFile(home), JSON.stringify(s, null, 2)); } catch {}
};

// A credential, a URL, a person's name or their repository's: none of it belongs in a report, and all
// of it turns up in a stack trace. thinker's own files keep their names, since knowing the failure was
// in `proxy-service.js:ensureProxy` is the entire value of the record.
export function scrub(text, { home = os.homedir(), install = INSTALL_DIR, repo = null } = {}) {
  let s = String(text ?? '');
  s = s.split(install).join('<thinker>');
  if (repo) s = s.split(repo).join('<repo>');
  if (home && home !== '/') s = s.split(home).join('~');
  s = s.replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_.-]{20,}|xox[baprs]-[A-Za-z0-9-]{8,})/g, '<token>');
  s = s.replace(/https?:\/\/[^\s)'"]+/g, '<url>');
  // whatever absolute path is left is someone's: the last two segments name the file, not the person
  s = s.replace(/(?:\/[A-Za-z0-9._@~+-]+){3,}/g, m => `…/${m.split('/').filter(Boolean).slice(-2).join('/')}`);
  return s;
}

// One record: what thinker was doing, what the error was, and where in thinker's own code. The stack is
// cut to its first frames, which is where the fault is; the rest is node's own plumbing.
export function errorRecord(op, err, { repo = null, now = Date.now(), version = thinkerVersion() } = {}) {
  const e = err && typeof err === 'object' ? err : { message: String(err) };
  const opts = { repo };
  const frames = String(e.stack || '').split('\n').slice(1, ERRORS.frames + 1).map(l => scrub(l.trim(), opts));
  return {
    at: new Date(now).toISOString(),
    op: String(op || 'unknown').slice(0, 60),
    version, node: process.versions?.node || null, platform: process.platform,
    name: String(e.name || 'Error').slice(0, 60),
    code: e.code ? String(e.code).slice(0, 40) : undefined,
    message: scrub(e.message || '', opts).slice(0, ERRORS.message),
    frames: frames.filter(Boolean),
  };
}

export function thinkerVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'package.json'), 'utf8')).version || null; } catch { return null; }
}

// Called from the catch sites. It must never throw and never slow a hook down: one append, no reads of
// anything but its own small file, and nothing at all in test mode.
export function recordError(op, err, { home = thinkerHome(), repo = null, now = Date.now() } = {}) {
  if (isTestMode() && !process.env.THINKER_ERRORS_TEST) return null;
  try {
    const rec = errorRecord(op, err, { repo, now });
    const kept = readErrors(home).filter(r => !(r.op === rec.op && r.name === rec.name && r.message === rec.message));
    kept.push({ ...rec, seen: (readErrors(home).find(r => r.op === rec.op && r.name === rec.name && r.message === rec.message)?.seen || 0) + 1 });
    writeErrors(home, kept);
    return rec;
  } catch { return null; }
}

export function readErrors(home = thinkerHome(), { now = Date.now() } = {}) {
  let lines = [];
  try { lines = fs.readFileSync(errorsFile(home), 'utf8').split('\n'); } catch { return []; }
  const cutoff = now - ERRORS.keepDays * 86400_000;
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try { const r = JSON.parse(l); if (Date.parse(r.at) >= cutoff) out.push(r); } catch {}
  }
  return out.slice(-ERRORS.keep);
}

function writeErrors(home, records) {
  try {
    fs.mkdirSync(path.dirname(errorsFile(home)), { recursive: true });
    fs.writeFileSync(errorsFile(home), records.slice(-ERRORS.keep).map(r => JSON.stringify(r)).join('\n') + '\n');
  } catch {}
}

// --- the question ----------------------------------------------------------

export const errorConsent = (home = thinkerHome()) => readState(home).consent || null;
export const errorOfferPending = (home = thinkerHome()) => {
  const s = readState(home);
  return Boolean(s.asked && !s.answered);
};

// Asked once, and only where there is something to send: a machine thinker has not failed on is never
// asked for permission to report nothing.
export function errorOfferDue({ home = thinkerHome(), now = Date.now(), store } = {}) {
  const s = readState(home);
  if (s.asked || s.answered || s.consent) return null;
  if (!isTelemetryEnabled({ home, store })) return null; // telemetry off means this too
  const errors = readErrors(home, { now }).filter(r => !r.sent);
  if (errors.length < ERRORS.askAfter) return null;
  return { errors };
}

export function errorOffer(store, { client, home = thinkerHome(), now = Date.now(), cli = CLI } = {}) {
  const due = errorOfferDue({ home, now, store });
  if (!due) return '';
  const tool = QUESTION_TOOLS[client];
  const one = due.errors[due.errors.length - 1];
  const ask = tool
    ? `Ask the user with your ${tool} tool, not in prose: "Send thinker's error reports to its developers?" (header "Reports"), options "Yes", "No" and "Never ask again".`
    : `Ask the user: "Send thinker's error reports to its developers?" — yes, no, or never.`;
  writeState(home, { ...readState(home), asked: new Date(now).toISOString(), client: client || null, count: due.errors.length });
  return [
    '<thinker-error-report>',
    `thinker has failed ${due.errors.length === 1 ? 'once' : `${due.errors.length} times`} on this machine and said nothing about it: the latest was ${one.op} — ${one.name}${one.code ? ` (${one.code})` : ''}. Nothing has been sent anywhere.`,
    'A report carries what thinker was doing, the error, and the frames inside thinker\'s own files. It never carries a path, a repository name, a URL, a token, or anything else about this machine; `thinker errors --list` prints exactly what would be sent.',
    ask,
    `Then call thinker's \`errors\` tool with the answer, or run \`"${process.execPath}" "${cli}" errors --answer <yes|no|never>\`. No answer sends nothing.`,
    '</thinker-error-report>',
  ].join('\n');
}

export async function answerErrorOffer(choice, { store, client, home = thinkerHome(), now = Date.now(), sendFn = sendErrors } = {}) {
  const raw = String(choice || '').trim().toLowerCase();
  const never = /^never/.test(raw);
  const yes = /^(y|yes|on|true|ok|sure)/.test(raw);
  writeState(home, { ...readState(home), answered: new Date(now).toISOString(), consent: never ? 'never' : yes ? 'yes' : 'no', client: client || null });
  try { store?.log?.({ op: 'error-offer-answer', choice: never ? 'never' : yes ? 'yes' : 'no', client }); } catch {}
  if (!yes) return never
    ? 'Recorded: thinker will not ask again and sends no error reports.'
    : 'Recorded: no error reports are sent. `thinker errors --answer yes` changes that.';
  const sent = await sendFn({ home, store });
  return sent.sent
    ? `Thank you — ${sent.count} report${sent.count === 1 ? '' : 's'} sent, and later failures will be reported too. \`thinker errors --answer never\` stops it.`
    : `Recorded. Nothing could be sent just now (${sent.reason || sent.error || 'unknown'}); the reports stay on this machine and go with the next one.`;
}

// --- sending ---------------------------------------------------------------

export const errorsEndpoint = endpoint => {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/[^/]*$/, 'errors');
  return url.toString();
};

export async function sendErrors({
  home = thinkerHome(),
  store,
  endpoint = errorsEndpoint(getTelemetryEndpoint({ home })),
  fetchFn = globalThis.fetch,
  now = Date.now(),
} = {}) {
  if (errorConsent(home) !== 'yes') return { sent: false, reason: 'no consent' };
  if (!isTelemetryEnabled({ home, store })) return { sent: false, reason: 'disabled' };
  // A test, a benchmark or an eval harness never reaches production, as the usage report does not
  // (telemetry.js:isTestTelemetryBlocked): THINKER_ERRORS_TEST=1 lets the records be written so the
  // path can be exercised, and without this that same run would have posted them for real. Only a
  // real fetch is judged; a test's own fetchFn is its own business.
  if (fetchFn === globalThis.fetch && isTestTelemetryBlocked(endpoint)) return { sent: false, reason: 'test_environment' };
  const all = readErrors(home, { now });
  const unsent = all.filter(r => !r.sent);
  if (!unsent.length) return { sent: false, reason: 'nothing to send' };
  const body = {
    installId: getInstallId(home),
    version: thinkerVersion(),
    platform: process.platform,
    errors: unsent.map(({ sent, ...r }) => r),
  };
  try {
    const res = await fetchFn(endpoint, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'thinker-cli' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { sent: false, status: res.status, error: `HTTP ${res.status}` };
    writeErrors(home, all.map(r => ({ ...r, sent: true })));
    try { store?.log?.({ op: 'error-report', count: unsent.length }); } catch {}
    return { sent: true, count: unsent.length, status: res.status };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

// What the person is shown by `thinker errors --list`: the records exactly as they would be sent.
export function errorsReport({ home = thinkerHome(), now = Date.now() } = {}) {
  const records = readErrors(home, { now });
  const consent = errorConsent(home);
  const lines = [];
  lines.push(consent === 'yes' ? 'Error reports: on. Reports are sent to thinker\'s developers.'
    : consent === 'never' ? 'Error reports: off, and thinker will not ask again.'
    : consent === 'no' ? 'Error reports: off.'
    : 'Error reports: not decided; nothing has been sent.');
  if (!records.length) { lines.push('No failures recorded on this machine.'); return lines.join('\n'); }
  lines.push('', `${records.length} record${records.length === 1 ? '' : 's'}, exactly as they would be sent:`);
  for (const r of records) {
    lines.push(`  ${r.at.slice(0, 16).replace('T', ' ')}  ${r.op}  ${r.name}${r.code ? ` (${r.code})` : ''}${r.seen > 1 ? ` ×${r.seen}` : ''}${r.sent ? '  [sent]' : ''}`);
    if (r.message) lines.push(`      ${r.message}`);
    for (const f of r.frames.slice(0, 3)) lines.push(`      ${f}`);
  }
  lines.push('', consent === 'yes' ? '`thinker errors --answer never` stops it.' : '`thinker errors --answer yes` sends these and later ones.');
  return lines.join('\n');
}
