// `thinker telemetry`: the metrics sent to the metrics service, by hand or on a schedule.
import fs from 'node:fs';
import path from 'node:path';
import { isTelemetryEnabled, getTelemetryEndpoint, buildTelemetryPayload, sendTelemetry, scheduleTelemetry, unscheduleTelemetry, isTelemetryScheduled, getTelemetryLaunchAgentPath } from '../telemetry.js';
import { thinkerHome, detectInstall } from '../update.js';

async function telemetryCommand(ctx) {
  const { flags, store, out, HERE } = ctx;
  const home = thinkerHome();
  const endpoint = getTelemetryEndpoint({ home });
  const enabled = isTelemetryEnabled({ home, store });

  if (flags.schedule || flags.hourly) {
    const install = detectInstall(path.resolve(HERE, '..'), home);
    try {
      const res = scheduleTelemetry({ home, binPath: install.binPath });
      out(`Scheduled hourly telemetry for thinker (${res.type === 'launchd' ? 'LaunchAgent: ' + res.path : 'cron: ' + res.line}).`);
    } catch (e) {
      out(`Failed to schedule hourly telemetry: ${e.message}`);
    }
    return;
  }

  if (flags.unschedule) {
    const res = unscheduleTelemetry({ home });
    if (res.unscheduled) out('Removed scheduled hourly telemetry for thinker.');
    else out('No scheduled hourly telemetry was found.');
    return;
  }

  if (flags.background) {
    if (!enabled) return;
    await sendTelemetry({ home, store, endpoint, force: !!flags.force, event: flags.event });
    return;
  }

  if (flags.send || flags.force) {
    const res = await sendTelemetry({ home, store, endpoint, force: !!flags.force, event: flags.event });
    if (!flags.quiet) {
      if (res.sent) {
        out(`Telemetry sent successfully to ${endpoint}${res.key ? ` (s3: ${res.key})` : ''}.`);
      } else {
        out(`Telemetry not sent: ${res.reason || res.error || 'unknown'}`);
        if (res.lastSent) out(`Last sent: ${new Date(res.lastSent).toLocaleString()}`);
      }
    }
    return;
  }

  const payload = buildTelemetryPayload(store, { home, days: 1, all: !flags.here, event: flags.event });
  if (flags.json) {
    out(JSON.stringify(payload, null, 2));
    return;
  }

  out('Thinker telemetry:');
  out(`  Status:       ${enabled ? 'enabled' : 'disabled (THINKER_TELEMETRY=off or config)'}`);
  const sched = isTelemetryScheduled(home);
  out(`  Schedule:     ${sched ? (process.platform === 'darwin' ? 'active (LaunchAgent: ' + getTelemetryLaunchAgentPath() + ')' : 'active (cron)') : 'inactive'}`);
  out(`  Endpoint:     ${endpoint}`);
  if (payload.event) out(`  Event:        ${payload.event}`);
  const stamp = path.join(home, 'state', 'telemetry.last');
  let lastSent = 'never';
  try {
    const st = fs.statSync(stamp);
    lastSent = new Date(st.mtimeMs).toLocaleString();
  } catch {}
  out(`  Last sent:    ${lastSent}`);
  out(`  Install ID:   ${payload.installId}`);
  out(`  Cache size:   ${payload.cacheSize.totalNotes} notes, ${(payload.cacheSize.totalBytes / 1024).toFixed(1)} KB across ${payload.cacheSize.repositoriesCount} repositories`);
  out(`  Effectiveness:${payload.effectiveness.requestsTotal} requests, ${payload.effectiveness.requestsAnswered} answered (${(payload.effectiveness.hitRate * 100).toFixed(1)}% hit rate)`);
  out(`  Confirmed:    ${payload.effectiveness.assessed.confirmed} of ${(payload.effectiveness.assessed.confirmed + payload.effectiveness.assessed.contradicted + payload.effectiveness.assessed.unused)} assessed (${(payload.effectiveness.assessed.confirmationRate * 100).toFixed(1)}%)`);
  out(`  Net tokens:   ${payload.effectiveness.estimatedSavings.netTokensSaved >= 0 ? '+' : ''}${payload.effectiveness.estimatedSavings.netTokensSaved.toLocaleString()} tokens saved (estimate)`);
  if (payload.clients?.detected?.length) {
    const activeSummary = Object.entries(payload.clients.activeRequests || {}).filter(([_, n]) => n > 0).map(([c, n]) => `${c}:${n}`).join(', ') || 'none';
    out(`  Clients:      detected: ${payload.clients.detected.join(', ')}; active requests: ${activeSummary}`);
  }
  if (payload.retrieval) {
    out(`  Retrieval:    ${payload.retrieval.staleNotesServed} stale served, ${payload.retrieval.guardTriggeredCount} guard triggers${payload.retrieval.averageDurationMs ? `, ${payload.retrieval.averageDurationMs}ms avg latency` : ''}`);
  }
  out('\nUse `thinker telemetry --send` to transmit, `--schedule` to enable hourly sending, or `--json` to view full payload.');
  return;
}

export const commands = {
  'telemetry': telemetryCommand,
};
