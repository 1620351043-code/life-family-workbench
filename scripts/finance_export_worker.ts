import { Pool } from "pg";
import { runQueuedFinanceExportWorker } from "../src/api/finance-export-worker.js";
import { createProductionCosObjectStoreFromEnv } from "../src/api/import-storage.js";
import type { DbPool } from "../src/api/database.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("导出 worker 需要 DATABASE_URL");

const store = createProductionCosObjectStoreFromEnv();
const pool = new Pool({ connectionString: databaseUrl });
try {
  const result = await runQueuedFinanceExportWorker(pool as unknown as DbPool, store, Number(process.env.LIFE_EXPORT_BATCH_LIMIT ?? 50));
  console.log(JSON.stringify({ ok: true, result }));
} finally {
  await pool.end();
}
