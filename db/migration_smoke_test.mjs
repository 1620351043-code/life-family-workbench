import fs from 'node:fs/promises';

const modulePath = process.env.PGLITE_MODULE || '@electric-sql/pglite';
const { PGlite } = await import(modulePath);
const db = new PGlite();

function splitSql(input) {
  const statements = [];
  let buffer = '';
  let quote = false;
  let dollarTag = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (dollarTag) {
      buffer += char;
      if (input.startsWith(dollarTag, index)) {
        const tag = dollarTag;
        buffer += input.slice(index + 1, index + tag.length);
        index += tag.length - 1;
        dollarTag = null;
      }
      continue;
    }

    if (!quote && char === '$' && next === '$') {
      dollarTag = '$$';
      buffer += '$$';
      index += 1;
      continue;
    }

    if (char === '\'' && input[index - 1] !== '\\') {
      if (quote && next === '\'') {
        buffer += '\'\'';
        index += 1;
        continue;
      }
      quote = !quote;
      buffer += char;
      continue;
    }

    if (!quote && char === ';') {
      if (buffer.trim()) statements.push(buffer.trim());
      buffer = '';
      continue;
    }

    buffer += char;
  }

  if (buffer.trim()) statements.push(buffer.trim());
  return statements;
}

const migrationFiles = [
  'migrations/0001_life_core_finance.sql',
  'migrations/0002_finance_import_state.sql',
  'migrations/0003_life_app_privileges.sql',
  'migrations/0004_family_space_ai.sql',
  'migrations/0005_finance_ledger_foundation.sql',
  'migrations/0006_finance_management_foundation.sql',
  'migrations/0007_finance_permissions.sql',
  'migrations/0008_finance_ai.sql',
  'migrations/0009_finance_production_hardening.sql',
  'migrations/0010_auth_sessions.sql',
  'migrations/0011_password_reset.sql',
  'migrations/0012_household_invitations.sql',
  'migrations/0013_member_sensitive_permissions.sql',
];
let statements = [];
for (const file of migrationFiles) {
  let sql = await fs.readFile(new URL(file, import.meta.url), 'utf8');
  sql = sql.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '-- pgcrypto is not bundled in PGlite');
  sql = sql.replaceAll('DEFAULT gen_random_uuid()', '');
  statements = statements.concat(splitSql(sql));
}

for (const [index, statement] of statements.entries()) {
  try {
    await db.query(statement);
  } catch (error) {
    console.error('migration statement ' + (index + 1) + ' failed: ' + error.message);
    console.error(statement.slice(0, 300));
    process.exitCode = 1;
    break;
  }
}

if (!process.exitCode) {
  const tables = await db.query(
    "SELECT count(*)::int AS count FROM pg_class WHERE relkind = 'r' AND relname IN ('app_user', 'household_member', 'household_invitation', 'member_sensitive_permission', 'financial_account', 'financial_source', 'import_batch', 'import_row', 'source_record', 'reconciliation_group', 'transaction_link', 'ledger_transaction', 'ledger_entry', 'category', 'budget', 'budget_period', 'physical_asset', 'asset_event', 'finance_drilldown_filter', 'financial_permission', 'family_topic', 'family_topic_comment', 'ai_memory_document', 'ai_insight', 'ai_action_proposal', 'ai_action_execution', 'finance_export_job', 'household_ai_connection', 'ai_memory_artifact')",
  );
  const authTables = await db.query("SELECT count(*)::int AS count FROM pg_class WHERE relkind = 'r' AND relname IN ('user_session', 'password_reset_token')");
  const policies = await db.query("SELECT count(*)::int AS count FROM pg_policies WHERE schemaname = 'public'");
  if (tables.rows[0].count !== 29) throw new Error('expected 29 protected tables, got ' + tables.rows[0].count);
  if (authTables.rows[0].count !== 2) throw new Error('expected user_session and password_reset_token tables');
  if (policies.rows[0].count !== 30) throw new Error('expected 30 RLS policies, got ' + policies.rows[0].count);
  console.log('migration smoke: PASS (' + statements.length + ' statements, 29 protected tables, 30 policies, app role grants)');
}

await db.close();
