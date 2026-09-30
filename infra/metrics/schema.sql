-- Every accepted report is an immutable snapshot. S3 keys remain its identity on import.
BEGIN;
CREATE TABLE IF NOT EXISTS reports (
      file_key TEXT PRIMARY KEY,
      install_id TEXT NOT NULL,
      event TEXT,
      version TEXT,
      platform TEXT,
      timestamp TIMESTAMPTZ NOT NULL,
      period_hours BIGINT,
      cache_total_notes BIGINT DEFAULT 0,
      cache_total_bytes BIGINT DEFAULT 0,
      cache_repositories_count BIGINT DEFAULT 0,
      requests_total BIGINT DEFAULT 0,
      requests_answered BIGINT DEFAULT 0,
      hit_rate DOUBLE PRECISION DEFAULT 0,
      servings_prompt BIGINT DEFAULT 0,
      servings_file BIGINT DEFAULT 0,
      servings_lookup BIGINT DEFAULT 0,
      tokens_served BIGINT DEFAULT 0,
      assessed_confirmed BIGINT DEFAULT 0,
      assessed_contradicted BIGINT DEFAULT 0,
      assessed_unused BIGINT DEFAULT 0,
      assessed_pending BIGINT DEFAULT 0,
      confirmation_rate DOUBLE PRECISION DEFAULT 0,
      calls_avoided BIGINT DEFAULT 0,
      tokens_avoided BIGINT DEFAULT 0,
      net_tokens_saved BIGINT DEFAULT 0,
      feedback_useful BIGINT DEFAULT 0,
      feedback_not_useful BIGINT DEFAULT 0,
      feedback_corrections BIGINT DEFAULT 0,
      sessions_distilled BIGINT DEFAULT 0,
      new_notes BIGINT DEFAULT 0,
      notes_merged BIGINT DEFAULT 0,
      prs_mined BIGINT DEFAULT 0,
      stale_verified BIGINT DEFAULT 0,
      raw_json JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Append so CREATE OR REPLACE VIEW can extend existing SELECT * views safely.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS device_id TEXT
  CHECK (device_id IS NULL OR device_id ~ '^v1:[a-f0-9]{64}$');
CREATE INDEX IF NOT EXISTS idx_reports_device_ts ON reports (device_id, timestamp DESC)
  WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reports_install_ts ON reports (install_id, timestamp DESC, file_key);
CREATE INDEX IF NOT EXISTS idx_reports_ts ON reports (timestamp);
CREATE INDEX IF NOT EXISTS idx_reports_event ON reports (event);
CREATE INDEX IF NOT EXISTS idx_reports_platform ON reports (platform);

CREATE OR REPLACE VIEW v_latest_installs AS
SELECT DISTINCT ON (install_id) * FROM reports
ORDER BY install_id, timestamp DESC, file_key DESC;

CREATE OR REPLACE VIEW v_active_installs AS
SELECT * FROM v_latest_installs
WHERE requests_total > 0 OR cache_total_notes > 0 OR sessions_distilled > 0;

CREATE OR REPLACE VIEW v_latest_devices AS
SELECT DISTINCT ON (device_id) * FROM reports
WHERE device_id IS NOT NULL
ORDER BY device_id, timestamp DESC, file_key DESC;

CREATE OR REPLACE VIEW v_hourly_volume AS
SELECT date_trunc('hour', timestamp AT TIME ZONE 'UTC') AS hour_utc,
       count(*) AS reports_count, count(DISTINCT install_id) AS unique_installs,
       sum(requests_total) AS total_requests, sum(tokens_served) AS total_tokens_served
FROM reports GROUP BY 1;

CREATE OR REPLACE VIEW cache_kinds AS
SELECT r.file_key, r.install_id, k.key AS kind, k.value::bigint AS count
FROM reports r CROSS JOIN LATERAL jsonb_each_text(
  CASE WHEN jsonb_typeof(raw_json #> '{cacheSize,kinds}') = 'object'
  THEN raw_json #> '{cacheSize,kinds}' ELSE '{}'::jsonb END
) k;

CREATE OR REPLACE VIEW v_kind_distribution AS
SELECT k.kind, sum(k.count) AS total_notes, count(DISTINCT k.install_id) AS installs_count
FROM cache_kinds k JOIN v_latest_installs l USING (file_key)
GROUP BY k.kind;
COMMIT;
