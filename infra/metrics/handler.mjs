import { randomUUID } from 'node:crypto';
import { InvalidReport } from './report.mjs';
import { normalizeMessage } from './messages.mjs';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Thinker-Version',
};

export function createHandler(write, writeMessage) {
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

