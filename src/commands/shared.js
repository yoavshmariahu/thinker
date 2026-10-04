// Helpers more than one command module needs.
import { execFileSync } from 'node:child_process';
import { verifyNote } from '../ops.js';

// owner/name of the GitHub repository behind `origin`, or null
export function githubSlug(repo) {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
    return m ? m[1] : null;
  } catch { return null; }
}
export const hasBin = b => { try { execFileSync(b, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };

export async function verifyAll(ctx, notes) {
  const { store, flags, out } = ctx;
  let cost = 0;
  for (const n of notes) {
    try {
      const r = await verifyNote(store, n, { model: flags.model });
      cost += r.cost || 0;
      out(`${r.verdict.padEnd(12)} ${n.id}: ${r.reason}`);
    } catch (e) { out(`error        ${n.id}: ${e.message}`); }
  }
  out(`verified ${notes.length} notes ($${cost.toFixed(3)})`);
}
