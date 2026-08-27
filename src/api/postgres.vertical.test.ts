import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { buildServer } from "./server.js";
import { SqlFinanceRepository } from "./finance-repository.js";
import { SqlFamilyRepository } from "./family-repository.js";
import type { DbPool } from "./database.js";
import { financeExportObjectKey, importObjectKey, MemoryImportObjectStore } from "./import-storage.js";
import { runQueuedFinanceExportWorker } from "./finance-export-worker.js";
import { runFinanceRetentionForHousehold } from "./finance-retention-worker.js";
import { SqlAuthStore, hashPassword } from "./auth.js";
import { InMemoryAuthAttemptLimiter } from "./auth-rate-limit.js";
import type { PasswordResetDelivery, PasswordResetDeliveryMessage } from "./password-reset-delivery.js";
import type { ParsedImportResult } from "./finance-import-parser.js";

const householdA = "00000000-0000-0000-0000-0000000000a1";
const householdB = "00000000-0000-0000-0000-0000000000b1";
const userA = "10000000-0000-0000-0000-0000000000a1";
const userB = "10000000-0000-0000-0000-0000000000b1";
const userC = "10000000-0000-0000-0000-0000000000c1";
const memberA = "20000000-0000-0000-0000-0000000000a1";
const memberB = "20000000-0000-0000-0000-0000000000b1";
const memberC = "20000000-0000-0000-0000-0000000000c1";
const scopeA = { householdId: householdA, userId: userA };

class MemoryPasswordResetDelivery implements PasswordResetDelivery {
  readonly messages: PasswordResetDeliveryMessage[] = [];
  async sendPasswordReset(message: PasswordResetDeliveryMessage) { this.messages.push(message); }
}

function splitSql(input: string): string[] {
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
    if (!quote && char === "$" && next === "$" ) {
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
      buffer += char;
      continue;
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

async function applyMigrations(db: PGlite) {
  for (const file of ["db/migrations/0001_life_core_finance.sql", "db/migrations/0002_finance_import_state.sql", "db/migrations/0003_life_app_privileges.sql", "db/migrations/0004_family_space_ai.sql", "db/migrations/0005_finance_ledger_foundation.sql", "db/migrations/0006_finance_management_foundation.sql", "db/migrations/0007_finance_permissions.sql", "db/migrations/0008_finance_ai.sql", "db/migrations/0009_finance_production_hardening.sql", "db/migrations/0010_auth_sessions.sql", "db/migrations/0011_password_reset.sql"]) {
    let sql = await readFile(file, "utf8");
    sql = sql.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "-- pgcrypto is not bundled in PGlite").replaceAll("DEFAULT gen_random_uuid()", "");
    for (const statement of splitSql(sql)) await db.query(statement);
  }
}

async function seed(db: PGlite) {
  const passwordHash = await hashPassword("secret-password");
  const sql = [
    ["INSERT INTO household (id, name) VALUES ($1, $2)", [householdA, "家庭 A"]],
    ["INSERT INTO household (id, name) VALUES ($1, $2)", [householdB, "家庭 B"]],
    ["INSERT INTO app_user (id, email, password_hash) VALUES ($1, $2, $3)", [userA, "a@example.invalid", passwordHash]],
    ["INSERT INTO app_user (id, email, password_hash) VALUES ($1, $2, $3)", [userB, "b@example.invalid", passwordHash]],
    ["INSERT INTO household_member (id, household_id, user_id, role) VALUES ($1, $2, $3, $4)", [memberA, householdA, userA, "owner"]],
    ["INSERT INTO household_member (id, household_id, user_id, role) VALUES ($1, $2, $3, $4)", [memberB, householdB, userB, "owner"]],
    ["INSERT INTO financial_source (id, household_id, source_type, display_name) VALUES ($1, $2, $3, $4)", ["30000000-0000-0000-0000-0000000000a1", householdA, "bank", "bank"]],
    ["INSERT INTO category (id, household_id, name, direction_scope, color_token) VALUES ($1, $2, $3, $4, $5)", ["40000000-0000-0000-0000-0000000000a1", householdA, "餐饮", "expense", "orange"]],
    ["INSERT INTO budget (id, household_id, category_id, name, amount, cycle) VALUES ($1, $2, $3, $4, $5, $6)", ["50000000-0000-0000-0000-0000000000a1", householdA, "40000000-0000-0000-0000-0000000000a1", "餐饮预算", "300.00", "month"]],
    ["INSERT INTO budget_period (id, household_id, budget_id, period_start, period_end, amount) VALUES ($1, $2, $3, $4, $5, $6)", ["60000000-0000-0000-0000-0000000000a1", householdA, "50000000-0000-0000-0000-0000000000a1", "2026-08-01", "2026-08-31", "300.00"]],
    ["INSERT INTO ledger_transaction (id, household_id, occurred_at, direction, amount, currency, merchant, category, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", ["70000000-0000-0000-0000-0000000000a1", householdA, "2026-08-01T09:00:00Z", "income", "1000.00", "CNY", "工资", "收入", userA]],
    ["INSERT INTO ledger_transaction (id, household_id, occurred_at, direction, amount, currency, merchant, category, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", ["70000000-0000-0000-0000-0000000000a2", householdA, "2026-08-03T18:00:00Z", "expense", "100.00", "CNY", "家庭餐饮", "餐饮", userA]],
    ["INSERT INTO physical_asset (id, household_id, name, asset_type) VALUES ($1, $2, $3, $4)", ["80000000-0000-0000-0000-0000000000a1", householdA, "家用设备", "equipment"]],
    ["INSERT INTO asset_event (id, household_id, asset_id, occurred_at, event_type, amount, recovery_amount) VALUES ($1, $2, $3, $4, $5, $6, $7)", ["81000000-0000-0000-0000-0000000000a1", householdA, "80000000-0000-0000-0000-0000000000a1", "2026-08-05T10:00:00Z", "purchase", "3000.00", "0.00"]],
    ["INSERT INTO ledger_transaction (id, household_id, occurred_at, direction, amount, currency, merchant, category, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", ["70000000-0000-0000-0000-0000000000b1", householdB, "2026-08-01T09:00:00Z", "expense", "999.00", "CNY", "家庭 B", "餐饮", userB]],
  ] as const;
  for (const [statement, values] of sql) await db.query(statement, Array.from(values));
}

async function addImportCandidate(db: PGlite, batchId: string) {
  const source = await db.query<{ id: string; source_type: string }>("SELECT id::text AS id, source_type FROM financial_source WHERE household_id = $1 AND source_type IN ('wechat', 'bank') ORDER BY source_type", [householdA]);
  const wechatSourceId = source.rows.find((item) => item.source_type === "wechat")?.id;
  const bankSourceId = source.rows.find((item) => item.source_type === "bank")?.id;
  if (!wechatSourceId || !bankSourceId) throw new Error("bank or wechat source missing");
  await db.query("INSERT INTO import_row (id, household_id, import_batch_id, source_row_number, normalized_payload) VALUES ($1, $2, $3, $4, '{}'::jsonb)", ["90000000-0000-0000-0000-0000000000a1", householdA, batchId, 1]);
  await db.query("INSERT INTO source_record (id, household_id, source_id, import_batch_id, import_row_id, external_id, source_fingerprint, occurred_at, direction, amount, currency, merchant, channel) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)", ["91000000-0000-0000-0000-0000000000a1", householdA, wechatSourceId, batchId, "90000000-0000-0000-0000-0000000000a1", "wechat-order-1", "fingerprint-1", "2026-08-04T12:00:00Z", "expense", "50.00", "CNY", "微信餐饮", "wechat"]);
  await db.query("INSERT INTO source_record (id, household_id, source_id, import_batch_id, external_id, source_fingerprint, occurred_at, direction, amount, currency, merchant, channel) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)", ["91000000-0000-0000-0000-0000000000a2", householdA, bankSourceId, batchId, "bank-order-1", "fingerprint-2", "2026-08-04T12:00:02Z", "expense", "50.00", "CNY", "银行餐饮", "bank"]);
  await db.query("INSERT INTO reconciliation_group (id, household_id, import_batch_id, recommended_link_type, confidence, reason_codes) VALUES ($1, $2, $3, $4, $5, $6::jsonb)", ["92000000-0000-0000-0000-0000000000a1", householdA, batchId, "duplicate", "0.92", '["time_close","amount_equal"]']);
  await db.query("INSERT INTO transaction_link (id, household_id, reconciliation_group_id, left_source_record_id, right_source_record_id, link_type, status, confidence, reason_codes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)", ["93000000-0000-0000-0000-0000000000a1", householdA, "92000000-0000-0000-0000-0000000000a1", "91000000-0000-0000-0000-0000000000a1", "91000000-0000-0000-0000-0000000000a2", "duplicate", "pending_review", "0.92", '["time_close","amount_equal"]']);
}

async function seedFamily(db: PGlite) {
  await db.query("INSERT INTO family_topic (id, household_id, author_id, topic_type, title, body) VALUES ($1, $2, $3, $4, $5, $6)", ["a1000000-0000-0000-0000-0000000000a1", householdA, userA, "idea", "周末家庭活动", "周六想去公园野餐，大家看看时间是否合适。"]);
  await db.query("INSERT INTO family_topic_comment (id, household_id, topic_id, author_id, body) VALUES ($1, $2, $3, $4, $5)", ["a2000000-0000-0000-0000-0000000000a1", householdA, "a1000000-0000-0000-0000-0000000000a1", userA, "我可以准备野餐垫和水果。"]);
}

describe("PostgreSQL finance vertical slice", () => {
  let db: PGlite;
  let pool: DbPool;
  let repository: SqlFinanceRepository;
  let familyRepository: SqlFamilyRepository;
  let app: ReturnType<typeof buildServer>;
  let importStore: MemoryImportObjectStore;

  beforeEach(async () => {
    db = new PGlite();
    await applyMigrations(db);
    await seed(db);
    await seedFamily(db);
    pool = {
      connect: async () => {
        await db.query("SET ROLE life_app");
        return { query: db.query.bind(db), release: () => undefined };
      },
    };
    importStore = new MemoryImportObjectStore();
    repository = new SqlFinanceRepository(pool, scopeA, importStore);
    familyRepository = new SqlFamilyRepository(pool, scopeA);
    app = buildServer({ resolveScope: () => scopeA, financeFactory: () => repository, familyFactory: () => familyRepository, importObjectStore: importStore });
  });

  afterEach(async () => {
    await db.query("RESET ROLE");
    await db.close();
  });

  it("uses deterministic PostgreSQL queries for overview and server-owned drilldowns", async () => {
    const response = await app.inject({ method: "GET", url: "/api/finance/overview?start=2026-08-01&end=2026-08-31&granularity=day" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.summary_cards.map((item: { key: string }) => item.key)).toEqual(["net_asset", "account_balance", "income", "expense", "net_cash_flow"]);
    expect(body.summary_cards.find((item: { key: string }) => item.key === "net_asset").value).toBe("3000.0000");
    expect(body.summary_cards.find((item: { key: string }) => item.key === "account_balance").value).toBe("0.0000");
    expect(body.account_balance_change).toEqual({ amount: "0.0000", rate: null, comparison_label: "较上月" });
    expect(body.granularity).toBe("day");
    expect(body.attention_items).toEqual([]);
    expect(body.budget_rings[0].label).toBe("餐饮");
    expect(body.budget_rings[0].used).toBe("100.0000");
    expect(body.trend_points).toHaveLength(31);
    expect(body.asset_cost_points[0].gross_cost).toBe("3000.0000");
    expect(body.asset_total_points).toHaveLength(31);
    expect(body.asset_total_points[0].total_asset).toBe("0.0000");
    expect(body.asset_total_points[4].total_asset).toBe("3000.0000");
    expect(body.asset_total_points[30].total_asset).toBe("3000.0000");

    const weekly = await app.inject({ method: "GET", url: "/api/finance/overview?start=2026-08-01&end=2026-08-31&granularity=week" });
    expect(weekly.statusCode).toBe(200);
    expect(weekly.json().granularity).toBe("week");
    expect(weekly.json().trend_points).toHaveLength(5);
    expect(weekly.json().trend_points[0].drilldown_ref.filters.granularity).toBe("week");

    await db.query("RESET ROLE");
    await db.query("INSERT INTO import_batch (id, household_id, source_id, file_name, file_sha256, object_key, status, raw_retention_until, created_by, file_size) VALUES ($1, $2, $3, $4, $5, $6, 'mapping_pending', now() + interval '365 days', $7, $8)", ["85000000-0000-0000-0000-0000000000a1", householdA, "30000000-0000-0000-0000-0000000000a1", "待确认.xlsx", "pending-hash", "pending-key", userA, 12]);
    await db.query("UPDATE budget_period SET amount = '50.00' WHERE household_id = $1 AND id = $2", [householdA, "60000000-0000-0000-0000-0000000000a1"]);
    await db.query("SET ROLE life_app");
    const attention = await app.inject({ method: "GET", url: "/api/finance/overview?start=2026-08-01&end=2026-08-31&granularity=day" });
    expect(attention.statusCode).toBe(200);
    expect(attention.json().attention_items.map((item: { key: string }) => item.key)).toEqual(["import_review", "budget_overrun"]);

    const ref = body.budget_rings[0].drilldown_ref.filter_id;
    const drilldown = await app.inject({ method: "GET", url: `/api/finance/drilldowns/${ref}` });
    expect(drilldown.statusCode).toBe(200);
    expect(drilldown.json().items[0].merchant).toBe("家庭餐饮");

    const foreignFilter = "94000000-0000-0000-0000-0000000000b1";
    await db.query("RESET ROLE");
    await db.query("INSERT INTO finance_drilldown_filter (id, household_id, filter_type, filters, created_by) VALUES ($1, $2, $3, $4::jsonb, $5)", [foreignFilter, householdB, "ledger_period", '{"start":"2026-08-01","end":"2026-08-31"}', userB]);
    await db.query("SET ROLE life_app");
    const hidden = await repository.getDrilldown(foreignFilter, 1, 50);
    expect(hidden).toBeNull();
  });

  it("resolves a production HttpOnly session to exactly one household and revokes it on logout", async () => {
    const authStore = new SqlAuthStore(pool);
    const authApp = buildServer({
      authStore,
      authAttemptLimiter: new InMemoryAuthAttemptLimiter({ login: { maxFailures: 2, blockMs: 60_000 }, register: { maxFailures: 2, blockMs: 60_000 } }),
      financeFactory: (scope) => new SqlFinanceRepository(pool, scope, importStore),
      familyFactory: (scope) => new SqlFamilyRepository(pool, scope),
      importObjectStore: importStore,
    });

    const unauthenticated = await authApp.inject({ method: "GET", url: "/api/me" });
    expect(unauthenticated.statusCode).toBe(401);
    const login = await authApp.inject({ method: "POST", url: "/api/auth/login", payload: { email: "a@example.invalid", password: "secret-password" } });
    expect(login.statusCode).toBe(200);
    expect(login.json().household.id).toBe(householdA);
    expect(login.json().household.role).toBe("owner");
    const setCookieHeader = login.headers["set-cookie"];
    const sessionCookie = String(Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader).split(";")[0];
    expect(sessionCookie).toMatch(/^life_session=/);

    const me = await authApp.inject({ method: "GET", url: "/api/me", headers: { cookie: sessionCookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ user: { id: userA, email: "a@example.invalid" }, household: { id: householdA, name: "家庭 A", role: "owner" } });
    const overview = await authApp.inject({ method: "GET", url: "/api/finance/overview?start=2026-08-01&end=2026-08-31&granularity=day", headers: { cookie: sessionCookie } });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().summary_cards[0].value).toBe("3000.0000");

    const logout = await authApp.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: sessionCookie } });
    expect(logout.statusCode).toBe(200);
    const afterLogout = await authApp.inject({ method: "GET", url: "/api/me", headers: { cookie: sessionCookie } });
    expect(afterLogout.statusCode).toBe(401);

    const wrongLogin = await authApp.inject({ method: "POST", url: "/api/auth/login", payload: { email: "a@example.invalid", password: "wrong-password" } });
    expect(wrongLogin.statusCode).toBe(401);
    expect(wrongLogin.json().code).toBe("INVALID_CREDENTIALS");
    const limitedLogin = await authApp.inject({ method: "POST", url: "/api/auth/login", payload: { email: "a@example.invalid", password: "wrong-password" } });
    expect(limitedLogin.statusCode).toBe(429);
    expect(limitedLogin.headers["retry-after"]).toBe("60");
    expect(limitedLogin.json().code).toBe("AUTH_RATE_LIMITED");

    const weakRegistration = await authApp.inject({ method: "POST", url: "/api/auth/register", payload: { email: "weak@example.invalid", password: "short", household_name: "弱密码家庭" } });
    expect(weakRegistration.statusCode).toBe(400);
    expect(weakRegistration.json().code).toBe("BAD_REQUEST");

    const registration = await authApp.inject({ method: "POST", url: "/api/auth/register", payload: { email: "new-family@example.invalid", password: "another-secret", household_name: "新家庭" } });
    expect(registration.statusCode).toBe(201);
    expect(registration.json().household.name).toBe("新家庭");
    expect(registration.json().household.id).not.toBe(householdA);
    expect(registration.json().household.role).toBe("owner");
    const duplicateRegistration = await authApp.inject({ method: "POST", url: "/api/auth/register", payload: { email: "new-family@example.invalid", password: "another-secret", household_name: "第二家庭" } });
    expect(duplicateRegistration.statusCode).toBe(409);
  });

  it("uses expiring single-use password reset tokens and revokes every active session", async () => {
    const authStore = new SqlAuthStore(pool);
    const delivery = new MemoryPasswordResetDelivery();
    const authApp = buildServer({
      authStore,
      passwordResetDelivery: delivery,
      financeFactory: (scope) => new SqlFinanceRepository(pool, scope, importStore),
      familyFactory: (scope) => new SqlFamilyRepository(pool, scope),
      importObjectStore: importStore,
    });

    const login = await authApp.inject({ method: "POST", url: "/api/auth/login", payload: { email: "a@example.invalid", password: "secret-password" } });
    expect(login.statusCode).toBe(200);
    const setCookieHeader = login.headers["set-cookie"];
    const sessionCookie = String(Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader).split(";")[0];

    const unknown = await authApp.inject({ method: "POST", url: "/api/auth/password-reset/request", payload: { email: "missing@example.invalid" } });
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json().message).toBe("如果该邮箱已注册，重置链接将很快送达");
    expect(delivery.messages).toHaveLength(0);

    const firstRequest = await authApp.inject({ method: "POST", url: "/api/auth/password-reset/request", payload: { email: "a@example.invalid" } });
    const secondRequest = await authApp.inject({ method: "POST", url: "/api/auth/password-reset/request", payload: { email: "a@example.invalid" } });
    expect(firstRequest.statusCode).toBe(202);
    expect(secondRequest.statusCode).toBe(202);
    expect(secondRequest.json()).toEqual(unknown.json());
    expect(delivery.messages).toHaveLength(2);
    const firstToken = delivery.messages[0].token;
    const activeToken = delivery.messages[1].token;
    expect(firstToken).not.toBe(activeToken);

    const stored = await db.query<{ token_hash: string }>("SELECT token_hash FROM password_reset_token ORDER BY created_at");
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows.every((row) => row.token_hash.length === 64 && row.token_hash !== firstToken && row.token_hash !== activeToken)).toBe(true);

    const superseded = await authApp.inject({ method: "POST", url: "/api/auth/password-reset/confirm", payload: { token: firstToken, password: "updated-password" } });
    expect(superseded.statusCode).toBe(400);
    expect(superseded.json().code).toBe("PASSWORD_RESET_INVALID");
    const weak = await authApp.inject({ method: "POST", url: "/api/auth/password-reset/confirm", payload: { token: activeToken, password: "short" } });
    expect(weak.statusCode).toBe(400);

    const confirmed = await authApp.inject({ method: "POST", url: "/api/auth/password-reset/confirm", payload: { token: activeToken, password: "updated-password" } });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.headers["set-cookie"]).toContain("Max-Age=0");
    const afterReset = await authApp.inject({ method: "GET", url: "/api/me", headers: { cookie: sessionCookie } });
    expect(afterReset.statusCode).toBe(401);
    const reused = await authApp.inject({ method: "POST", url: "/api/auth/password-reset/confirm", payload: { token: activeToken, password: "another-password" } });
    expect(reused.statusCode).toBe(400);

    const oldPassword = await authApp.inject({ method: "POST", url: "/api/auth/login", payload: { email: "a@example.invalid", password: "secret-password" } });
    expect(oldPassword.statusCode).toBe(401);
    const newPassword = await authApp.inject({ method: "POST", url: "/api/auth/login", payload: { email: "a@example.invalid", password: "updated-password" } });
    expect(newPassword.statusCode).toBe(200);

    const expiryRequest = await authApp.inject({ method: "POST", url: "/api/auth/password-reset/request", payload: { email: "a@example.invalid" } });
    expect(expiryRequest.statusCode).toBe(202);
    const expiredToken = delivery.messages[2].token;
    await db.query("UPDATE password_reset_token SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL");
    const expired = await authApp.inject({ method: "POST", url: "/api/auth/password-reset/confirm", payload: { token: expiredToken, password: "expired-password" } });
    expect(expired.statusCode).toBe(400);
    expect(expired.json().message).toContain("已过期");
    const limitedRequest = await authApp.inject({ method: "POST", url: "/api/auth/password-reset/request", payload: { email: "a@example.invalid" } });
    expect(limitedRequest.statusCode).toBe(429);
    expect(Number(limitedRequest.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("enqueues a permissioned CSV export, completes it asynchronously, expires it, and serves only the household file", async () => {
    const queued = await app.inject({ method: "POST", url: "/api/finance/exports", headers: { "idempotency-key": "export-august-1" }, payload: { start: "2026-08-01", end: "2026-08-31", format: "csv" } });
    expect(queued.statusCode).toBe(202);
    expect(queued.json().status).toBe("queued");
    const jobId = queued.json().id as string;
    const duplicate = await app.inject({ method: "POST", url: "/api/finance/exports", headers: { "idempotency-key": "export-august-1" }, payload: { start: "2026-08-01", end: "2026-08-31", format: "csv" } });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json().id).toBe(jobId);

    const exportWorker = await runQueuedFinanceExportWorker(pool, importStore);
    expect(exportWorker.find((item) => item.household_id === householdA)?.processed).toBe(1);
    const ready = await app.inject({ method: "GET", url: `/api/finance/exports/${jobId}` });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe("ready");
    expect(ready.json().download_url).toBe(`/api/finance/exports/${jobId}/download`);
    const download = await app.inject({ method: "GET", url: `/api/finance/exports/${jobId}/download` });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("text/csv");
    expect(String(download.body)).toContain("家庭餐饮");

    await db.query("RESET ROLE");
    await db.query("UPDATE finance_export_job SET download_expires_at = now() - interval '1 minute' WHERE household_id = $1 AND id = $2", [householdA, jobId]);
    await db.query("SET ROLE life_app");
    const expired = await app.inject({ method: "GET", url: `/api/finance/exports/${jobId}` });
    expect(expired.json().status).toBe("expired");
    const expiredDownload = await app.inject({ method: "GET", url: `/api/finance/exports/${jobId}/download` });
    expect(expiredDownload.statusCode).toBe(409);
    expect(importStore.objects.has(financeExportObjectKey(householdA, jobId))).toBe(true);
    await db.query("RESET ROLE");
    const retention = await runFinanceRetentionForHousehold(pool, householdA, importStore);
    expect(retention.exports_expired).toBe(1);
    expect(importStore.objects.has(financeExportObjectKey(householdA, jobId))).toBe(false);
  });

  it("deletes expired raw import objects with retryable state and audit without deleting formal ledger rows", async () => {
    const batchId = "85000000-0000-0000-0000-0000000000c1";
    await db.query("RESET ROLE");
    await db.query("INSERT INTO import_batch (id, household_id, source_id, file_name, file_sha256, object_key, status, raw_retention_until, created_by, file_size, header_preview) VALUES ($1, $2, $3, $4, $5, $6, 'committed', now() - interval '2 days', $7, $8, $9::jsonb)", [batchId, householdA, "30000000-0000-0000-0000-0000000000a1", "expired.xlsx", "expired-hash", "ignored-client-key", userA, 12, '{"sheets":[{"sheet_name":"Sheet1"}]}']);
    await db.query("SET ROLE life_app");
    await importStore.put(importObjectKey(householdA, batchId), Buffer.from("expired raw"));
    await db.query("RESET ROLE");
    const beforeLedger = await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM ledger_transaction WHERE household_id = $1", [householdA]);
    const result = await runFinanceRetentionForHousehold(pool, householdA, importStore);
    expect(result.deleted).toBe(1);
    expect(importStore.objects.has(importObjectKey(householdA, batchId))).toBe(false);
    await db.query("RESET ROLE");
    const afterBatch = await db.query<{ raw_delete_status: string; raw_deleted_at: string | null; header_preview: unknown }>("SELECT raw_delete_status, raw_deleted_at, header_preview FROM import_batch WHERE household_id = $1 AND id = $2", [householdA, batchId]);
    expect(afterBatch.rows[0].raw_delete_status).toBe("deleted");
    expect(afterBatch.rows[0].raw_deleted_at).toBeTruthy();
    expect(afterBatch.rows[0].header_preview).toEqual({ sheets: [] });
    const afterLedger = await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM ledger_transaction WHERE household_id = $1", [householdA]);
    expect(afterLedger.rows[0].count).toBe(beforeLedger.rows[0].count);
    const audit = await db.query<{ action: string }>("SELECT action FROM audit_log WHERE household_id = $1 AND resource_id = $2", [householdA, batchId]);
    expect(audit.rows.map((row) => row.action)).toContain("finance_import_raw_deleted");
  });

  it("runs import state transitions, reconciliation decision, commit and revoke in PostgreSQL", async () => {
    const rawFile = Buffer.from("wechat-export-fixture");
    const created = await app.inject({
      method: "POST",
      url: "/api/finance/import-batches",
      payload: { source_type: "wechat", file_name: "wechat.xlsx", file_size: rawFile.length, file_sha256: createHash("sha256").update(rawFile).digest("hex"), object_key: "households/a/imports/1/original" },
    });
    expect(created.statusCode).toBe(201);
    const batchId = created.json().id as string;
    expect(created.json().status).toBe("created");
    expect(created.json().file_name).toBe("wechat.xlsx");

    const mismatch = await app.inject({ method: "POST", url: `/api/finance/import-batches/${batchId}/upload`, headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("wrong-file") });
    expect(mismatch.statusCode).toBe(409);
    expect(importStore.objects.size).toBe(0);
    const upload = await app.inject({ method: "POST", url: `/api/finance/import-batches/${batchId}/upload`, headers: { "content-type": "application/octet-stream" }, payload: rawFile });
    expect(upload.statusCode).toBe(200);
    expect(upload.json().status).toBe("uploaded");
    expect(importStore.objects.get(importObjectKey(householdA, batchId))?.equals(rawFile)).toBe(true);

    const header = await app.inject({ method: "POST", url: `/api/finance/import-batches/${batchId}/header-confirmation`, payload: { sheet_name: "Sheet1", header_row: 18, data_start_row: 19 } });
    expect(header.statusCode).toBe(200);
    expect(header.json().status).toBe("mapping_pending");

    const mapping = await app.inject({ method: "POST", url: `/api/finance/import-batches/${batchId}/mapping-confirmation`, payload: { mapping: { occurred_at: "交易时间", amount: "金额(元)", direction: "收/支" }, parser_version: "real-bill-parser-v1" } });
    expect(mapping.statusCode).toBe(200);
    expect(mapping.json().status).toBe("confirmed");
    await db.query("RESET ROLE");
    await addImportCandidate(db, batchId);
    await db.query("SET ROLE life_app");

    const reconciliation = await app.inject({ method: "GET", url: `/api/finance/import-batches/${batchId}/reconciliation` });
    expect(reconciliation.statusCode).toBe(200);
    expect(reconciliation.json().candidates).toHaveLength(1);
    expect(reconciliation.json().candidates[0].records).toHaveLength(2);
    const candidateId = reconciliation.json().candidates[0].id as string;
    const version = mapping.json().version as number;

    const decision = await app.inject({ method: "POST", url: `/api/finance/import-batches/${batchId}/reconciliation/decisions`, payload: { candidate_id: candidateId, decision: "duplicate", expected_version: version } });
    expect(decision.statusCode).toBe(200);
    expect(decision.json().status).toBe("confirmed");

    const committed = await app.inject({ method: "POST", url: `/api/finance/import-batches/${batchId}/commit`, headers: { "idempotency-key": "commit-1" }, payload: { expected_version: version + 1, confirm_summary_hash: "summary-sha256" } });
    expect(committed.statusCode).toBe(200);
    expect(committed.json().batch.status).toBe("committed");
    expect(committed.json().inserted_transactions).toBe(1);

    const secondCommit = await app.inject({ method: "POST", url: `/api/finance/import-batches/${batchId}/commit`, headers: { "idempotency-key": "commit-1-retry" }, payload: { expected_version: 999, confirm_summary_hash: "summary-sha256" } });
    expect(secondCommit.statusCode).toBe(200);
    expect(secondCommit.json().inserted_transactions).toBe(0);

    await db.query("RESET ROLE");
    const ledgerCount = await db.query<{ count: number; primary_source_record_id: string }>("SELECT COUNT(*)::int AS count, MIN(primary_source_record_id::text) AS primary_source_record_id FROM ledger_transaction WHERE household_id = $1 AND import_batch_id = $2", [householdA, batchId]);
    expect(ledgerCount.rows[0].count).toBe(1);
    expect(ledgerCount.rows[0].primary_source_record_id).toBe("91000000-0000-0000-0000-0000000000a2");
    const importedTransaction = await db.query<{ id: string }>("SELECT id::text AS id FROM ledger_transaction WHERE household_id = $1 AND import_batch_id = $2 ORDER BY created_at LIMIT 1", [householdA, batchId]);
    const transactionId = importedTransaction.rows[0]?.id;
    expect(transactionId).toBeTruthy();
    await db.query("SET ROLE life_app");
    const detail = await app.inject({ method: "GET", url: `/api/finance/transactions/${transactionId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().source_records).toHaveLength(2);
    expect(detail.json().transaction_links).toHaveLength(1);

    const foreignDetail = await app.inject({ method: "GET", url: "/api/finance/transactions/70000000-0000-0000-0000-0000000000b1" });
    expect(foreignDetail.statusCode).toBe(404);

    const revoked = await app.inject({ method: "POST", url: `/api/finance/import-batches/${batchId}/revoke`, headers: { "idempotency-key": "revoke-1" } });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().status).toBe("revoked");
  });

  it("runs the parser worker contract through import_row, source_record and automatic candidates", async () => {
    const oldBankBatch = "8f000000-0000-0000-0000-0000000000a1";
    const oldBankRecord = "8f100000-0000-0000-0000-0000000000a1";
    await db.query("RESET ROLE");
    await db.query("INSERT INTO import_batch (id, household_id, source_id, file_name, file_sha256, object_key, status, raw_retention_until, created_by, file_size) VALUES ($1, $2, $3, $4, $5, $6, 'committed', now() + interval '365 days', $7, $8)", [oldBankBatch, householdA, "30000000-0000-0000-0000-0000000000a1", "bank-old.xls", "old-hash", "old-key", userA, 12]);
    await db.query("INSERT INTO source_record (id, household_id, source_id, import_batch_id, external_id, source_fingerprint, occurred_at, direction, amount, currency, merchant, channel) VALUES ($1, $2, $3, $4, $5, $6, $7, 'expense', $8, 'CNY', $9, $10)", [oldBankRecord, householdA, "30000000-0000-0000-0000-0000000000a1", oldBankBatch, "bank-old-1", "old-bank-fingerprint", "2026-08-04T12:00:02Z", "50.00", "家庭餐饮", "bank"]);
    await db.query("SET ROLE life_app");

    const rawFile = Buffer.from("parser-worker-fixture");
    const parsed: ParsedImportResult = {
      schema_version: "life.finance.import.v1",
      parser_version: "real-bill-parser-v1",
      source_type: "wechat",
      file_name: "wechat.xlsx",
      detected_sheet: "Sheet1",
      detected_header_row: 18,
      sheets: [{ sheet_name: "Sheet1", header_row: 18, data_start_row: 19, header_score: 8, field_mapping: { occurred_at: "交易时间", amount: "金额(元)", direction: "收/支" }, preview_rows: [], skipped_rows: 0, records: [] }],
      records: [{ source_row_number: 19, occurred_at: "2026-08-04 12:00:00", direction: "expense", amount: "50.0000", currency: "CNY", merchant: "家庭餐饮", external_id: "wechat-new-1", channel: "微信支付", remark: "", source_fingerprint: "wechat-new-fingerprint", sheet_name: "Sheet1" }],
      counts: { sheets: 1, rows: 1, skipped_rows: 0 },
    };
    app = buildServer({
      resolveScope: () => scopeA,
      financeFactory: () => repository,
      familyFactory: () => familyRepository,
      importObjectStore: importStore,
      importParser: { parse: async () => parsed },
    });
    const created = await app.inject({ method: "POST", url: "/api/finance/import-batches", payload: { source_type: "wechat", file_name: "wechat.xlsx", file_size: rawFile.length, file_sha256: createHash("sha256").update(rawFile).digest("hex"), object_key: "client-key-is-ignored" } });
    const batchId = created.json().id as string;
    await app.inject({ method: "POST", url: `/api/finance/import-batches/${batchId}/upload`, headers: { "content-type": "application/octet-stream" }, payload: rawFile });
    const parsedBatch = await app.inject({ method: "POST", url: `/api/finance/import-batches/${batchId}/parse` });
    expect(parsedBatch.statusCode).toBe(200);
    expect(parsedBatch.json().status).toBe("header_detected");
    await db.query("RESET ROLE");
    const stagedRows = await db.query<{ rows: number; records: number }>("SELECT (SELECT COUNT(*)::int FROM import_row WHERE household_id = $1 AND import_batch_id = $2) AS rows, (SELECT COUNT(*)::int FROM source_record WHERE household_id = $1 AND import_batch_id = $2) AS records", [householdA, batchId]);
    expect(stagedRows.rows[0]).toEqual({ rows: 1, records: 1 });
    await db.query("SET ROLE life_app");
    const header = await app.inject({ method: "POST", url: `/api/finance/import-batches/${batchId}/header-confirmation`, payload: { sheet_name: "Sheet1", header_row: 18, data_start_row: 19 } });
    expect(header.statusCode).toBe(200);
    const mapping = await app.inject({ method: "POST", url: `/api/finance/import-batches/${batchId}/mapping-confirmation`, payload: { mapping: parsed.sheets[0]?.field_mapping ?? {}, parser_version: parsed.parser_version } });
    expect(mapping.statusCode).toBe(200);
    expect(mapping.json().status).toBe("reconciliation_pending");
    const reconciliation = await app.inject({ method: "GET", url: `/api/finance/import-batches/${batchId}/reconciliation` });
    expect(reconciliation.statusCode).toBe(200);
    expect(reconciliation.json().candidates).toHaveLength(1);
    expect(reconciliation.json().candidates[0].records).toHaveLength(2);
  });

  it("writes manual income, expense and transfer entries, updates balances, and enforces finance write permission", async () => {
    const checking = await app.inject({ method: "POST", url: "/api/finance/accounts", payload: { name: "家庭银行卡", account_type: "bank", opening_balance: "500.00" } });
    expect(checking.statusCode).toBe(201);
    const checkingId = checking.json().id as string;
    const wallet = await app.inject({ method: "POST", url: "/api/finance/accounts", payload: { name: "家庭现金", account_type: "cash", opening_balance: "0.00" } });
    expect(wallet.statusCode).toBe(201);
    const walletId = wallet.json().id as string;

    const categories = await app.inject({ method: "GET", url: "/api/finance/categories?direction=expense" });
    expect(categories.statusCode).toBe(200);
    const categoryId = categories.json().categories[0].id as string;
    const expensePayload = { direction: "expense", occurred_at: "2026-08-10T12:00:00+08:00", amount: "50.00", currency: "CNY", account_id: checkingId, category_id: categoryId, merchant: "午餐", note: "家庭午餐" };
    const expense = await app.inject({
      method: "POST",
      url: "/api/finance/transactions",
      headers: { "idempotency-key": "manual-expense-1" },
      payload: expensePayload,
    });
    expect(expense.statusCode).toBe(201);
    const expenseId = expense.json().transaction_id as string;
    const duplicateExpense = await app.inject({ method: "POST", url: "/api/finance/transactions", headers: { "idempotency-key": "manual-expense-1" }, payload: expensePayload });
    expect(duplicateExpense.statusCode).toBe(201);
    expect(duplicateExpense.json().transaction_id).toBe(expenseId);
    const expenseDetail = await app.inject({ method: "GET", url: `/api/finance/transactions/${expenseId}` });
    expect(expenseDetail.statusCode).toBe(200);
    expect(expenseDetail.json().origin).toBe("manual");
    expect(expenseDetail.json().status).toBe("confirmed");
    expect(expenseDetail.json().note).toBe("家庭午餐");
    expect(expenseDetail.json().category_id).toBe(categoryId);
    expect(expenseDetail.json().entries).toEqual([{ account_id: checkingId, amount: "50.0000", entry_side: "credit" }]);
    const transactionList = await app.inject({ method: "GET", url: "/api/finance/transactions?page=1&page_size=5&start=2026-08-01&end=2026-08-31" });
    expect(transactionList.statusCode).toBe(200);
    expect(transactionList.json().items.find((item: { id: string }) => item.id === expenseId).merchant).toBe("午餐");

    const income = await app.inject({ method: "POST", url: "/api/finance/transactions", payload: { direction: "income", occurred_at: "2026-08-11T09:00:00+08:00", amount: "1000.00", currency: "CNY", account_id: walletId, merchant: "兼职收入" } });
    expect(income.statusCode).toBe(201);
    const transfer = await app.inject({ method: "POST", url: "/api/finance/transactions", payload: { direction: "transfer", occurred_at: "2026-08-12T09:00:00+08:00", amount: "100.00", currency: "CNY", account_id: checkingId, to_account_id: walletId, merchant: "现金备用" } });
    expect(transfer.statusCode).toBe(201);

    const accountsAfterWrites = await app.inject({ method: "GET", url: "/api/finance/accounts" });
    expect(accountsAfterWrites.statusCode).toBe(200);
    const accountRows = accountsAfterWrites.json().accounts as Array<{ id: string; balance: string }>;
    expect(accountRows.find((item) => item.id === checkingId)?.balance).toBe("350.0000");
    expect(accountRows.find((item) => item.id === walletId)?.balance).toBe("1100.0000");

    const updated = await app.inject({ method: "PATCH", url: `/api/finance/transactions/${expenseId}`, payload: { direction: "expense", occurred_at: "2026-08-10T12:00:00+08:00", amount: "80.00", currency: "CNY", account_id: checkingId, category_id: categoryId, merchant: "晚餐", note: "修改后的家庭用餐" } });
    expect(updated.statusCode).toBe(200);
    const accountsAfterUpdate = await app.inject({ method: "GET", url: "/api/finance/accounts" });
    const accountRowsAfterUpdate = accountsAfterUpdate.json().accounts as Array<{ id: string; balance: string }>;
    expect(accountRowsAfterUpdate.find((item) => item.id === checkingId)?.balance).toBe("320.0000");

    const revoked = await app.inject({ method: "POST", url: `/api/finance/transactions/${expenseId}/void`, payload: { reason: "误记，改用导入账单" } });
    expect(revoked.statusCode).toBe(200);
    const accountsAfterVoid = await app.inject({ method: "GET", url: "/api/finance/accounts" });
    const accountRowsAfterVoid = accountsAfterVoid.json().accounts as Array<{ id: string; balance: string }>;
    expect(accountRowsAfterVoid.find((item) => item.id === checkingId)?.balance).toBe("400.0000");
    expect((await app.inject({ method: "GET", url: `/api/finance/transactions/${expenseId}` })).statusCode).toBe(404);

    const overview = await app.inject({ method: "GET", url: "/api/finance/overview?start=2026-08-01&end=2026-08-31&granularity=day" });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().summary_cards.find((item: { key: string }) => item.key === "income").value).toBe("2000.0000");
    expect(overview.json().summary_cards.find((item: { key: string }) => item.key === "expense").value).toBe("100.0000");

    await db.query("RESET ROLE");
    await db.query("INSERT INTO app_user (id, email, password_hash) VALUES ($1, $2, $3)", [userC, "child@example.invalid", "test"]);
    await db.query("INSERT INTO household_member (id, household_id, user_id, role) VALUES ($1, $2, $3, 'child')", [memberC, householdA, userC]);
    await db.query("SET ROLE life_app");
    const childApp = buildServer({ resolveScope: () => ({ householdId: householdA, userId: userC }), financeFactory: (scope) => new SqlFinanceRepository(pool, scope) });
    const childWrite = await childApp.inject({ method: "POST", url: "/api/finance/transactions", payload: { direction: "expense", occurred_at: "2026-08-13T12:00:00+08:00", amount: "1.00", currency: "CNY", account_id: checkingId, category_id: categoryId, merchant: "儿童尝试记账" } });
    expect(childWrite.statusCode).toBe(403);

    await db.query("RESET ROLE");
    const audit = await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM audit_log WHERE household_id = $1 AND action LIKE 'finance_%'", [householdA]);
    expect(audit.rows[0].count).toBeGreaterThanOrEqual(7);
  });

  it("manages account lifecycle, stable categories and period budgets without rewriting history", async () => {
    const account = await app.inject({ method: "POST", url: "/api/finance/accounts", payload: { name: "待归档账户", account_type: "cash", opening_balance: "20.00" } });
    expect(account.statusCode).toBe(201);
    const accountId = account.json().id as string;
    const renamed = await app.inject({ method: "PATCH", url: `/api/finance/accounts/${accountId}`, payload: { name: "家庭备用现金", account_type: "wallet" } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("家庭备用现金");

    const category = await app.inject({ method: "POST", url: "/api/finance/categories", payload: { name: "家庭出行", direction_scope: "expense", color_token: "cyan" } });
    expect(category.statusCode).toBe(201);
    const categoryId = category.json().id as string;
    const budget = await app.inject({ method: "POST", url: "/api/finance/budgets", payload: { category_id: categoryId, name: "家庭出行预算", cycle: "month", amount: "800.00", currency: "CNY", period_start: "2026-08-01", period_end: "2026-08-31" } });
    expect(budget.statusCode).toBe(201);
    expect(budget.json().category_id).toBe(categoryId);
    expect(budget.json().remaining).toBe("800.0000");
    const budgetId = budget.json().id as string;
    const budgetList = await app.inject({ method: "GET", url: "/api/finance/budgets?start=2026-08-01&end=2026-08-31" });
    expect(budgetList.statusCode).toBe(200);
    expect(budgetList.json().budgets.some((item: { id: string }) => item.id === budgetId)).toBe(true);

    const budgetUpdate = await app.inject({ method: "PATCH", url: `/api/finance/budgets/${budgetId}`, payload: { category_id: categoryId, name: "家庭出行预算（调整）", cycle: "month", amount: "900.00", currency: "CNY", period_start: "2026-08-01", period_end: "2026-08-31" } });
    expect(budgetUpdate.statusCode).toBe(200);
    expect(budgetUpdate.json().amount).toBe("900.0000");
    expect(budgetUpdate.json().remaining).toBe("900.0000");

    const incomeCategory = await app.inject({ method: "POST", url: "/api/finance/categories", payload: { name: "家庭工资", direction_scope: "income", color_token: "green" } });
    expect(incomeCategory.statusCode).toBe(201);
    const invalidBudget = await app.inject({ method: "PATCH", url: `/api/finance/budgets/${budgetId}`, payload: { category_id: incomeCategory.json().id, name: "不应绑定收入分类", cycle: "month", amount: "900.00", currency: "CNY", period_start: "2026-08-01", period_end: "2026-08-31" } });
    expect(invalidBudget.statusCode).toBe(400);

    const activeCategoryArchive = await app.inject({ method: "POST", url: `/api/finance/categories/${categoryId}/archive` });
    expect(activeCategoryArchive.statusCode).toBe(409);

    const archiveBudget = await app.inject({ method: "POST", url: `/api/finance/budgets/${budgetId}/archive` });
    expect(archiveBudget.statusCode).toBe(200);
    const archiveCategory = await app.inject({ method: "POST", url: `/api/finance/categories/${categoryId}/archive` });
    expect(archiveCategory.statusCode).toBe(200);
    const archiveAccount = await app.inject({ method: "POST", url: `/api/finance/accounts/${accountId}/archive` });
    expect(archiveAccount.statusCode).toBe(200);
    const categoriesWithArchive = await app.inject({ method: "GET", url: "/api/finance/categories?include_archived=true" });
    expect(categoriesWithArchive.json().categories.find((item: { id: string }) => item.id === categoryId).status).toBe("archived");
  });

  it("manages physical assets, cost events, bill links and terminal status", async () => {
    const created = await app.inject({ method: "POST", url: "/api/finance/assets", payload: { name: "家庭咖啡机", asset_type: "家用设备" } });
    expect(created.statusCode).toBe(201);
    const assetId = created.json().id as string;
    expect(created.json().gross_cost).toBe("0.0000");

    const purchase = await app.inject({ method: "POST", url: `/api/finance/assets/${assetId}/events`, payload: { occurred_at: "2026-08-06T10:00:00+08:00", event_type: "purchase", amount: "699.00", recovery_amount: "0.00" } });
    expect(purchase.statusCode).toBe(201);
    const maintenance = await app.inject({ method: "POST", url: `/api/finance/assets/${assetId}/events`, payload: { occurred_at: "2026-08-12T10:00:00+08:00", event_type: "maintenance", amount: "20.00", recovery_amount: "0.00", ledger_transaction_id: "70000000-0000-0000-0000-0000000000a2" } });
    expect(maintenance.statusCode).toBe(201);
    expect(maintenance.json().ledger_transaction_id).toBe("70000000-0000-0000-0000-0000000000a2");

    const detailBeforeSale = await app.inject({ method: "GET", url: `/api/finance/assets/${assetId}` });
    expect(detailBeforeSale.statusCode).toBe(200);
    expect(detailBeforeSale.json().event_count).toBe(2);
    expect(detailBeforeSale.json().gross_cost).toBe("719.0000");
    expect(detailBeforeSale.json().net_cash_cost).toBe("719.0000");

    const sale = await app.inject({ method: "POST", url: `/api/finance/assets/${assetId}/events`, payload: { occurred_at: "2026-08-20T10:00:00+08:00", event_type: "sale", amount: "0.00", recovery_amount: "300.00" } });
    expect(sale.statusCode).toBe(201);
    const detailAfterSale = await app.inject({ method: "GET", url: `/api/finance/assets/${assetId}` });
    expect(detailAfterSale.json().status).toBe("sold");
    expect(detailAfterSale.json().recovery).toBe("300.0000");
    expect(detailAfterSale.json().net_cash_cost).toBe("419.0000");

    const terminalWrite = await app.inject({ method: "POST", url: `/api/finance/assets/${assetId}/events`, payload: { occurred_at: "2026-08-21T10:00:00+08:00", event_type: "maintenance", amount: "10.00", recovery_amount: "0.00" } });
    expect(terminalWrite.statusCode).toBe(409);
    const assets = await app.inject({ method: "GET", url: "/api/finance/assets" });
    expect(assets.statusCode).toBe(200);
    expect(assets.json().assets.find((item: { id: string }) => item.id === assetId).net_cash_cost).toBe("419.0000");
  });

  it("enforces household finance permissions, owner grants/revokes and audit", async () => {
    await db.query("RESET ROLE");
    await db.query("INSERT INTO app_user (id, email, password_hash) VALUES ($1, $2, $3)", [userC, "child@example.invalid", "test"]);
    await db.query("INSERT INTO household_member (id, household_id, user_id, role) VALUES ($1, $2, $3, $4)", [memberC, householdA, userC, "child"]);
    await db.query("SET ROLE life_app");

    const permissions = await app.inject({ method: "GET", url: "/api/finance/permissions" });
    expect(permissions.statusCode).toBe(200);
    expect(permissions.json().permissions.find((item: { user_id: string }) => item.user_id === userC).can_view).toBe(false);

    const childScope = { householdId: householdA, userId: userC };
    const childRepository = new SqlFinanceRepository(pool, childScope);
    const childApp = buildServer({ resolveScope: () => childScope, financeFactory: () => childRepository });
    const deniedOverview = await childApp.inject({ method: "GET", url: "/api/finance/overview?start=2026-08-01&end=2026-08-31&granularity=day" });
    expect(deniedOverview.statusCode).toBe(403);

    const granted = await app.inject({ method: "PATCH", url: `/api/finance/permissions/${userC}`, payload: { can_view: true, can_bookkeep: false, can_edit: false, can_import: false, can_reconcile: false, can_export: false } });
    expect(granted.statusCode).toBe(200);
    expect(granted.json().can_view).toBe(true);
    const allowedOverview = await childApp.inject({ method: "GET", url: "/api/finance/overview?start=2026-08-01&end=2026-08-31&granularity=day" });
    expect(allowedOverview.statusCode).toBe(200);
    const deniedWrite = await childApp.inject({ method: "POST", url: "/api/finance/transactions", payload: { direction: "expense", occurred_at: "2026-08-25T10:00:00+08:00", amount: "1.00", account_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", category_id: null } });
    expect(deniedWrite.statusCode).toBe(403);
    const childPermissionView = await childApp.inject({ method: "GET", url: "/api/finance/permissions" });
    expect(childPermissionView.statusCode).toBe(403);
    const childPermissionWrite = await childApp.inject({ method: "PATCH", url: `/api/finance/permissions/${userC}`, payload: { can_view: true, can_bookkeep: true, can_edit: true, can_import: true, can_reconcile: true, can_export: true } });
    expect(childPermissionWrite.statusCode).toBe(403);

    const revoked = await app.inject({ method: "POST", url: `/api/finance/permissions/${userC}/revoke` });
    expect(revoked.statusCode).toBe(200);
    const deniedAfterRevoke = await childApp.inject({ method: "GET", url: "/api/finance/overview?start=2026-08-01&end=2026-08-31&granularity=day" });
    expect(deniedAfterRevoke.statusCode).toBe(403);
    const audit = await app.inject({ method: "GET", url: "/api/finance/audit?limit=20" });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().entries.map((item: { action: string }) => item.action)).toEqual(expect.arrayContaining(["finance_permission_updated", "finance_permission_revoked"]));
  });

  it("generates tenant-scoped finance AI explanations with source refs and reversible proposal states", async () => {
    const generated = await app.inject({ method: "GET", url: "/api/finance/ai/summary?start=2026-08-01&end=2026-08-31" });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().insight.provider).toBe("deterministic-finance-v1");
    expect(generated.json().insight.source_refs[0].kind).toBe("period");
    expect(generated.json().insight.key_points.length).toBeGreaterThanOrEqual(3);
    expect(generated.json().proposal.status).toBe("proposed");
    const proposalId = generated.json().proposal.id as string;

    const confirmed = await app.inject({ method: "POST", url: `/api/finance/ai/proposals/${proposalId}/decision`, payload: { decision: "confirm", expected_version: 1 } });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().proposal.status).toBe("confirmed");
    expect(confirmed.json().execution.formal_ledger_mutation).toBe(false);
    const revoked = await app.inject({ method: "POST", url: `/api/finance/ai/proposals/${proposalId}/revoke` });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().proposal.status).toBe("revoked");

    const second = await app.inject({ method: "GET", url: "/api/finance/ai/summary?start=2026-08-01&end=2026-08-31" });
    const rejected = await app.inject({ method: "POST", url: `/api/finance/ai/proposals/${second.json().proposal.id}/decision`, payload: { decision: "reject", expected_version: 1 } });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().proposal.status).toBe("rejected");

    await db.query("RESET ROLE");
    const memoryRows = await db.query<{ id: string; object_key: string }>("SELECT id::text AS id, object_key FROM ai_memory_artifact WHERE household_id = $1", [householdA]);
    expect(memoryRows.rows.length).toBe(2);
    for (const memory of memoryRows.rows) {
      expect(importStore.objects.has(memory.object_key)).toBe(true);
    }
    await db.query("UPDATE ai_memory_artifact SET retention_until = now() - interval '1 minute' WHERE household_id = $1", [householdA]);
    await db.query("SET ROLE life_app");
    const retention = await runFinanceRetentionForHousehold(pool, householdA, importStore);
    expect(retention.ai_memory_deleted).toBe(2);
    await db.query("RESET ROLE");
    const deletedMemory = await db.query<{ status: string; deleted_at: string | null }>("SELECT status, deleted_at FROM ai_memory_artifact WHERE household_id = $1 ORDER BY created_at", [householdA]);
    expect(deletedMemory.rows.every((row) => row.status === "deleted" && row.deleted_at)).toBe(true);
    for (const memory of memoryRows.rows) {
      expect(importStore.objects.has(memory.object_key)).toBe(false);
    }
  });

  it("stores only a household AI secret reference and fails closed when the active secret is absent", async () => {
    const saved = await app.inject({ method: "PUT", url: "/api/finance/ai/connection", payload: { endpoint_url: "https://ai.example.invalid/v1", model: "family-finance", api_key_ref: "family-a-key", status: "active" } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().connection.api_key_ref).toBe("family-a-key");
    expect(saved.json().connection).not.toHaveProperty("api_key");
    const configured = await app.inject({ method: "GET", url: "/api/finance/ai/connection" });
    expect(configured.json().connection.endpoint_url).toBe("https://ai.example.invalid/v1");
    const summary = await app.inject({ method: "GET", url: "/api/finance/ai/summary?start=2026-08-01&end=2026-08-31" });
    expect(summary.statusCode).toBe(503);
    expect(summary.json().code).toBe("AI_CONNECTION_SECRET_MISSING");
    const connectionTest = await app.inject({ method: "POST", url: "/api/finance/ai/connection/test" });
    expect(connectionTest.statusCode).toBe(503);
    expect(connectionTest.json().code).toBe("AI_CONNECTION_SECRET_MISSING");
  });

  it("runs the family topic, source-linked AI summary, approval and audit flow", async () => {
    const home = await app.inject({ method: "GET", url: "/api/family/topics" });
    expect(home.statusCode).toBe(200);
    expect(home.json().topics[0].title).toBe("周末家庭活动");
    expect(home.json().topics[0].comment_count).toBe(1);

    const summary = await app.inject({ method: "POST", url: "/api/family/topics/a1000000-0000-0000-0000-0000000000a1/ai-summary" });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().insight.provider).toBe("deterministic-dev");
    expect(summary.json().insight.source_refs).toHaveLength(2);
    expect(summary.json().action_proposal.status).toBe("proposed");

    const proposalId = summary.json().action_proposal.id as string;
    const decision = await app.inject({ method: "POST", url: `/api/ai/action-proposals/${proposalId}/decision`, payload: { decision: "confirm", expected_version: 1 } });
    expect(decision.statusCode).toBe(200);
    expect(decision.json().proposal.status).toBe("confirmed");
    expect(decision.json().execution.comment_id).toBeTruthy();

    const detail = await app.inject({ method: "GET", url: "/api/family/topics/a1000000-0000-0000-0000-0000000000a1" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().comments).toHaveLength(2);
    await db.query("RESET ROLE");
    const audit = await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM audit_log WHERE household_id = $1 AND action LIKE 'ai_%'", [householdA]);
    expect(audit.rows[0].count).toBe(2);
  });
});
