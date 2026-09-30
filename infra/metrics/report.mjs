// Shared by the HTTP writer and the S3 importer. Never derive metric values from
// import time: repeated imports must produce exactly the same report.
const metrics = {
  cache_total_notes: 'cacheSize.totalNotes',
  cache_total_bytes: 'cacheSize.totalBytes',
  cache_repositories_count: 'cacheSize.repositoriesCount',
  requests_total: 'effectiveness.requestsTotal',
  requests_answered: 'effectiveness.requestsAnswered',
  hit_rate: 'effectiveness.hitRate',
  servings_prompt: 'effectiveness.servings.prompt',
  servings_file: 'effectiveness.servings.file',
  servings_lookup: 'effectiveness.servings.lookup',
  tokens_served: 'effectiveness.tokensServed',
  assessed_confirmed: 'effectiveness.assessed.confirmed',
  assessed_contradicted: 'effectiveness.assessed.contradicted',
  assessed_unused: 'effectiveness.assessed.unused',
  assessed_pending: 'effectiveness.assessed.pending',
  confirmation_rate: 'effectiveness.assessed.confirmationRate',
  calls_avoided: 'effectiveness.estimatedSavings.callsAvoided',
  tokens_avoided: 'effectiveness.estimatedSavings.tokensAvoided',
  net_tokens_saved: 'effectiveness.estimatedSavings.netTokensSaved',
  feedback_useful: 'effectiveness.feedback.useful',
  feedback_not_useful: 'effectiveness.feedback.notUseful',
  feedback_corrections: 'effectiveness.feedback.corrections',
  sessions_distilled: 'effectiveness.lifecycle.sessionsDistilled',
  new_notes: 'effectiveness.lifecycle.newNotes',
  notes_merged: 'effectiveness.lifecycle.notesMerged',
  prs_mined: 'effectiveness.lifecycle.prsMined',
  stale_verified: 'effectiveness.lifecycle.staleVerified',
};

export class InvalidReport extends Error {}

export function normalizeReport(key, data, receivedAt) {
  if (!data || Array.isArray(data) || typeof data !== 'object' ||
      typeof data.installId !== 'string' || !data.installId.trim() || data.installId.length > 256) {
    throw new InvalidReport('Missing or invalid installId');
  }
  const timestamp = data.timestamp ?? receivedAt;
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) {
    throw new InvalidReport('Missing or invalid timestamp');
  }
  const row = {
    file_key: key, install_id: data.installId, event: data.event ?? 'undefined',
    device_id: data.deviceId ?? null,
    version: data.version ?? 'unknown', platform: data.platform ?? 'unknown',
    timestamp: new Date(timestamp).toISOString(), period_hours: data.periodHours ?? 24,
  };
  if (row.device_id !== null && (typeof row.device_id !== 'string' || !/^v1:[a-f0-9]{64}$/.test(row.device_id))) {
    throw new InvalidReport('Invalid deviceId');
  }
  for (const field of ['event', 'version', 'platform']) {
    if (typeof row[field] !== 'string' || row[field].length > 256) throw new InvalidReport(`Invalid ${field}`);
  }
  if (!Number.isSafeInteger(row.period_hours) || row.period_hours < 0) throw new InvalidReport('Invalid periodHours');
  for (const [column, pointer] of Object.entries(metrics)) {
    const value = pointer.split('.').reduce((obj, part) => obj?.[part], data) ?? 0;
    const rate = column === 'hit_rate' || column === 'confirmation_rate';
    if (typeof value !== 'number' || !Number.isFinite(value) ||
        (!rate && !Number.isSafeInteger(value)) ||
        (column !== 'net_tokens_saved' && value < 0) || (rate && value > 1)) {
      throw new InvalidReport(`Invalid ${pointer}`);
    }
    row[column] = value;
  }
  const kinds = data.cacheSize?.kinds;
  if (kinds != null && (typeof kinds !== 'object' || Array.isArray(kinds) ||
      Object.values(kinds).some(n => !Number.isSafeInteger(n) || n < 0))) {
    throw new InvalidReport('Invalid cacheSize.kinds');
  }
  row.raw_json = JSON.stringify(data);
  return row;
}

export async function insertReport(db, key, data, receivedAt) {
  const row = normalizeReport(key, data, receivedAt);
  const columns = Object.keys(row);
  const result = await db.query(
    `INSERT INTO reports (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (file_key) DO NOTHING RETURNING file_key`, Object.values(row));
  if (result.rowCount === 0) {
    const existing = await db.query('SELECT raw_json = $2::jsonb AS matches FROM reports WHERE file_key = $1', [key, row.raw_json]);
    if (!existing.rows[0]?.matches) throw new Error(`Report key already exists with different data: ${key}`);
  }
  return result.rowCount === 1;
}
