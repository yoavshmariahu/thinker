// Defining the desired behaviors of a system together: the person's own coding agent interviews them
// about how each part of the system must behave, drafts each behavior against the code, and saves
// only the ones the person approves. Thinker does not run that conversation; it writes the prompt
// that starts it, with what this repository already has (the behaviors in force, the drafts waiting,
// its main areas). `thinker system define` prints it and puts it on the clipboard, and `thinker
// setup` offers it as its last optional step. `thinker ui` is where the person reviews the result.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { c } from './ui.js';
import { activeBehaviors, pendingBehaviors } from '../behavior-workbench.js';
import { planAreas } from '../topology.js';

// The main areas of the code, largest and most changed first, as directories a person recognises.
function mainAreas(repo, max = 8) {
  try {
    const dirs = [];
    for (const a of planAreas(repo, {}).areas) {
      const d = a.isFile ? path.dirname(a.dir) : a.dir;
      if (d && d !== '.' && !d.split('/').some(part => part.startsWith('.')) && !dirs.includes(d)) dirs.push(d); // hidden tool folders are not system areas
      if (dirs.length >= max) break;
    }
    return dirs;
  } catch { return []; }
}

// Step 0 sets the repository up from inside the agent session: the quick part (agents wired, .thinker/
// created) in the foreground, the cache build (merged pull requests, minutes) in the background, so the
// interview starts at once. Left out when the repository is set up and its cache has notes.
function setupStep(store) {
  const build = `start \`thinker setup --build --yes --no-behaviors\` as a background command and do not wait for it: it reads the merged pull requests into the cache and takes several minutes. It can be stopped any time and keeps what it saved. Start the interview now, and tell me when it finishes.`;
  if (!store) return [`0. Set thinker up here first. If the repository root has no .thinker/ folder, run \`thinker setup --yes --no-build --no-behaviors\` (a few seconds: it connects the agents and creates the cache, which \`thinker system add\` needs). Then, if the cache has no notes yet, ${build}`];
  if (!store.list().length) return [`0. The cache has no notes yet: ${build}`];
  return [];
}

// Without a store (an install outside any repository) the prompt is the general one: no counts or areas.
export function behaviorSessionPrompt(store) {
  const active = store ? activeBehaviors(store) : null, pending = store ? pendingBehaviors(store) : [], areas = store ? mainAreas(store.repo) : [];
  const L = [
    `Let's write down the desired behaviors of this system, using thinker. A desired behavior is a rule every future change must keep: something the system must always or never do, anchored to the code that enforces it. \`thinker review\` flags a change that breaks one, and blocks it if the behavior is fixed.`,
    '',
    'How to run this session:',
    ...setupStep(store),
    `1. Get oriented first. Run \`thinker system\` for the behaviors already in force${active ? ` (${active.length} now)` : ''}${pending.length ? ` and \`thinker system propose\` for the ${pending.length} drafts waiting for my decision` : ''}. Skim the main areas of the code${areas.length ? `: ${areas.join(', ')}` : ''}.`,
    `2. Interview me, one area at a time. Ask two or three short questions per area about how it must behave: what users and other systems rely on, security and privacy rules, data that must never be lost or exposed, how failures must be handled, limits and defaults that matter, and anything that broke before and must not break again. Ask, then wait for my answer. Do not assume an answer from the code: the code says what it does, I say what it must do.`,
    `3. For each rule we agree on, find where the code upholds it (thinker's find and drilldown tools, or search) and show me a draft: a title stating the requirement, two to five sentences, the path:Symbol pointers that enforce it, and whether it should be fixed (a change that breaks it is blocked) or mutable (a change that breaks it gets a warning). Say plainly if no code enforces it yet.`,
    `4. Save a behavior only after I say yes to that draft. Write it as JSON, {"title": ..., "body": ..., "answers": [two or three ways someone would ask about it], "deps": [{"path": ..., "symbol": ...}]}, to a temporary file, then run \`thinker system add <file> --fixed\` or \`--mutable\`. Never save one I have not approved, and never weaken or remove an existing behavior unless I ask.`,
  ];
  if (pending.length) L.push(`5. Go through the waiting drafts with me as well: for each, accept it (\`thinker system accept <id>\`, with \`--fixed\` if I want it blocking), or leave it for me to discard in \`thinker ui\`.`);
  L.push(`${pending.length ? '6' : '5'}. When we stop, run \`thinker system\` and summarize what we added. I can review and edit everything afterwards with \`thinker ui\`.`);
  L.push('', 'Start with the area you think matters most, and ask me your first question.');
  return L.join('\n');
}

// pbcopy, wl-copy, xclip or clip, whichever this machine has; false if none took it.
export function copyToClipboard(text) {
  const tries = process.platform === 'darwin' ? [['pbcopy', []]] : process.platform === 'win32' ? [['clip', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [cmd, args] of tries) {
    try { const r = spawnSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] }); if (r.status === 0) return true; } catch {}
  }
  return false;
}

// Print the prompt between two rules, with nothing on its lines but the prompt, so it copies cleanly.
export function printBehaviorSession(store, { out = console.log, copy = true } = {}) {
  const prompt = behaviorSessionPrompt(store);
  const copied = copy && Boolean(process.stdout.isTTY) && copyToClipboard(prompt);
  out(`\n  ${c.yellow('*')} ${c.magenta('~')} ${c.yellow('*')}  ${c.bold('Define your system behaviors with your coding agent')}`);
  const where = store ? 'this repository' : 'a repository where you ran thinker setup';
  out(c.dim(`  Paste this into a new session of your coding agent in ${where}${copied ? ' (it is on your clipboard)' : ''}.`));
  out(c.dim(`  It will interview you about each part of the system and save only the behaviors you approve.`));
  out(c.dim(`  Everything stays local: behaviors are files in the repository's .thinker/ folder, and Thinker uploads none of them.\n`));
  out(c.dim('─'.repeat(74)));
  out(prompt);
  out(c.dim('─'.repeat(74)));
  out(c.dim(`\n  Review and edit them afterwards: ${c.cyan('thinker ui')}\n`));
  return { prompt, copied };
}
