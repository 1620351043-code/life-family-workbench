-- P0-B: account lifecycle, category lifecycle and budget lifecycle.
-- Run after 0005_finance_ledger_foundation.sql with the migration role.

ALTER TABLE category
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived'));

ALTER TABLE budget
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived'));

CREATE INDEX category_household_status_name_idx
  ON category (household_id, status, name);

CREATE INDEX budget_household_status_updated_idx
  ON budget (household_id, status, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON category, budget, budget_period TO life_app;
