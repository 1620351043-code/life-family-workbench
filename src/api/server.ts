import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { Pool } from "pg";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { DomainError } from "./domain-error.js";
import { SqlFinanceRepository, type FinanceRepository, type FinanceAccount, type FinanceAssetEventType, type FinanceBudget, type FinanceCategory, type ImportSourceType } from "./finance-repository.js";
import { SqlFamilyRepository, type FamilyRepository, type FamilyTopicType } from "./family-repository.js";
import type { DbPool, FinanceScope } from "./database.js";
import { financeExportObjectKey, importObjectKey, LocalImportObjectStore, createProductionCosObjectStoreFromEnv, type ImportObjectStore } from "./import-storage.js";
import { LocalFinanceImportParser, type FinanceImportParser } from "./finance-import-parser.js";
import { runFinanceExportJob } from "./finance-export-worker.js";
import { SqlAuthStore, type AuthSession, type AuthStore } from "./auth.js";
import { InMemoryAuthAttemptLimiter, type AuthAttemptLimiter, type AuthRateLimitInput } from "./auth-rate-limit.js";
import { createPasswordResetDeliveryFromEnv, type PasswordResetDelivery } from "./password-reset-delivery.js";
import { sensitiveCapabilities } from "./sensitive-permissions.js";
import { isProductionDeployment, isSecureDeployment } from "./deployment-environment.js";

const sourceTypes = ["bank", "alipay", "wechat", "bookkeeping_app", "other"] as const;
const overviewQuerySchema = z.object({ start: z.string().date(), end: z.string().date(), granularity: z.enum(["day", "week", "month", "quarter"]).default("day") });
const pageQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(50) });
const transactionListQuerySchema = pageQuerySchema.extend({ start: z.string().date().optional(), end: z.string().date().optional(), direction: z.enum(["income", "expense", "transfer"]).optional(), account_id: z.string().uuid().optional(), import_batch_id: z.string().uuid().optional() });
const createImportBatchSchema = z.object({ source_type: z.enum(sourceTypes), file_name: z.string().min(1).max(255), file_size: z.number().int().nonnegative(), file_sha256: z.string().regex(/^[a-f0-9]{64}$/i), object_key: z.string().min(1), account_id: z.string().uuid().nullable().optional() });
const accountTypeSchema = z.enum(["bank", "cash", "wallet", "payment_platform", "other"]);
const createAccountSchema = z.object({ name: z.string().trim().min(1).max(80), account_type: accountTypeSchema, currency: z.string().length(3).default("CNY"), opening_balance: z.string().regex(/^\d+(?:\.\d{1,4})?$/).default("0") });
const updateAccountSchema = z.object({ name: z.string().trim().min(1).max(80), account_type: accountTypeSchema });
const categoryScopeSchema = z.enum(["income", "expense", "both"]);
const categorySchema = z.object({ name: z.string().trim().min(1).max(40), direction_scope: categoryScopeSchema, color_token: z.string().trim().min(1).max(32).default("violet") });
const budgetCycleSchema = z.enum(["month", "quarter", "year", "custom"]);
const budgetSchema = z.object({ category_id: z.string().uuid(), name: z.string().trim().max(80).default(""), cycle: budgetCycleSchema, amount: z.string().regex(/^\d+(?:\.\d{1,4})?$/), currency: z.string().length(3).default("CNY"), period_start: z.string().date(), period_end: z.string().date() });
const assetSchema = z.object({ name: z.string().trim().min(1).max(120), asset_type: z.string().trim().min(1).max(60) });
const assetEventSchema = z.object({ occurred_at: z.string().min(1), event_type: z.enum(["purchase", "maintenance", "consumable", "upgrade", "transfer", "sale", "disposal"]), amount: z.string().regex(/^\d+(?:\.\d{1,4})?$/).default("0"), recovery_amount: z.string().regex(/^\d+(?:\.\d{1,4})?$/).default("0"), ledger_transaction_id: z.string().uuid().nullable().optional() });
const manualTransactionSchema = z.object({ direction: z.enum(["income", "expense", "transfer"]), occurred_at: z.string().min(1), amount: z.string().regex(/^\d+(?:\.\d{1,4})?$/), currency: z.string().length(3).default("CNY"), account_id: z.string().uuid(), to_account_id: z.string().uuid().nullable().optional(), category_id: z.string().uuid().nullable().optional(), merchant: z.string().trim().max(120).nullable().optional(), note: z.string().trim().max(500).nullable().optional() });
const financePermissionSchema = z.object({ can_view: z.boolean(), can_bookkeep: z.boolean(), can_edit: z.boolean(), can_import: z.boolean(), can_reconcile: z.boolean(), can_export: z.boolean() });
const financeAuditQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });
const voidTransactionSchema = z.object({ reason: z.string().trim().min(1).max(500) });
const headerSchema = z.object({ sheet_name: z.string().min(1), header_row: z.number().int().min(1), data_start_row: z.number().int().min(1), data_end_row: z.number().int().min(1).optional() });
const mappingSchema = z.object({ mapping: z.record(z.string()), parser_version: z.string().min(1) });
const decisionSchema = z.object({ candidate_id: z.string().uuid(), decision: z.enum(["duplicate", "parent_settlement", "refund_reversal", "fee_related", "split", "unrelated"]), expected_version: z.number().int().min(1), reason: z.string().optional() });
const commitSchema = z.object({ expected_version: z.number().int().min(1), confirm_summary_hash: z.string().min(1) });
const topicTypes = ["idea", "request", "inspiration", "memory", "other"] as const;
const createTopicSchema = z.object({ topic_type: z.enum(topicTypes), title: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(10000) });
const commentSchema = z.object({ body: z.string().trim().min(1).max(2000) });
const aiActionDecisionSchema = z.object({ decision: z.enum(["confirm", "reject"]), expected_version: z.number().int().min(1) });
const financeAiDecisionSchema = z.object({ decision: z.enum(["confirm", "reject"]), expected_version: z.number().int().min(1) });
const financeAiConnectionSchema = z.object({ endpoint_url: z.string().url(), model: z.string().trim().min(1).max(120), api_key_ref: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/), status: z.enum(["active", "disabled"]).default("active") });
const financeExportSchema = z.object({ start: z.string().date(), end: z.string().date(), format: z.literal("csv").default("csv") });
const loginSchema = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(1024) });
const registerSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8, "密码至少需要 8 位").max(128, "密码不能超过 128 位"),
  household_name: z.string().trim().min(1, "请输入家庭名称").max(80),
});
const passwordResetRequestSchema = z.object({ email: z.string().email().max(320) });
const passwordResetConfirmSchema = z.object({
  token: z.string().min(32, "密码重置链接无效").max(512, "密码重置链接无效"),
  password: z.string().min(8, "密码至少需要 8 位").max(128, "密码不能超过 128 位"),
});
const invitationTokenSchema = z.string().min(16, "邀请码无效").max(512, "邀请码无效");
const invitationPreviewSchema = z.object({ token: invitationTokenSchema });
const invitationAcceptSchema = z.object({
  token: invitationTokenSchema,
  email: z.string().email().max(320),
  password: z.string().min(8, "密码至少需要 8 位").max(128, "密码不能超过 128 位"),
});
const invitationRoleSchema = z.enum(["adult", "child", "guest"]);
const createInvitationSchema = z.object({ role: invitationRoleSchema, expires_in_days: z.number().int().min(1).max(30).default(7) });
const memberRoleSchema = z.object({ role: invitationRoleSchema });
const sensitivePermissionSchema = z.object({
  capability: z.enum(sensitiveCapabilities),
  enabled: z.boolean(),
  expected_version: z.number().int().min(0),
});
const deletionRequestSchema = z.object({ request_type: z.enum(["account", "household"]) });
const deletionCancelSchema = z.object({ expected_version: z.number().int().min(1) });

export type FinanceRepositoryFactory = (scope: FinanceScope) => FinanceRepository;
export type FamilyRepositoryFactory = (scope: FinanceScope) => FamilyRepository;
export type ScopeResolver = (request: FastifyRequest) => FinanceScope | null | Promise<FinanceScope | null>;
export type ServerOptions = { financeFactory?: FinanceRepositoryFactory; familyFactory?: FamilyRepositoryFactory; resolveScope?: ScopeResolver; authStore?: AuthStore; authAttemptLimiter?: AuthAttemptLimiter; passwordResetDelivery?: PasswordResetDelivery; importObjectStore?: ImportObjectStore; importParser?: FinanceImportParser; exportRunner?: (scope: FinanceScope, jobId: string) => Promise<void>; importRunner?: (scope: FinanceScope, batchId: string, jobId: string) => Promise<unknown> };

const requestScopes = new WeakMap<object, FinanceScope | null>();
const requestSessions = new WeakMap<object, AuthSession>();

function headerValue(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function cookieValue(request: FastifyRequest, name: string): string | null {
  const cookieHeader = headerValue(request, "cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) return decodeURIComponent(valueParts.join("="));
  }
  return null;
}

function sessionCookieName() {
  return process.env.LIFE_SESSION_COOKIE_NAME?.trim() || "life_session";
}

function setSessionCookie(reply: { header(name: string, value: string): unknown }, token: string | null) {
  const secure = isSecureDeployment() || process.env.LIFE_SESSION_COOKIE_SECURE === "true";
  const suffix = secure ? "; Secure" : "";
  const maxAge = token ? "; Max-Age=2592000" : "; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
  reply.header("set-cookie", `${sessionCookieName()}=${token ? encodeURIComponent(token) : ""}; Path=/; HttpOnly; SameSite=Lax${suffix}${maxAge}`);
}

function defaultScopeResolver(request: FastifyRequest): FinanceScope | null {
  // Development-only bridge. Production must replace this with the HttpOnly session resolver.
  if (process.env.LIFE_DEV_DEMO_SCOPE !== "true") return null;
  const householdId = process.env.LIFE_DEMO_HOUSEHOLD_ID ?? headerValue(request, "x-life-household-id");
  const userId = process.env.LIFE_DEMO_USER_ID ?? headerValue(request, "x-life-user-id");
  return householdId && userId ? { householdId, userId } : null;
}

function requireScope(request: FastifyRequest, reply: { code(code: number): { send(body: unknown): unknown } }, resolver: ScopeResolver): FinanceScope | null {
  const resolved = requestScopes.has(request) ? requestScopes.get(request) ?? null : resolver(request);
  const scope = resolved && typeof (resolved as Promise<FinanceScope | null>).then === "function" ? null : resolved as FinanceScope | null;
  if (!scope) {
    reply.code(401).send({ code: "UNAUTHORIZED", message: "需要有效的家庭会话" });
    return null;
  }
  return scope;
}

function requireFactory(reply: { code(code: number): { send(body: unknown): unknown } }, factory?: FinanceRepositoryFactory): FinanceRepository | null {
  if (!factory) {
    reply.code(503).send({ code: "FINANCE_DB_NOT_CONFIGURED", message: "财务数据库尚未配置" });
    return null;
  }
  return factory as unknown as FinanceRepository;
}

function requireFamilyFactory(reply: { code(code: number): { send(body: unknown): unknown } }, factory?: FamilyRepositoryFactory): FamilyRepository | null {
  if (!factory) {
    reply.code(503).send({ code: "FAMILY_DB_NOT_CONFIGURED", message: "家庭空间数据库尚未配置" });
    return null;
  }
  return factory as unknown as FamilyRepository;
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const authStore = options.authStore;
  const authAttemptLimiter = options.authAttemptLimiter ?? new InMemoryAuthAttemptLimiter();
  const passwordResetDelivery = options.passwordResetDelivery;
  const resolveScope = options.resolveScope ?? defaultScopeResolver;
  if (isSecureDeployment() && !authStore && !options.resolveScope) throw new Error("staging/production 必须配置正式会话 resolver 或 authStore，禁止使用开发 scope");
  const importObjectStore: ImportObjectStore = options.importObjectStore ?? (isProductionDeployment() ? createProductionCosObjectStoreFromEnv() : new LocalImportObjectStore());
  if (isProductionDeployment() && !importObjectStore.production) throw new Error("生产环境必须使用腾讯云 COS 私有桶适配器，禁止回退到本地账单存储");
  const importParser = options.importParser ?? new LocalFinanceImportParser(importObjectStore);
  const app = Fastify({
    logger: isSecureDeployment(),
    bodyLimit: 50 * 1024 * 1024,
    trustProxy: isSecureDeployment() ? ["127.0.0.1", "::1"] : false,
  });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/api/")) return;
    if (authStore && !options.resolveScope) {
      const session = await authStore.resolveSession(cookieValue(request, sessionCookieName()) ?? "");
      if (session) {
        requestScopes.set(request, session.scope);
        requestSessions.set(request, session);
      } else {
        requestScopes.set(request, null);
      }
      return;
    }
    requestScopes.set(request, await resolveScope(request));
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ code: error.code, message: error.message, trace_id: request.id });
    if (error instanceof z.ZodError) return reply.code(400).send({ code: "BAD_REQUEST", message: error.issues[0]?.message ?? "提交内容不符合要求", trace_id: request.id });
    request.log.error(error);
    return reply.code(500).send({ code: "INTERNAL_ERROR", message: "服务暂时不可用", trace_id: request.id });
  });

  app.get("/healthz", async () => ({ status: "ok", service: "life-api" }));
  app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(await readFile(new URL("../../ui/low-fi/index.html", import.meta.url), "utf8")));

  app.post("/api/auth/login", async (request, reply) => {
    if (!authStore) return reply.code(503).send({ code: "AUTH_NOT_CONFIGURED", message: "身份服务尚未配置", trace_id: request.id });
    const input = loginSchema.parse(request.body);
    const limitInput: AuthRateLimitInput = { operation: "login", email: input.email, ipAddress: request.ip };
    const currentLimit = authAttemptLimiter.check(limitInput);
    if (!currentLimit.allowed) {
      reply.header("retry-after", String(currentLimit.retryAfterSeconds));
      return reply.code(429).send({ code: "AUTH_RATE_LIMITED", message: "尝试次数过多，请稍后再试", retry_after_seconds: currentLimit.retryAfterSeconds, trace_id: request.id });
    }
    const result = await authStore.authenticate(input.email, input.password, { userAgent: headerValue(request, "user-agent"), ipAddress: request.ip });
    if (!result) {
      const nextLimit = authAttemptLimiter.recordFailure(limitInput);
      if (!nextLimit.allowed) {
        reply.header("retry-after", String(nextLimit.retryAfterSeconds));
        return reply.code(429).send({ code: "AUTH_RATE_LIMITED", message: "尝试次数过多，请稍后再试", retry_after_seconds: nextLimit.retryAfterSeconds, trace_id: request.id });
      }
      return reply.code(401).send({ code: "INVALID_CREDENTIALS", message: "邮箱或密码不正确", trace_id: request.id });
    }
    authAttemptLimiter.recordSuccess(limitInput);
    setSessionCookie(reply, result.token);
    return result.session.identity;
  });

  app.post("/api/auth/register", async (request, reply) => {
    if (!authStore) return reply.code(503).send({ code: "AUTH_NOT_CONFIGURED", message: "身份服务尚未配置", trace_id: request.id });
    const input = registerSchema.parse(request.body);
    const limitInput: AuthRateLimitInput = { operation: "register", email: input.email, ipAddress: request.ip };
    const currentLimit = authAttemptLimiter.check(limitInput);
    if (!currentLimit.allowed) {
      reply.header("retry-after", String(currentLimit.retryAfterSeconds));
      return reply.code(429).send({ code: "AUTH_RATE_LIMITED", message: "注册尝试过于频繁，请稍后再试", retry_after_seconds: currentLimit.retryAfterSeconds, trace_id: request.id });
    }
    const result = await authStore.register(input.email, input.password, input.household_name, { userAgent: headerValue(request, "user-agent"), ipAddress: request.ip });
    if (!result) {
      const nextLimit = authAttemptLimiter.recordFailure(limitInput);
      if (!nextLimit.allowed) {
        reply.header("retry-after", String(nextLimit.retryAfterSeconds));
        return reply.code(429).send({ code: "AUTH_RATE_LIMITED", message: "注册尝试过于频繁，请稍后再试", retry_after_seconds: nextLimit.retryAfterSeconds, trace_id: request.id });
      }
      return reply.code(409).send({ code: "EMAIL_ALREADY_REGISTERED", message: "该邮箱已注册，不能创建第二个家庭", trace_id: request.id });
    }
    authAttemptLimiter.recordSuccess(limitInput);
    setSessionCookie(reply, result.token);
    return reply.code(201).send(result.session.identity);
  });

  app.post("/api/auth/password-reset/request", async (request, reply) => {
    if (!authStore || !passwordResetDelivery) return reply.code(503).send({ code: "PASSWORD_RESET_NOT_CONFIGURED", message: "密码重置服务尚未配置", trace_id: request.id });
    const input = passwordResetRequestSchema.parse(request.body);
    const limitInput: AuthRateLimitInput = { operation: "password_reset_request", email: input.email, ipAddress: request.ip };
    const currentLimit = authAttemptLimiter.check(limitInput);
    if (!currentLimit.allowed) {
      reply.header("retry-after", String(currentLimit.retryAfterSeconds));
      return reply.code(429).send({ code: "AUTH_RATE_LIMITED", message: "请求次数过多，请稍后再试", retry_after_seconds: currentLimit.retryAfterSeconds, trace_id: request.id });
    }
    const reset = await authStore.createPasswordReset(input.email, { userAgent: headerValue(request, "user-agent"), ipAddress: request.ip });
    authAttemptLimiter.recordFailure(limitInput);
    if (reset) {
      try {
        await passwordResetDelivery.sendPasswordReset(reset);
      } catch (error) {
        request.log.error({ error }, "password reset delivery failed");
      }
    }
    return reply.code(202).send({ ok: true, message: "如果该邮箱已注册，重置链接将很快送达" });
  });

  app.post("/api/auth/password-reset/confirm", async (request, reply) => {
    if (!authStore) return reply.code(503).send({ code: "AUTH_NOT_CONFIGURED", message: "身份服务尚未配置", trace_id: request.id });
    const input = passwordResetConfirmSchema.parse(request.body);
    const limitInput: AuthRateLimitInput = { operation: "password_reset_confirm", email: input.token, ipAddress: request.ip };
    const currentLimit = authAttemptLimiter.check(limitInput);
    if (!currentLimit.allowed) {
      reply.header("retry-after", String(currentLimit.retryAfterSeconds));
      return reply.code(429).send({ code: "AUTH_RATE_LIMITED", message: "尝试次数过多，请稍后再试", retry_after_seconds: currentLimit.retryAfterSeconds, trace_id: request.id });
    }
    const applied = await authStore.applyPasswordReset(input.token, input.password);
    if (!applied) {
      const nextLimit = authAttemptLimiter.recordFailure(limitInput);
      if (!nextLimit.allowed) reply.header("retry-after", String(nextLimit.retryAfterSeconds));
      return reply.code(nextLimit.allowed ? 400 : 429).send({ code: nextLimit.allowed ? "PASSWORD_RESET_INVALID" : "AUTH_RATE_LIMITED", message: nextLimit.allowed ? "重置链接无效、已使用或已过期" : "尝试次数过多，请稍后再试", ...(nextLimit.allowed ? {} : { retry_after_seconds: nextLimit.retryAfterSeconds }), trace_id: request.id });
    }
    authAttemptLimiter.recordSuccess(limitInput);
    setSessionCookie(reply, null);
    return { ok: true, message: "密码已更新，请重新登录" };
  });

  app.get("/api/auth/invitations/preview", async (request, reply) => {
    if (!authStore) return reply.code(503).send({ code: "AUTH_NOT_CONFIGURED", message: "身份服务尚未配置", trace_id: request.id });
    const input = invitationPreviewSchema.parse(request.query);
    const limitInput: AuthRateLimitInput = { operation: "invitation_preview", email: input.token, ipAddress: request.ip };
    const currentLimit = authAttemptLimiter.check(limitInput);
    if (!currentLimit.allowed) {
      reply.header("retry-after", String(currentLimit.retryAfterSeconds));
      return reply.code(429).send({ code: "AUTH_RATE_LIMITED", message: "邀请码检查过于频繁，请稍后再试", retry_after_seconds: currentLimit.retryAfterSeconds, trace_id: request.id });
    }
    const invitation = await authStore.previewInvitation(input.token);
    if (invitation.status === "invalid") {
      authAttemptLimiter.recordFailure(limitInput);
      return reply.code(400).send({ code: "INVITATION_INVALID", message: "邀请码不存在或格式不正确", trace_id: request.id });
    }
    authAttemptLimiter.recordSuccess(limitInput);
    return invitation;
  });

  app.post("/api/auth/invitations/accept", async (request, reply) => {
    if (!authStore) return reply.code(503).send({ code: "AUTH_NOT_CONFIGURED", message: "身份服务尚未配置", trace_id: request.id });
    const input = invitationAcceptSchema.parse(request.body);
    const limitInput: AuthRateLimitInput = { operation: "invitation_accept", email: input.token, ipAddress: request.ip };
    const currentLimit = authAttemptLimiter.check(limitInput);
    if (!currentLimit.allowed) {
      reply.header("retry-after", String(currentLimit.retryAfterSeconds));
      return reply.code(429).send({ code: "AUTH_RATE_LIMITED", message: "加入尝试过于频繁，请稍后再试", retry_after_seconds: currentLimit.retryAfterSeconds, trace_id: request.id });
    }
    const result = await authStore.acceptInvitation(input.token, input.email, input.password, { userAgent: headerValue(request, "user-agent"), ipAddress: request.ip });
    if (result.status !== "accepted") {
      const nextLimit = authAttemptLimiter.recordFailure(limitInput);
      if (!nextLimit.allowed) reply.header("retry-after", String(nextLimit.retryAfterSeconds));
      if (!nextLimit.allowed) return reply.code(429).send({ code: "AUTH_RATE_LIMITED", message: "加入尝试过于频繁，请稍后再试", retry_after_seconds: nextLimit.retryAfterSeconds, trace_id: request.id });
      const errors = {
        invalid: ["INVITATION_INVALID", "邀请码不存在或格式不正确", 400],
        expired: ["INVITATION_EXPIRED", "邀请码已经过期，请联系家庭所有者重新生成", 410],
        revoked: ["INVITATION_REVOKED", "邀请码已被撤销，请联系家庭所有者", 410],
        used: ["INVITATION_USED", "邀请码已经被使用，请联系家庭所有者重新生成", 409],
        email_registered: ["ACCOUNT_ALREADY_HAS_HOUSEHOLD", "该账号已经属于一个家庭，不能加入第二个家庭", 409],
      } as const;
      const [code, message, statusCode] = errors[result.status];
      return reply.code(statusCode).send({ code, message, trace_id: request.id });
    }
    authAttemptLimiter.recordSuccess(limitInput);
    setSessionCookie(reply, result.token);
    return reply.code(201).send(result.session.identity);
  });

  app.post("/api/auth/logout", async (request, reply) => {
    if (authStore) await authStore.revokeSession(cookieValue(request, sessionCookieName()) ?? "");
    setSessionCookie(reply, null);
    return { ok: true };
  });

  app.get("/api/me", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const session = requestSessions.get(request);
    if (!session) return reply.code(503).send({ code: "IDENTITY_NOT_CONFIGURED", message: "当前服务未配置可返回身份详情的会话服务" });
    return session.identity;
  });

  app.get("/api/finance/overview", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const query = overviewQuerySchema.parse(request.query);
    if (query.end < query.start) throw new DomainError("BAD_REQUEST", "财务周期结束日期不能早于开始日期");
    return repository.getOverview(query.start, query.end, query.granularity);
  });

  app.get("/api/finance/accounts", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    return { accounts: await repository.listAccounts() };
  });

  app.post("/api/finance/accounts", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = createAccountSchema.parse(request.body);
    const account = await repository.createAccount({ name: input.name, accountType: input.account_type as FinanceAccount["account_type"], currency: input.currency, openingBalance: input.opening_balance });
    return reply.code(201).send(account);
  });

  app.patch<{ Params: { accountId: string } }>("/api/finance/accounts/:accountId", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = updateAccountSchema.parse(request.body);
    return repository.updateAccount(request.params.accountId, { name: input.name, accountType: input.account_type as FinanceAccount["account_type"] });
  });

  app.post<{ Params: { accountId: string } }>("/api/finance/accounts/:accountId/archive", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    return repository.archiveAccount(request.params.accountId);
  });

  app.get("/api/finance/categories", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const query = z.object({ direction: z.enum(["income", "expense", "transfer"]).optional(), include_archived: z.coerce.boolean().default(false) }).parse(request.query);
    return { categories: await repository.listCategories(query.direction, query.include_archived) };
  });

  app.post("/api/finance/categories", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = categorySchema.parse(request.body);
    return reply.code(201).send(await repository.createCategory({ name: input.name, directionScope: input.direction_scope as FinanceCategory["direction_scope"], colorToken: input.color_token }));
  });

  app.patch<{ Params: { categoryId: string } }>("/api/finance/categories/:categoryId", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = categorySchema.parse(request.body);
    return repository.updateCategory(request.params.categoryId, { name: input.name, directionScope: input.direction_scope as FinanceCategory["direction_scope"], colorToken: input.color_token });
  });

  app.post<{ Params: { categoryId: string } }>("/api/finance/categories/:categoryId/archive", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    return repository.archiveCategory(request.params.categoryId);
  });

  app.get("/api/finance/budgets", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const query = z.object({ start: z.string().date(), end: z.string().date(), include_archived: z.coerce.boolean().default(false) }).parse(request.query);
    if (query.end < query.start) throw new DomainError("BAD_REQUEST", "预算周期结束日期不能早于开始日期");
    return { budgets: await repository.listBudgets(query.start, query.end, query.include_archived) };
  });

  app.post("/api/finance/budgets", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = budgetSchema.parse(request.body);
    return reply.code(201).send(await repository.createBudget({ categoryId: input.category_id, name: input.name, cycle: input.cycle as FinanceBudget["cycle"], amount: input.amount, currency: input.currency, periodStart: input.period_start, periodEnd: input.period_end }));
  });

  app.get("/api/finance/permissions", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    return { permissions: await repository.listFinancePermissions() };
  });

  app.patch<{ Params: { userId: string } }>("/api/finance/permissions/:userId", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = financePermissionSchema.parse(request.body);
    return repository.updateFinancePermission(request.params.userId, input);
  });

  app.post<{ Params: { userId: string } }>("/api/finance/permissions/:userId/revoke", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    return repository.revokeFinancePermission(request.params.userId);
  });

  app.get("/api/finance/audit", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const query = financeAuditQuerySchema.parse(request.query);
    return { entries: await repository.listFinanceAudit(query.limit) };
  });

  app.post("/api/finance/exports", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = financeExportSchema.parse(request.body);
    const job = await repository.enqueueFinanceExport({ start: input.start, end: input.end, format: input.format, idempotencyKey: headerValue(request, "idempotency-key") ?? undefined });
    if (job.status === "queued" && options.exportRunner) void options.exportRunner(scope, job.id);
    return reply.code(202).send({ ...job, download_url: job.status === "ready" ? `/api/finance/exports/${job.id}/download` : null });
  });

  app.get<{ Params: { exportId: string } }>("/api/finance/exports/:exportId", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const job = await repository.getFinanceExport(request.params.exportId);
    if (!job) throw new DomainError("NOT_FOUND", "导出任务不存在或不属于当前家庭", 404);
    return { ...job, download_url: job.status === "ready" ? `/api/finance/exports/${job.id}/download` : null };
  });

  app.get<{ Params: { exportId: string } }>("/api/finance/exports/:exportId/download", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const job = await repository.getFinanceExport(request.params.exportId);
    if (!job) throw new DomainError("NOT_FOUND", "导出任务不存在或不属于当前家庭", 404);
    if (job.status !== "ready") throw new DomainError("EXPORT_NOT_READY", "导出文件尚未准备好或已过期", 409);
    const objectKey = financeExportObjectKey(scope.householdId, job.id);
    const signedUrl = importObjectStore.signedGetUrl?.(objectKey, new Date(job.download_expires_at ?? Date.now()));
    if (signedUrl) return reply.redirect(signedUrl);
    const bytes = await importObjectStore.read(objectKey);
    return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="life-finance-${job.period_start}-${job.period_end}.csv"`).send(bytes);
  });

  app.get("/api/finance/ai/summary", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const query = z.object({ start: z.string().date(), end: z.string().date() }).parse(request.query);
    return repository.getFinanceAiSummary(query.start, query.end);
  });

  app.get("/api/finance/ai/connection", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    return { connection: await repository.getFinanceAiConnection() };
  });

  app.put("/api/finance/ai/connection", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = financeAiConnectionSchema.parse(request.body);
    return { connection: await repository.upsertFinanceAiConnection({ endpointUrl: input.endpoint_url, model: input.model, apiKeyRef: input.api_key_ref, status: input.status }) };
  });

  app.post("/api/finance/ai/connection/test", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    return { connection: await repository.testFinanceAiConnection() };
  });

  app.post<{ Params: { proposalId: string } }>("/api/finance/ai/proposals/:proposalId/decision", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = financeAiDecisionSchema.parse(request.body);
    return repository.decideFinanceAiProposal(request.params.proposalId, input.decision, input.expected_version);
  });

  app.post<{ Params: { proposalId: string } }>("/api/finance/ai/proposals/:proposalId/revoke", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    return repository.revokeFinanceAiProposal(request.params.proposalId);
  });

  app.patch<{ Params: { budgetId: string } }>("/api/finance/budgets/:budgetId", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = budgetSchema.parse(request.body);
    return repository.updateBudget(request.params.budgetId, { categoryId: input.category_id, name: input.name, cycle: input.cycle as FinanceBudget["cycle"], amount: input.amount, currency: input.currency, periodStart: input.period_start, periodEnd: input.period_end });
  });

  app.post<{ Params: { budgetId: string } }>("/api/finance/budgets/:budgetId/archive", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    return repository.archiveBudget(request.params.budgetId);
  });

  app.get("/api/finance/assets", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    return { assets: await repository.listAssets() };
  });

  app.post("/api/finance/assets", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = assetSchema.parse(request.body);
    return reply.code(201).send(await repository.createAsset({ name: input.name, assetType: input.asset_type }));
  });

  app.patch<{ Params: { assetId: string } }>("/api/finance/assets/:assetId", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = assetSchema.parse(request.body);
    return repository.updateAsset(request.params.assetId, { name: input.name, assetType: input.asset_type });
  });

  app.get<{ Params: { assetId: string } }>("/api/finance/assets/:assetId", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const asset = await repository.getAssetDetail(request.params.assetId);
    if (!asset) throw new DomainError("NOT_FOUND", "资产不存在或不属于当前家庭", 404);
    return asset;
  });

  app.post<{ Params: { assetId: string } }>("/api/finance/assets/:assetId/events", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = assetEventSchema.parse(request.body);
    return reply.code(201).send(await repository.createAssetEvent(request.params.assetId, { occurredAt: input.occurred_at, eventType: input.event_type as FinanceAssetEventType, amount: input.amount, recoveryAmount: input.recovery_amount, ledgerTransactionId: input.ledger_transaction_id ?? null }));
  });

  app.get("/api/finance/transactions", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const query = transactionListQuerySchema.parse(request.query);
    return repository.listTransactions({ page: query.page, pageSize: query.page_size, start: query.start, end: query.end, direction: query.direction, accountId: query.account_id, importBatchId: query.import_batch_id });
  });

  app.post("/api/finance/transactions", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = manualTransactionSchema.parse(request.body);
    const result = await repository.createManualTransaction({ ...input, idempotencyKey: headerValue(request, "idempotency-key") ?? undefined });
    return reply.code(201).send(result);
  });

  app.patch<{ Params: { transactionId: string } }>("/api/finance/transactions/:transactionId", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = manualTransactionSchema.parse(request.body);
    return repository.updateManualTransaction(request.params.transactionId, input);
  });

  app.post<{ Params: { transactionId: string } }>("/api/finance/transactions/:transactionId/void", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = voidTransactionSchema.parse(request.body);
    return repository.voidManualTransaction(request.params.transactionId, input.reason);
  });

  app.get("/api/family/topics", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.familyFactory?.(scope);
    if (!repository) return requireFamilyFactory(reply, options.familyFactory);
    return repository.getSpaceHome();
  });

  app.get("/api/family/members", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope); if (!scope) return;
    const repository = options.familyFactory?.(scope); if (!repository) return requireFamilyFactory(reply, options.familyFactory);
    return { members: await repository.listMembers() };
  });

  app.get("/api/family/invitations", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope); if (!scope) return;
    const repository = options.familyFactory?.(scope); if (!repository) return requireFamilyFactory(reply, options.familyFactory);
    return { invitations: await repository.listInvitations() };
  });

  app.post("/api/family/invitations", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope); if (!scope) return;
    const input = createInvitationSchema.parse(request.body);
    const repository = options.familyFactory?.(scope); if (!repository) return requireFamilyFactory(reply, options.familyFactory);
    return reply.code(201).send(await repository.createInvitation(input.role, input.expires_in_days));
  });

  app.delete<{ Params: { invitationId: string } }>("/api/family/invitations/:invitationId", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope); if (!scope) return;
    const invitationId = z.string().uuid().parse(request.params.invitationId);
    const repository = options.familyFactory?.(scope); if (!repository) return requireFamilyFactory(reply, options.familyFactory);
    return repository.revokeInvitation(invitationId);
  });

  app.patch<{ Params: { userId: string } }>("/api/family/members/:userId/role", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope); if (!scope) return;
    const userId = z.string().uuid().parse(request.params.userId);
    const input = memberRoleSchema.parse(request.body);
    const repository = options.familyFactory?.(scope); if (!repository) return requireFamilyFactory(reply, options.familyFactory);
    return repository.updateMemberRole(userId, input.role);
  });

  app.get<{ Params: { userId: string } }>("/api/family/members/:userId/sensitive-permissions", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope); if (!scope) return;
    const userId = z.string().uuid().parse(request.params.userId);
    const repository = options.familyFactory?.(scope); if (!repository) return requireFamilyFactory(reply, options.familyFactory);
    return repository.getSensitivePermissions(userId);
  });

  app.patch<{ Params: { userId: string } }>("/api/family/members/:userId/sensitive-permissions", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope); if (!scope) return;
    const userId = z.string().uuid().parse(request.params.userId);
    const input = sensitivePermissionSchema.parse(request.body);
    const repository = options.familyFactory?.(scope); if (!repository) return requireFamilyFactory(reply, options.familyFactory);
    return repository.updateSensitivePermission(userId, input.capability, input.enabled, input.expected_version);
  });

  app.get("/api/data-rights", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope); if (!scope) return;
    const repository = options.familyFactory?.(scope); if (!repository) return requireFamilyFactory(reply, options.familyFactory);
    return repository.getDataRights();
  });

  app.post("/api/data-rights/deletion-requests", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope); if (!scope) return;
    const input = deletionRequestSchema.parse(request.body);
    const repository = options.familyFactory?.(scope); if (!repository) return requireFamilyFactory(reply, options.familyFactory);
    return reply.code(201).send(await repository.scheduleDeletion(input.request_type));
  });

  app.post<{ Params: { requestId: string } }>("/api/data-rights/deletion-requests/:requestId/cancel", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope); if (!scope) return;
    const requestId = z.string().uuid().parse(request.params.requestId);
    const input = deletionCancelSchema.parse(request.body);
    const repository = options.familyFactory?.(scope); if (!repository) return requireFamilyFactory(reply, options.familyFactory);
    return repository.cancelDeletion(requestId, input.expected_version);
  });

  app.post("/api/family/topics", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.familyFactory?.(scope);
    if (!repository) return requireFamilyFactory(reply, options.familyFactory);
    const input = createTopicSchema.parse(request.body);
    return reply.code(201).send(await repository.createTopic({ topicType: input.topic_type as FamilyTopicType, title: input.title, body: input.body }));
  });

  app.get<{ Params: { topicId: string } }>("/api/family/topics/:topicId", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.familyFactory?.(scope);
    if (!repository) return requireFamilyFactory(reply, options.familyFactory);
    const topic = await repository.getTopic(request.params.topicId);
    if (!topic) throw new DomainError("NOT_FOUND", "主题不存在", 404);
    return topic;
  });

  app.post<{ Params: { topicId: string } }>("/api/family/topics/:topicId/comments", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.familyFactory?.(scope);
    if (!repository) return requireFamilyFactory(reply, options.familyFactory);
    const input = commentSchema.parse(request.body);
    return reply.code(201).send(await repository.createComment(request.params.topicId, input.body));
  });

  app.post<{ Params: { topicId: string } }>("/api/family/topics/:topicId/ai-summary", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.familyFactory?.(scope);
    if (!repository) return requireFamilyFactory(reply, options.familyFactory);
    return repository.summarizeTopic(request.params.topicId);
  });

  app.post<{ Params: { proposalId: string } }>("/api/ai/action-proposals/:proposalId/decision", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.familyFactory?.(scope);
    if (!repository) return requireFamilyFactory(reply, options.familyFactory);
    const input = aiActionDecisionSchema.parse(request.body);
    return repository.decideAction(request.params.proposalId, input.decision, input.expected_version);
  });

  app.get<{ Params: { filterId: string } }>("/api/finance/drilldowns/:filterId", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const query = pageQuerySchema.parse(request.query);
    const result = await repository.getDrilldown(request.params.filterId, query.page, query.page_size);
    if (!result) throw new DomainError("NOT_FOUND", "下钻过滤条件不存在或已过期", 404);
    return result;
  });

  app.get<{ Params: { transactionId: string } }>("/api/finance/transactions/:transactionId", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const result = await repository.getTransactionDetail(request.params.transactionId);
    if (!result) throw new DomainError("NOT_FOUND", "账单不存在或不属于当前家庭", 404);
    return result;
  });

  app.get("/api/finance/import-batches", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const query = pageQuerySchema.parse(request.query);
    return { batches: await repository.listImportBatches(query.page_size) };
  });

  app.post("/api/finance/import-batches", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = createImportBatchSchema.parse(request.body);
    const batch = await repository.createImportBatch({ sourceType: input.source_type as ImportSourceType, fileName: input.file_name, fileSize: input.file_size, fileSha256: input.file_sha256, objectKey: input.object_key, accountId: input.account_id });
    return reply.code(201).send(batch);
  });

  app.get<{ Params: { batchId: string } }>("/api/finance/import-batches/:batchId/errors", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const query = pageQuerySchema.parse(request.query);
    return { rows: await repository.listImportErrors(request.params.batchId, query.page_size) };
  });

  app.get<{ Params: { batchId: string } }>("/api/finance/import-batches/:batchId", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const batch = await repository.getImportBatch(request.params.batchId);
    if (!batch) throw new DomainError("NOT_FOUND", "导入批次不存在", 404);
    return batch;
  });

  app.post<{ Params: { batchId: string } }>("/api/finance/import-batches/:batchId/header-confirmation", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = headerSchema.parse(request.body);
    return repository.confirmHeader(request.params.batchId, { sheetName: input.sheet_name, headerRow: input.header_row, dataStartRow: input.data_start_row, dataEndRow: input.data_end_row });
  });

  app.post<{ Params: { batchId: string } }>("/api/finance/import-batches/:batchId/upload", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const body = Buffer.isBuffer(request.body) ? request.body : null;
    if (!body) throw new DomainError("BAD_REQUEST", "上传接口需要 application/octet-stream 文件内容", 400);
    const actualSha256 = createHash("sha256").update(body).digest("hex");
    const batch = await repository.getImportBatch(request.params.batchId);
    if (!batch) throw new DomainError("NOT_FOUND", "导入批次不存在", 404);
    if (batch.status === "uploaded") return batch;
    const objectKey = importObjectKey(scope.householdId, request.params.batchId);
    await importObjectStore.put(objectKey, body);
    try {
      return await repository.markImportBatchUploaded(request.params.batchId, { actualSha256, actualSize: body.byteLength });
    } catch (error) {
      await importObjectStore.remove(objectKey);
      throw error;
    }
  });

  app.post<{ Params: { batchId: string } }>("/api/finance/import-batches/:batchId/parse", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const batch = await repository.getImportBatch(request.params.batchId);
    if (!batch) throw new DomainError("NOT_FOUND", "导入批次不存在", 404);
    const job = await repository.enqueueImportParse(request.params.batchId);
    const runImport = options.importRunner;
    if (job.status === "queued" && runImport) setTimeout(() => { void runImport(scope, request.params.batchId, job.id); }, 0);
    const updated = await repository.getImportBatch(request.params.batchId);
    if (!updated) throw new DomainError("NOT_FOUND", "导入批次不存在", 404);
    return reply.code(202).send({ batch: updated, job });
  });

  app.get<{ Params: { jobId: string } }>("/api/finance/import-jobs/:jobId", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const job = await repository.getImportParseJob(request.params.jobId);
    if (!job) throw new DomainError("NOT_FOUND", "解析任务不存在或不属于当前家庭", 404);
    return job;
  });

  app.post<{ Params: { jobId: string } }>("/api/finance/import-jobs/:jobId/pause", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    return repository.pauseImportParseJob(request.params.jobId);
  });

  app.post<{ Params: { jobId: string } }>("/api/finance/import-jobs/:jobId/resume", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    return repository.resumeImportParseJob(request.params.jobId);
  });

  app.post<{ Params: { jobId: string } }>("/api/finance/import-jobs/:jobId/cancel", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    return repository.cancelImportParseJob(request.params.jobId);
  });

  app.post<{ Params: { jobId: string } }>("/api/finance/import-jobs/:jobId/retry", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    return repository.retryImportParseJob(request.params.jobId);
  });

  app.post<{ Params: { batchId: string } }>("/api/finance/import-batches/:batchId/mapping-confirmation", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = mappingSchema.parse(request.body);
    return repository.confirmMapping(request.params.batchId, { mapping: input.mapping, parserVersion: input.parser_version });
  });

  app.get<{ Params: { batchId: string } }>("/api/finance/import-batches/:batchId/reconciliation", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const query = pageQuerySchema.parse(request.query);
    return repository.getReconciliation(request.params.batchId, query.page, query.page_size);
  });

  app.post<{ Params: { batchId: string } }>("/api/finance/import-batches/:batchId/reconciliation/decisions", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = decisionSchema.parse(request.body);
    return repository.decideReconciliation(request.params.batchId, { candidateId: input.candidate_id, decision: input.decision, expectedVersion: input.expected_version, reason: input.reason });
  });

  app.post<{ Params: { batchId: string } }>("/api/finance/import-batches/:batchId/commit", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    const input = commitSchema.parse(request.body);
    return repository.commitImportBatch(request.params.batchId, { expectedVersion: input.expected_version, confirmSummaryHash: input.confirm_summary_hash, idempotencyKey: headerValue(request, "idempotency-key") ?? undefined });
  });

  app.post<{ Params: { batchId: string } }>("/api/finance/import-batches/:batchId/revoke", async (request, reply) => {
    const scope = requireScope(request, reply, resolveScope);
    if (!scope) return;
    const repository = options.financeFactory?.(scope);
    if (!repository) return requireFactory(reply, options.financeFactory);
    return repository.revokeImportBatch(request.params.batchId, headerValue(request, "idempotency-key") ?? undefined);
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl = process.env.DATABASE_URL;
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  const importObjectStore: ImportObjectStore = isProductionDeployment() ? createProductionCosObjectStoreFromEnv() : new LocalImportObjectStore();
  const authStore = pool ? new SqlAuthStore(pool as unknown as DbPool) : undefined;
  const importParser = new LocalFinanceImportParser(importObjectStore);
  const passwordResetDelivery = createPasswordResetDeliveryFromEnv();
  const app = buildServer({
    financeFactory: pool ? ((scope) => new SqlFinanceRepository(pool as unknown as DbPool, scope, importObjectStore)) : undefined,
    familyFactory: pool ? ((scope) => new SqlFamilyRepository(pool as unknown as DbPool, scope)) : undefined,
    authStore,
    passwordResetDelivery,
    importObjectStore,
    importParser,
    exportRunner: pool ? ((scope, jobId) => runFinanceExportJob(pool as unknown as DbPool, scope, importObjectStore, jobId)) : undefined,
  });
  await app.listen({ host: "127.0.0.1", port: Number(process.env.PORT ?? 3100) });
}
