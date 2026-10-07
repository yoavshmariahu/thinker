import { execFile } from 'node:child_process';
import { agentWorkflow } from '../cache-guidance.js';
// An unavailable cache must not interrupt the host agent. Bound time and output,
// use argv rather than a shell, and inherit experiment/learning controls.
export function hookRunner(config) {
  return (what, event) => new Promise(resolve => {
    if (process.env.THINKER_IN_LLM) return resolve('');
    const args = [config.cli, 'hook', what, '--client', config.client, '--repo', config.repo];
    if (config.learn) args.push('--record');
    else if (what === 'stop') args.push('--no-distill');
    if (config.late && what === 'tool') args.push('--late');
    // The host may be a Bun executable (OpenCode), not a Node executable.
    const child = execFile('node', args, { cwd: config.repo, timeout: 15000, maxBuffer: 1024 * 1024, env: process.env }, (err, stdout) => resolve(err ? '' : stdout.trim()));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(event));
  });
}
export function guidance(config) {
  return agentWorkflow({ ...config, mcp: false });
}
