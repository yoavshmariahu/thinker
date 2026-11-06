import { randomUUID } from 'node:crypto';
import { InvalidReport } from './report.mjs';
import { normalizeMessage } from './messages.mjs';
import { normalizeErrorReport } from './errors.mjs';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Thinker-Version',
};

// What only an error report has: a list of errors, and none of the blocks a metrics snapshot is made of.
export const looksLikeErrorReport = data =>
  Array.isArray(data?.errors) && data.errors.length > 0 &&
  data.event === undefined && data.cacheSize === undefined && data.effectiveness === undefined;

export function createHandler(write, writeMessage, writeErrors) {
  return async function handler(event, context = {}) {
    context.callbackWaitsForEmptyEventLoop = false;
    const reply = (statusCode, body) => ({ statusCode, headers: HEADERS, body: body ? JSON.stringify(body) : '' });
    const method = event.requestContext?.http?.method || event.httpMethod || 'POST';
    if (method === 'OPTIONS') return reply(204);
    if (method !== 'POST') return reply(405, { error: 'Method Not Allowed' });
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
    if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) return reply(413, { error: 'Payload Too Large' });
    let data;
    try { data = JSON.parse(raw); }
    catch { return reply(400, { error: 'Invalid JSON' }); }
    if (event.rawPath === '/messages' || event.path === '/messages') {
      try {
        const message = normalizeMessage(data);
        await writeMessage(message);
        return reply(202, { status: 'accepted' });
      } catch (err) {
        if (err instanceof InvalidReport) return reply(422, { error: err.message });
        console.error('Failed to save message:', err.code || err.name);
        return reply(err.code === 'MESSAGE_CONFLICT' ? 409 : 500, { error: 'Unable to save message. Please try again.' });
      }
    }
    // thinker's own failures, sent only by an install whose person agreed to it (src/error-report.js).
    // One row per error (error_reports), so the same fault can be counted across installs.
    if (event.rawPath === '/errors' || event.path === '/errors') {
      try {
        const report = normalizeErrorReport(data);
        const id = event.requestContext?.requestId || context.awsRequestId || randomUUID();
        await writeErrors(`errors/${id}`, report, new Date().toISOString());
        return reply(202, { status: 'accepted', count: report.errors.length });
      } catch (err) {
        if (err instanceof InvalidReport) return reply(422, { error: err.message });
        console.error('Failed to record error report:', err.code || err.name);
        return reply(500, { error: 'Failed to record error report' });
      }
    }
    // An error report that reached the wrong path is still an error report. Until the `/errors` route was
    // deployed, `$default` sent it here and it was stored as an installation snapshot: 32 such rows on four
    // installs by 2026-11-05, each one device-less, event-less and all-zero, and each one that became an
    // install's newest row replaced that install's real snapshot in `v_latest_installs`. Routed by shape as
    // well as by path, so a route that moves again cannot do this.
    if (looksLikeErrorReport(data)) {
      try {
        const report = normalizeErrorReport(data);
        const id = event.requestContext?.requestId || context.awsRequestId || randomUUID();
        await writeErrors(`errors/${id}`, report, new Date().toISOString());
        return reply(202, { status: 'accepted', count: report.errors.length });
      } catch (err) {
        if (err instanceof InvalidReport) return reply(422, { error: err.message });
        console.error('Failed to record misrouted error report:', err.code || err.name);
        return reply(500, { error: 'Failed to record error report' });
      }
    }
    const key = `metrics/live/${event.requestContext?.requestId || context.awsRequestId || randomUUID()}.json`;
    const receivedAt = new Date().toISOString();
    try {
      await write(key, data, receivedAt);
      return reply(202, { status: 'accepted', key });
    } catch (err) {
      if (err instanceof InvalidReport) return reply(422, { error: err.message });
      // Do not log the report or connection configuration.
      console.error('Failed to record metrics:', err.code || err.name);
      return reply(500, { error: 'Failed to record metrics' });
    }
  };
}

