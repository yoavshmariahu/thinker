// `thinker settings`: how thinker works, set by hand, as on the page's Settings tab (settings.js: one list, one view,
// one way to change a value). With no verb it prints the settings as they stand on this machine, a group a heading
// and a setting under the one it depends on; a setting whose parent is off is not printed, as the page does not
// show it. `--here` is this repository's (the machine's values with its own over them). `set <id> <value>` changes
// one: a switch takes on or off, a choice one of its values.
import { isGitCheckout } from '../store.js';
import { settingsView, setSetting, renderSettings } from '../settings.js';

async function settingsCommand({ pos, flags, repo, store, out }) {
  const here = Boolean(flags.here);
  if (here && !isGitCheckout(repo)) { out(`${repo} is not a git repository: \`thinker settings\` without --here is the machine's.`); process.exitCode = 1; return; }
  const st = here ? store : null, scope = here ? 'repo' : 'machine';
  const [verb, id, ...rest] = pos;
  if (verb === 'set') {
    if (!id || !rest.length) { out('thinker settings set <id> <value> [--here]: the id is the name in brackets beside a setting.'); process.exitCode = 1; return; }
    const r = await setSetting(st, id, rest.join(' '), { scope });
    if (r.error) { out(r.error); process.exitCode = 1; return; }
    if (flags.json) { out(JSON.stringify(r.view, null, 2)); return; }
    out(r.said);
    return;
  }
  if (verb) { out(`thinker settings does not know ${verb}. \`thinker settings set <id> <value>\` changes one.`); process.exitCode = 1; return; }
  const v = settingsView(st, { scope });
  if (flags.json) { out(JSON.stringify(v, null, 2)); return; }
  for (const l of renderSettings(v)) out(l);
  out('', `\`thinker settings set <id> <value>${here ? ' --here' : ''}\` changes one (a switch: on or off); ${here ? 'without --here it is the machine\'s' : '--here is this repository\'s'}; \`thinker ui --tab settings\` is the page.`);
}

export const commands = { settings: settingsCommand };
