import { Pool } from "pg";
import { runQueuedFinanceImportWorker } from "../src/api/finance-import-worker.js";
import { LocalFinanceImportParser } from "../src/api/finance-import-parser.js";
import { LocalImportObjectStore, createProductionCosObjectStoreFromEnv, type ImportObjectStore } from "../src/api/import-storage.js";
import type { DbPool } from "../src/api/database.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("导入解析 worker 需要 DATABASE_URL");

const store: ImportObjectStore = process.env.NODE_ENV === "production"
  ? createProductionCosObjectStoreFromEnv()
  : new LocalImportObjectStore();
const parser = new LocalFinanceImportParser(store);
const pool = new Pool({ connectionString: databaseUrl });
try {
  const result = await runQueuedFinanceImportWorker(pool as unknown as DbPool, parser, store, Number(process.env.LIFE_IMPORT_BATCH_LIMIT ?? 50));
  console.log(JSON.stringify({ ok: true, result }));
} finally {
  await pool.end();
}
