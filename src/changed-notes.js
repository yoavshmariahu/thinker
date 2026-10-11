// Notes resting on the code under review. The prompt hook keys its bundle on the request, which for
// a review ("look at this change for bugs") names no code: on the held-out review benchmark the hook
// and the agent's own orient served nothing in 15 of 15 sessions while the cache held notes on the
// changed file in 10. A session that starts with a change in progress is served the notes review
// itself would consult first (review.js:selectNotes, the `direct` notes), whatever the request says.
//
// The change is the branch against the default branch plus whatever is uncommitted on top: a review
// is usually asked for on a pull request, whose commits sit on a branch with a clean working tree. On
// the default branch itself the change is the working tree against HEAD.
import { execFileSync } from 'node:child_process';
import { resolveScope, collectChange, makeReader, selectNotes } from './review.js';
import { renderNote } from './rank.js';

const NONE = { text: '', included: [], files: [] };

// origin's HEAD when there is a remote, else a local main or master; null when none exists
export function defaultBranchRef(repo) {
  const g = args => { try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); } catch { return null; } };
  const target = g(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
  if (target) return target;
  for (const name of ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']) if (g(['rev-parse', '--verify', '-q', name])) return name;
  return null;
}

export function changedCodeNotes(store, { session, client, max = 3, exclude = new Set() } = {}) {
  if (!store.exists() || store.config().changedNotes === false) return NONE;
  let change, reader;
  try {
    const base = defaultBranchRef(store.repo);
    const scope = resolveScope(store.repo, base ? { base } : {});   // merge-base with the default branch, or HEAD on it
    change = collectChange(store.repo, scope);
    if (!change.files?.length) return NONE;
    reader = makeReader(store.repo, scope);
  } catch { return NONE; }
  const live = store.list().filter(n => n.status !== 'invalid' && !n.archived && !exclude.has(n.id) && !(session && (n.servedIn || []).includes(session)));
  if (!live.length) return NONE;
  const { direct } = selectNotes(live, change, reader);   // sorted: symbol-level deps the change altered first
  const pick = direct.slice(0, max);
  if (!pick.length) return NONE;
  if (session) for (const n of pick) { n.uses = (n.uses || 0) + 1; n.servedIn = [...(n.servedIn || []), session].slice(-30); store.put(n); }
  const files = [...new Set(change.files.map(f => f.path))];
  const shown = files.slice(0, 6).join(', ') + (files.length > 6 ? `, and ${files.length - 6} more` : '');
  const intro = `Notes from earlier sessions about code this change touches (${shown}). They state what this code was made to do; check the change against them, and keep reading what the change needs.`;
  const text = `<thinker-cache>\n${intro}\n\n${pick.map(n => renderNote(n)).join('\n\n')}\n</thinker-cache>`;
  store.log({ op: 'changed', session, client: client || 'cli', files, served: pick.map(n => n.id) });
  return { text, included: pick, files };
}
