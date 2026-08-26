-- Application role privileges. Run with the migration role.
-- RLS remains the tenant boundary, these grants only make the role able to
-- execute the already-policy-protected reads/writes.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'life_app') THEN
    CREATE ROLE life_app NOSUPERUSER NOBYPASSRLS NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO life_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON household_member, audit_log, financial_account, financial_source,
  import_batch, import_row, source_record, reconciliation_group, transaction_link,
  ledger_transaction, ledger_entry, category, budget, budget_period, physical_asset,
  asset_event, finance_drilldown_filter TO life_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO life_app;
