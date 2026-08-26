-- Life initial tenant + finance migration.
-- Run with a migration role. The application role must not own these tables
-- and must not have BYPASSRLS.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE household (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE household_member (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  user_id uuid NOT NULL UNIQUE REFERENCES app_user(id),
  role text NOT NULL CHECK (role IN ('owner', 'adult', 'child', 'guest')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'left')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  UNIQUE (household_id, user_id)
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  actor_id uuid REFERENCES app_user(id),
  actor_type text NOT NULL DEFAULT 'user',
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  before_summary jsonb,
  after_summary jsonb,
  trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id)
);

CREATE TABLE financial_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  name text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('bank', 'cash', 'wallet', 'payment_platform', 'other')),
  currency char(3) NOT NULL DEFAULT 'CNY',
  opening_balance numeric(20, 4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  UNIQUE (household_id, name)
);

CREATE TABLE financial_source (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  source_type text NOT NULL CHECK (source_type IN ('bank', 'alipay', 'wechat', 'bookkeeping_app', 'other')),
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  UNIQUE (household_id, source_type, display_name)
);

CREATE TABLE import_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  source_id uuid NOT NULL,
  file_name text NOT NULL,
  file_sha256 text NOT NULL,
  object_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('created', 'uploaded', 'scanning', 'header_detected', 'mapping_pending', 'normalized', 'matching', 'reconciliation_pending', 'confirmed', 'committed', 'failed', 'cancelled', 'revoked')),
  detected_sheet text,
  detected_header_row integer,
  parser_version text,
  version integer NOT NULL DEFAULT 1,
  raw_retention_until timestamptz NOT NULL,
  terminal_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, source_id) REFERENCES financial_source (household_id, id),
  FOREIGN KEY (household_id, created_by) REFERENCES household_member (household_id, user_id)
);

CREATE TABLE import_row (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  import_batch_id uuid NOT NULL,
  source_row_number integer NOT NULL,
  normalized_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'parsed' CHECK (status IN ('parsed', 'invalid', 'corrected', 'ignored')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, import_batch_id) REFERENCES import_batch (household_id, id),
  UNIQUE (household_id, import_batch_id, source_row_number)
);

CREATE TABLE source_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  source_id uuid NOT NULL,
  import_batch_id uuid NOT NULL,
  import_row_id uuid,
  external_id text,
  source_fingerprint text NOT NULL,
  occurred_at timestamptz NOT NULL,
  direction text NOT NULL CHECK (direction IN ('income', 'expense', 'transfer')),
  amount numeric(20, 4) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'CNY',
  merchant text,
  channel text,
  remark text,
  raw_object_key text,
  raw_row_number integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, source_id) REFERENCES financial_source (household_id, id),
  FOREIGN KEY (household_id, import_batch_id) REFERENCES import_batch (household_id, id),
  FOREIGN KEY (household_id, import_row_id) REFERENCES import_row (household_id, id),
  UNIQUE (household_id, source_id, source_fingerprint)
);

CREATE TABLE reconciliation_group (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  import_batch_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'confirmed', 'rejected', 'revoked')),
  recommended_link_type text NOT NULL CHECK (recommended_link_type IN ('duplicate', 'parent_settlement', 'refund_reversal', 'fee_related', 'split', 'unrelated', 'pending_review')),
  confidence numeric(5, 4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, import_batch_id) REFERENCES import_batch (household_id, id),
  FOREIGN KEY (household_id, decided_by) REFERENCES household_member (household_id, user_id)
);

CREATE TABLE transaction_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  reconciliation_group_id uuid,
  left_source_record_id uuid NOT NULL,
  right_source_record_id uuid NOT NULL,
  link_type text NOT NULL CHECK (link_type IN ('duplicate', 'parent_settlement', 'refund_reversal', 'fee_related', 'split', 'unrelated', 'pending_review')),
  status text NOT NULL CHECK (status IN ('pending_review', 'confirmed', 'rejected', 'revoked')),
  confidence numeric(5, 4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, reconciliation_group_id) REFERENCES reconciliation_group (household_id, id),
  FOREIGN KEY (household_id, left_source_record_id) REFERENCES source_record (household_id, id),
  FOREIGN KEY (household_id, right_source_record_id) REFERENCES source_record (household_id, id),
  CHECK (left_source_record_id <> right_source_record_id)
);

CREATE TABLE ledger_transaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  occurred_at timestamptz NOT NULL,
  direction text NOT NULL CHECK (direction IN ('income', 'expense', 'transfer')),
  amount numeric(20, 4) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'CNY',
  merchant text,
  category text,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'reversed', 'voided')),
  primary_source_record_id uuid,
  import_batch_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, primary_source_record_id) REFERENCES source_record (household_id, id),
  FOREIGN KEY (household_id, import_batch_id) REFERENCES import_batch (household_id, id),
  FOREIGN KEY (household_id, created_by) REFERENCES household_member (household_id, user_id)
);

CREATE TABLE ledger_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  ledger_transaction_id uuid NOT NULL,
  account_id uuid NOT NULL,
  amount numeric(20, 4) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, ledger_transaction_id) REFERENCES ledger_transaction (household_id, id),
  FOREIGN KEY (household_id, account_id) REFERENCES financial_account (household_id, id)
);

CREATE TABLE category (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  name text NOT NULL,
  direction_scope text NOT NULL CHECK (direction_scope IN ('income', 'expense', 'both')),
  color_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  UNIQUE (household_id, name)
);

CREATE TABLE budget (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  category_id uuid NOT NULL,
  name text NOT NULL,
  currency char(3) NOT NULL DEFAULT 'CNY',
  amount numeric(20, 4) NOT NULL CHECK (amount >= 0),
  cycle text NOT NULL CHECK (cycle IN ('month', 'quarter', 'year', 'custom')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, category_id) REFERENCES category (household_id, id)
);

CREATE TABLE budget_period (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  budget_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  amount numeric(20, 4) NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, budget_id) REFERENCES budget (household_id, id),
  CHECK (period_end >= period_start),
  UNIQUE (household_id, budget_id, period_start, period_end)
);

CREATE TABLE physical_asset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  name text NOT NULL,
  asset_type text NOT NULL,
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'transferred', 'sold', 'disposed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id)
);

CREATE TABLE asset_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  asset_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('purchase', 'maintenance', 'consumable', 'upgrade', 'transfer', 'sale', 'disposal')),
  amount numeric(20, 4) NOT NULL DEFAULT 0,
  recovery_amount numeric(20, 4) NOT NULL DEFAULT 0,
  ledger_transaction_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, asset_id) REFERENCES physical_asset (household_id, id),
  FOREIGN KEY (household_id, ledger_transaction_id) REFERENCES ledger_transaction (household_id, id)
);

CREATE TABLE finance_drilldown_filter (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  filter_type text NOT NULL CHECK (filter_type IN ('ledger_period', 'ledger_direction', 'budget_category', 'asset_day', 'asset_period')),
  filters jsonb NOT NULL,
  created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 day',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, created_by) REFERENCES household_member (household_id, user_id)
);

CREATE INDEX import_batch_household_status_idx ON import_batch (household_id, status, created_at DESC);
CREATE INDEX source_record_household_occurred_idx ON source_record (household_id, occurred_at DESC);
CREATE INDEX source_record_household_external_idx ON source_record (household_id, source_id, external_id);
CREATE INDEX ledger_transaction_household_occurred_idx ON ledger_transaction (household_id, occurred_at DESC);
CREATE INDEX ledger_transaction_household_category_idx ON ledger_transaction (household_id, category, occurred_at DESC);
CREATE INDEX asset_event_household_asset_occurred_idx ON asset_event (household_id, asset_id, occurred_at DESC);
CREATE INDEX drilldown_household_expiry_idx ON finance_drilldown_filter (household_id, expires_at);

-- Deployment must create/use an application role with NOBYPASSRLS.
-- Every request must set app.user_id and app.household_id in a transaction.

ALTER TABLE household_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_member FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE financial_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_account FORCE ROW LEVEL SECURITY;
ALTER TABLE financial_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_source FORCE ROW LEVEL SECURITY;
ALTER TABLE import_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batch FORCE ROW LEVEL SECURITY;
ALTER TABLE import_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_row FORCE ROW LEVEL SECURITY;
ALTER TABLE source_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_record FORCE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_group FORCE ROW LEVEL SECURITY;
ALTER TABLE transaction_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_link FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_transaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_transaction FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entry FORCE ROW LEVEL SECURITY;
ALTER TABLE category ENABLE ROW LEVEL SECURITY;
ALTER TABLE category FORCE ROW LEVEL SECURITY;
ALTER TABLE budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget FORCE ROW LEVEL SECURITY;
ALTER TABLE budget_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_period FORCE ROW LEVEL SECURITY;
ALTER TABLE physical_asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE physical_asset FORCE ROW LEVEL SECURITY;
ALTER TABLE asset_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_event FORCE ROW LEVEL SECURITY;
ALTER TABLE finance_drilldown_filter ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_drilldown_filter FORCE ROW LEVEL SECURITY;

CREATE POLICY household_member_scope ON household_member
USING (
  user_id = current_setting('app.user_id', true)::uuid
  OR household_id = current_setting('app.household_id', true)::uuid
)
WITH CHECK (household_id = current_setting('app.household_id', true)::uuid);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'audit_log', 'financial_account', 'financial_source', 'import_batch', 'import_row',
    'source_record', 'reconciliation_group', 'transaction_link', 'ledger_transaction',
    'ledger_entry', 'category', 'budget', 'budget_period', 'physical_asset',
    'asset_event', 'finance_drilldown_filter'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (household_id = current_setting(''app.household_id'', true)::uuid) WITH CHECK (household_id = current_setting(''app.household_id'', true)::uuid)',
      table_name || '_scope', table_name
    );
  END LOOP;
END $$;

