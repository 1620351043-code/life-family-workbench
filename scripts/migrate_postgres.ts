import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("数据库迁移需要 DATABASE_URL");
if (process.env.LIFE_DB_MIGRATE_CONFIRM !== "YES") throw new Error("数据库迁移是单向操作，请设置 LIFE_DB_MIGRATE_CONFIRM=YES 后再执行");

const files = [
  "0001_life_core_finance.sql",
  "0002_finance_import_state.sql",
  "0003_life_app_privileges.sql",
  "0004_family_space_ai.sql",
  "0005_finance_ledger_foundation.sql",
  "0006_finance_management_foundation.sql",
  "0007_finance_permissions.sql",
  "0008_finance_ai.sql",
  "0009_finance_production_hardening.sql",
  "0010_auth_sessions.sql",
];

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext('life:migrations'))");
  await client.query(`CREATE TABLE IF NOT EXISTS life_schema_migration (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const file of files) {
    const applied = await client.query("SELECT 1 FROM life_schema_migration WHERE filename = $1", [file]);
    if (applied.rowCount) {
      console.log(`migration already applied: ${file}`);
      continue;
    }
    const sql = await readFile(join(process.cwd(), "db/migrations", file), "utf8");
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO life_schema_migration (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    console.log(`migration applied: ${file}`);
  }
  await client.query("SELECT pg_advisory_unlock(hashtext('life:migrations'))");
} finally {
  client.release();
  await pool.end();
}
