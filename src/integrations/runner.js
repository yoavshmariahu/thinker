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

// The person's answer to the warm-up offer, from the extension's own picker (pi.js): thinker records it
// and, on warm, starts the warm-up. Resolves to what thinker says, or '' when it could not run.
export function warmupAnswer(config, choice) {
  return new Promise(resolve => {
    const args = [config.cli, 'warmup', '--answer', choice, '--via', 'picker', '--client', config.client, '--repos', config.repo];
    execFile('node', args, { cwd: config.repo, timeout: 15000, env: process.env }, (err, stdout) => resolve(err ? '' : stdout.trim()));
  });
}
