-- Life Spike A: PostgreSQL household isolation contract
-- This file is intentionally explicit. Run it with a dedicated test database.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE household (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE
);

CREATE TABLE household_member (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  user_id uuid NOT NULL UNIQUE REFERENCES app_user(id),
  role text NOT NULL CHECK (role IN ('owner', 'adult', 'child', 'guest')),
  status text NOT NULL DEFAULT 'active'
);

CREATE TABLE family_topic (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  title text NOT NULL,
  body text NOT NULL,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id)
);

CREATE TABLE ledger_transaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  occurred_at timestamptz NOT NULL,
  direction text NOT NULL CHECK (direction IN ('income', 'expense', 'transfer')),
  amount numeric(20, 4) NOT NULL,
  currency char(3) NOT NULL,
  category text,
  UNIQUE (household_id, id)
);

CREATE TABLE ledger_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  ledger_transaction_id uuid NOT NULL,
  account_name text NOT NULL,
  amount numeric(20, 4) NOT NULL,
  UNIQUE (household_id, id),
  CONSTRAINT ledger_entry_same_household_transaction
    FOREIGN KEY (household_id, ledger_transaction_id)
    REFERENCES ledger_transaction (household_id, id)
);

CREATE ROLE life_app NOLOGIN;
ALTER ROLE life_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

ALTER TABLE family_topic ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_topic FORCE ROW LEVEL SECURITY;

ALTER TABLE ledger_transaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_transaction FORCE ROW LEVEL SECURITY;

ALTER TABLE ledger_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entry FORCE ROW LEVEL SECURITY;

CREATE POLICY family_topic_tenant_policy
ON family_topic
USING (
  household_id = current_setting('app.household_id', true)::uuid
)
WITH CHECK (
  household_id = current_setting('app.household_id', true)::uuid
);

CREATE POLICY ledger_transaction_tenant_policy
ON ledger_transaction
USING (
  household_id = current_setting('app.household_id', true)::uuid
)
WITH CHECK (
  household_id = current_setting('app.household_id', true)::uuid
);

CREATE POLICY ledger_entry_tenant_policy
ON ledger_entry
USING (
  household_id = current_setting('app.household_id', true)::uuid
)
WITH CHECK (
  household_id = current_setting('app.household_id', true)::uuid
);

GRANT SELECT, INSERT, UPDATE, DELETE ON family_topic TO life_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ledger_transaction TO life_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ledger_entry TO life_app;
