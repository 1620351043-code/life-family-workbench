import { Pool } from "pg";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`B-011 staging 缺少 ${name}`);
  return value;
}

const deploymentEnvironment = required("LIFE_DEPLOYMENT_ENV");
if (deploymentEnvironment !== "staging") throw new Error("B-011 preflight 只能在 LIFE_DEPLOYMENT_ENV=staging 执行");
if (process.env.LIFE_SESSION_COOKIE_SECURE !== "true") throw new Error("B-011 staging 必须设置 LIFE_SESSION_COOKIE_SECURE=true");
const databaseUrl = required("DATABASE_URL");
const publicAppUrl = required("LIFE_PUBLIC_APP_URL");
const passwordResetDeliveryEndpoint = required("LIFE_PASSWORD_RESET_DELIVERY_ENDPOINT");
if (!publicAppUrl.startsWith("https://")) throw new Error("B-011 LIFE_PUBLIC_APP_URL 必须使用 HTTPS");
if (!passwordResetDeliveryEndpoint.startsWith("https://")) throw new Error("B-011 LIFE_PASSWORD_RESET_DELIVERY_ENDPOINT 必须使用 HTTPS");

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
try {
  const roleResult = await pool.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean; server_version: string }>(
    `SELECT current_user,
            role.rolsuper,
            role.rolbypassrls,
            current_setting('server_version') AS server_version
       FROM pg_roles role
      WHERE role.rolname = current_user`,
  );
  const role = roleResult.rows[0];
  if (!role) throw new Error("B-011 无法读取 PostgreSQL 应用角色");
  if (role.rolsuper || role.rolbypassrls) throw new Error("B-011 staging 应用连接必须使用 NOSUPERUSER、NOBYPASSRLS 角色");

  const requiredTables = ["app_user", "household", "household_member", "user_session", "password_reset_token", "data_deletion_request"];
  const tables = await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT class.relname, class.relrowsecurity, class.relforcerowsecurity
       FROM pg_class class
       JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
      WHERE namespace.nspname = 'public' AND class.relname = ANY($1::text[])`,
    [requiredTables],
  );
  const tableMap = new Map(tables.rows.map((row) => [row.relname, row]));
  for (const table of requiredTables) if (!tableMap.has(table)) throw new Error(`B-011 staging 数据库缺少 ${table}`);
  for (const table of ["household_member", "data_deletion_request"]) {
    const row = tableMap.get(table);
    if (!row?.relrowsecurity || !row.relforcerowsecurity) throw new Error(`B-011 staging 表 ${table} 未启用 FORCE RLS`);
  }

  const requiredFunctions = [
    "life_auth_lookup_user(text)",
    "life_auth_register_user(uuid,uuid,uuid,text,text,text)",
    "life_auth_create_password_reset(uuid,text,text,timestamptz,text,inet)",
    "life_auth_apply_password_reset(text,text)",
  ];
  const securityDefinerOwners = new Set<string>();
  for (const procedure of requiredFunctions) {
    const result = await pool.query<{
      function_name: string;
      security_definer: boolean;
      owner_role: string;
      owner_superuser: boolean;
      owner_bypassrls: boolean;
    }>(
      `SELECT procedure.oid::regprocedure::text AS function_name,
              procedure.prosecdef AS security_definer,
              owner.rolname AS owner_role,
              owner.rolsuper AS owner_superuser,
              owner.rolbypassrls AS owner_bypassrls
         FROM pg_proc procedure
         JOIN pg_roles owner ON owner.oid = procedure.proowner
        WHERE procedure.oid = to_regprocedure($1)`,
      [procedure],
    );
    const functionContract = result.rows[0];
    if (!functionContract) throw new Error(`B-011 staging 数据库缺少 ${procedure}`);
    if (!functionContract.security_definer) throw new Error(`B-011 staging 函数 ${procedure} 必须为 SECURITY DEFINER`);
    if (!functionContract.owner_superuser && !functionContract.owner_bypassrls) {
      throw new Error(`B-011 staging 函数 ${procedure} 的所有者无法穿过 FORCE RLS`);
    }
    securityDefinerOwners.add(functionContract.owner_role);
  }

  console.log(JSON.stringify({
    ok: true,
    contract: "B-011 staging auth preflight",
    database_role: role.current_user,
    postgres_version: role.server_version,
    tables_checked: requiredTables.length,
    functions_checked: requiredFunctions.length,
    security_definer_owners: [...securityDefinerOwners].sort(),
    public_app_https: true,
    password_reset_delivery_https: true,
    secure_cookie: true,
    cos_scope: "explicitly_not_part_of_B-011",
  }));
} finally {
  await pool.end();
}
