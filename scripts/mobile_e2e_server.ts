import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { buildServer } from "../src/api/server.js";
import { SqlFinanceRepository } from "../src/api/finance-repository.js";
import { SqlFamilyRepository } from "../src/api/family-repository.js";
import { MemoryImportObjectStore } from "../src/api/import-storage.js";
import { SqlAuthStore, hashPassword } from "../src/api/auth.js";
import type { DbPool } from "../src/api/database.js";
import type { PasswordResetDelivery, PasswordResetDeliveryMessage } from "../src/api/password-reset-delivery.js";

const householdId = "00000000-0000-0000-0000-0000000000a1";
const userId = "10000000-0000-0000-0000-0000000000a1";
const memberId = "20000000-0000-0000-0000-0000000000a1";
const categoryId = "40000000-0000-0000-0000-0000000000a1";
const budgetId = "50000000-0000-0000-0000-0000000000a1";
const budgetPeriodId = "60000000-0000-0000-0000-0000000000a1";
const apiPort = Number(process.env.MOBILE_API_PORT ?? 3100);
export const MOBILE_E2E_EMAIL = "mobile-e2e@example.invalid";
export const MOBILE_E2E_PASSWORD = "mobile-e2e-password";

class MobileE2ePasswordResetDelivery implements PasswordResetDelivery {
  private readonly messages = new Map<string, PasswordResetDeliveryMessage>();
  async sendPasswordReset(message: PasswordResetDeliveryMessage) { this.messages.set(message.email.toLowerCase(), message); }
  get(email: string) { return this.messages.get(email.trim().toLowerCase()) ?? null; }
}

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
    if (!quote && char === "$" && next === "$") { dollarTag = "$$"; buffer += "$$"; index += 1; continue; }
    if (char === "'" && input[index - 1] !== "\\") {
      if (quote && next === "'") { buffer += "''"; index += 1; continue; }
      quote = !quote;
    }
    if (!quote && char === ";") { if (buffer.trim()) statements.push(buffer.trim()); buffer = ""; continue; }
    buffer += char;
  }
  if (buffer.trim()) statements.push(buffer.trim());
  return statements;
}

async function migrate(db: PGlite) {
  for (const file of ["0001_life_core_finance.sql", "0002_finance_import_state.sql", "0003_life_app_privileges.sql", "0004_family_space_ai.sql", "0005_finance_ledger_foundation.sql", "0006_finance_management_foundation.sql", "0007_finance_permissions.sql", "0008_finance_ai.sql", "0009_finance_production_hardening.sql", "0010_auth_sessions.sql", "0011_password_reset.sql", "0012_household_invitations.sql", "0013_member_sensitive_permissions.sql", "0014_data_rights_deletion_requests.sql"]) {
    let sql = await readFile(`db/migrations/${file}`, "utf8");
    sql = sql.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "-- pgcrypto is not bundled in PGlite").replaceAll("DEFAULT gen_random_uuid()", "");
    for (const statement of splitSql(sql)) await db.query(statement);
  }
}

const db = new PGlite();
await migrate(db);
await db.query("INSERT INTO household (id, name) VALUES ($1, $2)", [householdId, "移动端验收家庭"]);
await db.query("INSERT INTO app_user (id, email, password_hash) VALUES ($1, $2, $3)", [userId, MOBILE_E2E_EMAIL, await hashPassword(MOBILE_E2E_PASSWORD)]);
await db.query("INSERT INTO household_member (id, household_id, user_id, role) VALUES ($1, $2, $3, 'owner')", [memberId, householdId, userId]);
await db.query("INSERT INTO financial_source (id, household_id, source_type, display_name) VALUES ($1, $2, 'bank', 'bank')", ["30000000-0000-0000-0000-0000000000a1", householdId]);
await db.query("INSERT INTO category (id, household_id, name, direction_scope, color_token) VALUES ($1, $2, '餐饮', 'expense', 'orange')", [categoryId, householdId]);
await db.query("INSERT INTO budget (id, household_id, category_id, name, amount, cycle) VALUES ($1, $2, $3, '餐饮预算', '3000.00', 'month')", [budgetId, householdId, categoryId]);
await db.query("INSERT INTO budget_period (id, household_id, budget_id, period_start, period_end, amount) VALUES ($1, $2, $3, '2026-08-01', '2026-08-31', '3000.00')", [budgetPeriodId, householdId, budgetId]);
await db.query("INSERT INTO ledger_transaction (id, household_id, occurred_at, direction, amount, currency, merchant, category, created_by) VALUES ($1, $2, '2026-08-03T18:00:00Z', 'expense', '128.00', 'CNY', '家庭餐饮', '餐饮', $3)", ["70000000-0000-0000-0000-0000000000a1", householdId, userId]);
await db.query("INSERT INTO physical_asset (id, household_id, name, asset_type) VALUES ($1, $2, '家用设备', 'equipment')", ["80000000-0000-0000-0000-0000000000a1", householdId]);
await db.query("INSERT INTO asset_event (id, household_id, asset_id, occurred_at, event_type, amount, recovery_amount) VALUES ($1, $2, $3, '2026-08-05T10:00:00Z', 'purchase', '3000.00', '0.00')", ["81000000-0000-0000-0000-0000000000a1", householdId, "80000000-0000-0000-0000-0000000000a1"]);

const pool: DbPool = { connect: async () => { await db.query("SET ROLE life_app"); return { query: db.query.bind(db), release: () => undefined }; } };
const importStore = new MemoryImportObjectStore();
const authStore = new SqlAuthStore(pool);
const passwordResetDelivery = new MobileE2ePasswordResetDelivery();
const app = buildServer({ authStore, passwordResetDelivery, financeFactory: (requestScope) => new SqlFinanceRepository(pool, requestScope, importStore), familyFactory: (requestScope) => new SqlFamilyRepository(pool, requestScope), importObjectStore: importStore });
app.get<{ Querystring: { email?: string } }>("/__e2e/password-reset-token", async (request, reply) => {
  const message = request.query.email ? passwordResetDelivery.get(request.query.email) : null;
  if (!message) return reply.code(404).send({ code: "RESET_TOKEN_NOT_FOUND" });
  return { token: message.token, expires_at: message.expiresAt };
});
await app.listen({ host: "127.0.0.1", port: apiPort });
console.log(`mobile-e2e-api listening on ${apiPort}`);

const close = async () => { await app.close(); await db.close(); process.exit(0); };
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
