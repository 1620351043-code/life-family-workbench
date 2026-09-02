-- E-114: DB-backed asynchronous finance import parsing queue.
-- The API enqueues a job; a worker claims jobs per household under RLS,
-- runs the isolated parser, stages parsed rows, and supports retry, pause,
-- resume and cancel. The original requester scope is preserved for audit.

CREATE TABLE finance_import_job (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES household(id),
  import_batch_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  next_attempt_at timestamptz,
  lease_expires_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  UNIQUE (household_id, import_batch_id),
  FOREIGN KEY (household_id, import_batch_id) REFERENCES import_batch (household_id, id),
  FOREIGN KEY (household_id, requested_by) REFERENCES household_member (household_id, user_id)
);

CREATE INDEX finance_import_job_queue_idx
  ON finance_import_job (status, next_attempt_at, created_at)
  WHERE status = 'queued';

CREATE INDEX finance_import_job_stale_idx
  ON finance_import_job (status, lease_expires_at)
  WHERE status = 'running';

ALTER TABLE finance_import_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_import_job FORCE ROW LEVEL SECURITY;

CREATE POLICY finance_import_job_scope ON finance_import_job
  USING (household_id = current_setting('app.household_id', true)::uuid)
  WITH CHECK (household_id = current_setting('app.household_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON finance_import_job TO life_app;
