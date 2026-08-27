import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { buildServer } from "../src/api/server.js";
import { SqlFinanceRepository } from "../src/api/finance-repository.js";
import { LocalImportObjectStore } from "../src/api/import-storage.js";
import type { DbPool } from "../src/api/database.js";

const householdId = "00000000-0000-0000-0000-0000000000a1";
const userId = "10000000-0000-0000-0000-0000000000a1";
const memberId = "20000000-0000-0000-0000-0000000000a1";
const scope = { householdId, userId };
const billDir = process.env.LIFE_REAL_BILL_DIR ?? "/Users/wrt/Downloads/账单";

function splitSql(input: string) {
  const statements: string[] = [];
  let buffer = "";
  let quote = false;
  let dollarTag: string | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (dollarTag) {
      buffer += char;
      if (input.startsWith(dollarTag, index)) {
        buffer += input.slice(index + 1, index + dollarTag.length);
        index += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (!quote && char === "$" && next === "$") {
      dollarTag = "$$";
      buffer += "$$";
      index += 1;
      continue;
    }
    if (char === "'" && input[index - 1] !== "\\") {
      if (quote && next === "'") {
        buffer += "''";
        index += 1;
        continue;
      }
      quote = !quote;
    }
    if (!quote && char === ";") {
      if (buffer.trim()) statements.push(buffer.trim());
      buffer = "";
      continue;
    }
    buffer += char;
  }
  if (buffer.trim()) statements.push(buffer.trim());
  return statements;
}

async function migrate(db: PGlite) {
  for (const file of ["0001_life_core_finance.sql", "0002_finance_import_state.sql", "0003_life_app_privileges.sql", "0004_family_space_ai.sql", "0005_finance_ledger_foundation.sql", "0006_finance_management_foundation.sql", "0007_finance_permissions.sql", "0008_finance_ai.sql", "0009_finance_production_hardening.sql", "0010_auth_sessions.sql", "0011_password_reset.sql"]) {
    let sql = await readFile(join(process.cwd(), "db/migrations", file), "utf8");
    sql = sql.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "-- pgcrypto is not bundled in PGlite").replaceAll("DEFAULT gen_random_uuid()", "");
    for (const statement of splitSql(sql)) await db.query(statement);
  }
}

function classify(fileName: string) {
  if (fileName.includes("支付宝")) return "alipay" as const;
  if (fileName.includes("微信")) return "wechat" as const;
  if (fileName.toLowerCase().includes("hqmx")) return "bank" as const;
  if (fileName.includes("时光序")) return "bookkeeping_app" as const;
  return null;
}

async function main() {
  const db = new PGlite();
  await migrate(db);
  await db.query("INSERT INTO household (id, name) VALUES ($1, $2)", [householdId, "真实账单回放家庭"]);
  await db.query("INSERT INTO app_user (id, email, password_hash) VALUES ($1, $2, $3)", [userId, "real-bill@example.invalid", "test"]);
  await db.query("INSERT INTO household_member (id, household_id, user_id, role) VALUES ($1, $2, $3, 'owner')", [memberId, householdId, userId]);

  const pool: DbPool = { connect: async () => { await db.query("SET ROLE life_app"); return { query: db.query.bind(db), release: () => undefined }; } };
  const objectRoot = await mkdtemp(join("/private/tmp", "life-real-import-store-"));
  const objectStore = new LocalImportObjectStore(objectRoot);
  const repository = new SqlFinanceRepository(pool, scope, objectStore);
  const app = buildServer({ resolveScope: () => scope, financeFactory: () => repository, importObjectStore: objectStore });
  const files = await readdir(billDir);
  const results: Array<Record<string, unknown>> = [];

  for (const fileName of files.sort()) {
    const sourceType = classify(fileName);
    if (!sourceType || ![".csv", ".xls", ".xlsx"].includes(fileName.slice(fileName.lastIndexOf(".")).toLowerCase())) continue;
    const bytes = await readFile(join(billDir, fileName));
    const hash = createHash("sha256").update(bytes).digest("hex");
    const created = await app.inject({ method: "POST", url: "/api/finance/import-batches", payload: { source_type: sourceType, file_name: fileName, file_size: bytes.length, file_sha256: hash, object_key: "client-value-ignored" } });
    if (created.statusCode !== 201) throw new Error(`创建 ${sourceType} 批次失败：${created.body}`);
    const batchId = created.json().id as string;
    const upload = await app.inject({ method: "POST", url: `/api/finance/import-batches/${batchId}/upload`, headers: { "content-type": "application/octet-stream" }, payload: bytes });
    if (upload.statusCode !== 200) throw new Error(`上传 ${sourceType} 批次失败：${upload.body}`);
    const parsed = await app.inject({ method: "POST", url: `/api/finance/import-batches/${batchId}/parse` });
    if (parsed.statusCode !== 200) throw new Error(`解析 ${sourceType} 批次失败：${parsed.body}`);
    const parsedBatch = parsed.json();
    const header = await app.inject({ method: "POST", url: `/api/finance/import-batches/${batchId}/header-confirmation`, payload: { sheet_name: parsedBatch.detected_sheet ?? "Sheet1", header_row: parsedBatch.detected_header_row ?? 1, data_start_row: (parsedBatch.detected_header_row ?? 1) + 1 } });
    if (header.statusCode !== 200) throw new Error(`确认表头失败：${header.body}`);
    const mapping = await app.inject({ method: "POST", url: `/api/finance/import-batches/${batchId}/mapping-confirmation`, payload: { mapping: parsedBatch.field_mapping ?? {}, parser_version: "real-bill-parser-v1" } });
    if (mapping.statusCode !== 200) throw new Error(`确认映射失败：${mapping.body}`);
    let currentBatch = mapping.json();
    const reconciliation = await app.inject({ method: "GET", url: `/api/finance/import-batches/${batchId}/reconciliation?page=1&page_size=100` });
    const candidates = reconciliation.json().candidates as Array<{ id: string; status: string }>;
    for (const candidate of candidates.filter((item) => item.status === "pending_review")) {
      const decision = await app.inject({ method: "POST", url: `/api/finance/import-batches/${batchId}/reconciliation/decisions`, payload: { candidate_id: candidate.id, decision: "duplicate", expected_version: currentBatch.version } });
      if (decision.statusCode !== 200) throw new Error(`确认关联失败：${decision.body}`);
      currentBatch = (await app.inject({ method: "GET", url: `/api/finance/import-batches/${batchId}` })).json();
    }
    const commit = await app.inject({ method: "POST", url: `/api/finance/import-batches/${batchId}/commit`, headers: { "idempotency-key": `real-bill-${batchId}` }, payload: { expected_version: currentBatch.version, confirm_summary_hash: hash } });
    if (commit.statusCode !== 200) throw new Error(`提交 ${sourceType} 批次失败：${commit.body}`);
    const committed = commit.json();
    await db.query("RESET ROLE");
    const counts = await db.query<{ import_rows: number; source_records: number; ledger_transactions: number }>(`SELECT (SELECT COUNT(*)::int FROM import_row WHERE household_id = $1 AND import_batch_id = $2) AS import_rows, (SELECT COUNT(*)::int FROM source_record WHERE household_id = $1 AND import_batch_id = $2) AS source_records, (SELECT COUNT(*)::int FROM ledger_transaction WHERE household_id = $1 AND import_batch_id = $2) AS ledger_transactions`, [householdId, batchId]);
    await db.query("SET ROLE life_app");
    results.push({ source_type: sourceType, parsed_rows: parsedBatch.counts.rows, import_rows: counts.rows[0].import_rows, source_records: counts.rows[0].source_records, candidates: candidates.length, inserted_transactions: committed.inserted_transactions, status: committed.batch.status });
  }

  await db.query("RESET ROLE");
  const total = await db.query<{ source_records: number; ledger_transactions: number }>("SELECT (SELECT COUNT(*)::int FROM source_record WHERE household_id = $1) AS source_records, (SELECT COUNT(*)::int FROM ledger_transaction WHERE household_id = $1) AS ledger_transactions", [householdId]);
  console.log(JSON.stringify({ files: results, household_totals: total.rows[0], privacy: { printed_transaction_values: false, printed_merchants: false, printed_accounts: false } }, null, 2));
  await db.close();
}

await main();
