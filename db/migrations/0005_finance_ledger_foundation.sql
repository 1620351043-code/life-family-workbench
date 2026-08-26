-- P0-A: ledger entries, manual transactions and account-backed balances.
-- Run after 0004_family_space_ai.sql with the migration role.

ALTER TABLE financial_source
  ADD COLUMN account_id uuid;

ALTER TABLE financial_source
  ADD CONSTRAINT financial_source_account_fk
  FOREIGN KEY (household_id, account_id)
  REFERENCES financial_account (household_id, id);

ALTER TABLE ledger_transaction
  ADD COLUMN origin text NOT NULL DEFAULT 'import'
    CHECK (origin IN ('import', 'manual', 'system'));

ALTER TABLE ledger_transaction
  DROP CONSTRAINT ledger_transaction_status_check;

ALTER TABLE ledger_transaction
  ADD CONSTRAINT ledger_transaction_status_check
    CHECK (status IN ('confirmed', 'pending_account', 'reversed', 'voided'));

ALTER TABLE ledger_transaction
  ADD COLUMN category_id uuid;

ALTER TABLE ledger_transaction
  ADD CONSTRAINT ledger_transaction_category_fk
  FOREIGN KEY (household_id, category_id)
  REFERENCES category (household_id, id);

ALTER TABLE ledger_transaction
  ADD COLUMN note text;

ALTER TABLE ledger_transaction
  ADD COLUMN updated_by uuid;

ALTER TABLE ledger_transaction
  ADD COLUMN voided_at timestamptz;

ALTER TABLE ledger_transaction
  ADD COLUMN voided_by uuid;

ALTER TABLE ledger_transaction
  ADD COLUMN void_reason text;

ALTER TABLE ledger_transaction
  ADD COLUMN idempotency_key text;

ALTER TABLE ledger_transaction
  ADD CONSTRAINT ledger_transaction_updated_by_fk
  FOREIGN KEY (household_id, updated_by)
  REFERENCES household_member (household_id, user_id);

ALTER TABLE ledger_transaction
  ADD CONSTRAINT ledger_transaction_voided_by_fk
  FOREIGN KEY (household_id, voided_by)
  REFERENCES household_member (household_id, user_id);

ALTER TABLE ledger_entry
  ADD COLUMN entry_side text NOT NULL DEFAULT 'debit'
    CHECK (entry_side IN ('debit', 'credit'));

CREATE INDEX financial_source_household_account_idx
  ON financial_source (household_id, account_id);

CREATE INDEX ledger_transaction_household_origin_idx
  ON ledger_transaction (household_id, origin, occurred_at DESC);

CREATE UNIQUE INDEX ledger_transaction_manual_idempotency_idx
  ON ledger_transaction (household_id, idempotency_key)
  WHERE origin = 'manual' AND idempotency_key IS NOT NULL;

CREATE INDEX ledger_entry_household_account_created_idx
  ON ledger_entry (household_id, account_id, created_at DESC);

CREATE INDEX audit_log_household_resource_created_idx
  ON audit_log (household_id, resource_type, resource_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON financial_source, ledger_transaction, ledger_entry, audit_log TO life_app;
