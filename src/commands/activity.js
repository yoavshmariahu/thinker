// `thinker activity`: Recent activity in the terminal, as it runs down the right of the page's chat (upkeep.js:upkeepView,
// one computation): a line an action with what it came to, and for a pull request where to read it. Nothing here is
// for the person to do: thinker does its work itself, and how it behaves -- or taking a thing back -- is said to it
// (`thinker chat`), not typed as a flag. `run` is the check itself, as maintenance starts it every four hours
// (`--look`: only look, which is all the page ever starts). The decisions and what each saved in full are `thinker
// context --history`, the pull requests `thinker prs`.
import { upkeepView, upkeepCheck, behaviorOf, renderUpkeep } from '../upkeep.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function activityCommand({ pos, flags, store, out }) {
  const [verb] = pos;
  if (verb === 'run') {
    const r = await upkeepCheck(store, { act: !flags.look });
    if (flags.quiet) return;
    if (r.skipped) return out('Thinker is switched off here. `thinker chat "look after this repository again"` turns it back on.');
    for (const d of r.did) out(`thinker: ${d.said}`);
    for (const e of r.errors) out(`  could not look at ${e.chore}: ${e.message}`);
    out(`${flags.look ? 'Looked' : 'Checked'}: ${r.did.length ? `${plural(r.did.length, 'thing')} done` : 'nothing done'}${r.pending ? `, ${r.pending} waiting ${r.pending === 1 ? 'its' : 'their'} turn` : ''}.`);
    return;
  }
  if (verb) { out(`thinker activity does not know ${verb}. It lists what thinker did; \`thinker chat "…"\` is how you tell it to do, leave or take back a thing.`); process.exitCode = 1; return; }
  // the first look in a repository thinker has never checked: look now, it costs nothing and changes nothing
  if (behaviorOf(store).level !== 'off' && !upkeepView(store).lastCheck) await upkeepCheck(store, { act: false });
  const v = upkeepView(store);
  if (flags.json) { out(JSON.stringify(v, null, 2)); return; }
  for (const l of renderUpkeep(v, { feed: flags.all ? v.feed.length : 12 })) out(l);
  out('', '`thinker chat "…"` asks thinker about any of this, tells it how to behave, or has it take a thing back; `thinker ui` is the page.');
}

export const commands = { activity: activityCommand };
