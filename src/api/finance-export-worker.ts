import { randomUUID } from "node:crypto";
import { inTenantTransaction, type DbPool, type FinanceScope } from "./database.js";
import { financeExportObjectKey, type ImportObjectStore } from "./import-storage.js";

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

type ExportRow = {
  id: string;
  occurred_at: string;
  direction: string;
  amount: string;
  currency: string;
  merchant: string | null;
  category: string | null;
  status: string;
  origin: string;
  note: string | null;
};

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows: ExportRow[]): Buffer {
  const header = ["账单ID", "发生时间", "方向", "金额", "币种", "商户", "分类", "状态", "来源", "备注"];
  const body = rows.map((row) => [row.id, row.occurred_at, row.direction, row.amount, row.currency, row.merchant, row.category, row.status, row.origin, row.note].map(csvCell).join(","));
  return Buffer.from(`\uFEFF${[header.map(csvCell).join(","), ...body].join("\r\n")}\r\n`, "utf8");
}

async function auditExport(pool: DbPool, scope: FinanceScope, jobId: string, action: string, beforeSummary: unknown, afterSummary: unknown) {
  await inTenantTransaction(pool, scope, async (client) => {
    await client.query(
      `INSERT INTO audit_log (id, household_id, actor_id, actor_type, action, resource_type, resource_id, before_summary, after_summary, trace_id)
       VALUES ($1, $2, $3, 'system', $4, 'finance_export_job', $5, $6::jsonb, $7::jsonb, $8)`,
      [randomUUID(), scope.householdId, null, action, jobId, JSON.stringify(beforeSummary), JSON.stringify(afterSummary), randomUUID()],
    );
  });
}

/**
 * DB-backed export worker. The API only enqueues a job; this function is safe
 * to run in-process for development or from a separate worker process in
 * production. It never exposes the COS object key to a client.
 */
export async function runFinanceExportJob(pool: DbPool, scope: FinanceScope, store: ImportObjectStore, jobId: string): Promise<void> {
  const claimed = await inTenantTransaction(pool, scope, async (client) => {
    const result = await client.query<{ id: string; period_start: string; period_end: string; format: string; status: string }>(
      `UPDATE finance_export_job
          SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
        WHERE household_id = $1 AND id = $2 AND status = 'queued'
        RETURNING id::text AS id, period_start::text AS period_start, period_end::text AS period_end, format, status`,
      [scope.householdId, jobId],
    );
    return result.rows[0] ?? null;
  });
  if (!claimed) return;

  try {
    const rows = await inTenantTransaction(pool, scope, async (client) => {
      const result = await client.query<ExportRow>(
        `SELECT id::text AS id, occurred_at::text AS occurred_at, direction, amount::text AS amount,
                currency, merchant, category, status, origin, note
           FROM ledger_transaction
          WHERE household_id = $1 AND occurred_at >= $2::date AND occurred_at < ($3::date + interval '1 day')
          ORDER BY occurred_at, created_at, id`,
        [scope.householdId, claimed.period_start, claimed.period_end],
      );
      return result.rows;
    });
    const objectKey = financeExportObjectKey(scope.householdId, jobId);
    const bytes = toCsv(rows);
    await store.put(objectKey, bytes);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await inTenantTransaction(pool, scope, async (client) => {
      await client.query(
        `UPDATE finance_export_job
            SET status = 'ready', object_key = $3, row_count = $4, download_expires_at = $5, completed_at = now(), updated_at = now(), error_code = NULL, error_message = NULL
          WHERE household_id = $1 AND id = $2 AND status = 'running'`,
        [scope.householdId, jobId, objectKey, rows.length, expiresAt.toISOString()],
      );
    });
    await auditExport(pool, scope, jobId, "finance_export_completed", { status: "running" }, { status: "ready", row_count: rows.length, expires_at: expiresAt.toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "导出任务失败";
    await inTenantTransaction(pool, scope, async (client) => {
      await client.query(
        `UPDATE finance_export_job SET status = 'failed', error_code = 'EXPORT_WORKER_FAILED', error_message = $3, completed_at = now(), updated_at = now()
          WHERE household_id = $1 AND id = $2 AND status = 'running'`,
        [scope.householdId, jobId, message],
      );
    });
    await auditExport(pool, scope, jobId, "finance_export_failed", { status: "running" }, { status: "failed", error: message });
  }
}

/**
 * Queue runner for production restarts and multi-process deployments. Each
 * household is read under its own RLS context; the job's original requester
 * is then reused for the ledger read so the worker never needs a bypass-RLS
 * database role.
 */
export async function runQueuedFinanceExportWorker(pool: DbPool, store: ImportObjectStore, limitPerHousehold = 50) {
  const client = await pool.connect();
  let households: string[];
  try {
    const result = await client.query<{ id: string }>("SELECT id::text AS id FROM household ORDER BY id");
    households = result.rows.map((row) => row.id);
  } finally {
    client.release?.();
  }

  const results: Array<{ household_id: string; scanned: number; processed: number }> = [];
  for (const householdId of households) {
    const queued = await inTenantTransaction(pool, { householdId, userId: SYSTEM_USER_ID }, async (tenantClient) => {
      const result = await tenantClient.query<{ id: string; requested_by: string }>(
        `SELECT id::text AS id, requested_by::text AS requested_by
           FROM finance_export_job
          WHERE household_id = $1 AND status = 'queued'
          ORDER BY created_at, id
          LIMIT $2`,
        [householdId, Math.max(1, Math.min(500, Math.trunc(limitPerHousehold)))],
      );
      return result.rows;
    });
    let processed = 0;
    for (const job of queued) {
      await runFinanceExportJob(pool, { householdId, userId: job.requested_by }, store, job.id);
      processed += 1;
    }
    results.push({ household_id: householdId, scanned: queued.length, processed });
  }
  return results;
}
