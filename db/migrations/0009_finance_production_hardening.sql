-- Finance production hardening: exports, raw retention, household AI connection and memory artifacts.
-- Run with the migration role. The application role must not own these tables and must not have BYPASSRLS.

CREATE TABLE finance_export_job (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES household(id),
  requested_by uuid NOT NULL,
  format text NOT NULL DEFAULT 'csv' CHECK (format IN ('csv')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired', 'cancelled')),
  object_key text,
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  download_expires_at timestamptz,
  error_code text,
  error_message text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  UNIQUE (household_id, idempotency_key),
  FOREIGN KEY (household_id, requested_by) REFERENCES household_member (household_id, user_id),
  CHECK (period_end >= period_start)
);

CREATE INDEX finance_export_job_queue_idx
  ON finance_export_job (status, created_at)
  WHERE status = 'queued';

ALTER TABLE import_batch
  ADD COLUMN IF NOT EXISTS raw_delete_status text NOT NULL DEFAULT 'pending'
    CHECK (raw_delete_status IN ('pending', 'running', 'deleted', 'failed', 'not_required')),
  ADD COLUMN IF NOT EXISTS raw_deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS raw_delete_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS raw_delete_error text;

CREATE INDEX import_batch_retention_queue_idx
  ON import_batch (raw_retention_until, raw_delete_status)
  WHERE raw_delete_status IN ('pending', 'failed');

CREATE TABLE household_ai_connection (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES household(id),
  provider text NOT NULL CHECK (provider IN ('openai_compatible')),
  endpoint_url text NOT NULL,
  model text NOT NULL,
  api_key_ref text NOT NULL,
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('active', 'disabled', 'error')),
  capabilities jsonb NOT NULL DEFAULT '{"finance":true}'::jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_tested_at timestamptz,
  last_error text,
  UNIQUE (household_id),
  FOREIGN KEY (household_id, created_by) REFERENCES household_member (household_id, user_id)
);

CREATE TABLE ai_memory_artifact (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES household(id),
  owner_user_id uuid,
  artifact_type text NOT NULL CHECK (artifact_type IN ('fact', 'event', 'summary', 'embedding')),
  object_key text NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-fA-F]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted', 'pending_delete')),
  retention_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (household_id, id),
  UNIQUE (household_id, object_key),
  FOREIGN KEY (household_id, owner_user_id) REFERENCES household_member (household_id, user_id),
  CHECK (object_key LIKE ('households/' || household_id::text || '/ai-memory/%'))
);

ALTER TABLE finance_export_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_export_job FORCE ROW LEVEL SECURITY;
ALTER TABLE household_ai_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_ai_connection FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_memory_artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_memory_artifact FORCE ROW LEVEL SECURITY;

CREATE POLICY finance_export_job_scope ON finance_export_job
  USING (household_id = current_setting('app.household_id', true)::uuid)
  WITH CHECK (household_id = current_setting('app.household_id', true)::uuid);

CREATE POLICY household_ai_connection_scope ON household_ai_connection
  USING (household_id = current_setting('app.household_id', true)::uuid)
  WITH CHECK (household_id = current_setting('app.household_id', true)::uuid);

CREATE POLICY ai_memory_artifact_scope ON ai_memory_artifact
  USING (household_id = current_setting('app.household_id', true)::uuid)
  WITH CHECK (household_id = current_setting('app.household_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON finance_export_job, household_ai_connection, ai_memory_artifact TO life_app;
GRANT SELECT ON household TO life_app;
