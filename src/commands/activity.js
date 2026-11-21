// `thinker activity`: Recent activity in the terminal, as the page's tab opens on it (upkeep.js:upkeepView, one
// computation): what needs the person, and what thinker did. `run` has it check this repository now, acting by itself
// where its settings let it (`--look`: only look, which is all the page ever starts); `do <n>` does what an item
// offers, `leave <n>` leaves it a week, `undo <id>` takes back something that was done. How it behaves is changed by
// talking to it (`thinker chat`), not by a flag here. The decisions and what each saved are `thinker context
// --history`, the pull requests `thinker prs`.
import { upkeepView, upkeepCheck, upkeepDo, upkeepDismiss, upkeepUndo, behaviorOf, renderUpkeep } from '../upkeep.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function activityCommand({ pos, flags, store, out }) {
  const [verb, ...refs] = pos;
  const fail = msg => { out(msg); process.exitCode = 1; };
  if (verb === 'run') {
    const r = await upkeepCheck(store, { act: !flags.look });
    if (flags.quiet) return;
    if (r.skipped) return out('Thinker is switched off here. `thinker chat "look after this repository again"` turns it back on.');
    for (const d of r.did) out(`thinker: ${d.said}`);
    for (const e of r.errors) out(`  could not look at ${e.chore}: ${e.message}`);
    out(`Looked: ${r.found ? `${plural(r.found, 'thing')} need${r.found === 1 ? 's' : ''} you` : 'nothing needs you'}${r.did.length ? `, ${plural(r.did.length, 'thing')} done on its own` : ''}${r.later ? `, ${r.later} more waiting ${r.later === 1 ? 'its' : 'their'} turn` : ''}. \`thinker activity\` lists them.`);
    return;
  }
  if (verb === 'do' || verb === 'leave') {
    if (!refs.length) return fail(`thinker activity ${verb} <n>: the number of something that needs you (\`thinker activity\` lists them), several with spaces or commas, or all`);
    let wanted = refs.flatMap(r => String(r).split(',')).map(r => r.trim()).filter(Boolean);
    // numbers move as items leave the list: resolve them all to ids first
    const items = upkeepView(store).items;
    if (wanted.some(r => /^all$/i.test(r))) wanted = items.filter(i => verb === 'leave' || i.action).map(i => i.id);
    else wanted = wanted.map(r => items.find(i => i.id === r || String(i.n) === r)?.id || r);
    for (const ref of wanted) {
      const r = verb === 'do' ? await upkeepDo(store, ref) : upkeepDismiss(store, ref);
      if (r.error) fail(r.error); else out(r.said);
    }
    return;
  }
  if (verb === 'undo') {
    if (!refs[0]) return fail('thinker activity undo <id>: the id beside the line under What thinker did');
    const r = upkeepUndo(store, refs[0]);
    return r.error ? fail(r.error) : out(r.said);
  }
  if (verb) return fail(`thinker activity does not know ${verb}: run [--look], do <n>, leave <n>, undo <id>`);
  // the first look in a repository thinker has never checked: look now, it costs nothing and changes nothing
  if (behaviorOf(store).level !== 'off' && !upkeepView(store).lastCheck) await upkeepCheck(store, { act: false });
  const v = upkeepView(store);
  if (flags.json) { out(JSON.stringify(v, null, 2)); return; }
  for (const l of renderUpkeep(v, { feed: flags.all ? v.feed.length : 12 })) out(l);
  out('', 'thinker activity run checks again now (no model call; --look only looks), do <n> does what an item offers, leave <n> leaves it a week, undo <id> takes an action back. `thinker chat "…"` tells thinker how to behave; `thinker ui --tab activity` is the page.');
}

export const commands = { activity: activityCommand };
