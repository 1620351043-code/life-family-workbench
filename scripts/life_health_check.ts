import { statfsSync, constants } from "node:fs";
import { stat, access } from "node:fs/promises";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import * as tls from "node:tls";
import { Pool } from "pg";
import { createProductionCosObjectStoreFromEnv } from "../src/api/import-storage.js";

type HealthState = "ok" | "warning" | "critical";

type HealthCheck = {
  name: string;
  state: HealthState;
  code: string | null;
  message: string;
  metrics: Record<string, number | string | boolean | null>;
};

type HealthReport = {
  ok: boolean;
  state: HealthState;
  generated_at: string;
  host: string;
  deployment: string;
  checks: HealthCheck[];
  alert: { delivered: boolean; state: string; code: string | null } | null;
};

type CertificateInfo = {
  valid_to: string;
  days_remaining: number;
};

function envBoolean(env: Record<string, string | undefined>, name: string, fallback = false): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function envNumber(env: Record<string, string | undefined>, name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的数字`);
  }
  return value;
}

function makeCheck(name: string, state: HealthState, code: string | null, message: string, metrics: HealthCheck["metrics"] = {}): HealthCheck {
  return { name, state, code, message, metrics };
}

function buildReport(checks: HealthCheck[], deployment: string): HealthReport {
  const state: HealthState = checks.some((item) => item.state === "critical")
    ? "critical"
    : checks.some((item) => item.state === "warning")
      ? "warning"
      : "ok";
  return {
    ok: state === "ok",
    state,
    generated_at: new Date().toISOString(),
    host: hostname(),
    deployment: deployment || "unknown",
    checks,
    alert: null,
  };
}

function deploymentName(env: Record<string, string | undefined>): string {
  return (env.LIFE_DEPLOYMENT_ENV ?? env.NODE_ENV ?? "development").trim().toLowerCase();
}

function deploymentIsProduction(env: Record<string, string | undefined>): boolean {
  return deploymentName(env) === "production";
}

async function runCapturedCheck(name: string, work: () => Promise<HealthCheck>): Promise<HealthCheck> {
  try {
    return await work();
  } catch {
    return makeCheck(name, "critical", "CHECK_FAILED", `${name} 检查执行失败`, { unexpected_error: true });
  }
}

async function checkApi(env: Record<string, string | undefined>): Promise<HealthCheck> {
  const rawUrl = env.LIFE_HEALTH_API_URL?.trim() || "http://127.0.0.1:3100";
  let base: URL;
  try {
    base = new URL(rawUrl);
  } catch {
    return makeCheck("api", "critical", "API_URL_INVALID", "API 监控地址不是有效 URL", {});
  }
  if (!["http:", "https:"].includes(base.protocol)) {
    return makeCheck("api", "critical", "API_URL_INVALID", "API 监控地址必须使用 HTTP(S)", {});
  }
  const timeoutMs = envNumber(env, "LIFE_HEALTH_API_TIMEOUT_MS", 5000, 500, 30_000);
  const startedAt = Date.now();
  try {
    const response = await fetch(new URL("/healthz", base).toString(), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    const body = await response.json().catch(() => null);
    const latencyMs = Date.now() - startedAt;
    if (!response.ok || body?.status !== "ok") {
      return makeCheck("api", "critical", "API_UNHEALTHY", `API /healthz 返回异常状态`, {
        status: response.status,
        latency_ms: latencyMs,
      });
    }
    return makeCheck("api", "ok", null, "API /healthz 正常", {
      status: response.status,
      latency_ms: latencyMs,
    });
  } catch {
    return makeCheck("api", "critical", "API_UNREACHABLE", "API 无法连接或请求超时", {
      timeout_ms: timeoutMs,
    });
  }
}

function resolveAiSecret(env: Record<string, string | undefined>, apiKeyRef: string): "present" | "missing" | "unverifiable" {
  const envName = `LIFE_AI_SECRET_${apiKeyRef.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()}`;
  if (env[envName]?.trim()) return "present";
  const mapText = env.LIFE_AI_SECRET_MAP?.trim();
  if (!mapText) return "unverifiable";
  try {
    const map = JSON.parse(mapText) as Record<string, unknown>;
    return typeof map[apiKeyRef] === "string" && map[apiKeyRef].trim() ? "present" : "missing";
  } catch {
    return "unverifiable";
  }
}

async function checkDatabase(env: Record<string, string | undefined>, pool: Pool | null): Promise<HealthCheck> {
  const databaseUrl = env.LIFE_HEALTH_DATABASE_URL?.trim();
  if (!databaseUrl) {
    return makeCheck("database", "critical", "DATABASE_URL_MISSING", "健康检查未配置独立数据库连接", {});
  }
  if (!pool) {
    return makeCheck("database", "critical", "DATABASE_UNREACHABLE", "数据库连接池不可用", {});
  }
  const startedAt = Date.now();
  try {
    const roleResult = await pool.query<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      server_version: string;
    }>(
      `SELECT current_user,
              role.rolsuper,
              role.rolbypassrls,
              current_setting('server_version') AS server_version
         FROM pg_roles role
        WHERE role.rolname = current_user`,
    );
    const role = roleResult.rows[0];
    if (!role) return makeCheck("database", "critical", "DATABASE_ROLE_UNREADABLE", "无法读取数据库角色信息", {});

    const requiredTables = [
      "household",
      "app_user",
      "household_member",
      "finance_import_job",
      "finance_export_job",
      "import_batch",
      "household_ai_connection",
      "ai_memory_artifact",
      "ledger_transaction",
    ];
    const tableResult = await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT class.relname, class.relrowsecurity, class.relforcerowsecurity
         FROM pg_class class
         JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = 'public' AND class.relname = ANY($1::text[])`,
      [requiredTables],
    );
    const foundTables = new Map(tableResult.rows.map((row) => [row.relname, row]));
    const missingTables = requiredTables.filter((name) => !foundTables.has(name));
    if (missingTables.length) {
      return makeCheck("database", "critical", "DATABASE_TABLES_MISSING", `数据库缺少关键表：${missingTables.join(", ")}`, {});
    }

    const rlsResult = await pool.query<{ rls_tables: number }>(
      `SELECT count(*)::int AS rls_tables
         FROM pg_class class
         JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = 'public'
          AND class.relrowsecurity
          AND class.relforcerowsecurity`,
    );
    const migrationResult = await pool.query<{ migrations: number }>("SELECT count(*)::int AS migrations FROM life_schema_migration");
    let dataDirectory = env.LIFE_HEALTH_PG_DATA_DIR?.trim() ?? "";
    try {
      const dataDirectoryResult = await pool.query<{ data_directory: string }>("SHOW data_directory");
      dataDirectory = String(dataDirectoryResult.rows[0]?.data_directory ?? "") || dataDirectory;
    } catch {
      // Monitoring role is intentionally not granted pg_read_all_settings; use LIFE_HEALTH_PG_DATA_DIR.
    }
    const latencyMs = Date.now() - startedAt;
    const rlsTables = Number(rlsResult.rows[0]?.rls_tables ?? 0);
    const migrations = Number(migrationResult.rows[0]?.migrations ?? 0);
    const rlsHealthy = rlsTables >= 32;
    const migrationHealthy = migrations >= 15;
    if (!migrationHealthy || !rlsHealthy) {
      return makeCheck("database", "critical", "DATABASE_STRUCTURE_UNHEALTHY", "数据库迁移或 FORCE RLS 数量未达到生产基线", {
        migrations,
        rls_tables: rlsTables,
        latency_ms: latencyMs,
      });
    }
    return makeCheck("database", "ok", null, "数据库连接与结构正常", {
      migrations,
      rls_tables: rlsTables,
      server_version: role.server_version,
      latency_ms: latencyMs,
      data_directory: dataDirectory || null,
    });
  } catch {
    return makeCheck("database", "critical", "DATABASE_UNREACHABLE", "数据库连接或关键查询失败", {
      latency_ms: Date.now() - startedAt,
    });
  }
}

async function checkQueue(env: Record<string, string | undefined>, pool: Pool | null): Promise<HealthCheck> {
  if (!pool) return makeCheck("queue", "critical", "QUEUE_DATABASE_UNAVAILABLE", "队列检查需要数据库连接", {});
  try {
    const result = await pool.query<{
      import_pending: number;
      import_stale: number;
      import_failed: number;
      import_oldest_seconds: number;
      export_pending: number;
      export_failed: number;
      export_oldest_seconds: number;
      retention_pending: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM finance_import_job WHERE status IN ('queued', 'paused')) AS import_pending,
         (SELECT count(*)::int FROM finance_import_job WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < now())) AS import_stale,
         (SELECT count(*)::int FROM finance_import_job WHERE status = 'failed') AS import_failed,
         (SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at)))::int, 0) FROM finance_import_job WHERE status = 'queued') AS import_oldest_seconds,
         (SELECT count(*)::int FROM finance_export_job WHERE status IN ('queued', 'running')) AS export_pending,
         (SELECT count(*)::int FROM finance_export_job WHERE status = 'failed') AS export_failed,
         (SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at)))::int, 0) FROM finance_export_job WHERE status = 'queued') AS export_oldest_seconds,
         (SELECT count(*)::int FROM import_batch WHERE raw_delete_status IN ('pending', 'failed') AND raw_retention_until <= now()) AS retention_pending`,
    );
    const row = result.rows[0];
    if (!row) return makeCheck("queue", "critical", "QUEUE_UNREADABLE", "无法读取队列状态", {});
    const importPending = Number(row.import_pending ?? 0);
    const importStale = Number(row.import_stale ?? 0);
    const importFailed = Number(row.import_failed ?? 0);
    const importOldest = Number(row.import_oldest_seconds ?? 0);
    const exportPending = Number(row.export_pending ?? 0);
    const exportFailed = Number(row.export_failed ?? 0);
    const exportOldest = Number(row.export_oldest_seconds ?? 0);
    const retentionPending = Number(row.retention_pending ?? 0);
    const staleMinutes = envNumber(env, "LIFE_HEALTH_QUEUE_STALE_MINUTES", 30, 5, 1440);
    const failedCritical = envNumber(env, "LIFE_HEALTH_QUEUE_FAILED_CRITICAL", 5, 1, 1000);
    const pendingCritical = envNumber(env, "LIFE_HEALTH_QUEUE_PENDING_CRITICAL", 500, 1, 10000);
    const retentionCritical = envNumber(env, "LIFE_HEALTH_RETENTION_CRITICAL", 20, 1, 10000);

    const metrics: HealthCheck["metrics"] = {
      import_pending: importPending,
      import_stale: importStale,
      import_failed: importFailed,
      import_oldest_seconds: importOldest,
      export_pending: exportPending,
      export_failed: exportFailed,
      export_oldest_seconds: exportOldest,
      retention_pending: retentionPending,
    };

    if (importStale > 0) {
      return makeCheck("queue", "critical", "QUEUE_IMPORT_STALE", "存在解析 worker 租约超时任务", metrics);
    }
    if (importFailed >= failedCritical || exportFailed >= failedCritical) {
      return makeCheck("queue", "critical", "QUEUE_FAILED_TASKS", "导入或导出失败任务达到严重阈值", metrics);
    }
    if (retentionPending >= retentionCritical) {
      return makeCheck("queue", "critical", "RETENTION_BACKLOG", "到期原始账单清理积压超过阈值", metrics);
    }
    if (importOldest >= staleMinutes * 60 || exportOldest >= staleMinutes * 60) {
      return makeCheck("queue", "warning", "QUEUE_STALE", "队列中存在较久未处理任务", metrics);
    }
    if (importPending + exportPending >= pendingCritical || importFailed > 0 || exportFailed > 0 || retentionPending > 0) {
      return makeCheck("queue", "warning", "QUEUE_DEGRADED", "队列存在待处理或失败任务", metrics);
    }
    return makeCheck("queue", "ok", null, "导入、导出与清理队列正常", metrics);
  } catch {
    return makeCheck("queue", "critical", "QUEUE_UNREADABLE", "队列检查失败", {});
  }
}

async function checkObjectStorage(env: Record<string, string | undefined>): Promise<HealthCheck> {
  const production = deploymentIsProduction(env);
  const cosFields = ["LIFE_COS_BUCKET", "LIFE_COS_REGION", "LIFE_COS_SECRET_ID", "LIFE_COS_SECRET_KEY"] as const;
  const missingCos = cosFields.filter((name) => !env[name]?.trim());
  if (production) {
    if (missingCos.length) {
      return makeCheck("object_storage", "critical", "COS_UNCONFIGURED", "生产对象存储配置不完整", {
        missing_fields: missingCos.length,
      });
    }
    if (envBoolean(env, "LIFE_HEALTH_COS_LIVE_SMOKE", false)) {
      try {
        const store = createProductionCosObjectStoreFromEnv();
        const key = `life-health/${randomUUID()}.check`;
        const bytes = Buffer.from("life-health-smoke", "utf8");
        await store.put(key, bytes);
        const downloaded = await store.read(key);
        await store.remove(key);
        if (!downloaded.equals(bytes)) {
          return makeCheck("object_storage", "critical", "COS_SMOKE_FAILED", "COS 上传/读取/删除闭环校验失败", { live_smoke: true });
        }
        return makeCheck("object_storage", "ok", null, "COS 私有对象存储正常", { live_smoke: true });
      } catch {
        return makeCheck("object_storage", "critical", "COS_SMOKE_FAILED", "COS 私有对象存储不可用", { live_smoke: true });
      }
    }
    return makeCheck("object_storage", "ok", null, "COS 配置已就绪，实时 smoke 未启用", {
      live_smoke: false,
      configured: true,
    });
  }

  const root = env.LIFE_HEALTH_STORAGE_ROOT?.trim() || env.LIFE_IMPORT_STORAGE_ROOT?.trim() || "/var/lib/life/staging-imports";
  try {
    await access(root, constants.R_OK | constants.W_OK);
    const info = await stat(root);
    return makeCheck("object_storage", "ok", null, "本地对象存储目录可读可写", {
      live_smoke: false,
      configured: true,
      directory: info.isDirectory(),
    });
  } catch {
    return makeCheck("object_storage", "critical", "STORAGE_UNAVAILABLE", "本地对象存储目录不可用", {
      live_smoke: false,
      configured: false,
    });
  }
}

async function checkAi(env: Record<string, string | undefined>, pool: Pool | null): Promise<HealthCheck> {
  if (!pool) return makeCheck("ai", "critical", "AI_DATABASE_UNAVAILABLE", "AI 检查需要数据库连接", {});
  try {
    const result = await pool.query<{ status: string; api_key_ref: string }>(
      `SELECT status, api_key_ref FROM household_ai_connection ORDER BY created_at`,
    );
    let active = 0;
    let disabled = 0;
    let errored = 0;
    let missingSecrets = 0;
    let secretVerifiable = false;
    for (const row of result.rows) {
      const status = String(row.status ?? "");
      if (status === "active") {
        active += 1;
        const resolved = resolveAiSecret(env, String(row.api_key_ref ?? ""));
        if (resolved === "missing") missingSecrets += 1;
        if (resolved !== "unverifiable") secretVerifiable = true;
      } else if (status === "disabled") {
        disabled += 1;
      } else if (status === "error") {
        errored += 1;
      }
    }
    const metrics: HealthCheck["metrics"] = {
      active_connections: active,
      disabled_connections: disabled,
      error_connections: errored,
      missing_secrets: missingSecrets,
      secret_verifiable: secretVerifiable,
    };
    if (errored > 0 || missingSecrets > 0) {
      return makeCheck("ai", "warning", "AI_CONNECTION_DEGRADED", "存在失败或密钥缺失的家庭 AI 连接", metrics);
    }
    return makeCheck("ai", "ok", null, "家庭 AI 连接状态正常", metrics);
  } catch {
    return makeCheck("ai", "critical", "AI_UNREADABLE", "AI 连接检查失败", {});
  }
}

function diskUsage(path: string): { total_bytes: number; free_bytes: number; used_percent: number } {
  const info = statfsSync(path);
  const blockSize = Number(info.bsize);
  const totalBlocks = Number(info.blocks);
  const freeBlocks = Number(info.bavail);
  const totalBytes = totalBlocks * blockSize;
  const freeBytes = freeBlocks * blockSize;
  return {
    total_bytes: totalBytes,
    free_bytes: freeBytes,
    used_percent: totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10 : 0,
  };
}

async function checkDisk(env: Record<string, string | undefined>, dataDirectory: string | null): Promise<HealthCheck> {
  const paths = new Set<string>();
  const configuredPaths = env.LIFE_HEALTH_DISK_PATHS?.trim();
  if (configuredPaths) {
    for (const item of configuredPaths.split(",")) {
      const value = item.trim();
      if (value) paths.add(value);
    }
  }
  paths.add("/srv/life");
  paths.add(env.LIFE_HEALTH_STORAGE_ROOT?.trim() || env.LIFE_IMPORT_STORAGE_ROOT?.trim() || "/var/lib/life/staging-imports");
  if (dataDirectory) paths.add(dataDirectory);

  const warnPercent = envNumber(env, "LIFE_HEALTH_DISK_WARN_PERCENT", 80, 30, 99);
  const criticalPercent = envNumber(env, "LIFE_HEALTH_DISK_CRITICAL_PERCENT", 90, 50, 100);
  const results: Array<{ path: string; used_percent: number; free_bytes: number }> = [];
  for (const target of paths) {
    try {
      const usage = diskUsage(target);
      results.push({ path: target, used_percent: usage.used_percent, free_bytes: usage.free_bytes });
    } catch {
      return makeCheck("disk", "critical", "DISK_PATH_UNREADABLE", "磁盘检查路径不可访问", { path: target });
    }
  }
  const worstPercent = Math.max(...results.map((item) => item.used_percent));
  const metrics: HealthCheck["metrics"] = {
    checked_paths: results.length,
    worst_used_percent: worstPercent,
    warn_percent: warnPercent,
    critical_percent: criticalPercent,
  };
  if (worstPercent > criticalPercent) {
    return makeCheck("disk", "critical", "DISK_CRITICAL", "磁盘使用率超过严重阈值", metrics);
  }
  if (worstPercent > warnPercent) {
    return makeCheck("disk", "warning", "DISK_WARNING", "磁盘使用率超过预警阈值", metrics);
  }
  return makeCheck("disk", "ok", null, "磁盘空间充足", metrics);
}

async function getCertificate(host: string, port: number, timeoutMs: number): Promise<CertificateInfo> {
  return new Promise((resolvePromise, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: true,
      timeout: timeoutMs,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("TLS timeout"));
    }, timeoutMs + 1000);
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      socket.end();
      clearTimeout(timer);
      if (!certificate?.valid_to) {
        reject(new Error("TLS certificate missing"));
        return;
      }
      const expiresAt = new Date(certificate.valid_to).getTime();
      resolvePromise({
        valid_to: certificate.valid_to,
        days_remaining: Math.max(0, Math.floor((expiresAt - Date.now()) / 86_400_000)),
      });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function checkCertificate(env: Record<string, string | undefined>): Promise<HealthCheck> {
  const rawHost = env.LIFE_HEALTH_TLS_HOST?.trim();
  let host = rawHost ?? "";
  if (!host && env.LIFE_PUBLIC_APP_URL?.trim()) {
    try {
      host = new URL(env.LIFE_PUBLIC_APP_URL).hostname;
    } catch {
      host = "";
    }
  }
  if (!host) {
    return makeCheck("certificate", "warning", "TLS_HOST_MISSING", "未配置 TLS 监控主机", {});
  }
  const port = envNumber(env, "LIFE_HEALTH_TLS_PORT", 443, 1, 65535);
  const timeoutMs = envNumber(env, "LIFE_HEALTH_TLS_TIMEOUT_MS", 5000, 500, 30_000);
  const warnDays = envNumber(env, "LIFE_HEALTH_CERT_WARN_DAYS", 14, 1, 365);
  const criticalDays = envNumber(env, "LIFE_HEALTH_CERT_CRITICAL_DAYS", 7, 1, 365);
  try {
    const certificate = await getCertificate(host, port, timeoutMs);
    const metrics: HealthCheck["metrics"] = {
      days_remaining: certificate.days_remaining,
      valid_to: certificate.valid_to,
    };
    if (certificate.days_remaining <= criticalDays) {
      return makeCheck("certificate", "critical", "TLS_CERT_CRITICAL", "HTTPS 证书即将过期或已过期", metrics);
    }
    if (certificate.days_remaining <= warnDays) {
      return makeCheck("certificate", "warning", "TLS_CERT_WARNING", "HTTPS 证书将在近期到期", metrics);
    }
    return makeCheck("certificate", "ok", null, "HTTPS 证书有效期充足", metrics);
  } catch {
    return makeCheck("certificate", "critical", "TLS_CERT_UNREACHABLE", "无法连接 HTTPS 获取证书信息", { host });
  }
}

async function sendAlert(env: Record<string, string | undefined>, report: HealthReport): Promise<HealthReport["alert"]> {
  const endpoint = env.LIFE_HEALTH_ALERT_WEBHOOK_URL?.trim();
  if (!endpoint) return { delivered: false, state: report.state, code: "ALERT_WEBHOOK_NOT_CONFIGURED" };
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") {
      return { delivered: false, state: report.state, code: "ALERT_WEBHOOK_MUST_HTTPS" };
    }
    const failed = report.checks.filter((item) => item.state !== "ok");
    const payload = {
      event: "life_health_alert",
      state: report.state,
      generated_at: report.generated_at,
      host: report.host,
      deployment: report.deployment,
      summary: report.state === "critical" ? "Life staging/production 健康检查出现严重告警" : "Life staging/production 健康检查出现告警",
      checks: failed.map((item) => ({ name: item.name, state: item.state, code: item.code })),
    };
    const token = env.LIFE_HEALTH_ALERT_WEBHOOK_TOKEN?.trim();
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    return { delivered: response.ok, state: report.state, code: response.ok ? null : "ALERT_WEBHOOK_REJECTED" };
  } catch {
    return { delivered: false, state: report.state, code: "ALERT_WEBHOOK_UNREACHABLE" };
  }
}

export async function runHealthCheck(env: Record<string, string | undefined> = process.env): Promise<HealthReport> {
  const deployment = deploymentName(env);
  const checks: HealthCheck[] = [];
  let pool: Pool | null = null;
  const databaseUrl = env.LIFE_HEALTH_DATABASE_URL?.trim();
  if (databaseUrl) {
    try {
      pool = new Pool({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 10_000,
      });
    } catch {
      pool = null;
    }
  }

  let dataDirectory: string | null = null;
  checks.push(await runCapturedCheck("api", () => checkApi(env)));
  const database = await runCapturedCheck("database", () => checkDatabase(env, pool));
  checks.push(database);
  if (database.state === "ok" && typeof database.metrics.data_directory === "string") {
    dataDirectory = database.metrics.data_directory || null;
  }
  if (pool) {
    checks.push(await runCapturedCheck("queue", () => checkQueue(env, pool)));
    checks.push(await runCapturedCheck("ai", () => checkAi(env, pool)));
  } else {
    checks.push(makeCheck("queue", "critical", "QUEUE_DATABASE_UNAVAILABLE", "队列检查需要数据库连接", {}));
    checks.push(makeCheck("ai", "critical", "AI_DATABASE_UNAVAILABLE", "AI 检查需要数据库连接", {}));
  }
  checks.push(await runCapturedCheck("object_storage", () => checkObjectStorage(env)));
  checks.push(await runCapturedCheck("disk", () => checkDisk(env, dataDirectory)));
  checks.push(await runCapturedCheck("certificate", () => checkCertificate(env)));

  const report = buildReport(checks, deployment);
  if (report.state !== "ok") {
    report.alert = await sendAlert(env, report);
  }
  try {
    await pool?.end();
  } catch {
    // Ignore pool shutdown errors after checks.
  }
  return report;
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  void (async () => {
    try {
      const report = await runHealthCheck();
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.state === "critical" ? 1 : report.state === "warning" ? 2 : 0;
    } catch {
      process.exitCode = 1;
    }
  })();
}
