-- Persist the user-confirmed parts of the import state machine.
-- Run after 0001_life_core_finance.sql with the migration role.

ALTER TABLE import_batch
  ADD COLUMN IF NOT EXISTS file_size bigint,
  ADD COLUMN IF NOT EXISTS data_start_row integer,
  ADD COLUMN IF NOT EXISTS data_end_row integer,
  ADD COLUMN IF NOT EXISTS field_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS header_preview jsonb NOT NULL DEFAULT '{"sheets":[]}'::jsonb,
  ADD COLUMN IF NOT EXISTS confirmed_summary_hash text,
  ADD COLUMN IF NOT EXISTS commit_idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS import_batch_commit_idempotency_idx
  ON import_batch (household_id, commit_idempotency_key)
  WHERE commit_idempotency_key IS NOT NULL;
