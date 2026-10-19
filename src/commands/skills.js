// `thinker skills`: the skill files of this checkout as the cache sees them (skills.js). Cards are
// written by maintenance and by a build; here they are listed, scanned by hand, audited by hand,
// reviewed by a person, and one of several duplicates pinned.
import fs from 'node:fs';
import path from 'node:path';
import { scanSkills, auditSkill, reviewSkill, dedupeSkills, skillRows, renderSkills, skillsLine, isSkill } from '../skills.js';
import { refresh } from '../ops.js';
import { skillSuggestOn, seedSkillEvidence, ensureSeeded, loadEvidence, emptyEvidence, suggestFrom, skillSuggestConfig } from '../skill-suggest.js';

async function skillsCommand(ctx) {
  const { pos, flags, store, out } = ctx;
  const sub = pos[0];
  if (!sub || sub === 'list') {
    refresh(store, store.list().filter(isSkill));
    if (flags.json) return out(JSON.stringify(skillRows(store), null, 2));
    return out(renderSkills(skillRows(store)));
  }
  if (sub === 'scan') {
    const r = await scanSkills(store, { limit: Number(flags.limit) || 20, again: !!flags.again, dry: !!flags.dry, model: flags.model, phase: 'manual', onSkill: f => { if (!flags.quiet && !flags.dry) out(`reading ${f}`); } });
    if (flags.dry) { for (const f of r.skills) out(`would read ${f}`); for (const x of r.removed) out(`would retire ${x.id} (${x.file} removed)`); }
    for (const x of r.saved) out(`saved   ${x.id}  ${x.file}`);
    for (const x of r.updated) out(`updated ${x.id}  ${x.file}${x.wasBroken ? '  (back from out of date)' : ''}`);
    for (const d of r.duplicates) out(`duplicates: ${d.kept} is served; ${d.dropped.join(', ')} archived as its duplicate${d.dropped.length === 1 ? '' : 's'}`);
    return out(skillsLine(r));
  }
  if (sub === 'audit') {
    const n = pos[1] && store.get(pos[1]);
    if (!n || !isSkill(n)) throw new Error('usage: thinker skills audit <skill note id>');
    const [fresh] = refresh(store, [n]);
    const r = await auditSkill(store, fresh, { model: flags.model });
    out(`${r.verdict}${r.reason ? `: ${r.reason}` : ''}`);
    for (const i of r.issues || []) out(`  - ${i.claim}${i.actual ? ` → ${i.actual}` : ''}${i.pointer ? ` [${i.pointer}]` : ''}`);
    return;
  }
  if (sub === 'review') {
    const r = reviewSkill(store, pos[1] || '');
    if (r.error) throw new Error(r.error);
    return out(`reviewed ${r.note.id}: served and audited again`);
  }
  if (sub === 'prefer') {
    const n = pos[1] && store.get(pos[1]);
    if (!n || !isSkill(n)) throw new Error('usage: thinker skills prefer <skill note id>');
    const file = path.join(store.dir, 'config.json');
    const cfg = store.config();
    cfg.skills = { ...(cfg.skills || {}), prefer: [...new Set([n.id, ...(cfg.skills?.prefer || [])])] };
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
    const d = dedupeSkills(store);
    return out(`${n.id} is served among its duplicates${d.length ? ` (${d.map(x => `${x.kept} over ${x.dropped.join(', ')}`).join('; ')})` : ''}`);
  }
  if (sub === 'dedupe') {
    const d = dedupeSkills(store, { dry: !!flags.dry });
    for (const x of d) out(`${x.kept} is served; ${x.dropped.join(', ')} ${flags.dry ? 'would be' : ''} archived as duplicates`);
    return out(`${d.length} duplicate ${d.length === 1 ? 'group' : 'groups'}`);
  }
  // skill suggestions by file (skill-suggest.js; off unless harness.skillSuggest): seed the evidence from named
  // transcripts (an eval seeds from its training tasks only), or from this machine's recent sessions; preview a file
  if (sub === 'seed') {
    const files = pos.slice(1);
    const r = files.length ? seedSkillEvidence(store, files) : (ensureSeeded(store), { sessions: Object.keys(loadEvidence(store)?.sessions || {}).length, files: null });
    out(`skill evidence: ${r.sessions} sessions credited${r.files != null ? ` of ${r.files} transcripts` : ''}${skillSuggestOn(store) ? '' : ' (suggestions are off here: harness.skillSuggest in .thinker/config.json)'}`);
    return;
  }
  if (sub === 'suggest') {
    if (!pos[1]) throw new Error('usage: thinker skills suggest <file>');
    const ev = loadEvidence(store) || emptyEvidence(), picks = suggestFrom(ev, pos[1], { cfg: skillSuggestConfig(store) });
    if (flags.json) return out(JSON.stringify({ picks, greedy: picks.greedy }, null, 2));
    out(picks.length ? picks.map(p => `${p.skill}  sample ${p.score.toFixed(2)}  mean ${p.mean.toFixed(2)}`).join('\n') : 'nothing to suggest');
    return;
  }
  throw new Error(`unknown: thinker skills ${sub}. Subcommands: list, scan, audit <id>, review <id>, prefer <id>, dedupe, seed [transcripts...], suggest <file>`);
}

export const commands = { skills: skillsCommand };
