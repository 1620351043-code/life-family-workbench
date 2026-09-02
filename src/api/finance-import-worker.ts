import { randomUUID } from "node:crypto";
import { inTenantTransaction, type DbPool, type FinanceScope } from "./database.js";
import type { FinanceImportParser, ParsedImportResult } from "./finance-import-parser.js";
import { SqlFinanceRepository } from "./finance-repository.js";
import type { ImportObjectStore } from "./import-storage.js";

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

type QueuedImportJob = {
  id: string;
  batch_id: string;
  requested_by: string;
  attempts: number;
  max_attempts: number;
};

type ImportBatchMeta = {
  object_key: string;
  file_name: string;
  source_type: string;
};

async function writeImportJobAudit(pool: DbPool, scope: FinanceScope, jobId: string, action: string, beforeSummary: Record<string, unknown> | null, afterSummary: Record<string, unknown> | null) {
  await inTenantTransaction(pool, scope, async (client) => {
    await client.query(
      `INSERT INTO audit_log (id, household_id, actor_id, actor_type, action, resource_type, resource_id, before_summary, after_summary, trace_id)
       VALUES ($1, $2, $3, 'system', $4, 'finance_import_job', $5, $6::jsonb, $7::jsonb, $8)`,
      [randomUUID(), scope.householdId, null, action, jobId, JSON.stringify(beforeSummary), JSON.stringify(afterSummary), randomUUID()],
    );
  });
}

async function claimImportJob(pool: DbPool, scope: FinanceScope, jobId: string): Promise<QueuedImportJob | null> {
  return inTenantTransaction(pool, scope, async (client) => {
    const result = await client.query<Record<string, unknown>>(
      `UPDATE finance_import_job
          SET status = 'running', attempts = attempts + 1,
              started_at = COALESCE(started_at, now()),
              lease_expires_at = now() + interval '5 minutes',
              error_code = NULL, error_message = NULL, updated_at = now()
        WHERE household_id = $1 AND id = $2
          AND status = 'queued'
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        RETURNING id::text AS id, import_batch_id::text AS batch_id, requested_by::text AS requested_by,
                  attempts::int AS attempts, max_attempts::int AS max_attempts`,
      [scope.householdId, jobId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { id: String(row.id), batch_id: String(row.batch_id), requested_by: String(row.requested_by), attempts: Number(row.attempts), max_attempts: Number(row.max_attempts) };
  });
}

async function loadImportBatch(pool: DbPool, scope: FinanceScope, batchId: string): Promise<ImportBatchMeta> {
  return inTenantTransaction(pool, scope, async (client) => {
    const result = await client.query<Record<string, unknown>>(
      `SELECT ib.object_key AS object_key, ib.file_name AS file_name, fs.source_type AS source_type
         FROM import_batch ib
         JOIN financial_source fs ON fs.household_id = ib.household_id AND fs.id = ib.source_id
        WHERE ib.household_id = $1 AND ib.id = $2`,
      [scope.householdId, batchId],
    );
    const row = requireWorkerRow(result.rows, "IMPORT_BATCH_MISSING", "账单批次不存在");
    return { object_key: String(row.object_key), file_name: String(row.file_name), source_type: String(row.source_type) };
  });
}

function requireWorkerRow(rows: Array<Record<string, unknown>>, code: string, message: string): Record<string, unknown> {
  const row = rows[0];
  if (!row) throw new Error(`${code}: ${message}`);
  return row;
}

async function markImportJobSucceeded(pool: DbPool, scope: FinanceScope, jobId: string): Promise<boolean> {
  return inTenantTransaction(pool, scope, async (client) => {
    const result = await client.query<{ id: string }>(
      `UPDATE finance_import_job
          SET status = 'succeeded', lease_expires_at = NULL, next_attempt_at = NULL,
              error_code = NULL, error_message = NULL, completed_at = now(), updated_at = now()
        WHERE household_id = $1 AND id = $2 AND status = 'running'
        RETURNING id::text AS id`,
      [scope.householdId, jobId],
    );
    return result.rows.length === 1;
  });
}

async function markImportJobFailure(pool: DbPool, scope: FinanceScope, job: QueuedImportJob, error: unknown): Promise<"retry" | "failed" | "skipped"> {
  const message = error instanceof Error ? error.message.slice(0, 500) : "账单解析失败";
  return inTenantTransaction(pool, scope, async (client) => {
    const result = await client.query<{ status: string; attempts: number }>(
      `UPDATE finance_import_job
          SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
              next_attempt_at = CASE WHEN attempts < max_attempts THEN now() + (LEAST(attempts, 6) * interval '1 minute') ELSE NULL END,
              lease_expires_at = NULL,
              error_code = CASE WHEN attempts >= max_attempts THEN 'IMPORT_PARSE_WORKER_FAILED' ELSE 'IMPORT_PARSE_WORKER_RETRY' END,
              error_message = $3,
              completed_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
              updated_at = now()
        WHERE household_id = $1 AND id = $2 AND status = 'running'
        RETURNING status, attempts::int AS attempts`,
      [scope.householdId, job.id, message],
    );
    const row = result.rows[0];
    if (!row) return "skipped";
    if (String(row.status) === "failed") {
      await client.query(
        `UPDATE import_batch SET status = 'failed', version = version + 1, updated_at = now()
          WHERE household_id = $1 AND id = $2 AND status IN ('scanning', 'uploaded', 'created')`,
        [scope.householdId, job.batch_id],
      );
    }
    return String(row.status) === "failed" ? "failed" : "retry";
  });
}

async function recoverStaleImportJobs(pool: DbPool, householdId: string): Promise<number> {
  return inTenantTransaction(pool, { householdId, userId: SYSTEM_USER_ID }, async (client) => {
    const result = await client.query<{ id: string }>(
      `UPDATE finance_import_job
          SET status = 'queued', lease_expires_at = NULL, next_attempt_at = now(),
              error_code = 'IMPORT_PARSE_WORKER_STALE', error_message = '解析 worker 租约超时，已恢复排队',
              updated_at = now()
        WHERE household_id = $1 AND status = 'running' AND lease_expires_at < now()
        RETURNING id::text AS id`,
      [householdId],
    );
    return result.rows.length;
  });
}

/**
 * DB-backed import parsing worker. The HTTP API only enqueues a job and
 * returns quickly; this function is safe to run in-process for development or
 * from a separate worker process in production. Each job is claimed and staged
 * under the original requester's tenant scope and never bypasses RLS.
 */
export async function runFinanceImportJob(pool: DbPool, parser: FinanceImportParser, store: ImportObjectStore, scope: FinanceScope, jobId: string): Promise<"succeeded" | "retry" | "failed" | "cancelled" | "paused" | "skipped" | null> {
  const claimed = await claimImportJob(pool, scope, jobId);
  if (!claimed) return null;
  try {
    const batch = await loadImportBatch(pool, scope, claimed.batch_id);
    const parsed: ParsedImportResult = await parser.parse({ objectKey: batch.object_key, sourceType: batch.source_type, fileName: batch.file_name });
    const control = await inTenantTransaction(pool, scope, async (client) => {
      const result = await client.query<{ status: string }>(
        `SELECT status FROM finance_import_job WHERE household_id = $1 AND id = $2 FOR UPDATE`,
        [scope.householdId, jobId],
      );
      return result.rows[0]?.status ?? "cancelled";
    });
    if (control !== "running") return control === "paused" ? "paused" : "cancelled";
    await new SqlFinanceRepository(pool, scope, store).stageParsedImport(claimed.batch_id, parsed);
    const succeeded = await markImportJobSucceeded(pool, scope, jobId);
    if (succeeded) await writeImportJobAudit(pool, scope, jobId, "finance_import_parse_succeeded", { status: "running" }, { status: "succeeded", batch_id: claimed.batch_id });
    return succeeded ? "succeeded" : "skipped";
  } catch (error) {
    const outcome = await markImportJobFailure(pool, scope, claimed, error);
    await writeImportJobAudit(pool, scope, jobId, outcome === "failed" ? "finance_import_parse_failed" : "finance_import_parse_retry", { status: "running" }, { status: outcome, error: error instanceof Error ? error.message.slice(0, 500) : "账单解析失败" });
    return outcome;
  }
}

/**
 * Production queue runner. It recovers stale leases first and processes a
 * bounded number of queued jobs per household per run.
 */
export async function runQueuedFinanceImportWorker(pool: DbPool, parser: FinanceImportParser, store: ImportObjectStore, limitPerHousehold = 50) {
  const client = await pool.connect();
  let households: string[];
  try {
    const result = await client.query<{ id: string }>("SELECT id::text AS id FROM household ORDER BY id");
    households = result.rows.map((row) => row.id);
  } finally {
    client.release?.();
  }

  const results: Array<{ household_id: string; scanned: number; processed: number; recovered: number }> = [];
  for (const householdId of households) {
    const recovered = await recoverStaleImportJobs(pool, householdId);
    const queued = await inTenantTransaction(pool, { householdId, userId: SYSTEM_USER_ID }, async (tenantClient) => {
      const result = await tenantClient.query<Record<string, unknown>>(
        `SELECT id::text AS id, import_batch_id::text AS batch_id, requested_by::text AS requested_by,
                attempts::int AS attempts, max_attempts::int AS max_attempts
           FROM finance_import_job
          WHERE household_id = $1 AND status = 'queued'
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          ORDER BY created_at, id
          LIMIT $2`,
        [householdId, Math.max(1, Math.min(500, Math.trunc(limitPerHousehold)))],
      );
      return result.rows.map((row) => ({ id: String(row.id), batch_id: String(row.batch_id), requested_by: String(row.requested_by), attempts: Number(row.attempts), max_attempts: Number(row.max_attempts) }));
    });
    let processed = 0;
    for (const job of queued) {
      const outcome = await runFinanceImportJob(pool, parser, store, { householdId, userId: job.requested_by }, job.id);
      if (outcome === "succeeded" || outcome === "retry" || outcome === "failed") processed += 1;
    }
    results.push({ household_id: householdId, scanned: queued.length, processed, recovered });
  }
  return results;
}
