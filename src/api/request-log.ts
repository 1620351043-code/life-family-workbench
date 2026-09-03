import { createHash } from "node:crypto";

export type RequestLogEntry = {
  kind: "http";
  trace_id: string;
  method: string;
  route: string;
  status_code: number;
  duration_ms: number;
  ip_hash: string | null;
  user_agent: string | null;
  user_id_hash: string | null;
  household_id_hash: string | null;
  email_hash: string | null;
};

const DEFAULT_LOG_SALT = "life-family-workbench";

function logSalt(): string {
  const configured = process.env.LIFE_LOG_SALT?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_LOG_SALT;
}

export function privacyHash(value: string | null | undefined): string | null {
  if (!value) return null;
  return createHash("sha256").update(`${logSalt()}\0${value}`).digest("hex").slice(0, 16);
}

export function redactUrl(value: string): string {
  try {
    return new URL(value, "http://localhost").pathname;
  } catch {
    return value.split("?")[0] ?? value;
  }
}

export type RequestLogInput = {
  traceId: string;
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
  ip?: string | null;
  userAgent?: string | null;
  userId?: string | null;
  householdId?: string | null;
  email?: string | null;
};

export function buildRequestLogEntry(input: RequestLogInput): RequestLogEntry {
  return {
    kind: "http",
    trace_id: input.traceId,
    method: input.method.toUpperCase(),
    route: redactUrl(input.route),
    status_code: input.statusCode,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    ip_hash: privacyHash(input.ip),
    user_agent: input.userAgent?.slice(0, 200) ?? null,
    user_id_hash: privacyHash(input.userId),
    household_id_hash: privacyHash(input.householdId),
    email_hash: privacyHash(input.email),
  };
}
