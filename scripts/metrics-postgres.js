#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { insertReport, normalizeReport } from '../infra/metrics/report.mjs';

export function aws(args, { profile = 'yoav', region = 'us-east-1' } = {}) {
  return execFileSync('aws', ['--profile', profile, '--region', region, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// macOS cannot reopen a Node child-process socket as /dev/stdin. Use a private
// temporary file for AWS JSON input, and remove it even when the command fails.
export function awsInput(args, input, options = {}) {
  const scratch = fileURLToPath(new URL('../.metrics-work/', import.meta.url));
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'aws-input-'));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'input.json');
  try {
    fs.writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
    return aws([...args, '--cli-input-json', `file://${file}`], options);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export function connectionOptions(options) {
  let secret = {};
  if (options.secret) {
    secret = JSON.parse(JSON.parse(aws(['secretsmanager', 'get-secret-value', '--secret-id', options.secret], options)).SecretString);
  }
  const host = options.host || secret.host || process.env.PGHOST;
  if (options['tunnel-port'] && !host) throw new Error('A tunnel needs --host (the database hostname) for TLS verification');
  const caFile = options.ca || process.env.PGSSLROOTCERT;
  return {
    host: options['tunnel-port'] ? '127.0.0.1' : host,
    port: Number(options['tunnel-port'] || secret.port || process.env.PGPORT || 5432),
    database: options.database || secret.dbname || process.env.PGDATABASE,
    user: secret.username || process.env.PGUSER,
    password: secret.password || process.env.PGPASSWORD,
    ssl: {
      rejectUnauthorized: true,
      ...(host ? { servername: host } : {}),
      ...(caFile ? { ca: fs.readFileSync(caFile, 'utf8') } : {}),
    },
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
  };
}

// S3 manifests, not the contents of an old local cache, determine what is imported.
// Comparing the ETag also catches an object changed between the list and sync.
export function readSourceReports(manifest, cacheDir, prefix) {
  return manifest.filter(item => item.Key.endsWith('.json')).map(item => {
    const relative = item.Key.slice(prefix.length);
    const file = path.resolve(cacheDir, relative);
    if (!item.Key.startsWith(prefix) || !file.startsWith(path.resolve(cacheDir) + path.sep)) {
      throw new Error(`Unexpected S3 key: ${item.Key}`);
    }
    const raw = fs.readFileSync(file);
    const etag = item.ETag?.replaceAll('"', '');
    if (raw.length !== item.Size || !/^[a-f0-9]{32}$/.test(etag || '') ||
        createHash('md5').update(raw).digest('hex') !== etag) {
      throw new Error(`S3/cache checksum mismatch for ${item.Key}; rerun the sync/import`);
    }
    const data = JSON.parse(raw);
    const receivedAt = item.LastModified;
    normalizeReport(item.Key, data, receivedAt); // Validate everything before writing anything.
    return { key: item.Key, data, receivedAt };
  });
}

export async function importReports(db, reports) {
  let inserted = 0;
  // One transaction makes a failed import visible as a failure, without a partial batch.
  await db.query('BEGIN');
  try {
    for (const report of reports) {
      if (await insertReport(db, report.key, report.data, report.receivedAt)) inserted++;
    }
    const verification = await verifyReports(db, reports);
    await db.query('COMMIT');
    return { inserted, existing: reports.length - inserted, ...verification };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

export async function verifyReports(db, reports) {
  for (const report of reports) {
    const row = normalizeReport(report.key, report.data, report.receivedAt);
    const columns = Object.keys(row);
    const checks = columns.map((name, i) => `${name} IS NOT DISTINCT FROM $${i + 1}${name === 'raw_json' ? '::jsonb' : ''}`);
    const result = await db.query(`SELECT (${checks.join(' AND ')}) AS matches FROM reports WHERE file_key = $1`, Object.values(row));
    if (!result.rows[0]?.matches) throw new Error(`PostgreSQL verification failed: ${report.key}`);
  }
  return { verified: reports.length };
}

async function main() {
  const { values: options, positionals } = parseArgs({ allowPositionals: true, options: {
    profile: { type: 'string', default: 'yoav' }, region: { type: 'string', default: 'us-east-1' },
    secret: { type: 'string' }, database: { type: 'string' }, host: { type: 'string' }, ca: { type: 'string' },
    'tunnel-port': { type: 'string' }, 'cache-dir': { type: 'string', default: '.metrics-work/s3' },
    bucket: { type: 'string', default: 'thinker-metrics-442899048927' },
    prefix: { type: 'string', default: 'metrics/' },
  } });
  const [command, sql] = positionals;
  if (!['init', 'migrate', 'verify', 'query'].includes(command)) {
    throw new Error('Usage: node scripts/metrics-postgres.js init|migrate|verify|query [SQL] --secret NAME [--tunnel-port 15432 --ca rds.pem]');
  }
  let reports;
  if (command === 'migrate' || command === 'verify') {
    if (!options.prefix.endsWith('/')) throw new Error('--prefix must end with /');
    const manifest = JSON.parse(aws(['s3api', 'list-objects-v2', '--bucket', options.bucket, '--prefix', options.prefix, '--output', 'json'], options)).Contents || [];
    fs.mkdirSync(options['cache-dir'], { recursive: true });
    aws(['s3', 'sync', `s3://${options.bucket}/${options.prefix}`, options['cache-dir'], '--only-show-errors'], options);
    reports = readSourceReports(manifest, options['cache-dir'], options.prefix);
  }
  const { default: pg } = await import('../infra/metrics/node_modules/pg/lib/index.js');
  const db = new pg.Client(connectionOptions(options));
  await db.connect();
  try {
    if (command === 'init') {
      await db.query(fs.readFileSync(new URL('../infra/metrics/schema.sql', import.meta.url), 'utf8'));
      console.log('PostgreSQL schema ready');
    } else if (command === 'migrate') console.log(JSON.stringify(await importReports(db, reports)));
    else if (command === 'verify') console.log(JSON.stringify(await verifyReports(db, reports)));
    else {
      if (!sql) throw new Error('Supply a SQL query');
      // The operator CLI defaults to read-only even with an administrative login.
      await db.query('BEGIN READ ONLY');
      const result = await db.query(sql);
      console.log(JSON.stringify(result.rows, null, 2));
      await db.query('ROLLBACK');
    }
  } finally { await db.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err.message); process.exitCode = 1; });
}
