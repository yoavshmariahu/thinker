// Settings: how thinker works, set by hand (2026-11-21, the owner's ask: "a settings page for users to be able to
// manually control how thinker works"). One list (GROUPS), one view of it (settingsView) and one way to change a
// value (setSetting); the page's Settings tab (/api/settings) and `thinker settings` are the two doors and print
// the same rows. The chat still changes the same keys in words (chat.js `set`, through upkeep.js:setBehavior).
//
// A setting is a switch or a choice from a short list, never a number typed in: every value offered is one the
// code that reads the key accepts, so a thing cannot be set here and silently dropped there.
//
// Settings sit under one another (`parent`): what thinker may change sits under whether it changes anything, a
// read's size and model under whether reads are handed over, the profile under learning from sessions. A setting
// whose parent is off is not shown (`shown: false`) and has no effect, and **its stored value is left as it is**,
// so switching the parent back on brings back what was chosen. The parent is honoured where the key is read, not
// only here: upkeep.js stops at `level: off`, delegate.js at `enabled` (and at `reads` and `suites` for each
// kind), profile.js serves nothing where `learn.sessions` is off, hooks.js says nothing where `notice` is off,
// error-report.js sends nothing where telemetry is off.
//
// One set of settings for the machine, kept in `<THINKER_HOME>/config.json` (the owner, 2026-11-21: "don't make
// settings per repo"). `learn`, `notice` and `maintain` were read from a repository's `.thinker/config.json` alone
// until this; they are now the machine's (repo-switch.js:layeredConfig), and a repository whose own file already
// sets one still has it honoured there, as before. Neither door shows or writes a repository's file. Not here, on
// purpose: the clearing (context cutting, the owner's call), the holdouts (an experiment's arms), prices, and what
// only thinker's own upkeep needs (the schedule of the check for a release; whether a release found is asked
// about or installed is here, `update.level`, since 2026-11-24).
import { thinkerHome } from './update.js';
import { readMachineConfig, updateMachineConfig } from './repo-switch.js';
import { BEHAVIOR, STEER, SETTINGS as UPKEEP_SETTINGS, setBehavior } from './upkeep.js';
import { DELEGATE_DEFAULTS } from './delegate.js';
import { DEFAULTS as MAINTAIN_DEFAULTS } from './maintain.js';
import { NOTICE_HOURS } from './notice-cadence.js';
import { errorConsent, answerErrorOffer } from './error-report.js';
import { UPDATE_ASK } from './update-ask.js';

const days = n => (n === 1 ? 'Day' : n === 7 ? 'Week' : n === 14 ? '2 weeks' : n === 30 ? 'Month' : `${n} days`);
const hours = n => days(n / 24);
const usd = n => `$${n} a day`;
const tokens = n => (n === 0 ? 'No cap' : n >= 1e6 ? `${n / 1e6}M tokens` : `${n / 1000}k tokens`);
const MODELS = [['claude-haiku-5-5', 'Haiku 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5']];
const AUTO = ['upkeep.level', ['auto']], LOOKING = ['upkeep.level', ['auto', 'ask']];

// Every setting, in the order both doors print it. `id` is the key's path in config.json. `options` makes it a
// choice ([value, label] or a value `fmt` words); without them it is a switch. `parent`: [id, the values of it
// under which this one is shown and in force]. `section`: a small heading over a run of settings. `as`: how the page
// draws it where a plain row would not do (`cards`: a choice whose options each say what they mean; `tile`: one of a
// set of things to tick); the command prints every one as a line.
export const GROUPS = [
  { id: 'automation', title: 'Automation', about: 'What thinker changes to cut what your sessions cost, and whether it asks you first.', items: [
    { id: 'upkeep.level', as: 'cards', label: 'How much thinker does on its own', dflt: BEHAVIOR.level, help: '', options: [
      ['ask', 'Ask first', 'Asks you in one of your sessions, once a week at most, which changes to ship. Nothing changes without your yes.'],
      ['auto', 'Automatic', 'Opens pull requests and makes references of unused tools itself, where it clearly pays.'],
      ['off', 'Off', 'Stops looking.']] },
    { id: 'upkeep.prs', as: 'tile', parent: LOOKING, section: 'It may change', label: 'Instruction files', dflt: BEHAVIOR.prs,
      help: 'Shorten sections sessions rarely need, in a pull request you merge.' },
    { id: 'upkeep.remove', parent: ['upkeep.prs', [true]], label: 'Remove sections outright', dflt: BEHAVIOR.remove, help: '' },
    { id: 'upkeep.tools', as: 'tile', parent: LOOKING, label: 'Tools and MCP servers', dflt: BEHAVIOR.tools, help: 'Make a reference of a tool nobody calls, which stays callable. One you plainly use is never touched.' },
    { id: 'upkeep.skills', as: 'tile', parent: LOOKING, label: 'Skills', dflt: BEHAVIOR.skills, help: 'Switch off the ones nobody calls.' },
    { id: 'upkeep.minPerDay', parent: LOOKING, section: 'How readily', label: 'A change must save at least', dflt: BEHAVIOR.minPerDay, options: STEER.minPerDay.steps, fmt: usd,
      help: 'Each change, a day. Smaller savings are left alone.' },
    { id: 'upkeep.batchEveryDays', parent: LOOKING, label: 'A question or a pull request at most every', dflt: BEHAVIOR.batchEveryDays, options: [1, 3, 7, 14, 30], fmt: days,
      help: 'Changes go together: one question, one pull request.' },
    { id: 'upkeep.followUp', parent: AUTO, label: 'Check each change after a week', dflt: BEHAVIOR.followUp,
      help: 'And take back what did not pay or broke a rule.',
      note: v => (v['learn.sessions'] === false ? 'Learning is off, so this check sees cost alone, not broken rules.' : '') },
  ] },
  { id: 'delegation', title: 'Delegation', about: 'Simple work handed to a cheaper model. Thinking, edits and fixes stay on yours.', items: [
    { id: 'delegate.enabled', label: 'Hand simple work to a cheaper model', dflt: DELEGATE_DEFAULTS.enabled,
      help: 'It reports back and your model works from the report.' },
    { id: 'delegate.reads', parent: ['delegate.enabled', [true]], label: 'Big file reads', dflt: DELEGATE_DEFAULTS.reads,
      help: 'A subagent reports where things are. Your model still reads the lines it edits.' },
    { id: 'delegate.threshold', parent: ['delegate.reads', [true]], label: 'Reads of at least', dflt: DELEGATE_DEFAULTS.threshold, options: [2000, 4000, 8000, 16_000, 32_000, 64_000], fmt: tokens, help: '' },
    { id: 'delegate.exploreModel', parent: ['delegate.reads', [true]], label: 'Model for reads', dflt: null, options: [[null, 'Same as test runs'], ...MODELS], help: '' },
    { id: 'delegate.suites', parent: ['delegate.enabled', [true]], label: 'Whole-suite test runs', dflt: DELEGATE_DEFAULTS.suites,
      help: 'A subagent reports the summary and the failures. A single test file stays with your model.' },
    { id: 'delegate.model', parent: ['delegate.suites', [true]], label: 'Model for test runs', dflt: DELEGATE_DEFAULTS.model, options: MODELS, help: '' },
    { id: 'delegate.repeats', parent: ['delegate.enabled', [true]], label: 'Skip reading a file again', dflt: DELEGATE_DEFAULTS.repeats,
      help: 'A repeat read is answered with a pointer to the copy your model already has.' },
  ] },
  { id: 'learning', title: 'Learning', about: 'How you work, read from your sessions and kept on this machine.', items: [
    { id: 'learn.sessions', label: 'Learn from my sessions', dflt: true, help: 'One read of each session when it ends, on Opus through your own login.' },
    { id: 'learn.profile', parent: ['learn.sessions', [true]], label: 'Give agents the profile', dflt: true, help: 'What it learned, about 1,500 tokens, on the first prompt.' },
    { id: 'maintain.dailyTokens', parent: ['learn.sessions', [true]], label: 'Daily budget', dflt: MAINTAIN_DEFAULTS.dailyTokens, options: [500_000, 1_000_000, 2_000_000, 5_000_000, 0], fmt: tokens,
      help: 'A session\'s read is about 25k tokens.' },
  ] },
  { id: 'telling', title: 'Notifications', about: 'What thinker says about its own work.', items: [
    { id: 'notice.enabled', label: 'Summary at the end of a turn', dflt: true, help: 'What it saved and did, said once in a while in your agent.' },
    { id: 'notice.everyHours', parent: ['notice.enabled', [true]], label: 'At most every', dflt: NOTICE_HOURS, options: [24, 72, 168], fmt: hours, help: '' },
    { id: 'prComments', label: 'Savings comment on merged pull requests', dflt: true, help: 'Posted once, through your gh login.' },
  ] },
  { id: 'updates', title: 'Updates', about: 'New releases of thinker itself.', items: [
    { id: 'update.level', as: 'cards', label: 'When a new release is out', dflt: UPDATE_ASK.level, help: '', options: [
      ['ask', 'Ask first', 'Asks you in one of your sessions whether to install it. Nothing is installed without your yes.'],
      ['auto', 'Automatic', 'Installs it in the background, within four hours of its release.'],
      ['off', 'Off', 'Stops looking. Running thinker update yourself still installs the latest.']] },
    { id: 'update.askEveryDays', parent: ['update.level', ['ask']], label: 'A question at most every', dflt: UPDATE_ASK.askEveryDays, options: [1, 3, 7, 14, 30], fmt: days,
      help: 'About the newest release, whatever came out in between.' },
  ] },
  { id: 'privacy', title: 'Privacy', about: 'What leaves this machine.', items: [
    { id: 'telemetry', label: 'Share usage figures', dflt: true, help: 'Counts, tokens and dollars. No prompts, no code, no names.' },
    { id: 'errors', own: true, parent: ['telemetry', [true]], label: 'Share error reports', dflt: false,
      help: '`thinker errors` prints exactly what would be sent.' },
  ] },
];
const ITEMS = new Map(GROUPS.flatMap(g => g.items.map(i => [i.id, i])));

// A whole block switched off the old way (`delegate: false`, `notice: "off"`, `upkeep: false`) reads as its switch.
const BLOCK_OFF = { upkeep: { level: 'off' }, delegate: { enabled: false }, notice: { enabled: false }, update: { level: 'off' } };
const block = (cfg, key) => { const v = cfg?.[key]; return (v === false || v === 'off') && BLOCK_OFF[key] ? BLOCK_OFF[key] : v; };
const at = (cfg, id) => { const [head, key] = id.split('.'); const b = block(cfg, head); return key === undefined ? b : b && typeof b === 'object' ? b[key] : undefined; };
const put = (cfg, id, v) => {
  const [head, key] = id.split('.');
  if (key === undefined) return { ...cfg, [head]: v };
  const b = block(cfg, head);
  return { ...cfg, [head]: { ...(b && typeof b === 'object' ? b : {}), [key]: v } };
};
const optionsOf = (item, value) => {
  if (!item.options) return null;
  const opts = item.options.map(o => (Array.isArray(o) ? { value: o[0], label: o[1], ...(o[2] ? { about: o[2] } : {}) } : { value: o, label: item.fmt ? item.fmt(o) : String(o) }));
  // a value set another way (the chat's "more like this", the file by hand) is still the value: it is listed, as it is
  if (!opts.some(o => o.value === value)) opts.push({ value, label: item.fmt && typeof value === 'number' ? item.fmt(value) : String(value) });
  return opts;
};
const valid = (item, v) => v !== undefined && (item.options ? true : typeof v === 'boolean');

/** The machine's settings as they stand. Every row carries whether it is shown. */
export function settingsView({ home = thinkerHome() } = {}) {
  const machine = readMachineConfig(home);
  const values = {};
  for (const item of ITEMS.values()) {
    const v = item.own ? errorConsent(home) === 'yes' : at(machine, item.id);
    values[item.id] = item.own || valid(item, v) ? v : item.dflt;
  }
  const on = id => { const p = ITEMS.get(id).parent; return !p || (p[1].includes(values[p[0]]) && on(p[0])); };
  const depth = id => { const p = ITEMS.get(id).parent; return p ? 1 + depth(p[0]) : 0; };
  const groups = GROUPS.map(g => ({ id: g.id, title: g.title, about: g.about, items: g.items.map(i => ({
    id: i.id, label: i.label, help: i.help, kind: i.options ? 'choice' : 'switch', value: values[i.id], dflt: i.dflt,
    ...(i.options ? { options: optionsOf(i, values[i.id]) } : {}), ...(i.section ? { section: i.section } : {}), ...(i.as ? { as: i.as } : {}),
    parent: i.parent ? i.parent[0] : null, depth: depth(i.id), shown: on(i.id),
    ...(i.note && i.note(values) ? { note: i.note(values) } : {}),
  })) }));
  return { groups };
}

const BOOL = { true: true, on: true, yes: true, false: false, off: false, no: false };
// what a door sent, as the value the key takes: a switch is on or off, a choice is one of the values offered
function coerce(item, raw) {
  if (!item.options) return typeof raw === 'boolean' ? raw : BOOL[String(raw).toLowerCase()];
  const hit = optionsOf(item, item.dflt).find(o => o.value === raw || String(o.value) === String(raw) || (o.value === null && ['', 'same', 'default'].includes(String(raw).toLowerCase())));
  return hit ? hit.value : undefined;
}

/** One setting changed, on this machine. Returns what it is now in words and the view after it, or what was wrong. */
export async function setSetting(id, raw, { home = thinkerHome() } = {}) {
  const item = ITEMS.get(id);
  if (!item) return { error: `there is no setting called ${id}` };
  const v = coerce(item, raw);
  if (v === undefined) return { error: `${id} cannot be ${JSON.stringify(raw)}: ${item.options ? optionsOf(item, item.dflt).map(o => o.value).join(', ') : 'on or off'}` };
  const [head, key] = id.split('.');
  if (item.own) await answerErrorOffer(v ? 'yes' : 'never', { home, client: 'settings', sendFn: async () => ({ sent: false }) });
  else if (head === 'upkeep' && UPKEEP_SETTINGS[key]) { const r = setBehavior(null, key, v, { scope: 'machine', home }); if (r.error) return r; }
  else updateMachineConfig(home, cfg => put(cfg, id, v));
  const opt = item.options && optionsOf(item, v).find(o => o.value === v);
  return { id, said: `${item.label}: ${opt ? opt.label : v ? 'on' : 'off'}`, view: settingsView({ home }) };
}

/** The view in lines, as `thinker settings` prints it: the rows the page shows, under their groups. */
export function renderSettings(view) {
  const lines = ['Settings on this machine'];
  for (const g of view.groups) {
    const rows = g.items.filter(i => i.shown);
    if (!rows.length) continue;
    lines.push('', g.title);
    for (const i of rows) {
      const said = i.kind === 'choice' ? i.options.find(o => o.value === i.value)?.label : i.value ? 'on' : 'off';
      lines.push(`${'  '.repeat(i.depth + 1)}${i.label}: ${said}   [${i.id}]${i.note ? `  (${i.note})` : ''}`);
    }
  }
  return lines;
}
