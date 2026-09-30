import pg from 'pg';
import { insertReport } from './report.mjs';
import { createHandler } from './handler.mjs';

let pool;
function database() {
  if (!pool) {
    pool = new pg.Pool({
      // PGHOST/PGDATABASE/PGUSER/PGPASSWORD supplied by deployment; no credentials
      // in client releases. Lambda loads the RDS CA with NODE_EXTRA_CA_CERTS.
      ssl: { rejectUnauthorized: true },
      max: 1, connectionTimeoutMillis: 4000, idleTimeoutMillis: 60000,
      statement_timeout: 5000,
    });
    pool.on('error', err => console.error('Idle PostgreSQL connection error:', err.code));
  }
  return pool;
}

export const handler = createHandler((key, data, receivedAt) => insertReport(database(), key, data, receivedAt));
