import { Pool } from "pg";
import { runFinanceRetentionWorker } from "../src/api/finance-retention-worker.js";
import { LocalImportObjectStore, createProductionCosObjectStoreFromEnv, type ImportObjectStore } from "../src/api/import-storage.js";
import type { DbPool } from "../src/api/database.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("清理 worker 需要 DATABASE_URL");
const store: ImportObjectStore = process.env.NODE_ENV === "production"
  ? createProductionCosObjectStoreFromEnv()
  : new LocalImportObjectStore();
const pool = new Pool({ connectionString: databaseUrl });
try {
  const result = await runFinanceRetentionWorker(pool as unknown as DbPool, store, Number(process.env.LIFE_RETENTION_BATCH_LIMIT ?? 50));
  console.log(JSON.stringify({ ok: true, result }));
} finally {
  await pool.end();
}
