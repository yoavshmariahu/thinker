// `thinker settings`: how thinker works, set by hand, as on the page's Settings tab (settings.js: one list, one view,
// one way to change a value). With no verb it prints the machine's settings as they stand, a group a heading and a
// setting under the one it depends on; a setting whose parent is off is not printed, as the page does not show it.
// `set <id> <value>` changes one: a switch takes on or off, a choice one of its values. One set for the machine;
// there is none per repository.
import { settingsView, setSetting, renderSettings } from '../settings.js';

async function settingsCommand({ pos, flags, out }) {
  const [verb, id, ...rest] = pos;
  if (verb === 'set') {
    if (!id || !rest.length) { out('thinker settings set <id> <value>: the id is the name in brackets beside a setting.'); process.exitCode = 1; return; }
    const r = await setSetting(id, rest.join(' '));
    if (r.error) { out(r.error); process.exitCode = 1; return; }
    if (flags.json) { out(JSON.stringify(r.view, null, 2)); return; }
    out(r.said);
    return;
  }
  if (verb) { out(`thinker settings does not know ${verb}. \`thinker settings set <id> <value>\` changes one.`); process.exitCode = 1; return; }
  const v = settingsView();
  if (flags.json) { out(JSON.stringify(v, null, 2)); return; }
  for (const l of renderSettings(v)) out(l);
  out('', '`thinker settings set <id> <value>` changes one (a switch: on or off); `thinker ui --tab settings` is the page.');
}

export const commands = { settings: settingsCommand };
