// Helpers more than one command module needs.
import { execFileSync } from 'node:child_process';

// owner/name of the GitHub repository behind `origin`, or null
export function githubSlug(repo) {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
    return m ? m[1] : null;
  } catch { return null; }
}
export const hasBin = b => { try { execFileSync(b, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };
