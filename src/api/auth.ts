import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { DbPool, FinanceScope } from "./database.js";

const PASSWORD_PREFIX = "scrypt-v1";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

function deriveKey(password: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, { N: 16_384, r: 8, p: 1 }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived as Buffer);
    });
  });
}

export type AuthIdentity = {
  user: { id: string; email: string };
  household: { id: string; name: string; role: "owner" | "adult" | "child" | "guest" };
};

export type AuthSession = { scope: FinanceScope; identity: AuthIdentity };

export type AuthStore = {
  authenticate(email: string, password: string, metadata?: { userAgent?: string | null; ipAddress?: string | null }): Promise<{ token: string; session: AuthSession } | null>;
  register(email: string, password: string, householdName: string, metadata?: { userAgent?: string | null; ipAddress?: string | null }): Promise<{ token: string; session: AuthSession } | null>;
  resolveSession(token: string): Promise<AuthSession | null>;
  revokeSession(token: string): Promise<void>;
};

function hashToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length > 1024) throw new Error("密码长度不符合要求");
  const salt = randomBytes(16);
  const derived = await deriveKey(password, salt, 64);
  return `${PASSWORD_PREFIX}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 3 || parts[0] !== PASSWORD_PREFIX) return false;
  try {
    const salt = Buffer.from(parts[1], "base64url");
    const expected = Buffer.from(parts[2], "base64url");
    const actual = await deriveKey(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function identityFromRow(row: Record<string, unknown>): AuthIdentity {
  return {
    user: { id: String(row.user_id), email: String(row.email) },
    household: { id: String(row.household_id), name: String(row.household_name), role: String(row.role) as AuthIdentity["household"]["role"] },
  };
}

function sessionFromIdentity(identity: AuthIdentity): AuthSession {
  return { scope: { householdId: identity.household.id, userId: identity.user.id }, identity };
}

export class SqlAuthStore implements AuthStore {
  constructor(private readonly pool: DbPool) {}

  async authenticate(email: string, password: string, metadata: { userAgent?: string | null; ipAddress?: string | null } = {}) {
    const client = await this.pool.connect();
    try {
      const lookup = await client.query<Record<string, unknown>>("SELECT * FROM life_auth_lookup_user($1)", [email.trim()]);
      const row = lookup.rows[0];
      if (!row || !(await verifyPassword(password, String(row.password_hash)))) return null;

      const identity = identityFromRow(row);
      const token = randomBytes(32).toString("base64url");
      await client.query(
        `INSERT INTO user_session (id, user_id, household_id, token_hash, expires_at, user_agent, ip_address)
         VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 second'), $6, $7::inet)`,
        [randomUUID(), identity.user.id, identity.household.id, hashToken(token), SESSION_TTL_SECONDS, metadata.userAgent?.slice(0, 500) ?? null, metadata.ipAddress ?? null],
      );
      return { token, session: sessionFromIdentity(identity) };
    } finally {
      client.release?.();
    }
  }

  async register(email: string, password: string, householdName: string, metadata: { userAgent?: string | null; ipAddress?: string | null } = {}) {
    const client = await this.pool.connect();
    try {
      const passwordHash = await hashPassword(password);
      const userId = randomUUID();
      const householdId = randomUUID();
      const memberId = randomUUID();
      await client.query("BEGIN");
      const result = await client.query<Record<string, unknown>>(
        "SELECT * FROM life_auth_register_user($1, $2, $3, $4, $5, $6)",
        [userId, householdId, memberId, email.trim(), passwordHash, householdName.trim()],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      const identity = identityFromRow(row);
      const token = randomBytes(32).toString("base64url");
      await client.query(
        `INSERT INTO user_session (id, user_id, household_id, token_hash, expires_at, user_agent, ip_address)
         VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 second'), $6, $7::inet)`,
        [randomUUID(), identity.user.id, identity.household.id, hashToken(token), SESSION_TTL_SECONDS, metadata.userAgent?.slice(0, 500) ?? null, metadata.ipAddress ?? null],
      );
      await client.query("COMMIT");
      return { token, session: sessionFromIdentity(identity) };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
      if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "23505") return null;
      throw error;
    } finally {
      client.release?.();
    }
  }

  async resolveSession(token: string): Promise<AuthSession | null> {
    if (!token || token.length > 256) return null;
    const client = await this.pool.connect();
    try {
      const sessionResult = await client.query<{ user_id: string; household_id: string }>(
        `SELECT user_id::text AS user_id, household_id::text AS household_id
           FROM user_session
          WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
        [hashToken(token)],
      );
      const session = sessionResult.rows[0];
      if (!session) return null;
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.user_id', $1, true), set_config('app.household_id', $2, true)", [session.user_id, session.household_id]);
      const identityResult = await client.query<Record<string, unknown>>(
        `SELECT u.id::text AS user_id, u.email, h.id::text AS household_id, h.name AS household_name, hm.role
           FROM app_user u
           JOIN household_member hm ON hm.user_id = u.id AND hm.household_id = $2 AND hm.status = 'active'
           JOIN household h ON h.id = hm.household_id
          WHERE u.id = $1`,
        [session.user_id, session.household_id],
      );
      await client.query("UPDATE user_session SET last_seen_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [hashToken(token)]);
      await client.query("COMMIT");
      const row = identityResult.rows[0];
      return row ? sessionFromIdentity(identityFromRow(row)) : null;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    } finally {
      client.release?.();
    }
  }

  async revokeSession(token: string): Promise<void> {
    if (!token) return;
    const client = await this.pool.connect();
    try {
      await client.query("UPDATE user_session SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [hashToken(token)]);
    } finally {
      client.release?.();
    }
  }
}
