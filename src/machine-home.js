// Who may write or restart this machine's service entries: the proxy's LaunchAgent or systemd unit, the telemetry
// schedule, the update schedule. One answer, asked by all three writers (proxy-service.js, telemetry.js, update.js).
//
// A service manager's entry is one per account, not one per THINKER_HOME: `launchctl bootstrap gui/<uid>` registers
// the label for the person whoever asked, and it neither reads `$HOME` nor knows what a THINKER_HOME is. So only the
// machine's own home may touch it, and "the machine's own" has to be decided from something the environment cannot
// move. Until 2026-11-21 it was decided from `os.homedir()`, which answers `$HOME` first. A test file run outside
// `npm test` spawned the CLI with `HOME=<a temp directory>` and nothing else changed: `<temp>/.thinker` was then
// `os.homedir()/.thinker`, the run counted as the machine, booted the person's proxy out of launchd and registered
// its own (a test copy's `cli.js` on another port, with `THINKER_HOME` in the temp directory) under the same label.
// The proxy launchd then started had the real `$HOME` and that temp `THINKER_HOME`, and its own start-up wrote the
// person's `~/Library/LaunchAgents/com.thinker.telemetry.plist` to run the test copy against the temp home every
// hour. The person's proxy ran outside launchd from then on, with nothing to start it again if it died.
//
// The account's home comes from the password database (`os.userInfo()`), which no variable changes. The machine's
// home is `<that>/.thinker`, and a run owns the service entries only when its THINKER_HOME is that directory and it
// is not a test. Every other home -- a test's, a benchmark's, a scratch install's, a `HOME` pointed somewhere else --
// keeps its entries in a directory of its own and never reaches launchctl, systemctl or crontab.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTestMode } from './test-mode.js';

// The account's home as the system has it. An account with no entry (a container run as a bare uid) has only `$HOME`
// to go by, and no service manager of its own to protect.
export function accountHome() {
  try { const h = os.userInfo().homedir; if (h) return h; } catch { /* no entry for this uid */ }
  return os.homedir();
}

const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// `machine`: { account, env }, for a test that stands a temporary directory in for the account's home
export function ownsMachine(home, { account = accountHome(), env = process.env } = {}) {
  return !isTestMode(env) && !!home && real(home) === real(path.join(account, '.thinker'));
}

// Where a home's entries live: the account's own directories for the machine's home, a directory under the home for
// any other. Never under `$HOME`: an entry there would be loaded into the account's domain all the same.
export function launchAgentPath(home, label, machine = {}) {
  const dir = ownsMachine(home, machine) ? path.join(machine.account || accountHome(), 'Library', 'LaunchAgents') : path.join(home, 'LaunchAgents');
  return path.join(dir, `${label}.plist`);
}
export function systemdUserDir(home, machine = {}) {
  if (!ownsMachine(home, machine)) return path.join(home, 'systemd-user');
  return path.join((machine.env || process.env).XDG_CONFIG_HOME || path.join(machine.account || accountHome(), '.config'), 'systemd', 'user');
}

export const NOT_THE_MACHINE = 'not the machine\'s own THINKER_HOME';
