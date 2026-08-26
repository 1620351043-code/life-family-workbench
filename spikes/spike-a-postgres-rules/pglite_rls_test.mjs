import fs from 'node:fs/promises';

const modulePath = process.env.PGLITE_MODULE || '@electric-sql/pglite';
const { PGlite } = await import(modulePath);

const db = new PGlite();
const schemaPath = new URL('./schema.sql', import.meta.url);
let schema = await fs.readFile(schemaPath, 'utf8');

// PGlite ships the PostgreSQL engine but not pgcrypto. The native PostgreSQL
// SQL remains unchanged; this runtime test only replaces UUID defaults because
// all fixture IDs below are explicit.
schema = schema
  .replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '-- pgcrypto is not bundled in PGlite')
  .replaceAll('DEFAULT gen_random_uuid()', '');

async function exec(sql, params = []) {
  return db.query(sql, params);
}

async function runSchema() {
  for (const statement of schema.split(';').map((item) => item.trim()).filter(Boolean)) {
    await exec(statement);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectReject(action, label) {
  try {
    await action();
  } catch (_) {
    return;
  }
  throw new Error(`expected rejection: ${label}`);
}

async function seed() {
  const rows = [
    ['INSERT INTO household (id, name) VALUES ($1, $2)', ['00000000-0000-0000-0000-00000000000a', '家庭 A']],
    ['INSERT INTO household (id, name) VALUES ($1, $2)', ['00000000-0000-0000-0000-00000000000b', '家庭 B']],
    ['INSERT INTO app_user (id, email) VALUES ($1, $2)', ['10000000-0000-0000-0000-00000000000a', 'a@example.invalid']],
    ['INSERT INTO app_user (id, email) VALUES ($1, $2)', ['10000000-0000-0000-0000-00000000000b', 'b@example.invalid']],
    ['INSERT INTO household_member (id, household_id, user_id, role) VALUES ($1, $2, $3, $4)', ['20000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'owner']],
    ['INSERT INTO household_member (id, household_id, user_id, role) VALUES ($1, $2, $3, $4)', ['20000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', 'owner']],
    ['INSERT INTO family_topic (id, household_id, title, body, created_by) VALUES ($1, $2, $3, $4, $5)', ['30000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'A topic', 'A body', '10000000-0000-0000-0000-00000000000a']],
    ['INSERT INTO family_topic (id, household_id, title, body, created_by) VALUES ($1, $2, $3, $4, $5)', ['30000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'B topic', 'B body', '10000000-0000-0000-0000-00000000000b']],
    ['INSERT INTO ledger_transaction (id, household_id, occurred_at, direction, amount, currency, category) VALUES ($1, $2, $3, $4, $5, $6, $7)', ['40000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', '2026-08-24T10:00:00Z', 'expense', '10.00', 'CNY', 'food']],
    ['INSERT INTO ledger_transaction (id, household_id, occurred_at, direction, amount, currency, category) VALUES ($1, $2, $3, $4, $5, $6, $7)', ['40000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', '2026-08-24T10:00:00Z', 'expense', '20.00', 'CNY', 'food']],
  ];
  for (const [sql, params] of rows) await exec(sql, params);
}

async function run() {
  await runSchema();
  await seed();

  const policyCheck = await exec(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, r.rolbypassrls
    FROM pg_class c
    JOIN pg_roles r ON r.rolname = 'life_app'
    WHERE c.relname IN ('family_topic', 'ledger_transaction', 'ledger_entry')
    ORDER BY c.relname
  `);
  assert(policyCheck.rows.length === 3, 'expected three protected tables');
  assert(policyCheck.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity), 'RLS is not enabled and forced on all protected tables');
  assert(policyCheck.rows.every((row) => row.rolbypassrls === false), 'life_app can bypass RLS');

  await exec('SET ROLE life_app');
  await exec('BEGIN');
  await exec("SELECT set_config('app.user_id', $1, true)", ['10000000-0000-0000-0000-00000000000a']);
  await exec("SELECT set_config('app.household_id', $1, true)", ['00000000-0000-0000-0000-00000000000a']);

  const topics = await exec('SELECT title FROM family_topic ORDER BY title');
  assert(topics.rows.length === 1 && topics.rows[0].title === 'A topic', 'family A read leaked another household');

  const ledger = await exec('SELECT amount::text AS amount FROM ledger_transaction ORDER BY amount');
  assert(ledger.rows.length === 1, 'family A ledger read leaked another household');

  await expectReject(
    () => exec('INSERT INTO family_topic (id, household_id, title, body, created_by) VALUES ($1, $2, $3, $4, $5)', ['30000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000b', 'cross', 'cross', '10000000-0000-0000-0000-00000000000a']),
    'cross-household topic insert',
  );

  await expectReject(
    () => exec('INSERT INTO ledger_entry (id, household_id, ledger_transaction_id, account_name, amount) VALUES ($1, $2, $3, $4, $5)', ['50000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-00000000000b', 'main', '20.00']),
    'cross-household ledger foreign key',
  );

  await exec('COMMIT');
  await exec('RESET ROLE');
  console.log('Spike A PGlite PostgreSQL engine test: PASS');
  console.log('  RLS enabled and forced: 3 protected tables');
  console.log('  NOBYPASSRLS: life_app verified');
  console.log('  Household A reads only A: PASS');
  console.log('  Cross-household insert and composite FK: rejected');
  console.log('  Native PostgreSQL recheck: still required for pgcrypto and production image parity');
}

try {
  await run();
} finally {
  await db.close();
}
