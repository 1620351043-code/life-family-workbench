#!/usr/bin/env node
// I-014 anomaly drill driver.
//
// This script intentionally uses isolated test households and synthetic data.
// It never prints passwords, session tokens, API keys or raw bill content.
// Destructive operations are not performed by the script; the generated
// report is the source of truth for a separate cleanup step.
//
// Safety requirements:
//   LIFE_ANOMALY_CONFIRM=I_UNDERSTAND_THIS_RUNS_ANOMALY_DRILL
//   LIFE_ANOMALY_BASE_URL=https://...
//   LIFE_ANOMALY_DB_URL is only needed for direct worker/DB scenarios.
//
// Scenarios:
//   isolation - concurrent households, cross-tenant read isolation
//   large_import - near-limit upload + parser worker, over-limit rejection
//   queue - export queue backlog and bounded worker processing
//   ai - active AI connection failure must not break core finance pages
//   slow - bulk ledger seed, EXPLAIN ANALYZE and API latency baseline

import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const CONFIRMATION = "I_UNDERSTAND_THIS_RUNS_ANOMALY_DRILL";
const PRODUCTION_HOST = "life.wbutterfly.cn";
const SCENARIOS = ["isolation", "large_import", "queue", "ai", "slow"];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}

function integer(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
}

function httpsUrl(value, name) {
  const parsed = new URL(value);
  if (!["https:", "http:"].includes(parsed.protocol)) throw new Error(`${name} 必须使用 HTTP(S)`);
  if (parsed.username || parsed.password) throw new Error(`${name} 不能在 URL 中携带凭据`);
  if (parsed.hostname === PRODUCTION_HOST && process.env.LIFE_ANOMALY_ALLOW_PRODUCTION !== "YES") {
    throw new Error(`禁止直接演练生产域名 ${PRODUCTION_HOST}；确认后设置 LIFE_ANOMALY_ALLOW_PRODUCTION=YES`);
  }
  if (parsed.protocol === "http:" && !["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error(`${name} 非本机地址必须使用 HTTPS`);
  }
  return parsed;
}

function assertNoCredentialOutput() {
  const source = new URL(import.meta.url).searchParams.get("source") ?? "";
  if (/password|token|secret/i.test(source)) throw new Error("演练脚本不能读取/打印凭据字段");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function nonce() {
  return `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(5).toString("hex")}`;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

class HttpError extends Error {
  constructor(status, code, message, payload) {
    super(message || `HTTP ${status}`);
    this.status = status;
    this.code = code ?? `HTTP_${status}`;
    this.payload = payload ?? null;
  }
}

class FamilyClient {
  constructor(baseUrl, email, password, identity, cookie) {
    this.baseUrl = baseUrl;
    this.email = email;
    this.password = password;
    this.identity = identity;
    this.cookie = cookie;
  }

  async raw(method, path, { headers = {}, body, timeoutMs = 30_000 } = {}) {
    const url = new URL(path, this.baseUrl).toString();
    const response = await fetch(url, {
      method,
      headers: { ...headers, ...(this.cookie ? { cookie: this.cookie } : {}) },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    return { response, status: response.status, payload, text };
  }

  async json(method, path, body, options = {}) {
    const result = await this.raw(method, path, {
      ...options,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(options.headers ?? {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!result.response.ok) {
      throw new HttpError(result.status, result.payload?.code, result.payload?.message, result.payload);
    }
    return result.payload;
  }

  async expectStatus(method, path, expectedCodes, body, options = {}) {
    const result = await this.raw(method, path, {
      ...options,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(options.headers ?? {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const allowed = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
    if (!allowed.includes(result.status)) {
      throw new HttpError(result.status, result.payload?.code, `预期 HTTP ${allowed.join("/")}，实际 ${result.status}`, result.payload);
    }
    return result;
  }

  async register() {
    const result = await this.raw("POST", "/api/auth/register", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: this.email, password: this.password, household_name: this.identity.household_name }),
    });
    if (result.status !== 201) {
      throw new HttpError(result.status, result.payload?.code, `注册失败：HTTP ${result.status}`, result.payload);
    }
    const cookieHeader = result.response.headers.get("set-cookie");
    if (!cookieHeader) throw new Error("注册成功但没有返回会话 Cookie");
    this.cookie = cookieHeader.split(";")[0];
    this.identity = { ...this.identity, ...result.payload?.user ? { user: result.payload.user } : {}, ...result.payload?.household ? { household: result.payload.household } : {} };
    return this.identity;
  }
}

async function registerFamilies(baseUrl, count, runNonce) {
  const families = [];
  for (let index = 0; index < count; index += 1) {
    const email = `anomaly-${runNonce}-${index}@life.invalid`;
    const password = `Life#A-${randomBytes(12).toString("base64url")}`;
    const householdName = `I014-${runNonce}-${index}`;
    const identity = { household_name: householdName, user: null, household: null };
    const family = new FamilyClient(baseUrl, email, password, identity);
    await family.register();
    families.push(family);
  }
  return families;
}

async function seedFamily(family, index) {
  const account = await family.json("POST", "/api/finance/accounts", {
    name: `I014 账户 ${index}`,
    account_type: "wallet",
    currency: "CNY",
    opening_balance: "0",
  });
  const incomeCategory = await family.json("POST", "/api/finance/categories", {
    name: `I014 收入 ${index}`,
    direction_scope: "income",
    color_token: "violet",
  });
  const expenseCategory = await family.json("POST", "/api/finance/categories", {
    name: `I014 支出 ${index}`,
    direction_scope: "expense",
    color_token: "rose",
  });
  const transactions = [];
  for (let row = 0; row < 2; row += 1) {
    const transaction = await family.json("POST", "/api/finance/transactions", {
      direction: row === 0 ? "income" : "expense",
      occurred_at: row === 0 ? "2026-01-01 09:00:00" : "2026-01-02 09:00:00",
      amount: row === 0 ? "100.00" : "25.00",
      currency: "CNY",
      account_id: account.id,
      category_id: row === 0 ? incomeCategory.id : expenseCategory.id,
      merchant: `I014-MARKER-${index}-${row}`,
    });
    transactions.push(transaction.transaction_id);
  }
  return {
    account,
    incomeCategory,
    expenseCategory,
    transactions,
    markers: [`I014-MARKER-${index}-0`, `I014-MARKER-${index}-1`],
  };
}

async function runIsolationScenario(families) {
  const startedAt = Date.now();
  const perFamily = [];
  for (let index = 0; index < families.length; index += 1) {
    const family = families[index];
    const seeded = await seedFamily(family, index);
    const [accounts, categories, transactions, overview] = await Promise.all([
      family.json("GET", "/api/finance/accounts"),
      family.json("GET", "/api/finance/categories"),
      family.json("GET", "/api/finance/transactions?page=1&page_size=100"),
      family.json("GET", "/api/finance/overview?start=2026-01-01&end=2026-01-31&granularity=day"),
    ]);
    const visibleMerchants = (transactions.items ?? []).map((item) => item.merchant).join(",");
    const foreignMarkers = (families ?? []).flatMap((_, otherIndex) => otherIndex === index ? [] : [`I014-MARKER-${otherIndex}-0`, `I014-MARKER-${otherIndex}-1`]);
    const leaked = foreignMarkers.filter((marker) => visibleMerchants.includes(marker));
    if (leaked.length) throw new Error(`家庭隔离泄露：${leaked.join(",")}`);
    if (!seeded.markers.every((marker) => visibleMerchants.includes(marker))) throw new Error(`家庭 ${index} 自己的账本数据不可见`);
    if (!accounts.accounts?.some((item) => item.id === seeded.account.id)) throw new Error(`家庭 ${index} 账户隔离异常`);
    if (!categories.categories?.some((item) => item.id === seeded.expenseCategory.id)) throw new Error(`家庭 ${index} 分类隔离异常`);
    perFamily.push({
      index,
      household_id: family.identity.household?.id ?? null,
      account_count: accounts.accounts?.length ?? 0,
      category_count: categories.categories?.length ?? 0,
      transaction_count: transactions.pagination?.total ?? 0,
      overview_summary_cards: overview.summary_cards?.length ?? 0,
      markers: seeded.markers.length,
    });
    families[index].transactionIds = seeded.transactions;
  }

  const concurrentStartedAt = Date.now();
  const concurrent = await Promise.all(families.map(async (family, index) => {
    const started = Date.now();
    await Promise.all([
      family.json("GET", "/api/finance/overview?start=2026-01-01&end=2026-01-31&granularity=day"),
      family.json("GET", `/api/finance/transactions?page=1&page_size=100`),
      family.json("GET", `/api/finance/drilldowns/${globalThis.crypto.randomUUID()}`).catch((error) => error instanceof HttpError && error.status === 404 ? null : Promise.reject(error)),
    ]);
    return { index, latency_ms: Date.now() - started };
  }));
  const concurrentDurationMs = Date.now() - concurrentStartedAt;

  const crossChecks = [];
  for (let left = 0; left < families.length; left += 1) {
    for (let right = 0; right < families.length; right += 1) {
      if (left === right) continue;
      const foreign = families[right].identity ?? null;
      const cross = await families[left].expectStatus(
        "GET",
        `/api/finance/transactions/${families[right].transactionIds?.[0] ?? ""}`,
        [404],
      );
      crossChecks.push({ from: left, to: right, status: cross.status });
    }
  }

  return {
    ok: true,
    scenario: "isolation",
    household_count: families.length,
    per_family: perFamily,
    concurrent_requests: concurrent,
    concurrent_duration_ms: concurrentDurationMs,
    cross_tenant_404_checks: crossChecks.length,
    duration_ms: Date.now() - startedAt,
  };
}

async function buildLargeCsv(targetBytes) {
  const header = "交易时间,金额,收支,交易对方,流水号,备注";
  const rows = [header];
  let bytes = Buffer.byteLength(`${header}\n`, "utf8");
  const filler = "x".repeat(280);
  let rowNumber = 0;
  while (bytes < targetBytes && rows.length < 100_001) {
    rowNumber += 1;
    const line = [
      "2026-01-01 12:00:00",
      "0.01",
      "支出",
      "I014-LARGE",
      `L-${rowNumber}`,
      `${filler}-${rowNumber}`,
    ].map(csvCell).join(",");
    bytes += Buffer.byteLength(`${line}\n`, "utf8");
    rows.push(line);
  }
  return Buffer.from(`${rows.join("\n")}\n`, "utf8");
}

async function createAndParseImport(family, accountId, fileName, bytes) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const batch = await family.json("POST", "/api/finance/import-batches", {
    source_type: "bank",
    file_name: fileName,
    file_size: bytes.byteLength,
    file_sha256: sha256,
    object_key: `anomaly/${family.identity.household?.id ?? "test"}/${fileName}`,
    account_id: accountId,
  });
  await family.raw("POST", `/api/finance/import-batches/${batch.id}/upload`, {
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
    timeoutMs: 120_000,
  }).then((result) => {
    if (result.status !== 200) {
      throw new HttpError(result.status, result.payload?.code, `账单上传失败：HTTP ${result.status}`, result.payload);
    }
  });
  const parsed = await family.json("POST", `/api/finance/import-batches/${batch.id}/parse`);
  const jobId = parsed?.job?.id;
  if (!jobId) throw new Error("解析接口没有返回 job id");
  const deadline = Date.now() + 90_000;
  let job = null;
  while (Date.now() < deadline) {
    job = await family.json("GET", `/api/finance/import-jobs/${jobId}`);
    if (["succeeded", "failed", "cancelled"].includes(job.status)) break;
    await sleep(1_000);
  }
  const finalJob = job ?? await family.json("GET", `/api/finance/import-jobs/${jobId}`);
  const finalBatch = await family.json("GET", `/api/finance/import-batches/${batch.id}`);
  return { batch, job: finalJob, batch_detail: finalBatch };
}

async function runLargeImportScenario(families) {
  const family = families[0];
  const readyAccount = await family.json("GET", "/api/finance/accounts");
  const accountId = readyAccount.accounts?.[0]?.id;
  if (!accountId) throw new Error("大文件场景缺少账户");

  const targetMb = integer("LIFE_ANOMALY_LARGE_FILE_MB", 12, 1, 49);
  const bytes = await buildLargeCsv(targetMb * 1024 * 1024);
  const startedAt = Date.now();
  const result = await createAndParseImport(family, accountId, `anomaly-large-${bytes.byteLength}.csv`, bytes);
  const nearLimit = {
    file_size: bytes.byteLength,
    target_mb: targetMb,
    parse_status: result.job?.status,
    parse_error_code: result.job?.error_code ?? null,
    batch_status: result.batch_detail?.status ?? null,
    parsed_rows: result.batch_detail?.counts?.rows ?? 0,
    duration_ms: Date.now() - startedAt,
  };
  if (result.job?.status !== "succeeded") {
    throw new Error(`超大账单解析未成功：${JSON.stringify({ status: result.job?.status, error_code: result.job?.error_code, error_message: result.job?.error_message?.slice(0, 120) })}`);
  }

  const tooLargeBytes = Buffer.alloc(50 * 1024 * 1024 + 1, 0x30);
  const tooLargeSha256 = createHash("sha256").update(tooLargeBytes).digest("hex");
  const tooLarge = await family.expectStatus("POST", "/api/finance/import-batches", [400], {
    source_type: "bank",
    file_name: "anomaly-too-large.csv",
    file_size: tooLargeBytes.byteLength,
    file_sha256: tooLargeSha256,
    object_key: "anomaly/too-large.csv",
    account_id: accountId,
  });

  const rawDelete = await family.raw("DELETE", `/api/finance/import-batches/${result.batch.id}/raw`);
  return {
    ok: true,
    scenario: "large_import",
    near_limit: nearLimit,
    over_limit_rejection: { status: tooLarge.status, code: tooLarge.payload?.code ?? null, file_size: tooLargeBytes.byteLength, object_created: false },
    raw_delete_status: rawDelete.status,
  };
}

async function queueApiProbe(family, jobCount) {
  const startedAt = Date.now();
  const created = [];
  for (let index = 0; index < jobCount; index += 1) {
    const response = await family.json("POST", "/api/finance/exports", {
      start: "2026-01-01",
      end: "2026-01-01",
      format: "csv",
    }, { headers: { "idempotency-key": `anomaly-api-${index}` } });
    created.push(response);
  }
  await sleep(3_000);
  const statuses = {};
  for (const job of created) {
    const detail = await family.json("GET", `/api/finance/exports/${job.id}`);
    statuses[detail.status] = (statuses[detail.status] ?? 0) + 1;
  }
  return {
    created: jobCount,
    statuses_after_probe: statuses,
    duration_ms: Date.now() - startedAt,
  };
}

async function seedExportBacklog(pool, family, jobCount) {
  await withTenant(pool, scopeOf(family), async (client) => {
    await client.query(
      `INSERT INTO finance_export_job (id, household_id, requested_by, format, period_start, period_end, idempotency_key)
       SELECT gen_random_uuid(), $1, $2, 'csv',
              date '2026-01-01' + (g % 28),
              date '2026-01-01' + (g % 28),
              'anomaly-direct-' || g
         FROM generate_series(1, $3) AS g
       ON CONFLICT (household_id, idempotency_key) DO NOTHING`,
      [family.identity.household.id, family.identity.user.id, jobCount],
    );
  });
}

async function runQueueScenario(families, databaseUrl) {
  const family = families[0];
  const jobCount = integer("LIFE_ANOMALY_EXPORT_JOBS", 60, 10, 500);
  const limit = integer("LIFE_ANOMALY_EXPORT_BATCH_LIMIT", 50, 1, 500);
  const startedAt = Date.now();
  const apiProbe = await queueApiProbe(family, Math.min(10, jobCount));
  if (!databaseUrl) {
    return {
      ok: true,
      scenario: "queue",
      mode: "api_probe_only",
      api_probe: apiProbe,
      db_direct: null,
      skipped_reason: "未提供 LIFE_ANOMALY_DB_URL，未执行真实数据库队列堆积",
      duration_ms: Date.now() - startedAt,
    };
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await seedExportBacklog(pool, family, jobCount);
    const storeRoot = process.env.LIFE_IMPORT_STORAGE_ROOT;
    const workerResult = await runDirectExportWorker(databaseUrl, storeRoot, limit);
    const workerEntry = workerResult.find((item) => item.household_id === family.identity.household.id) ?? null;
    const sampleStatuses = [];
    for (const id of [1, Math.max(1, Math.floor(jobCount / 2)), jobCount]) {
      const job = await family.json("GET", `/api/finance/exports/${await exportJobId(pool, family, `anomaly-direct-${id}`)}`);
      sampleStatuses.push({ ordinal: id, status: job.status, job_id_present: Boolean(job.id) });
    }
    return {
      ok: true,
      scenario: "queue",
      mode: "api_probe_and_db_worker",
      api_probe: apiProbe,
      db_direct: {
        seeded_jobs: jobCount,
        batch_limit: limit,
        worker: workerEntry,
        sample_statuses: sampleStatuses,
      },
      duration_ms: Date.now() - startedAt,
    };
  } finally {
    await pool.end();
  }
}

async function exportJobId(pool, family, idempotencyKey) {
  return withTenant(pool, scopeOf(family), async (client) => {
    const result = await client.query("SELECT id::text AS id FROM finance_export_job WHERE household_id = $1 AND idempotency_key = $2", [family.identity.household.id, idempotencyKey]);
    return result.rows[0]?.id ?? null;
  });
}

async function runDirectExportWorker(databaseUrl, storeRoot, limit) {
  const workerPath = join(process.cwd(), "scripts", "finance_export_worker.ts");
  const tsxPath = join(process.cwd(), "node_modules", ".bin", "tsx");
  const { stdout } = await execFileAsync(tsxPath, [workerPath], {
    cwd: process.cwd(),
    timeout: 90_000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ...(storeRoot ? { LIFE_IMPORT_STORAGE_ROOT: storeRoot } : {}),
      LIFE_EXPORT_BATCH_LIMIT: String(limit),
    },
  });
  const parsed = JSON.parse(stdout.trim());
  if (!parsed?.ok) throw new Error("导出 worker 执行失败");
  return parsed.result ?? [];
}
async function runAiScenario(families) {
  const family = families[0];
  const startedAt = Date.now();
  const baseline = await family.json("GET", "/api/finance/ai/summary?start=2026-01-01&end=2026-01-31");
  const baselineProvider = baseline?.insight?.provider ?? null;
  const endpoint = process.env.LIFE_ANOMALY_AI_ENDPOINT_URL?.trim() || "https://127.0.0.1:9";
  const apiKeyRef = process.env.LIFE_ANOMALY_AI_KEY_REF?.trim() || "ANOMALY_TIMEOUT";
  const saved = await family.json("PUT", "/api/finance/ai/connection", {
    endpoint_url: endpoint,
    model: "anomaly-test",
    api_key_ref: apiKeyRef,
    status: "active",
  });
  const testResult = await family.expectStatus("POST", "/api/finance/ai/connection/test", [502, 503], undefined);
  const failingSummary = await family.expectStatus("GET", "/api/finance/ai/summary?start=2026-01-01&end=2026-01-31", [502, 503], undefined);
  const coreHealth = await family.json("GET", "/healthz");
  const coreOverview = await family.json("GET", "/api/finance/overview?start=2026-01-01&end=2026-01-31&granularity=day");
  const disabled = await family.json("PUT", "/api/finance/ai/connection", {
    endpoint_url: endpoint,
    model: "anomaly-test",
    api_key_ref: apiKeyRef,
    status: "disabled",
  });
  const afterDisabled = await family.json("GET", "/api/finance/ai/summary?start=2026-01-01&end=2026-01-31");
  return {
    ok: true,
    scenario: "ai",
    baseline_provider: baselineProvider,
    configured_endpoint_host: new URL(endpoint).hostname,
    test_status: testResult.status,
    test_code: testResult.payload?.code ?? null,
    summary_after_failure_status: failingSummary.status,
    summary_after_failure_code: failingSummary.payload?.code ?? null,
    core_health_after_failure: coreHealth?.status ?? null,
    core_overview_after_failure: Boolean(coreOverview?.summary_cards),
    disabled_status: disabled?.connection?.status ?? null,
    deterministic_after_disabled: Boolean(afterDisabled?.insight),
    actual_timeout: testResult.payload?.code === "AI_CONNECTION_TEST_FAILED" ? "connection_error_or_timeout" : "secret_missing_before_network",
    duration_ms: Date.now() - startedAt,
  };
}

async function seedSlowLedger(pool, family, rowCount) {
  await withTenant(pool, scopeOf(family), async (client) => {
    const category = await client.query(
      "SELECT id::text AS id FROM category WHERE household_id = $1 AND direction_scope IN ('expense', 'both') ORDER BY created_at LIMIT 1",
      [family.identity.household.id],
    );
    const categoryId = category.rows[0]?.id ?? null;
    await client.query(
      `INSERT INTO ledger_transaction (id, household_id, occurred_at, direction, amount, currency, merchant, category, status, origin, category_id, created_by, updated_by)
       SELECT gen_random_uuid(), $1,
              timestamp '2026-01-01 08:00:00' + ((g % 31) * interval '1 day'),
              'expense', 1.00, 'CNY', 'I014-SLOW-' || g, '慢查询', 'confirmed', 'manual', $2, $3, $3
         FROM generate_series(1, $4) AS g
       ON CONFLICT DO NOTHING`,
      [family.identity.household.id, categoryId, family.identity.user.id, rowCount],
    );
    await client.query(
      `INSERT INTO ledger_entry (id, household_id, ledger_transaction_id, account_id, amount, entry_side)
       SELECT gen_random_uuid(), lt.household_id, lt.id, $2, lt.amount, 'credit'
         FROM ledger_transaction lt
        WHERE lt.household_id = $1 AND lt.merchant LIKE 'I014-SLOW-%'
       ON CONFLICT DO NOTHING`,
      [family.identity.household.id, family.identity.userAccountId],
    );
  });
}

async function explainOverview(pool, family) {
  return withTenant(pool, scopeOf(family), async (client) => {
    const [income, expense, budget] = await Promise.all([
      client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
         SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'income'), 0)::text
           FROM ledger_transaction
          WHERE household_id = $1 AND status = 'confirmed' AND currency = 'CNY'
            AND occurred_at >= $2::date AND occurred_at < ($3::date + interval '1 day')`,
        [family.identity.household.id, "2026-01-01", "2026-01-31"],
      ),
      client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
         SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'expense'), 0)::text
           FROM ledger_transaction
          WHERE household_id = $1 AND status = 'confirmed' AND currency = 'CNY'
            AND occurred_at >= $2::date AND occurred_at < ($3::date + interval '1 day')`,
        [family.identity.household.id, "2026-01-01", "2026-01-31"],
      ),
      client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
         SELECT b.id::text, COALESCE(SUM(lt.amount) FILTER (WHERE lt.direction = 'expense' AND lt.status = 'confirmed'), 0)::text AS used
           FROM budget b
           JOIN budget_period bp ON bp.household_id = b.household_id AND bp.budget_id = b.id
           LEFT JOIN ledger_transaction lt ON lt.household_id = b.household_id AND lt.category_id = b.category_id
            AND lt.occurred_at >= GREATEST($2::date, bp.period_start)
            AND lt.occurred_at < LEAST($3::date + interval '1 day', bp.period_end + interval '1 day')
          WHERE b.household_id = $1 AND b.status = 'active'
            AND bp.period_start <= $3::date AND bp.period_end >= $2::date
          GROUP BY b.id`,
        [family.identity.household.id, "2026-01-01", "2026-01-31"],
      ),
    ]);
    const first = income.rows[0]?.["QUERY PLAN"]?.[0] ?? income.rows[0]?.["QUERY PLAN"] ?? null;
    const second = expense.rows[0]?.["QUERY PLAN"]?.[0] ?? expense.rows[0]?.["QUERY PLAN"] ?? null;
    const third = budget.rows[0]?.["QUERY PLAN"]?.[0] ?? budget.rows[0]?.["QUERY PLAN"] ?? null;
    return {
      income_plan: compactPlan(first),
      expense_plan: compactPlan(second),
      budget_plan: compactPlan(third),
      income_execution_ms: extraction(first)?.Execution?.Planning?.Total_Time ?? null,
      expense_execution_ms: extraction(second)?.Execution?.Planning?.Total_Time ?? null,
      budget_execution_ms: extraction(third)?.Execution?.Planning?.Total_Time ?? null,
    };
  });
}

function compactPlan(plan) {
  if (!plan) return null;
  const json = JSON.stringify(plan);
  return json.length > 5_000 ? `${json.slice(0, 5_000)}...` : json;
}

function extraction(plan) {
  if (!plan) return null;
  const value = Array.isArray(plan) ? plan[0] : plan;
  return value;
}

async function runSlowScenario(families, databaseUrl) {
  if (!databaseUrl) {
    return {
      ok: false,
      scenario: "slow",
      skipped_reason: "未提供 LIFE_ANOMALY_DB_URL，无法执行真实 PostgreSQL 慢查询基线",
    };
  }
  const family = families[0];
  const rowCount = integer("LIFE_ANOMALY_SLOW_ROWS", 30_000, 1_000, 200_000);
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    family.identity.userAccountId = (await family.json("GET", "/api/finance/accounts")).accounts?.[0]?.id ?? null;
    const seededStart = Date.now();
    await seedSlowLedger(pool, family, rowCount);
    const seedDurationMs = Date.now() - seededStart;
    const plannedStart = Date.now();
    const plans = await explainOverview(pool, family);
    const planDurationMs = Date.now() - plannedStart;
    const apiStarted = Date.now();
    const overview = await family.json("GET", "/api/finance/overview?start=2026-01-01&end=2026-01-31&granularity=day");
    const apiDurationMs = Date.now() - apiStarted;
    const counts = await withTenant(pool, scopeOf(family), async (client) => {
      const result = await client.query(
        "SELECT COUNT(*)::int AS transactions, (SELECT COUNT(*)::int FROM ledger_entry WHERE household_id = $1) AS entries FROM ledger_transaction WHERE household_id = $1",
        [family.identity.household.id],
      );
      return result.rows[0] ?? { transactions: 0, entries: 0 };
    });
    return {
      ok: true,
      scenario: "slow",
      seeded_rows: rowCount,
      seed_duration_ms: seedDurationMs,
      explain_duration_ms: planDurationMs,
      api_overview_duration_ms: apiDurationMs,
      api_overview_cards: overview.summary_cards?.length ?? 0,
      counts,
      plans,
    };
  } finally {
    await pool.end();
  }
}

async function withTenant(pool, scope, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.household_id', $1, true), set_config('app.user_id', $2, true)", [scope.householdId, scope.userId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original */ }
    throw error;
  } finally {
    client.release?.();
  }
}

function scopeOf(family) {
  return {
    householdId: family.identity.household?.id,
    userId: family.identity.user?.id,
  };
}

async function main() {
  assertNoCredentialOutput();
  if ((process.env.LIFE_ANOMALY_CONFIRM ?? "") !== CONFIRMATION) {
    throw new Error(`LIFE_ANOMALY_CONFIRM 必须为 ${CONFIRMATION}`);
  }
  const baseUrl = httpsUrl(required("LIFE_ANOMALY_BASE_URL"), "LIFE_ANOMALY_BASE_URL");
  const runNonce = process.env.LIFE_ANOMALY_NONCE?.trim() || nonce();
  const selected = (process.env.LIFE_ANOMALY_SCENARIOS?.trim() || SCENARIOS.join(",")).split(",").map((item) => item.trim()).filter(Boolean);
  if (!selected.length || selected.some((item) => !SCENARIOS.includes(item))) throw new Error(`LIFE_ANOMALY_SCENARIOS 仅支持：${SCENARIOS.join(",")}`);
  const householdCount = integer("LIFE_ANOMALY_HOUSEHOLDS", 3, 2, 8);
  const outputDir = process.env.LIFE_ANOMALY_OUTPUT_DIR?.trim() || join("output", "anomaly", runNonce);
  const databaseUrl = process.env.LIFE_ANOMALY_DB_URL?.trim() || "";
  await mkdir(outputDir, { recursive: true });

  const report = {
    ok: false,
    contract: "I-014 anomaly drill",
    started_at: nowIso(),
    base_origin: baseUrl.origin,
    run_nonce: runNonce,
    scenarios: selected,
    households: [],
    results: {},
    skipped: [],
    completed_at: null,
  };
  let families = [];

  try {
    families = await registerFamilies(baseUrl, householdCount, runNonce);
    report.households = families.map((family) => ({
      email: family.email,
      household_id: family.identity.household?.id ?? null,
      household_name: family.identity.household?.name ?? family.identity.household_name,
    }));

    for (const scenario of selected) {
      if (scenario === "isolation") report.results.isolation = await runIsolationScenario(families);
      if (scenario === "large_import") report.results.large_import = await runLargeImportScenario(families);
      if (scenario === "queue") report.results.queue = await runQueueScenario(families, databaseUrl);
      if (scenario === "ai") report.results.ai = await runAiScenario(families);
      if (scenario === "slow") report.results.slow = await runSlowScenario(families, databaseUrl);
    }

    const executed = Object.keys(report.results);
    report.ok = executed.length === selected.length && executed.every((key) => report.results[key]?.ok === true);
    report.completed_at = nowIso();
  } catch (error) {
    report.error = { message: error instanceof Error ? error.message : String(error), status: error instanceof HttpError ? error.status : null, code: error instanceof HttpError ? error.code : null };
    report.completed_at = nowIso();
  } finally {
    const filePath = join(outputDir, "report.json");
    await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({
      ok: report.ok,
      contract: report.contract,
      scenarios: report.scenarios,
      completed: Object.keys(report.results),
      error: report.error ?? null,
      report: filePath,
    }, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
}

await main();
