// Serving the cache to a Devin Cloud session (2026-11-02).
//
// A cloud session runs on Cognition's VM, not here, so none of the machine-wide wiring `connect` writes can
// reach it: the box has no Devin configuration of its own, and hooks placed in its home or user-config
// directories never fire (measured). What does fire is the **repository's own** `.devin/hooks.v1.json`,
// cloned with the code: on every prompt, with the working directory set to the checkout, and its
// `additionalContext` reaching the model (verified 2026-11-02 against a `drs sandbox-create` session, by a
// sentinel the agent repeated that existed nowhere on disk).
//
// Two properties of that door shape everything here. The config is read when the session starts and then
// cached, so it has to be committed, not written during a session. And the hook runs on a machine whose paths
// are not this one's, so the command may carry no absolute path and no `--repo`: it is the bare `thinker`
// from the snapshot's PATH, and the hook takes the checkout from its own working directory.
import fs from 'node:fs';
import path from 'node:path';

export const CLOUD_DIR = '.devin';
export const CLOUD_HOOKS_FILE = 'hooks.v1.json';
export const CLOUD_BLUEPRINT = 'blueprint.yaml';
// the one line that says a step or a hook entry is thinker's, so a rerun replaces its own and nothing else
export const MARK = 'thinker';
const EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'];

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const isOurs = c => typeof c === 'string' && /(^|\s|\/)thinker(\s|$)/.test(c) && c.includes(' hook ');

// The hooks a cloud session runs. `cli` is how thinker is called there: the bare command by default, since the
// blueprint puts it on the PATH, which is also what keeps the file portable between machines.
export function cloudHooks({ late = true, learn = true, cli = 'thinker' } = {}) {
  const cmd = (what, extra = '') => `${cli} hook ${what} --client devin${extra}`;
  const rec = learn ? ' --record' : '';
  const group = (what, extra, timeout, matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd(what, extra), timeout }] });
  const out = { UserPromptSubmit: [group('prompt', rec, 15)] };
  if (late || learn) out.PostToolUse = [group('tool', (late ? ' --late' : '') + rec, 10, '.*')];
  out.Stop = [group('stop', learn ? rec : ' --no-distill', 10)];
  if (learn) out.SessionEnd = [group('stop', rec, 10)];
  return out;
}

// Merge into whatever the repository already has: thinker's own entries are replaced, every other hook stays.
export function mergeCloudHooks(existing, ours) {
  const out = { ...(existing && typeof existing === 'object' ? existing : {}) };
  for (const ev of EVENTS) {
    const kept = (Array.isArray(out[ev]) ? out[ev] : []).filter(g => !(g?.hooks || []).some(h => isOurs(h?.command)));
    const mine = ours[ev] || [];
    if (kept.length || mine.length) out[ev] = [...kept, ...mine]; else delete out[ev];
  }
  return out;
}

// The snapshot step: install thinker so the hook has something to run, and optionally restore a cache, since
// a repository's local notes are gitignored and a clone arrives without them.
export function blueprintStep({ cacheUrl = '', repoDir = '' } = {}) {
  const lines = [`  - name: ${MARK}`, '    run: |', '      npx -y @zerotimedev/thinker --yes --no-ui'];
  if (cacheUrl) {
    lines.push(`      cd ${repoDir || '"$(git rev-parse --show-toplevel)"'}`);
    lines.push(`      thinker import ${JSON.stringify(cacheUrl)}`);
  }
  return lines.join('\n') + '\n';
}

// Where the box clones a GitHub repository, observed: ~/repos/<name>.
export const cloudRepoDir = origin => {
  const m = String(origin || '').match(/([^/:]+?)(?:\.git)?\s*$/);
  return m ? `~/repos/${m[1]}` : '';
};

// Writes what a cloud session needs, into the repository, for the person to commit. The blueprint is only
// written when thinker owns it: an existing one someone else wrote is never edited, and its step is handed
// back to be pasted, because a wrong edit there breaks every session's environment.
export function writeDevinCloud(repo, { late = true, learn = true, cacheUrl = '', origin = '', cli = 'thinker' } = {}) {
  const dir = path.join(repo, CLOUD_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const hooksFile = path.join(dir, CLOUD_HOOKS_FILE);
  const merged = mergeCloudHooks(readJson(hooksFile), cloudHooks({ late, learn, cli }));
  fs.writeFileSync(hooksFile, JSON.stringify(merged, null, 2) + '\n');

  const step = blueprintStep({ cacheUrl, repoDir: cloudRepoDir(origin) });
  const bpFile = path.join(dir, CLOUD_BLUEPRINT);
  const had = fs.existsSync(bpFile) ? fs.readFileSync(bpFile, 'utf8') : null;
  let blueprint = 'written', snippet = '';
  if (had == null) fs.writeFileSync(bpFile, 'initialize:\n' + step);
  else if (had.includes(`name: ${MARK}`)) {
    // replace our step in place, from its name line to the next step or the end of the block
    const re = new RegExp(`^ {2}- name: ${MARK}\\n(?: {4}.*\\n| *\\n)*`, 'm');
    fs.writeFileSync(bpFile, had.replace(re, step));
    blueprint = 'updated';
  } else { blueprint = 'left alone'; snippet = step; }

  return {
    files: [path.join(CLOUD_DIR, CLOUD_HOOKS_FILE), ...(snippet ? [] : [path.join(CLOUD_DIR, CLOUD_BLUEPRINT)])],
    blueprint, snippet, events: Object.keys(merged),
  };
}
