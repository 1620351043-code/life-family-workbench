import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createProductionCosObjectStoreFromEnv } from "../src/api/import-storage.js";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`生产发布缺少 ${name}`);
  return value;
}

if (process.env.NODE_ENV !== "production") throw new Error("生产 preflight 必须设置 NODE_ENV=production");
const databaseUrl = required("DATABASE_URL");
const publicAppUrl = required("LIFE_PUBLIC_APP_URL");
const passwordResetDeliveryEndpoint = required("LIFE_PASSWORD_RESET_DELIVERY_ENDPOINT");
if (!publicAppUrl.startsWith("https://")) throw new Error("生产 LIFE_PUBLIC_APP_URL 必须使用 HTTPS");
if (!passwordResetDeliveryEndpoint.startsWith("https://")) throw new Error("生产 LIFE_PASSWORD_RESET_DELIVERY_ENDPOINT 必须使用 HTTPS");
required("LIFE_COS_BUCKET");
required("LIFE_COS_REGION");
required("LIFE_COS_SECRET_ID");
required("LIFE_COS_SECRET_KEY");
if (process.env.LIFE_COS_LIVE_SMOKE !== "true") throw new Error("生产 preflight 需要 LIFE_COS_LIVE_SMOKE=true 才会执行 COS 上传/读取/签名/删除闭环");

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
try {
  const role = await pool.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT current_user, r.rolsuper, r.rolbypassrls
       FROM pg_roles r
      WHERE r.rolname = current_user`,
  );
  const dbRole = role.rows[0];
  if (!dbRole || dbRole.rolsuper || dbRole.rolbypassrls) throw new Error("生产应用连接必须使用 NOSUPERUSER、NOBYPASSRLS 角色");

  const requiredTables = ["household", "app_user", "household_member", "user_session", "password_reset_token", "finance_export_job", "finance_import_job", "import_batch", "ai_memory_artifact"];
  const tableRows = await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [requiredTables],
  );
  const found = new Map(tableRows.rows.map((row) => [row.relname, row]));
  for (const table of requiredTables) if (!found.has(table)) throw new Error(`生产数据库缺少表 ${table}，请先执行 npm run db:migrate`);
  for (const table of ["household_member", "import_batch", "finance_export_job", "finance_import_job", "ai_memory_artifact"]) {
    const row = found.get(table);
    if (!row?.relrowsecurity || !row.relforcerowsecurity) throw new Error(`生产数据库表 ${table} 未启用 FORCE ROW LEVEL SECURITY`);
  }
  const functionCheck = await pool.query("SELECT to_regprocedure('life_auth_lookup_user(text)') AS function_name");
  if (!functionCheck.rows[0]?.function_name) throw new Error("生产数据库缺少 life_auth_lookup_user(text)");
  const passwordResetFunctionCheck = await pool.query("SELECT to_regprocedure('life_auth_apply_password_reset(text,text)') AS function_name");
  if (!passwordResetFunctionCheck.rows[0]?.function_name) throw new Error("生产数据库缺少 life_auth_apply_password_reset(text,text)");

  const store = createProductionCosObjectStoreFromEnv();
  const key = `production-smoke/${randomUUID()}.txt`;
  const content = Buffer.from("life-production-smoke", "utf8");
  try {
    await store.put(key, content);
    const downloaded = await store.read(key);
    if (!downloaded.equals(content)) throw new Error("COS 读取内容与上传内容不一致");
    const signed = store.signedGetUrl?.(key, new Date(Date.now() + 60_000));
    if (!signed?.startsWith("https://")) throw new Error("COS 签名 URL 不是 HTTPS");
  } finally {
    await store.remove(key);
  }
  console.log(JSON.stringify({ ok: true, database_role: dbRole.current_user, tables_checked: requiredTables.length, cos_smoke: "passed" }));
} finally {
  await pool.end();
}
