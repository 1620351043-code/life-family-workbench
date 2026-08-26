import { randomUUID } from "node:crypto";
import { inTenantTransaction, type DbPool, type FinanceScope } from "./database.js";
import { importObjectKey, type ImportObjectStore } from "./import-storage.js";

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

type RetentionBatch = { id: string; object_key: string; raw_delete_attempts: number };
type RetentionExport = { id: string; object_key: string };
type RetentionMemory = { id: string; object_key: string };

async function writeRetentionAudit(pool: DbPool, householdId: string, resourceType: string, resourceId: string, action: string, beforeSummary: unknown, afterSummary: unknown) {
  await inTenantTransaction(pool, { householdId, userId: SYSTEM_USER_ID }, async (client) => {
    await client.query(
      `INSERT INTO audit_log (id, household_id, actor_id, actor_type, action, resource_type, resource_id, before_summary, after_summary, trace_id)
       VALUES ($1, $2, NULL, 'system', $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
      [randomUUID(), householdId, action, resourceType, resourceId, JSON.stringify(beforeSummary), JSON.stringify(afterSummary), randomUUID()],
    );
  });
}

export async function runFinanceRetentionForHousehold(pool: DbPool, householdId: string, store: ImportObjectStore, limit = 50) {
  const scope: FinanceScope = { householdId, userId: SYSTEM_USER_ID };
  const batches: RetentionBatch[] = await inTenantTransaction(pool, scope, async (client) => {
    const result = await client.query<RetentionBatch>(
      `SELECT id::text AS id, object_key, raw_delete_attempts
         FROM import_batch
        WHERE household_id = $1
          AND raw_retention_until <= now()
          AND raw_delete_status IN ('pending', 'failed')
          AND raw_delete_attempts < 5
        ORDER BY raw_retention_until, created_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [householdId, Math.max(1, Math.min(500, Math.trunc(limit)))],
    );
    for (const batch of result.rows) {
      await client.query(
        `UPDATE import_batch SET raw_delete_status = 'running', raw_delete_attempts = raw_delete_attempts + 1, raw_delete_error = NULL, updated_at = now()
          WHERE household_id = $1 AND id = $2`,
        [householdId, batch.id],
      );
    }
    return result.rows;
  });

  let deleted = 0;
  let failed = 0;
  for (const batch of batches) {
    const key = importObjectKey(householdId, batch.id);
    try {
      await store.remove(key);
      await inTenantTransaction(pool, scope, async (client) => {
        await client.query(
          `UPDATE import_batch
              SET raw_delete_status = 'deleted', raw_deleted_at = now(), raw_delete_error = NULL,
                  header_preview = '{"sheets":[]}'::jsonb, updated_at = now()
            WHERE household_id = $1 AND id = $2`,
          [householdId, batch.id],
        );
        await client.query(`UPDATE source_record SET raw_object_key = NULL WHERE household_id = $1 AND import_batch_id = $2`, [householdId, batch.id]);
      });
      await writeRetentionAudit(pool, householdId, "import_batch", batch.id, "finance_import_raw_deleted", { raw_delete_status: "running", attempts: batch.raw_delete_attempts + 1 }, { raw_delete_status: "deleted", header_preview_removed: true });
      deleted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "原始账单清理失败";
      await inTenantTransaction(pool, scope, async (client) => {
        await client.query(`UPDATE import_batch SET raw_delete_status = 'failed', raw_delete_error = $3, updated_at = now() WHERE household_id = $1 AND id = $2`, [householdId, batch.id, message]);
      });
      await writeRetentionAudit(pool, householdId, "import_batch", batch.id, "finance_import_raw_delete_failed", { raw_delete_status: "running", attempts: batch.raw_delete_attempts + 1 }, { raw_delete_status: "failed", error: message });
      failed += 1;
    }
  }
  let exportsExpired = 0;
  let exportsFailed = 0;
  const exportJobs: RetentionExport[] = await inTenantTransaction(pool, scope, async (client) => {
    const result = await client.query<RetentionExport>(
      `SELECT id::text AS id, object_key
         FROM finance_export_job
        WHERE household_id = $1
          AND status IN ('ready', 'expired')
          AND download_expires_at <= now()
          AND object_key IS NOT NULL
        ORDER BY download_expires_at, created_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [householdId, Math.max(1, Math.min(500, Math.trunc(limit)))],
    );
    return result.rows;
  });
  for (const job of exportJobs) {
    try {
      await store.remove(job.object_key);
      await inTenantTransaction(pool, scope, async (client) => {
        await client.query(
          `UPDATE finance_export_job
              SET status = 'expired', object_key = NULL, updated_at = now()
            WHERE household_id = $1 AND id = $2 AND status = 'ready'`,
          [householdId, job.id],
        );
      });
      await writeRetentionAudit(pool, householdId, "finance_export_job", job.id, "finance_export_expired", { status: "ready" }, { status: "expired", object_removed: true });
      exportsExpired += 1;
    } catch (error) {
      await writeRetentionAudit(pool, householdId, "finance_export_job", job.id, "finance_export_expire_failed", { status: "ready" }, { status: "ready", error: error instanceof Error ? error.message.slice(0, 500) : "导出文件清理失败" });
      exportsFailed += 1;
    }
  }

  let memoryDeleted = 0;
  let memoryFailed = 0;
  const memoryArtifacts: RetentionMemory[] = await inTenantTransaction(pool, scope, async (client) => {
    const result = await client.query<RetentionMemory>(
      `SELECT id::text AS id, object_key
         FROM ai_memory_artifact
        WHERE household_id = $1
          AND status IN ('active', 'pending_delete')
          AND retention_until <= now()
        ORDER BY retention_until, created_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [householdId, Math.max(1, Math.min(500, Math.trunc(limit)))],
    );
    for (const artifact of result.rows) {
      await client.query(`UPDATE ai_memory_artifact SET status = 'pending_delete' WHERE household_id = $1 AND id = $2`, [householdId, artifact.id]);
    }
    return result.rows;
  });
  for (const artifact of memoryArtifacts) {
    try {
      await store.remove(artifact.object_key);
      await inTenantTransaction(pool, scope, async (client) => {
        await client.query(
          `UPDATE ai_memory_artifact
              SET status = 'deleted', deleted_at = now()
            WHERE household_id = $1 AND id = $2 AND status = 'pending_delete'`,
          [householdId, artifact.id],
        );
      });
      await writeRetentionAudit(pool, householdId, "ai_memory_artifact", artifact.id, "finance_ai_memory_deleted", { status: "pending_delete" }, { status: "deleted", object_removed: true });
      memoryDeleted += 1;
    } catch (error) {
      await writeRetentionAudit(pool, householdId, "ai_memory_artifact", artifact.id, "finance_ai_memory_delete_failed", { status: "pending_delete" }, { status: "pending_delete", error: error instanceof Error ? error.message.slice(0, 500) : "AI 记忆清理失败" });
      memoryFailed += 1;
    }
  }

  return { household_id: householdId, scanned: batches.length, deleted, failed, exports_expired: exportsExpired, exports_failed: exportsFailed, ai_memory_deleted: memoryDeleted, ai_memory_failed: memoryFailed };
}

export async function runFinanceRetentionWorker(pool: DbPool, store: ImportObjectStore, limitPerHousehold = 50) {
  const client = await pool.connect();
  let households: string[];
  try {
    const result = await client.query<{ id: string }>("SELECT id::text AS id FROM household ORDER BY id");
    households = result.rows.map((row) => row.id);
  } finally {
    client.release?.();
  }
  const results = [];
  for (const householdId of households) results.push(await runFinanceRetentionForHousehold(pool, householdId, store, limitPerHousehold));
  return results;
}
