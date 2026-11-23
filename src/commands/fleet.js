// `thinker config set|unset api-key` and `thinker status`: the fleet's two doors on a machine (fleet.js).
// `fleet-report` is the hook's own: the one process left waiting to send at the five-minute mark.
// `status` also says what the org has left for thinker's hosted models (hosted.js), where the endpoint
// answers: the balance is the server's own figure, read now, and nothing here computes one.
import { setFleetKey, unsetFleetKey, fleetStatus, sendFleetReport } from '../fleet.js';
import { hostedCredits } from '../hosted.js';

async function configCommand({ pos = [], out }) {
  const [verb, name, value] = pos;
  if (name !== 'api-key' || !['set', 'unset'].includes(verb)) { out('Usage: thinker config set api-key <key> | thinker config unset api-key'); process.exitCode = 1; return; }
  if (verb === 'unset') { out(unsetFleetKey() ? 'Removed the API key. This machine runs locally.' : 'No API key was set.'); return; }
  try { setFleetKey(value); } catch (error) { out(error.message); process.exitCode = 1; return; }
  const status = await fleetStatus();
  out(status.reachable ? `Saved. Connected to fleet${status.orgName ? ` (org: ${status.orgName})` : ''}.`
    : status.reason === 'invalid-key' ? 'Saved, but the fleet refused it: the API key is invalid or revoked.'
      : 'Saved. The fleet could not be reached just now; thinker keeps running locally and reports when it can.');
}

async function statusCommand({ flags = {}, out }) {
  const status = await fleetStatus();
  const credits = status.mode === 'fleet' ? await hostedCredits({ fresh: true }) : null;
  const known = credits && !credits.error ? { balanceUsd: credits.balance, grantedUsd: credits.granted, spentUsd: credits.spent } : null;
  if (flags.json) { out(JSON.stringify({ ...status, ...(known ? { credits: known } : {}) }, null, 2)); return; }
  if (status.mode === 'local') { out(`mode     local (${status.reason})\nmachine  ${status.machineId}`); return; }
  out([`mode     fleet (API key from ${status.keyFrom === 'env' ? 'THINKER_API_KEY' : 'thinker config'})`,
    `org      ${status.orgName || 'unknown'}`, `machine  ${status.machineId}`,
    `fleet    ${status.reachable ? 'reachable' : status.reason === 'invalid-key' ? 'API key invalid or revoked, running locally' : 'unreachable, running locally'}`,
    ...(known ? ['credits  $' + known.balanceUsd.toFixed(2) + ' for thinker\'s hosted models'] : [])].join('\n'));
}

async function fleetReportCommand({ flags = {} }) {
  const at = Number(flags.at) || 0;
  const wait = Math.min(Math.max(0, at - Date.now()), 10 * 60_000);
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  await sendFleetReport();
}

export const commands = { config: configCommand, status: statusCommand, 'fleet-report': fleetReportCommand };
