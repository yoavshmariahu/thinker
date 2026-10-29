import { InvalidReport } from './report.mjs';

// An error report from a CLI that the person agreed to send (src/error-report.js). The client scrubs
// before sending; this refuses anything that still looks like a path, a URL or a credential, so a
// client with a scrubbing bug cannot store one here either.
const LOOKS_PRIVATE = /(^|\s|['"(])\/(Users|home|root|var|opt|private)\//;
const LOOKS_LIKE_URL = /https?:\/\//i;
const LOOKS_LIKE_TOKEN = /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_.-]{20,})/;

const clean = (value, limit, what) => {
  if (typeof value !== 'string') throw new InvalidReport(`Invalid ${what}`);
  if (value.length > limit || value.includes('\0')) throw new InvalidReport(`Invalid ${what}`);
  if (LOOKS_PRIVATE.test(value) || LOOKS_LIKE_URL.test(value) || LOOKS_LIKE_TOKEN.test(value)) throw new InvalidReport(`${what} carries machine detail`);
  return value;
};

export function normalizeErrorReport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new InvalidReport('Invalid error report');
  const { installId, version = null, platform = null, errors } = data;
  if (typeof installId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(installId)) throw new InvalidReport('Invalid install ID');
  if (!Array.isArray(errors) || !errors.length || errors.length > 20) throw new InvalidReport('An error report carries 1 to 20 errors');
  if (version !== null && (typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$/.test(version))) throw new InvalidReport('Invalid version');
  if (platform !== null && (typeof platform !== 'string' || !/^[a-z0-9]{1,16}$/.test(platform))) throw new InvalidReport('Invalid platform');
  return {
    installId, version, platform,
    errors: errors.map(e => {
      if (!e || typeof e !== 'object' || Array.isArray(e)) throw new InvalidReport('Invalid error');
      if (typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) throw new InvalidReport('Invalid error time');
      const frames = e.frames === undefined ? [] : e.frames;
      if (!Array.isArray(frames) || frames.length > 20) throw new InvalidReport('Invalid frames');
      return {
        at: new Date(e.at).toISOString(),
        op: clean(e.op ?? '', 60, 'op'),
        name: clean(e.name ?? 'Error', 60, 'name'),
        code: e.code === undefined || e.code === null ? null : clean(e.code, 40, 'code'),
        message: clean(e.message ?? '', 500, 'message'),
        node: e.node === undefined || e.node === null ? null : clean(e.node, 24, 'node version'),
        platform: e.platform === undefined || e.platform === null ? null : clean(e.platform, 16, 'platform'),
        version: e.version === undefined || e.version === null ? null : clean(e.version, 32, 'version'),
        seen: Number.isInteger(e.seen) && e.seen > 0 && e.seen < 1e6 ? e.seen : 1,
        frames: frames.map(f => clean(f, 300, 'frame')),
      };
    }),
  };
}

export async function insertErrorReport(db, key, report, receivedAt) {
  const rows = report.errors;
  const values = [];
  const params = [];
  rows.forEach((e, i) => {
    const at = params.length;
    values.push(`($${at + 1}, $${at + 2}, $${at + 3}, $${at + 4}, $${at + 5}, $${at + 6}, $${at + 7}, $${at + 8}, $${at + 9}, $${at + 10}, $${at + 11}, $${at + 12}, $${at + 13}::jsonb, $${at + 14})`);
    params.push(key, i, report.installId, e.version || report.version, e.platform || report.platform, e.node,
      e.at, e.op, e.name, e.code, e.message, e.seen, JSON.stringify(e.frames), receivedAt);
  });
  await db.query(`INSERT INTO error_reports
    (file_key, idx, install_id, version, platform, node_version, occurred_at, op, name, code, message, seen, frames, received_at)
    VALUES ${values.join(', ')} ON CONFLICT (file_key, idx) DO NOTHING`, params);
}
