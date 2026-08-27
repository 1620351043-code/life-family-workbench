import { createHash } from "node:crypto";

export type AuthRateLimitOperation = "login" | "register" | "password_reset_request" | "password_reset_confirm";
export type AuthRateLimitInput = { operation: AuthRateLimitOperation; email: string; ipAddress?: string | null };
export type AuthRateLimitDecision = { allowed: boolean; retryAfterSeconds: number };

export type AuthAttemptLimiter = {
  check(input: AuthRateLimitInput): AuthRateLimitDecision;
  recordFailure(input: AuthRateLimitInput): AuthRateLimitDecision;
  recordSuccess(input: AuthRateLimitInput): void;
};

type LimitRule = { maxFailures: number; windowMs: number; blockMs: number };
type Entry = { failures: number; windowStartedAt: number; blockedUntil: number; lastSeenAt: number };

export type InMemoryAuthAttemptLimiterOptions = {
  login?: Partial<LimitRule>;
  register?: Partial<LimitRule>;
  password_reset_request?: Partial<LimitRule>;
  password_reset_confirm?: Partial<LimitRule>;
  maxEntries?: number;
  now?: () => number;
};

const DEFAULT_RULES: Record<AuthRateLimitOperation, LimitRule> = {
  login: { maxFailures: 5, windowMs: 15 * 60_000, blockMs: 15 * 60_000 },
  register: { maxFailures: 5, windowMs: 60 * 60_000, blockMs: 60 * 60_000 },
  password_reset_request: { maxFailures: 3, windowMs: 60 * 60_000, blockMs: 60 * 60_000 },
  password_reset_confirm: { maxFailures: 5, windowMs: 15 * 60_000, blockMs: 15 * 60_000 },
};

function secondsUntil(timestamp: number, now: number) {
  return Math.max(1, Math.ceil((timestamp - now) / 1000));
}

export class InMemoryAuthAttemptLimiter implements AuthAttemptLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly rules: Record<AuthRateLimitOperation, LimitRule>;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: InMemoryAuthAttemptLimiterOptions = {}) {
    this.rules = {
      login: { ...DEFAULT_RULES.login, ...options.login },
      register: { ...DEFAULT_RULES.register, ...options.register },
      password_reset_request: { ...DEFAULT_RULES.password_reset_request, ...options.password_reset_request },
      password_reset_confirm: { ...DEFAULT_RULES.password_reset_confirm, ...options.password_reset_confirm },
    };
    this.maxEntries = Math.max(100, options.maxEntries ?? 10_000);
    this.now = options.now ?? Date.now;
  }

  check(input: AuthRateLimitInput): AuthRateLimitDecision {
    const now = this.now();
    const key = this.key(input);
    const entry = this.entries.get(key);
    if (!entry) return { allowed: true, retryAfterSeconds: 0 };
    entry.lastSeenAt = now;
    if (entry.blockedUntil > now) return { allowed: false, retryAfterSeconds: secondsUntil(entry.blockedUntil, now) };
    const rule = this.rules[input.operation];
    if (now - entry.windowStartedAt >= rule.windowMs) {
      this.entries.delete(key);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  recordFailure(input: AuthRateLimitInput): AuthRateLimitDecision {
    const now = this.now();
    const rule = this.rules[input.operation];
    const key = this.key(input);
    const current = this.entries.get(key);
    const entry = !current || now - current.windowStartedAt >= rule.windowMs
      ? { failures: 0, windowStartedAt: now, blockedUntil: 0, lastSeenAt: now }
      : current;
    entry.failures += 1;
    entry.lastSeenAt = now;
    if (entry.failures >= rule.maxFailures) entry.blockedUntil = now + rule.blockMs;
    this.entries.set(key, entry);
    this.prune(now);
    return entry.blockedUntil > now
      ? { allowed: false, retryAfterSeconds: secondsUntil(entry.blockedUntil, now) }
      : { allowed: true, retryAfterSeconds: 0 };
  }

  recordSuccess(input: AuthRateLimitInput) {
    this.entries.delete(this.key(input));
  }

  private key(input: AuthRateLimitInput) {
    const normalized = `${input.operation}:${input.email.trim().toLowerCase()}:${input.ipAddress?.trim() || "unknown"}`;
    return createHash("sha256").update(normalized).digest("hex");
  }

  private prune(now: number) {
    if (this.entries.size <= this.maxEntries) return;
    for (const [key, entry] of [...this.entries.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)) {
      if (this.entries.size <= this.maxEntries) break;
      if (entry.blockedUntil <= now || this.entries.size > this.maxEntries) this.entries.delete(key);
    }
  }
}
