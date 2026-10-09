// `thinker` commands on the notes themselves: serving by hand (orient, lookup, find, drilldown), the
// desired behaviors (system), and the housekeeping of the store (list, show, add, rm, check-free
// re-hashing, archiving, phrasing, links). Each takes the dispatcher's context (cli.js).
import fs from 'node:fs';
import path from 'node:path';
import { listBehaviors, renderBehaviors, addBehavior, promoteBehavior, proposeBehaviors, writeSystemMarkdown } from '../behavior.js';
import { listBehaviorProposals, acceptBehaviorProposal } from '../behavior-proposals.js';
import { annotateFanout } from '../codegraph.js';
import { formatTokens } from '../model-usage.js';
import { orient, trackTurn, phraseNotes, phraseKey, lookup, drilldown, find, createNote, feedback, refresh, renderNote, linkNotes, archiveNotes, archiveConfig } from '../ops.js';

async function orientCommand(ctx) {
  const { pos, flags, store, out } = ctx;
  const r = await orient(store, { task: pos.join(' '), file: flags.file, session: flags.session || process.env.THINKER_SESSION, client: flags.client || 'cli', budget: Number(flags.budget) || 1000, snippets: !!flags.snippets });
  out(r.included.length ? r.text : '(no matching notes)');
  return;
}

async function lookupCommand(ctx) {
  const { pos, flags, store, out } = ctx;
  const r = await lookup(store, { query: pos.join(' '), client: flags.client || 'cli', budget: Number(flags.budget) || 2500, maxNotes: flags.n ? Number(flags.n) : 3, snippets: !!flags.snippets, kind: typeof flags.kind === 'string' ? flags.kind : undefined });
  trackTurn(store, flags.session || process.env.THINKER_SESSION, r.included.map(note => note.id));
  out(r.included.length ? r.text : '(nothing cached about that)');
  return;
}

async function findCommand(ctx) {
  const { pos, flags, store, out } = ctx;
  const r = find(store, { query: pos.join(' '), path: flags.path || undefined, limit: Number(flags.limit) || 12, client: flags.client || 'cli' });
  if (r.error) { out('error: ' + r.error); process.exit(1); }
  out(r.text);
  return;
}

async function drilldownCommand(ctx) {
  const { pos, flags, store, out } = ctx;
  const r = drilldown(store, { pointer: pos.join(' '), client: flags.client || 'cli', budget: Number(flags.budget) || 2500 });
  if (r.error) { out('error: ' + r.error); process.exit(1); }
  out(r.text);
  return;
}

async function systemCommand(ctx) {
  const { pos, flags, repo, store, out, readStdin } = ctx;
  // thinker system [add|promote|accept|propose|md] …: the desired behaviors (behavior.js)
  const sub = ['add', 'promote', 'accept', 'propose', 'md', 'define'].includes(pos[0]) ? pos.shift() : 'list';
  const mutability = flags.fixed ? 'fixed' : flags.mutable ? 'mutable' : undefined;
  if (sub === 'add') {
    const input = JSON.parse(pos[0] ? fs.readFileSync(pos[0], 'utf8') : readStdin());
    const r = addBehavior(store, input, { mutability });
    if (r.error) { out('error: ' + r.error); process.exit(1); }
    out(`saved ${r.note.id} (${r.note.mutability})` + (r.dropped.length ? ` (dropped: ${JSON.stringify(r.dropped)})` : ''));
  } else if (sub === 'promote' || sub === 'accept') {
    if (!pos.length) { out(`usage: thinker system ${sub} <id…> [--fixed | --mutable]`); process.exit(1); }
    for (const id of pos) {
      const r = sub === 'accept' && id.startsWith('proposal-')
        ? acceptBehaviorProposal(store, id, { fixed: mutability === 'fixed' })
        : promoteBehavior(store, id, { mutability: mutability || 'mutable' });
      out(r.error ? `${id}: ${r.error}` : r.unchanged ? `${id}: already a ${r.note.mutability} behavior` : `${id}: now a ${r.note.mutability} behavior`);
    }
  } else if (sub === 'propose') {
    const drafts = listBehaviorProposals(store);
    for (const p of drafts) out(`${p.id}\n  ${p.title}\n  ${p.body}\n  Evidence: ${p.source?.ref || p.source?.type || p.sourceId}; ${p.reason}\n  Accept: thinker system accept ${p.id}`);
    const c = proposeBehaviors(store);
    for (const x of c) out(`${x.kind.padEnd(10)} ${x.id.padEnd(45)} acted on ${x.confirmed}×, served ${x.uses}×  ${x.title}`);
    out(c.length ? `${c.length} rule notes; thinker system promote <id> [--fixed] makes one a desired behavior` : drafts.length ? `${drafts.length} behavior drafts awaiting acceptance` : 'no behavior candidates yet');
  } else if (sub === 'define') {
    // the prompt that starts an interview with the person's own coding agent (setup/define.js)
    const { printBehaviorSession } = await import('../setup/define.js');
    printBehaviorSession(store.exists() ? store : null, { out, copy: !flags['no-copy'] });
  } else if (sub === 'md') {
    out(`wrote ${path.relative(repo, writeSystemMarkdown(store, { force: true }))}`);
  } else {
    const rows = listBehaviors(store, { all: !!flags.all });
    out(flags.json ? JSON.stringify(rows.map(({ note, ...r }) => r), null, 2) : renderBehaviors(rows));
  }
  return;
}

async function listCommand(ctx) {
  const { flags, repo, store, out } = ctx;
  let notes = refresh(store, store.list());
  if (flags.stale) notes = notes.filter(n => n.status === 'stale');
  if (!flags.all) notes = notes.filter(n => n.status !== 'invalid');
  if (flags.json) {
    out(JSON.stringify({
      notes: notes.map(n => ({
        id: n.id, title: n.title, kind: n.kind, status: n.status,
        archived: !!n.archived, scope: store.isShared(n.id) ? 'repo' : 'local',
        confidence: n.confidence ?? 0.7, uses: n.uses || 0,
      })),
      unreadable: store.unreadable().map(u => ({ file: path.relative(repo, u.file), reason: u.reason }))
        .sort((a, b) => a.file.localeCompare(b.file)),
      total: notes.length,
    }, null, 2));
    return;
  }
  for (const n of notes) out(`${(store.isShared(n.id) ? 'repo' : 'local').padEnd(5)} ${(n.archived ? 'archived' : n.status).padEnd(8)} ${String(n.kind).padEnd(10)} ${n.id.padEnd(45)} c=${Math.round((n.confidence ?? 0.7) * 100)}% uses=${n.uses || 0}  ${n.title}`);
  for (const u of store.unreadable()) out(`warning: ${path.relative(repo, u.file)} is not served: ${u.reason}`);
  out(`${notes.length} notes`);
  return;
}

async function showCommand(ctx) {
  const { pos, flags, store, out } = ctx;
  const n = store.get(pos[0]); if (!n) { out('no such note'); process.exit(1); }
  out(flags.json ? JSON.stringify(n, null, 2) : renderNote(n) + `\nsource: ${JSON.stringify(n.source)}  verified: ${n.verified}  status: ${n.status}  attest: ${JSON.stringify(n.attest || {})}  related: ${(n.related || []).join(', ') || '-'}`);
  const sup = store.superseded(pos[0]);
  if (sup && !flags.json) out(`\nsuperseded: a pull replaced this note while this checkout had an unshared change to it (${Object.keys(sup.pending).join(', ')}). Kept in .thinker/local/shared/${pos[0]}.json; put it back with feedback or remember if it still holds.` + (sup.pending.body ? `\n--- unshared body ---\n${sup.pending.body}` : ''));
  return;
}

async function rmCommand(ctx) {
  const { pos, store, out } = ctx;
  out(store.remove(pos[0]) ? 'removed' : 'no such note'); return;
}

async function addCommand(ctx) {
  const { pos, flags, store, out, readStdin } = ctx;
  const input = JSON.parse(pos[0] ? fs.readFileSync(pos[0], 'utf8') : readStdin());
  const r = createNote(store, input, { source: { type: flags.source || 'human' } });
  if (r.error) { out('error: ' + r.error); process.exit(1); }
  out(`saved ${r.note.id}` + (r.dropped.length ? ` (dropped: ${JSON.stringify(r.dropped)})` : ''));
  return;
}

async function feedbackCommand({ pos, store, out, readStdin }) {
  const input = JSON.parse(pos[0] ? fs.readFileSync(pos[0], 'utf8') : readStdin());
  if (!input || typeof input.id !== 'string' || !input.id || typeof input.useful !== 'boolean' || (input.correction !== undefined && typeof input.correction !== 'string')) {
    throw new Error('feedback expects JSON with id (string), useful (boolean), and optional correction (string)');
  }
  const r = feedback(store, input);
  if (r.error) throw new Error(r.error);
  out(`Recorded. ${r.note.id} confidence now ${Math.round(r.note.confidence * 100)}%${input.correction ? ', body updated' : ''}.`);
}

async function relinkCommand(ctx) {
  const { store, out } = ctx;
  const notes = store.list(); for (const n of notes) linkNotes(store, n, notes); out(`linked ${notes.length} notes`); return;
}

async function rehashCommand(ctx) {
  const { flags, store, out } = ctx;
  // Re-baseline every note's dependency hashes against the current tree
  // without LLM verification (use after upgrading thinker's hashing).
  let n = 0;
  for (const note of store.list()) { note.deps = (note.deps || []).map(d => ({ ...hashDep(store.repo, d), ...(d.fanout ? { fanout: d.fanout } : {}) })).filter(d => !d.missing); if (flags.fanout) note.deps = annotateFanout(store.repo, note.deps, { max: 12 }); note.status = note.status === 'invalid' ? 'invalid' : 'fresh'; delete note.stale; delete note.verifying; store.put(note); n++; }
  out(`rehashed ${n} notes${flags.fanout ? ' and counted their references' : ''}`);
  return;
}

async function archiveCommand(ctx) {
  const { pos, flags, store, out } = ctx;
  // thinker archive [--dry] [--list] [--restore] [ids…] [--kinds a,b] [--days n]: notes out of
  // serving and upkeep, kept for review (ops.js:archiveNotes); maintenance runs the same rules
  const cfg = archiveConfig(store);
  if (flags.list) {
    const arch = store.list().filter(n => n.archived);
    for (const n of arch) out(`${String(n.kind).padEnd(10)} ${n.id.padEnd(45)} ${n.archived.at.slice(0, 10)}  ${n.archived.reason}  ${n.title}`);
    out(`${arch.length} archived notes (rules: kinds ${cfg.kinds.join(', ')}; not served in ${cfg.unservedDays} days${cfg.enabled ? '' : '; archive: false in the config'})`);
    return;
  }
  const over = {};
  if (typeof flags.kinds === 'string') over.kinds = flags.kinds.split(',').map(s => s.trim()).filter(Boolean);
  if (flags.days !== undefined) over.unservedDays = Number(flags.days) || 0;
  if (!pos.length && !flags.restore) over.enabled = true; // asked by hand: the rules apply even with archive: false in the config
  const done = archiveNotes(store, { dry: !!flags.dry, ids: pos.length ? pos : undefined, restore: !!flags.restore, ...over });
  for (const d of done) out(`${flags.restore ? 'restored' : flags.dry ? 'would archive' : 'archived'}  ${d.id}  [${d.kind}] ${d.title}${d.reason ? `  (${d.reason})` : ''}`);
  out(`${done.length} ${done.length === 1 ? 'note' : 'notes'} ${flags.restore ? 'restored' : flags.dry ? 'would be archived' : 'archived'}`);
  return;
}

async function phraseCommand(ctx) {
  const { pos, flags, store, out } = ctx;
  // how a user would put what each note is about; notes that have it for their present text are left (--force)
  let notes = store.list().filter(n => n.status !== 'invalid' && (!pos.length || pos.includes(n.id)));
  if (!flags.force) notes = notes.filter(n => !n.says?.length || !n.search || n.saysFor !== phraseKey(n));
  const per = 8, conc = Number(flags.conc) || 4;
  const groups = []; for (let i = 0; i < notes.length; i += per) groups.push(notes.slice(i, i + per));
  let n = 0, tokens = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (groups.length) {
      const g = groups.shift();
      try { const r = await phraseNotes(store, g, { model: flags.model }); n += r.done.length; tokens += r.tokens || 0; }
      catch (e) { out(`phrase: ${g.length} notes skipped (${String(e.message).slice(0, 120)})`); }
    }
  }));
  out(`phrasings written for ${n} of ${notes.length} notes${tokens ? ` (~${formatTokens(tokens)} tokens)` : ''}`);
  return;
}

export const commands = {
  'orient': orientCommand,
  'lookup': lookupCommand,
  'find': findCommand,
  'drilldown': drilldownCommand,
  'system': systemCommand,
  'list': listCommand,
  'show': showCommand,
  'rm': rmCommand,
  'add': addCommand,
  'feedback': feedbackCommand,
  'relink': relinkCommand,
  'rehash': rehashCommand,
  'archive': archiveCommand,
  'phrase': phraseCommand,
};
