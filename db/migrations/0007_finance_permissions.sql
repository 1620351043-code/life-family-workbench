-- P0-D: household-scoped finance permissions and auditable grants.
-- Run after 0006_finance_management_foundation.sql with the migration role.

CREATE TABLE financial_permission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  user_id uuid NOT NULL,
  can_view boolean NOT NULL DEFAULT false,
  can_bookkeep boolean NOT NULL DEFAULT false,
  can_edit boolean NOT NULL DEFAULT false,
  can_import boolean NOT NULL DEFAULT false,
  can_reconcile boolean NOT NULL DEFAULT false,
  can_export boolean NOT NULL DEFAULT false,
  granted_by uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  UNIQUE (household_id, user_id),
  FOREIGN KEY (household_id, user_id) REFERENCES household_member (household_id, user_id),
  FOREIGN KEY (household_id, granted_by) REFERENCES household_member (household_id, user_id)
);

CREATE INDEX financial_permission_household_active_idx
  ON financial_permission (household_id, revoked_at, user_id);

ALTER TABLE financial_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_permission FORCE ROW LEVEL SECURITY;

CREATE POLICY financial_permission_scope ON financial_permission
  USING (household_id = current_setting('app.household_id', true)::uuid)
  WITH CHECK (household_id = current_setting('app.household_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON financial_permission TO life_app;
