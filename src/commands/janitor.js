// `thinker janitor`: the janitor's inbox and what it has done, as the page's Janitor tab shows them (janitor.js:
// janitorView, one computation). `run` sends it round now (free: no model call), `do <n>` does what an item offers,
// `leave <n>` leaves it alone for a week, `undo <id>` takes back something it did, `auto on|off` says whether a
// round may sweep and put up pull requests by itself here.
import fs from 'node:fs';
import path from 'node:path';
import { janitorView, janitorRound, janitorDo, janitorDismiss, janitorUndo, janitorConfig, renderJanitor } from '../janitor.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function setAuto(store, on) {
  const file = path.join(store.dir, 'config.json');
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const cur = cfg.janitor && typeof cfg.janitor === 'object' ? cfg.janitor : {};
  cfg.janitor = { ...cur, auto: on };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
}

async function janitorCommand({ pos, flags, store, out }) {
  const [verb, ...refs] = pos;
  const fail = msg => { out(msg); process.exitCode = 1; };
  if (verb === 'auto') {
    const want = String(refs[0] || '').toLowerCase();
    if (!['on', 'off'].includes(want)) return fail(`thinker janitor auto takes on or off; it is ${janitorConfig(store).auto ? 'on' : 'off'} here`);
    setAuto(store, want === 'on');
    out(want === 'on' ? 'The janitor now acts on its own here: a round sweeps merged worktrees and branches, and puts up one pull request at a time for a section nobody needs. A tool is still only switched off by you.' : 'The janitor only proposes here again: nothing is swept and no pull request is put up until you say so.');
    return;
  }
  if (verb === 'run') {
    const r = await janitorRound(store);
    if (flags.quiet) return;
    if (r.skipped) return out('The janitor is off here (janitor in .thinker/config.json).');
    for (const d of r.did) out(`🧹 ${d.said}`);
    for (const e of r.errors) out(`   could not look at ${e.chore}: ${e.message}`);
    out(`🧹 Round done: ${r.found ? `${plural(r.found, 'thing')} in the inbox` : 'all clean'}${r.did.length ? `, ${plural(r.did.length, 'thing')} done on its own` : ''}. \`thinker janitor\` lists them.`);
    return;
  }
  if (verb === 'do' || verb === 'leave') {
    if (!refs.length) return fail(`thinker janitor ${verb} <n>: the number of an inbox item (\`thinker janitor\` lists them), several with spaces or commas, or all`);
    let wanted = refs.flatMap(r => String(r).split(',')).map(r => r.trim()).filter(Boolean);
    // numbers move as items leave the inbox: resolve them all to ids first
    const items = janitorView(store).items;
    if (wanted.some(r => /^all$/i.test(r))) wanted = items.filter(i => verb === 'leave' || i.action).map(i => i.id);
    else wanted = wanted.map(r => items.find(i => i.id === r || String(i.n) === r)?.id || r);
    for (const ref of wanted) {
      const r = verb === 'do' ? await janitorDo(store, ref) : janitorDismiss(store, ref);
      if (r.error) fail(r.error); else out(`🧹 ${r.said}${r.done && verb === 'do' ? '' : ''}`);
    }
    return;
  }
  if (verb === 'undo') {
    if (!refs[0]) return fail('thinker janitor undo <id>: the id beside the line under Done lately');
    const r = janitorUndo(store, refs[0]);
    return r.error ? fail(r.error) : out(`🧹 ${r.said}`);
  }
  if (verb) return fail(`thinker janitor does not know ${verb}: run, do <n>, leave <n>, undo <id>, auto on|off`);
  // the first look in a repository it has never been round: go round now, it costs nothing
  if (janitorConfig(store).enabled && !janitorView(store).lastRound) await janitorRound(store);
  const v = janitorView(store);
  if (flags.json) { out(JSON.stringify(v, null, 2)); return; }
  for (const l of renderJanitor(v, { feed: flags.all ? v.feed.length : 12 })) out(l);
  out('', 'thinker janitor run sends it round now (no model call), do <n> does what an item offers, leave <n> leaves it a week, undo <id> takes an action back, auto on|off lets a round act by itself; `thinker ui --tab janitor` is the page.');
}

export const commands = { janitor: janitorCommand };
