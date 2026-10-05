// Native node:test events, serialized without losing non-enumerable Error fields.
// Mounted read-only by the Docker runner; never loaded from candidate code.
function error(e) {
  if (!e) return null;
  return { message: e.message, code: e.code, failureType: e.failureType, expected: e.expected, actual: e.actual, stack: e.stack, cause: e.cause ? error(e.cause) : undefined };
}
export default async function* reporter(source) {
  for await (const event of source) {
    if (!['test:pass', 'test:fail', 'test:summary'].includes(event.type)) continue;
    const data = { ...event.data };
    if (data.details?.error) data.details = { ...data.details, error: error(data.details.error) };
    yield `THINKER_TEST_EVENT ${JSON.stringify({ type: event.type, data }, (_, v) => typeof v === 'bigint' ? String(v) : v)}\n`;
  }
}
