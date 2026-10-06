#!/usr/bin/env node
// Run through a private database tunnel. Credentials stay in memory and are
// saved to Secrets Manager. Safe to rerun: existing logins retain passwords.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { aws, awsInput, connectionOptions } from '../../scripts/metrics-postgres.js';

const { values: options } = parseArgs({ options: {
  secret: { type: 'string' }, host: { type: 'string' }, ca: { type: 'string' },
  'tunnel-port': { type: 'string' }, profile: { type: 'string', default: 'yoav' },
  region: { type: 'string', default: 'us-east-1' },
} });
if (!options.secret || !options.host) throw new Error('--secret (RDS admin secret) and --host are required');
const database = 'thinker_metrics';
const users = ['thinker_metrics_writer', 'thinker_metrics_reader'];
const secrets = {};
for (const user of users) {
  const name = `thinker/metrics/${user.endsWith('writer') ? 'writer' : 'reader'}`;
  try {
    secrets[user] = JSON.parse(JSON.parse(aws(['secretsmanager', 'get-secret-value', '--secret-id', name], options)).SecretString);
    if (secrets[user].host !== options.host || secrets[user].dbname !== database || secrets[user].username !== user) {
      throw new Error(`Existing secret ${name} points to another database; refusing to overwrite it`);
    }
  } catch (err) {
    if (!String(err.stderr).includes('ResourceNotFoundException')) throw err;
    const secret = { username: user, password: randomBytes(32).toString('base64url'), host: options.host, port: 5432, dbname: database };
    awsInput(['secretsmanager', 'create-secret'], { Name: name, SecretString: JSON.stringify(secret) }, options);
    secrets[user] = secret;
  }
}

const db = new pg.Client(connectionOptions({ ...options, database: 'postgres' }));
await db.connect();
try {
  if (!(await db.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rowCount) {
    await db.query('CREATE DATABASE thinker_metrics');
  }
  for (const user of users) {
    if (!(await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user])).rowCount) {
      // Identifiers come from the fixed list above; PostgreSQL escapes the password.
      const { rows } = await db.query('SELECT quote_literal($1) AS password', [secrets[user].password]);
      await db.query(`CREATE ROLE ${user} LOGIN PASSWORD ${rows[0].password} CONNECTION LIMIT 10`);
    }
  }
} finally { await db.end(); }

const metrics = new pg.Client(connectionOptions({ ...options, database }));
await metrics.connect();
try {
  await metrics.query(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  await metrics.query(`
    REVOKE ALL ON DATABASE thinker_metrics FROM PUBLIC;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT CONNECT ON DATABASE thinker_metrics TO thinker_metrics_writer, thinker_metrics_reader;
    GRANT USAGE ON SCHEMA public TO thinker_metrics_writer, thinker_metrics_reader;
    GRANT SELECT, INSERT ON reports, website_messages TO thinker_metrics_writer;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO thinker_metrics_reader;
  `);
} finally { await metrics.end(); }
console.log('thinker_metrics schema and restricted writer/reader logins ready');
