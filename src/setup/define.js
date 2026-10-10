// Defining the desired behaviors of a system together: the person's own coding agent interviews them
// about how each part of the system must behave (beyond what its design documents already state: behavior-docs.js), drafts each behavior against the code, and saves
// only the ones the person approves. Thinker does not run that conversation; it writes the prompt
// that starts it, with what this repository already has (the behaviors in force, the drafts waiting,
// its main areas). `thinker system define` prints it and puts it on the clipboard, and `thinker
// setup` offers it as its last optional step. `thinker ui` is where the person reviews the result.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { c } from './ui.js';
import { activeBehaviors, pendingBehaviors } from '../behavior-workbench.js';
import { isBehavior } from '../behavior.js';
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
// created) in the foreground. The cache build (merged pull requests, minutes) is started in the
// background after the design documents are read (step 1), so the two never read the same document
// at once and the interview starts without waiting for it. Both are left out where they are done.
function setupStep(store) {
  if (!store) return [`0. Set thinker up here first. Behaviors belong to one repository: if this folder is not inside a git repository, ask me which repository to set up and work there. If the repository root has no .thinker/ folder, run \`thinker setup --yes --no-build --no-behaviors\` (a few seconds: it connects the agents and creates the cache, which \`thinker system add\` needs).`];
  return [];
}
function buildStep(store) {
  const build = `start \`thinker setup --build --yes --no-behaviors\` as a background command and do not wait for it: it reads the merged pull requests into the cache and takes several minutes. It can be stopped any time and keeps what it saved. Go on with the session, and tell me when it finishes.`;
  if (!store) return ` Then, if the cache has no notes yet, ${build}`;
  return store.list().some(n => !isBehavior(n)) ? '' : ` Then, since the cache has no notes yet, ${build}`;
}

// Without a store (an install outside any repository) the prompt is the general one: no counts or areas.
export function behaviorSessionPrompt(store) {
  const active = store ? activeBehaviors(store) : null, pending = store ? pendingBehaviors(store) : [], areas = store ? mainAreas(store.repo) : [];
  const fromDocs = active ? active.filter(b => b.fromDoc).length : 0;
  const L = [
    `Let's write down the desired behaviors of this system, using thinker. A desired behavior is a rule every future change must keep: something the system must always or never do, anchored to the code that enforces it. \`thinker review\` flags a change that breaks one, and blocks it if the behavior is fixed.`,
    '',
    'How to run this session:',
    ...setupStep(store),
    `1. Start from the design documents checked into the repository (READMEs beside the code, design files): what they say the system must do is the default set of behaviors${fromDocs ? `, and ${fromDocs} of the behaviors in force came from them` : ''}. Run \`thinker system docs\` and wait for it (one model call per document not read yet, a few minutes at most, so give the command a long timeout; with nothing new to read it returns at once). It saves each rule a document states as a mutable behavior that quotes the document. Then run \`thinker system\` for the behaviors in force${active ? ` (${active.length} before this run)` : ''}${pending.length ? ` and \`thinker system propose\` for the ${pending.length} drafts waiting for my decision` : ''}, and go through the ones that came from documents with me, a few at a time: show me each title and the sentence it quotes, and ask me which to keep, reword, make blocking (\`thinker system promote <id> --fixed\`) or discard (\`thinker rm <id>\`). Wait for my answer before changing any.${buildStep(store)}`,
    `2. Skim the main areas of the code${areas.length ? `: ${areas.join(', ')}` : ''}, and note what the documents and the behaviors so far do not cover.`,
    `3. Interview me, one area at a time, about what the documents leave out. Ask two or three short questions per area about how it must behave: what users and other systems rely on, security and privacy rules, data that must never be lost or exposed, how failures must be handled, limits and defaults that matter, and anything that broke before and must not break again. Ask, then wait for my answer. Do not assume an answer from the code: the code says what it does, I say what it must do.`,
    `4. For each rule we agree on, find where the code upholds it (thinker's find and drilldown tools; in a session started before thinker was installed, the \`thinker find\` and \`thinker drilldown\` commands; or search) and show me a draft: a title stating the requirement, two to five sentences, the path:Symbol pointers that enforce it, and whether it should be fixed (a change that breaks it is blocked) or mutable (a change that breaks it gets a warning). Say plainly if no code enforces it yet.`,
    `5. Save a behavior only after I say yes to that draft. Write it as JSON, {"title": ..., "body": ..., "answers": [two or three ways someone would ask about it], "deps": [{"path": ..., "symbol": ...}]}, to a temporary file, then run \`thinker system add <file> --fixed\` or \`--mutable\`. Never save one I have not approved, and never weaken or remove an existing behavior unless I ask.`,
  ];
  if (pending.length) L.push(`6. Go through the waiting drafts with me as well: for each, accept it (\`thinker system accept <id>\`, with \`--fixed\` if I want it blocking), or leave it for me to discard in \`thinker ui\`.`);
  L.push(`${pending.length ? '7' : '6'}. When we stop, run \`thinker system\` and summarize what we added. I can review and edit everything afterwards with \`thinker ui\`. If thinker was installed during this session, tell me to start a new agent session: its hooks and tools load when a session starts.`);
  L.push(`${pending.length ? '8' : '7'}. Then offer me a first code review. Run \`gh pr list --state open --limit 10\` here (skip this step if gh is missing, not signed in, or there are no open pull requests) and ask whether I'd like to try \`thinker review\` on one of them. If I pick one and the working tree is clean, note the current branch, run \`gh pr checkout <number>\` and \`thinker review --base origin/<its base branch>\`, walk me through the findings, then check out the branch I was on again. If the working tree has uncommitted changes, do not switch branches: tell me to commit or stash first. Post nothing to the pull request. If the cache build is still running, say the review will know more once it finishes.`);
  L.push('', 'Start with step ' + (store ? '1' : '0') + ', and keep me in the loop: one question at a time.');
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
  out(c.dim(`  It starts from what your design documents (READMEs) state, goes through that with you, then interviews you about the rest.`));
  out(c.dim(`  Everything stays local: behaviors are files in the repository's .thinker/ folder, and Thinker uploads none of them.\n`));
  out(c.dim('─'.repeat(74)));
  out(prompt);
  out(c.dim('─'.repeat(74)));
  out(c.dim(`\n  Review and edit them afterwards: ${c.cyan('thinker ui')}\n`));
  return { prompt, copied };
}
