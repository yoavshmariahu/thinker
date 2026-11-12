import { execFile } from 'node:child_process';
// An unavailable cache must not interrupt the host agent. Bound time and output,
// use argv rather than a shell, and inherit experiment/learning controls.
export function hookRunner(config) {
  return (what, event) => new Promise(resolve => {
    if (process.env.THINKER_IN_LLM) return resolve('');
    // installed for one checkout (config.repo), or machine-wide: the hook takes the checkout from the
    // session's directory (event.cwd), as the other agents' user-level hooks do
    const args = [config.cli, 'hook', what, '--client', config.client, ...(config.repo ? ['--repo', config.repo] : ['--user'])];
    if (config.learn) args.push('--record');
    else if (what === 'stop') args.push('--no-distill');
    if (config.late && what === 'tool') args.push('--late');
    // The host may be a Bun executable (OpenCode), not a Node executable. The delegation hook (delegate.js)
    // runs a subagent inside the call, minutes rather than seconds; every other hook answers at once.
    const timeout = what === 'pretool' ? 300_000 : 15_000;
    // `config.env` rides over the host's environment: OpenCode runs plugins in a long-lived server process, so a
    // checkout's copy cannot be driven from the shell that starts `opencode run`.
    const env = config.env ? { ...process.env, ...config.env } : process.env;
    const child = execFile('node', args, { cwd: config.repo || event.cwd || process.cwd(), timeout, maxBuffer: 1024 * 1024, env }, (err, stdout) => resolve(err ? '' : stdout.trim()));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(event));
  });
}

