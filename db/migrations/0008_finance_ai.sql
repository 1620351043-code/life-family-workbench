-- P1-B: tenant-scoped finance AI insight and reversible review proposals.
-- Finance AI never writes a ledger mutation directly. Confirmed proposals only
-- record that the user accepted the explanation/review result.

ALTER TABLE ai_insight
  ALTER COLUMN topic_id DROP NOT NULL;

ALTER TABLE ai_insight
  ADD COLUMN scope_type text NOT NULL DEFAULT 'topic';

ALTER TABLE ai_insight DROP CONSTRAINT IF EXISTS ai_insight_insight_type_check;

ALTER TABLE ai_insight
  ADD CONSTRAINT ai_insight_insight_type_check
  CHECK (insight_type IN ('summary', 'recommendation', 'memory_update', 'finance_summary', 'finance_explanation', 'finance_reconciliation'));

ALTER TABLE ai_insight
  ADD CONSTRAINT ai_insight_scope_type_check
  CHECK (scope_type IN ('topic', 'finance'));

ALTER TABLE ai_action_proposal DROP CONSTRAINT IF EXISTS ai_action_proposal_action_type_check;
ALTER TABLE ai_action_proposal DROP CONSTRAINT IF EXISTS ai_action_proposal_status_check;

ALTER TABLE ai_action_proposal
  ADD CONSTRAINT ai_action_proposal_action_type_check
  CHECK (action_type IN ('publish_summary_comment', 'update_memory', 'finance_review'));

ALTER TABLE ai_action_proposal
  ADD CONSTRAINT ai_action_proposal_status_check
  CHECK (status IN ('proposed', 'confirmed', 'rejected', 'revoked', 'expired'));

CREATE INDEX ai_insight_finance_scope_idx
  ON ai_insight (household_id, scope_type, created_at DESC);
