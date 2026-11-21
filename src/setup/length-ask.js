// How long an answer should be: asked once per machine, at setup, and never again.
//
// Why it is a question and not something learned. The profile does read this subject from the person's
// reactions, and on this machine it got it wrong for weeks: its line about answers had three wordings and was
// followed in none of the 12 sessions it bore on, while every rewrite of it moved the answer's shape by up to 2x,
// usually the wrong way (#889, reverted by #892). Measured on 20 real prompts of the owner's that had drawn a
// bare "what", each re-answered from identical material, the wording that works is simply a number plus a rule
// about tables: no number gave a median of 164 words and a table in a quarter of answers, "under 120 words, and
// no table unless asked" gave 126 words and none, "under 60" gave 68. The number is a dial, about 1.1x what is
// asked for, so the person can set their own median in one keystroke and it never needs to be inferred again.
//
// This is the third question setup is allowed to ask (the owner's call, 2026-11-21, after seeing the measurement),
// against the house rule of one suggestion rather than three. It is asked only on a terminal, only when no setting
// exists, and answering "no preference" is recorded so nobody is asked twice.
import { answerStyle, pinnedStyleLines } from '../profile.js';
import { updateMachineConfig, readMachineConfig } from '../repo-switch.js';
import { selectMenu, c } from './ui.js';

// The numbers are the measured ones: asked for N, answers land at about 1.1 N.
export const ASK_LENGTH = [
  { label: 'Just the bottom line', note: 'about 70 words, no tables', value: 60, key: 'b' },
  { label: 'The bottom line and the numbers behind it', note: 'about 130 words, no tables', value: 120, key: 'n' },
  { label: 'Full detail', note: 'no limit; roughly 165 words here, tables where they help', value: null, key: 'f' },
];

/** Has this machine been asked already? A set number, or a recorded "no preference", both count. */
export function lengthAsked(store, { home } = {}) {
  if (answerStyle(store).words) return true;
  try { return readMachineConfig(home)?.style?.asked === true; } catch { return false; }
}

/**
 * Ask once, write the answer, and say what was set. Returns { asked, words } -- `asked: false` when there was
 * nothing to ask (no terminal, or answered before).
 */
export async function askAnswerLength({ store, out = console.log, stdin = process.stdin, stdout = process.stdout,
  select = selectMenu, update = updateMachineConfig, home, asked = lengthAsked(store, { home }) } = {}) {
  if (asked || !(stdin?.isTTY && stdout?.isTTY)) return { asked: false, words: answerStyle(store).words };
  out('');
  const pick = await select({
    header: `  ${c.bold('How much do you want in an answer?')}`,
    hint: '↑/↓ move, Enter picks · changed later with thinker profile style --words <n>',
    items: ASK_LENGTH.map(x => ({ ...x, label: `${x.label} ${c.dim(`· ${x.note}`)}` })), out, stdin, stdout,
  });
  if (!pick) return { asked: false, words: answerStyle(store).words };   // escaped: ask again next time
  const words = pick.value;
  update(home, cfg => ({ ...cfg, style: { ...(cfg.style || {}), asked: true, ...(words ? { answerWords: words } : {}) } }));
  out(words
    ? `  ${c.green('✓')} Answers here: ${pinnedStyleLines({ words })[0]}`
    : `  ${c.green('✓')} No length set; answers stay as they are.`);
  return { asked: true, words };
}
