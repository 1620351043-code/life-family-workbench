import { DomainError } from "./domain-error.js";
import { assertSensitivePermission, hasSensitivePermission } from "./sensitive-permissions.js";
import { createHash, randomUUID } from "node:crypto";
import { inTenantTransaction, type DbClient, type DbPool, type FinanceScope } from "./database.js";
import { aiMemoryObjectKey, importObjectKey, type ImportObjectStore } from "./import-storage.js";
import type { ParsedImportPreviewRow, ParsedImportResult } from "./finance-import-parser.js";
import { DeterministicFinanceAiProvider, OpenAiCompatibleFinanceAiProvider, type FinanceAiFacts, type FinanceAiProvider } from "./ai-gateway.js";

export type DrilldownType = "ledger_period" | "ledger_direction" | "budget_category" | "budget_category_group" | "asset_day" | "asset_period";
export type DrilldownRef = { type: DrilldownType; filter_id: string; filters: Record<string, string> };
export type Period = { start: string; end: string; timezone: string };
export type FinanceGranularity = "day" | "week" | "month" | "quarter";
export type FinanceSummaryCardKey = "net_asset" | "account_balance" | "income" | "expense" | "net_cash_flow";
export type FinanceAttentionItem = {
  key: "import_review" | "budget_overrun";
  label: string;
  detail: string;
  count: number;
  severity: "warning" | "danger";
  action: "import" | "budget";
  drilldown_ref: DrilldownRef | null;
};

export type FinanceOverview = {
  period: Period;
  granularity: FinanceGranularity;
  summary_cards: Array<{ key: FinanceSummaryCardKey; value: string; currency: string; drilldown_ref: DrilldownRef }>;
  account_balance_change: { amount: string; rate: string | null; comparison_label: string };
  attention_items: FinanceAttentionItem[];
  budget_center: { label: string; total_limit: string; total_used: string; progress: number; drilldown_ref: DrilldownRef };
  budget_rings: Array<{ category: string; category_id: string; label: string; limit: string; used: string; progress: number; color_token: string; drilldown_ref: DrilldownRef; group_drilldown_ref?: DrilldownRef }>;
  trend_container: { drilldown_ref: DrilldownRef };
  trend_points: Array<{ bucket: string; income: string; expense: string; net_cash_flow: string; drilldown_ref: DrilldownRef }>;
  asset_cost_container: { drilldown_ref: DrilldownRef };
  asset_cost_points: Array<{ bucket: string; purchase_cost: string; maintenance_cost: string; gross_cost: string; recovery: string; net_cash_cost: string; drilldown_ref: DrilldownRef }>;
  asset_total_points: Array<{ bucket: string; total_asset: string; drilldown_ref: DrilldownRef }>;
};

export type ImportSourceType = "bank" | "alipay" | "wechat" | "bookkeeping_app" | "other";
export type ImportStatus = "created" | "uploaded" | "scanning" | "header_detected" | "mapping_pending" | "normalized" | "matching" | "reconciliation_pending" | "confirmed" | "committed" | "failed" | "cancelled" | "revoked";
export type ImportBatch = {
  id: string;
  file_name: string;
  file_size: number;
  source_type: ImportSourceType;
  status: ImportStatus;
  version: number;
  detected_header_row: number | null;
  detected_sheet: string | null;
  raw_retention_until: string;
  counts: { rows: number; invalid?: number };
  field_mapping?: Record<string, string>;
  header_preview?: { sheets: Array<{ sheet_name: string | null; header_row: number | null; data_start_row: number | null; header_score: number; field_mapping: Record<string, string>; preview_rows: ParsedImportPreviewRow[]; skipped_rows: number; empty?: boolean }> };
};

export type CreateImportBatchInput = { sourceType: ImportSourceType; fileName: string; fileSize: number; fileSha256: string; objectKey: string };
export type HeaderConfirmationInput = { sheetName: string; headerRow: number; dataStartRow: number; dataEndRow?: number };
export type MappingConfirmationInput = { mapping: Record<string, string>; parserVersion: string };
export type ReconciliationDecisionInput = { candidateId: string; decision: "duplicate" | "parent_settlement" | "refund_reversal" | "fee_related" | "split" | "unrelated"; expectedVersion: number; reason?: string };
export type CommitImportInput = { expectedVersion: number; confirmSummaryHash: string; idempotencyKey?: string };
export type UploadImportInput = { actualSha256: string; actualSize: number };

export type FinanceDrilldown = {
  filter: DrilldownRef;
  items: unknown[];
  pagination: { page: number; page_size: number; total: number };
};

export type FinanceTransactionDetail = {
  id: string;
  occurred_at: string;
  direction: "income" | "expense" | "transfer";
  amount: string;
  currency: string;
  merchant: string;
  category: string;
  category_id: string | null;
  origin: "import" | "manual" | "system";
  status: "confirmed" | "pending_account" | "reversed" | "voided";
  note: string;
  source_count: number;
  entries: Array<{ account_id: string; amount: string; entry_side: "debit" | "credit" }>;
  source_records: Array<{ id: string; source_type: string; detail_level: "anchor" | "detail" | "original"; merchant_detail: string; order_reference: string }>;
  transaction_links: Array<{ id: string; link_type: string; status: string; confidence: number; reason_codes: string[] }>;
};

export type FinanceAccount = {
  id: string;
  name: string;
  account_type: "bank" | "cash" | "wallet" | "payment_platform" | "other";
  currency: string;
  opening_balance: string;
  balance: string;
  status: "active" | "archived";
};

export type FinanceCategory = {
  id: string;
  name: string;
  direction_scope: "income" | "expense" | "both";
  color_token: string;
  status: "active" | "archived";
};

export type FinanceBudget = {
  id: string;
  category_id: string;
  category_name: string;
  color_token: string;
  cycle: "month" | "quarter" | "year" | "custom";
  amount: string;
  currency: string;
  period_start: string;
  period_end: string;
  used: string;
  remaining: string;
  progress: number;
  status: "active" | "archived";
};

export type FinanceAssetEventType = "purchase" | "maintenance" | "consumable" | "upgrade" | "transfer" | "sale" | "disposal";
export type FinanceAsset = {
  id: string;
  name: string;
  asset_type: string;
  status: "held" | "transferred" | "sold" | "disposed";
  event_count: number;
  gross_cost: string;
  recovery: string;
  net_cash_cost: string;
  last_event_at: string | null;
};
export type FinanceAssetEvent = {
  id: string;
  asset_id: string;
  occurred_at: string;
  event_type: FinanceAssetEventType;
  amount: string;
  recovery_amount: string;
  ledger_transaction_id: string | null;
};
export type FinanceAssetDetail = FinanceAsset & { events: FinanceAssetEvent[] };
export type FinancePermissionAction = "view" | "bookkeep" | "edit" | "import" | "reconcile" | "export";
export type FinancePermission = {
  user_id: string;
  email: string;
  role: "owner" | "adult" | "child" | "guest";
  can_view: boolean;
  can_bookkeep: boolean;
  can_edit: boolean;
  can_import: boolean;
  can_reconcile: boolean;
  can_export: boolean;
  explicit: boolean;
  granted_at: string | null;
  revoked_at: string | null;
};
export type FinancePermissionInput = Pick<FinancePermission, "can_view" | "can_bookkeep" | "can_edit" | "can_import" | "can_reconcile" | "can_export">;
export type FinanceAuditEntry = {
  id: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before_summary: unknown;
  after_summary: unknown;
  trace_id: string;
  created_at: string;
};
export type FinanceExportJob = {
  id: string;
  format: "csv";
  period_start: string;
  period_end: string;
  status: "queued" | "running" | "ready" | "failed" | "expired" | "cancelled";
  row_count: number;
  download_expires_at: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
};
export type FinanceAiConnection = {
  provider: "openai_compatible";
  endpoint_url: string;
  model: string;
  api_key_ref: string;
  status: "active" | "disabled" | "error";
  last_tested_at: string | null;
  last_error: string | null;
};
export type FinanceAiSourceRef = { kind: "transaction" | "source_record" | "budget" | "asset_event" | "period"; id: string; label: string; drilldown_ref: DrilldownRef };
export type FinanceAiProposal = {
  id: string;
  action_type: "finance_review";
  status: "proposed" | "confirmed" | "rejected" | "revoked" | "expired";
  version: number;
  payload: Record<string, unknown>;
};
export type FinanceAiSummary = {
  insight: {
    id: string;
    insight_type: "finance_summary";
    summary: string;
    key_points: string[];
    explanations: string[];
    source_refs: FinanceAiSourceRef[];
    provider: string;
    model: string | null;
    created_at: string;
  };
  proposal: FinanceAiProposal;
};

export type ManualTransactionInput = {
  direction: "income" | "expense" | "transfer";
  occurred_at: string;
  amount: string;
  currency: string;
  account_id: string;
  to_account_id?: string | null;
  category_id?: string | null;
  merchant?: string | null;
  note?: string | null;
  idempotencyKey?: string;
};

export type FinanceTransactionListItem = {
  id: string;
  occurred_at: string;
  direction: "income" | "expense" | "transfer";
  amount: string;
  currency: string;
  merchant: string;
  category: string;
  origin: "import" | "manual" | "system";
  status: "confirmed" | "pending_account" | "reversed" | "voided";
};

export type FinanceTransactionList = {
  items: FinanceTransactionListItem[];
  pagination: { page: number; page_size: number; total: number };
};

export type ReconciliationCandidate = {
  id: string;
  recommended_link_type: string;
  status: string;
  confidence: number;
  reason_codes: string[];
  records: Array<{ id: string; source_type: string; occurred_at: string; direction: string; amount: string; merchant_detail?: string }>;
};

export type ReconciliationResponse = {
  batch_id: string;
  candidates: ReconciliationCandidate[];
  pagination: { page: number; page_size: number; total: number };
};

export type CommitImportResponse = { batch: ImportBatch; inserted_transactions: number; linked_records: number; pending_records: number; failed_records: number };
export type ImportErrorRow = { row_number: number; status: string; error_codes: string[]; normalized_payload: Record<string, unknown> };

export interface FinanceRepository {
  getOverview(start: string, end: string, granularity: string): Promise<FinanceOverview>;
  getDrilldown(filterId: string, page: number, pageSize: number): Promise<FinanceDrilldown | null>;
  getTransactionDetail(transactionId: string): Promise<FinanceTransactionDetail | null>;
  listAccounts(): Promise<FinanceAccount[]>;
  createAccount(input: { name: string; accountType: FinanceAccount["account_type"]; currency: string; openingBalance: string }): Promise<FinanceAccount>;
  updateAccount(accountId: string, input: { name: string; accountType: FinanceAccount["account_type"] }): Promise<FinanceAccount>;
  archiveAccount(accountId: string): Promise<{ account_id: string }>;
  listCategories(direction?: "income" | "expense" | "transfer", includeArchived?: boolean): Promise<FinanceCategory[]>;
  createCategory(input: { name: string; directionScope: FinanceCategory["direction_scope"]; colorToken: string }): Promise<FinanceCategory>;
  updateCategory(categoryId: string, input: { name: string; directionScope: FinanceCategory["direction_scope"]; colorToken: string }): Promise<FinanceCategory>;
  archiveCategory(categoryId: string): Promise<{ category_id: string }>;
  listBudgets(start: string, end: string, includeArchived?: boolean): Promise<FinanceBudget[]>;
  createBudget(input: { categoryId: string; name: string; cycle: FinanceBudget["cycle"]; amount: string; currency: string; periodStart: string; periodEnd: string }): Promise<FinanceBudget>;
  updateBudget(budgetId: string, input: { categoryId: string; name: string; cycle: FinanceBudget["cycle"]; amount: string; currency: string; periodStart: string; periodEnd: string }): Promise<FinanceBudget>;
  archiveBudget(budgetId: string): Promise<{ budget_id: string }>;
  listAssets(): Promise<FinanceAsset[]>;
  createAsset(input: { name: string; assetType: string }): Promise<FinanceAssetDetail>;
  updateAsset(assetId: string, input: { name: string; assetType: string }): Promise<FinanceAsset>;
  getAssetDetail(assetId: string): Promise<FinanceAssetDetail | null>;
  createAssetEvent(assetId: string, input: { occurredAt: string; eventType: FinanceAssetEventType; amount: string; recoveryAmount: string; ledgerTransactionId?: string | null }): Promise<FinanceAssetEvent>;
  listFinancePermissions(): Promise<FinancePermission[]>;
  updateFinancePermission(userId: string, input: FinancePermissionInput): Promise<FinancePermission>;
  revokeFinancePermission(userId: string): Promise<{ user_id: string }>;
  listFinanceAudit(limit?: number): Promise<FinanceAuditEntry[]>;
  enqueueFinanceExport(input: { start: string; end: string; format: "csv"; idempotencyKey?: string }): Promise<FinanceExportJob>;
  getFinanceExport(jobId: string): Promise<FinanceExportJob | null>;
  getFinanceAiConnection(): Promise<FinanceAiConnection | null>;
  upsertFinanceAiConnection(input: { endpointUrl: string; model: string; apiKeyRef: string; status: "active" | "disabled" }): Promise<FinanceAiConnection>;
  testFinanceAiConnection(): Promise<FinanceAiConnection>;
  getFinanceAiSummary(start: string, end: string): Promise<FinanceAiSummary>;
  decideFinanceAiProposal(proposalId: string, decision: "confirm" | "reject", expectedVersion: number): Promise<{ proposal: FinanceAiProposal; execution: { formal_ledger_mutation: false } | null }>;
  revokeFinanceAiProposal(proposalId: string): Promise<{ proposal: FinanceAiProposal }>;
  createManualTransaction(input: ManualTransactionInput): Promise<{ transaction_id: string }>;
  listTransactions(input: { page: number; pageSize: number; start?: string; end?: string; direction?: "income" | "expense" | "transfer"; accountId?: string; importBatchId?: string }): Promise<FinanceTransactionList>;
  updateManualTransaction(transactionId: string, input: ManualTransactionInput): Promise<{ transaction_id: string }>;
  voidManualTransaction(transactionId: string, reason: string): Promise<{ transaction_id: string }>;
  createImportBatch(input: CreateImportBatchInput): Promise<ImportBatch>;
  markImportBatchUploaded(batchId: string, input: UploadImportInput): Promise<ImportBatch>;
  getImportBatch(batchId: string): Promise<ImportBatch | null>;
  listImportBatches(limit?: number): Promise<ImportBatch[]>;
  listImportErrors(batchId: string, limit?: number): Promise<ImportErrorRow[]>;
  confirmHeader(batchId: string, input: HeaderConfirmationInput): Promise<ImportBatch>;
  stageParsedImport(batchId: string, parsed: ParsedImportResult): Promise<ImportBatch>;
  confirmMapping(batchId: string, input: MappingConfirmationInput): Promise<ImportBatch>;
  getReconciliation(batchId: string, page: number, pageSize: number): Promise<ReconciliationResponse>;
  decideReconciliation(batchId: string, input: ReconciliationDecisionInput): Promise<ReconciliationCandidate>;
  commitImportBatch(batchId: string, input: CommitImportInput): Promise<CommitImportResponse>;
  revokeImportBatch(batchId: string, idempotencyKey?: string): Promise<ImportBatch>;
}

type BatchRow = {
  id: string;
  file_name: string;
  file_size: number;
  source_type: ImportSourceType;
  status: ImportStatus;
  version: number;
  detected_header_row: number | null;
  detected_sheet: string | null;
  raw_retention_until: string;
  row_count: number;
  invalid_row_count: number;
  field_mapping: Record<string, string>;
  header_preview: ImportBatch["header_preview"];
};

type FilterRow = { id: string; filter_type: DrilldownType; filters: Record<string, string> };

function asMoney(value: unknown): string {
  if (value === null || value === undefined || value === "") return "0";
  return String(value);
}

function asNumber(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function asJsonObject(value: unknown): Record<string, string> {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, string>;
    } catch (_) {
      return {};
    }
  }
  return (value ?? {}) as Record<string, string>;
}

function nullableText(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function requireRow<Row extends Record<string, unknown>>(rows: Row[], code: string, message: string): Row {
  const row = rows[0];
  if (!row) throw new DomainError(code, message, code === "NOT_FOUND" || code.endsWith("_NOT_FOUND") ? 404 : 409);
  return row;
}

function positiveMoney(value: string, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,4})?$/.test(normalized) || Number(normalized) <= 0) {
    throw new DomainError("INVALID_AMOUNT", `${field}必须是大于 0 的金额`, 400);
  }
  return normalized;
}

function nonNegativeMoney(value: string, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,4})?$/.test(normalized) || Number(normalized) < 0) {
    throw new DomainError("INVALID_AMOUNT", `${field}必须是大于等于 0 的金额`, 400);
  }
  return normalized;
}

function safeCurrency(value: string): string {
  const normalized = String(value ?? "CNY").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) throw new DomainError("INVALID_CURRENCY", "币种必须是三位字母代码", 400);
  return normalized;
}

function safeDateTime(value: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || Number.isNaN(new Date(normalized).valueOf())) throw new DomainError("INVALID_OCCURRED_AT", "交易时间格式不正确", 400);
  return normalized;
}

function normalizeFinanceGranularity(value: string): { value: FinanceGranularity; dateTruncUnit: "day" | "week" | "month" | "quarter"; step: string } {
  if (value === "week") return { value: "week", dateTruncUnit: "week", step: "1 week" };
  if (value === "month") return { value: "month", dateTruncUnit: "month", step: "1 month" };
  if (value === "quarter") return { value: "quarter", dateTruncUnit: "quarter", step: "3 months" };
  return { value: "day", dateTruncUnit: "day", step: "1 day" };
}

function defaultFinancePermission(role: string): FinancePermissionInput {
  const allowed = role === "owner" || role === "adult";
  return { can_view: allowed, can_bookkeep: allowed, can_edit: allowed, can_import: allowed, can_reconcile: allowed, can_export: allowed };
}

async function getMemberRole(client: DbClient, scope: FinanceScope): Promise<string> {
  const result = await client.query<{ role: string; status: string }>(
    `SELECT role, status
       FROM household_member
      WHERE household_id = $1 AND user_id = $2`,
    [scope.householdId, scope.userId],
  );
  const member = result.rows[0];
  if (!member || member.status !== "active") throw new DomainError("FINANCE_PERMISSION_DENIED", "当前成员没有当前家庭财务权限", 403);
  return member.role;
}

async function assertFinancialPermission(client: DbClient, scope: FinanceScope, action: FinancePermissionAction): Promise<void> {
  const role = await getMemberRole(client, scope);
  const defaults = defaultFinancePermission(role);
  if (role === "owner") return;
  const result = await client.query<Record<string, unknown>>(
    `SELECT can_view, can_bookkeep, can_edit, can_import, can_reconcile, can_export
       FROM financial_permission
      WHERE household_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [scope.householdId, scope.userId],
  );
  const row = result.rows[0];
  const allowed = row ? Boolean(row[`can_${action}`]) : defaults[`can_${action}`];
  if (!allowed) throw new DomainError("FINANCE_PERMISSION_DENIED", "当前成员没有这项财务权限", 403);
}

async function assertFinanceOwner(client: DbClient, scope: FinanceScope): Promise<void> {
  const role = await getMemberRole(client, scope);
  if (role !== "owner") throw new DomainError("FINANCE_OWNER_REQUIRED", "只有家庭所有者可以管理财务权限和审计", 403);
}

async function writeFinanceAudit(
  client: DbClient,
  scope: FinanceScope,
  action: string,
  resourceType: string,
  resourceId: string,
  beforeSummary: Record<string, unknown> | null,
  afterSummary: Record<string, unknown> | null,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (id, household_id, actor_id, actor_type, action, resource_type, resource_id, before_summary, after_summary, trace_id)
     VALUES ($1, $2, $3, 'user', $4, $5, $6, $7::jsonb, $8::jsonb, $9)`,
    [randomUUID(), scope.householdId, scope.userId, action, resourceType, resourceId, JSON.stringify(beforeSummary), JSON.stringify(afterSummary), randomUUID()],
  );
}

async function getActiveAccount(client: DbClient, scope: FinanceScope, accountId: string): Promise<{ id: string; name: string; currency: string }> {
  const result = await client.query<{ id: string; name: string; currency: string }>(
    `SELECT id::text AS id, name, currency
       FROM financial_account
      WHERE household_id = $1 AND id = $2 AND status = 'active'`,
    [scope.householdId, accountId],
  );
  return requireRow(result.rows, "ACCOUNT_NOT_FOUND", "账户不存在或已归档");
}

async function getCategoryForTransaction(
  client: DbClient,
  scope: FinanceScope,
  categoryId: string | null | undefined,
  direction: "income" | "expense" | "transfer",
): Promise<{ id: string | null; name: string | null }> {
  if (!categoryId) return { id: null, name: null };
  if (direction === "transfer") throw new DomainError("TRANSFER_CATEGORY_INVALID", "转账不能绑定收支分类", 400);
  const result = await client.query<{ id: string; name: string; direction_scope: string }>(
    `SELECT id::text AS id, name, direction_scope
       FROM category
      WHERE household_id = $1 AND id = $2 AND status = 'active'`,
    [scope.householdId, categoryId],
  );
  const category = requireRow(result.rows, "CATEGORY_NOT_FOUND", "分类不存在");
  if (category.direction_scope !== "both" && category.direction_scope !== direction) {
    throw new DomainError("CATEGORY_DIRECTION_INVALID", "该分类不适用于当前收支方向", 400);
  }
  return { id: category.id, name: category.name };
}

async function insertLedgerEntries(
  client: DbClient,
  scope: FinanceScope,
  transactionId: string,
  input: { direction: "income" | "expense" | "transfer"; amount: string; accountId: string; toAccountId?: string | null },
): Promise<void> {
  const amount = positiveMoney(input.amount, "金额");
  if (input.direction === "transfer") {
    if (!input.toAccountId || input.accountId === input.toAccountId) throw new DomainError("TRANSFER_ACCOUNT_INVALID", "转账必须选择两个不同账户", 400);
    await getActiveAccount(client, scope, input.toAccountId);
    await client.query(
      `INSERT INTO ledger_entry (id, household_id, ledger_transaction_id, account_id, amount, entry_side)
       VALUES ($1, $2, $3, $4, $5, 'credit'), ($6, $2, $3, $7, $5, 'debit')`,
      [randomUUID(), scope.householdId, transactionId, input.accountId, amount, randomUUID(), input.toAccountId],
    );
    return;
  }
  await client.query(
    `INSERT INTO ledger_entry (id, household_id, ledger_transaction_id, account_id, amount, entry_side)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), scope.householdId, transactionId, input.accountId, amount, input.direction === "income" ? "debit" : "credit"],
  );
}

function batchSelectSql() {
  return `
    SELECT ib.id::text AS id,
           ib.file_name,
           COALESCE(ib.file_size, 0)::int AS file_size,
           fs.source_type,
           ib.status,
           ib.version,
           ib.detected_header_row,
           ib.detected_sheet,
           ib.raw_retention_until::text AS raw_retention_until,
           (SELECT COUNT(*)::int FROM import_row ir WHERE ir.household_id = ib.household_id AND ir.import_batch_id = ib.id) AS row_count,
           (SELECT COUNT(*)::int FROM import_row ir WHERE ir.household_id = ib.household_id AND ir.import_batch_id = ib.id AND ir.status = 'invalid') AS invalid_row_count,
           ib.field_mapping,
           ib.header_preview
      FROM import_batch ib
      JOIN financial_source fs ON fs.household_id = ib.household_id AND fs.id = ib.source_id
     WHERE ib.household_id = $1 AND ib.id = $2
  `;
}

function batchListSelectSql() {
  return `
    SELECT ib.id::text AS id,
           ib.file_name,
           COALESCE(ib.file_size, 0)::int AS file_size,
           fs.source_type,
           ib.status,
           ib.version,
           ib.detected_header_row,
           ib.detected_sheet,
           ib.raw_retention_until::text AS raw_retention_until,
           (SELECT COUNT(*)::int FROM import_row ir WHERE ir.household_id = ib.household_id AND ir.import_batch_id = ib.id) AS row_count,
           (SELECT COUNT(*)::int FROM import_row ir WHERE ir.household_id = ib.household_id AND ir.import_batch_id = ib.id AND ir.status = 'invalid') AS invalid_row_count,
           ib.field_mapping,
           ib.header_preview
      FROM import_batch ib
      JOIN financial_source fs ON fs.household_id = ib.household_id AND fs.id = ib.source_id
     WHERE ib.household_id = $1
     ORDER BY ib.created_at DESC
     LIMIT $2
  `;
}

function mapBatch(row: BatchRow): ImportBatch {
  return {
    id: row.id,
    file_name: row.file_name,
    file_size: Number(row.file_size ?? 0),
    source_type: row.source_type,
    status: row.status,
    version: Number(row.version),
    detected_header_row: row.detected_header_row,
    detected_sheet: row.detected_sheet,
    raw_retention_until: row.raw_retention_until,
    counts: { rows: Number(row.row_count ?? 0), invalid: Number(row.invalid_row_count ?? 0) },
    field_mapping: row.field_mapping ?? {},
    header_preview: row.header_preview ?? { sheets: [] },
  };
}

function mapFinanceExportJob(row: Record<string, unknown>): FinanceExportJob {
  return {
    id: String(row.id),
    format: "csv",
    period_start: String(row.period_start),
    period_end: String(row.period_end),
    status: String(row.status) as FinanceExportJob["status"],
    row_count: Number(row.row_count ?? 0),
    download_expires_at: row.download_expires_at ? String(row.download_expires_at) : null,
    error_code: row.error_code ? String(row.error_code) : null,
    error_message: row.error_message ? String(row.error_message) : null,
    created_at: String(row.created_at),
    completed_at: row.completed_at ? String(row.completed_at) : null,
  };
}

function mapFinanceAiConnection(row: Record<string, unknown>): FinanceAiConnection {
  return {
    provider: "openai_compatible",
    endpoint_url: String(row.endpoint_url),
    model: String(row.model),
    api_key_ref: String(row.api_key_ref),
    status: String(row.status) as FinanceAiConnection["status"],
    last_tested_at: row.last_tested_at ? String(row.last_tested_at) : null,
    last_error: row.last_error ? String(row.last_error) : null,
  };
}

function resolveHouseholdAiSecret(apiKeyRef: string): string | null {
  const envName = `LIFE_AI_SECRET_${apiKeyRef.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()}`;
  const direct = process.env[envName]?.trim();
  if (direct) return direct;
  const mapText = process.env.LIFE_AI_SECRET_MAP?.trim();
  if (!mapText) return null;
  try {
    const map = JSON.parse(mapText) as Record<string, unknown>;
    const value = map[apiKeyRef];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

async function insertFilter(client: DbClient, scope: FinanceScope, filterType: DrilldownType, filters: Record<string, string>): Promise<DrilldownRef> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO finance_drilldown_filter (id, household_id, filter_type, filters, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id::text AS id`,
    [randomUUID(), scope.householdId, filterType, JSON.stringify(filters), scope.userId],
  );
  const row = requireRow(result.rows, "FILTER_CREATE_FAILED", "无法创建财务下钻过滤条件");
  return { type: filterType, filter_id: row.id, filters };
}

export class SqlFinanceRepository implements FinanceRepository {
  constructor(private readonly pool: DbPool, private readonly scope: FinanceScope, private readonly aiMemoryStore?: ImportObjectStore) {}

  async listAccounts(): Promise<FinanceAccount[]> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "view");
      const result = await client.query<FinanceAccount>(
        `SELECT fa.id::text AS id, fa.name, fa.account_type, fa.currency,
                fa.opening_balance::text AS opening_balance, fa.status,
                (fa.opening_balance + COALESCE(SUM(
                  CASE WHEN lt.status = 'confirmed' AND le.entry_side = 'debit' THEN le.amount
                       WHEN lt.status = 'confirmed' AND le.entry_side = 'credit' THEN -le.amount
                       ELSE 0 END
                ), 0))::text AS balance
           FROM financial_account fa
           LEFT JOIN ledger_entry le
             ON le.household_id = fa.household_id AND le.account_id = fa.id
           LEFT JOIN ledger_transaction lt
             ON lt.household_id = le.household_id AND lt.id = le.ledger_transaction_id
          WHERE fa.household_id = $1 AND fa.status = 'active'
          GROUP BY fa.id
          ORDER BY fa.created_at, fa.name`,
        [this.scope.householdId],
      );
      return result.rows.map((row) => ({ ...row, id: String(row.id), opening_balance: String(row.opening_balance), balance: String(row.balance), status: row.status as FinanceAccount["status"], account_type: row.account_type as FinanceAccount["account_type"] }));
    });
  }

  async createAccount(input: { name: string; accountType: FinanceAccount["account_type"]; currency: string; openingBalance: string }): Promise<FinanceAccount> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "edit");
      const name = String(input.name ?? "").trim();
      if (!name || name.length > 80) throw new DomainError("INVALID_ACCOUNT_NAME", "账户名称不能为空且不能超过 80 个字符", 400);
      const openingBalance = String(input.openingBalance ?? "0").trim();
      if (!/^\d+(?:\.\d{1,4})?$/.test(openingBalance) || Number(openingBalance) < 0) throw new DomainError("INVALID_OPENING_BALANCE", "期初余额不能为负数", 400);
      const currency = safeCurrency(input.currency);
      const exists = await client.query(`SELECT 1 FROM financial_account WHERE household_id = $1 AND name = $2`, [this.scope.householdId, name]);
      if (exists.rows[0]) throw new DomainError("ACCOUNT_ALREADY_EXISTS", "同名账户已存在", 409);
      const id = randomUUID();
      const result = await client.query<FinanceAccount>(
        `INSERT INTO financial_account (id, household_id, name, account_type, currency, opening_balance)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id::text AS id, name, account_type, currency, opening_balance::text AS opening_balance, status, opening_balance::text AS balance`,
        [id, this.scope.householdId, name, input.accountType, currency, openingBalance],
      );
      const account = requireRow(result.rows, "ACCOUNT_CREATE_FAILED", "账户创建失败");
      await writeFinanceAudit(client, this.scope, "finance_account_created", "financial_account", id, null, { name, account_type: input.accountType, currency, opening_balance: openingBalance });
      return { ...account, account_type: account.account_type as FinanceAccount["account_type"], status: account.status as FinanceAccount["status"] };
    });
  }

  async updateAccount(accountId: string, input: { name: string; accountType: FinanceAccount["account_type"] }): Promise<FinanceAccount> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "edit");
      const name = String(input.name ?? "").trim();
      if (!name || name.length > 80) throw new DomainError("INVALID_ACCOUNT_NAME", "账户名称不能为空且不能超过 80 个字符", 400);
      const current = await client.query<Record<string, unknown>>(
        `SELECT id::text AS id, name, account_type, currency, opening_balance::text AS opening_balance, status
           FROM financial_account WHERE household_id = $1 AND id = $2 FOR UPDATE`,
        [this.scope.householdId, accountId],
      );
      const row = requireRow(current.rows, "ACCOUNT_NOT_FOUND", "账户不存在或不属于当前家庭");
      if (row.status !== "active") throw new DomainError("ACCOUNT_ARCHIVED", "已归档账户不能编辑", 409);
      const duplicate = await client.query(`SELECT 1 FROM financial_account WHERE household_id = $1 AND name = $2 AND id <> $3`, [this.scope.householdId, name, accountId]);
      if (duplicate.rows[0]) throw new DomainError("ACCOUNT_ALREADY_EXISTS", "同名账户已存在", 409);
      const result = await client.query<FinanceAccount>(
        `UPDATE financial_account SET name = $3, account_type = $4, updated_at = now()
          WHERE household_id = $1 AND id = $2
          RETURNING id::text AS id, name, account_type, currency, opening_balance::text AS opening_balance, status, opening_balance::text AS balance`,
        [this.scope.householdId, accountId, name, input.accountType],
      );
      const account = requireRow(result.rows, "ACCOUNT_UPDATE_FAILED", "账户更新失败");
      await writeFinanceAudit(client, this.scope, "finance_account_updated", "financial_account", accountId, { name: row.name, account_type: row.account_type }, { name, account_type: input.accountType });
      return { ...account, account_type: account.account_type as FinanceAccount["account_type"], status: account.status as FinanceAccount["status"] };
    });
  }

  async archiveAccount(accountId: string): Promise<{ account_id: string }> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "edit");
      const current = await client.query<Record<string, unknown>>(`SELECT id::text AS id, name, status FROM financial_account WHERE household_id = $1 AND id = $2 FOR UPDATE`, [this.scope.householdId, accountId]);
      const row = requireRow(current.rows, "ACCOUNT_NOT_FOUND", "账户不存在或不属于当前家庭");
      if (row.status === "archived") return { account_id: accountId };
      await client.query(`UPDATE financial_account SET status = 'archived', updated_at = now() WHERE household_id = $1 AND id = $2`, [this.scope.householdId, accountId]);
      await writeFinanceAudit(client, this.scope, "finance_account_archived", "financial_account", accountId, { name: row.name, status: row.status }, { status: "archived" });
      return { account_id: accountId };
    });
  }

  async listCategories(direction?: "income" | "expense" | "transfer", includeArchived = false): Promise<FinanceCategory[]> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "view");
      const scope = direction === "transfer" ? null : direction ?? null;
      const result = await client.query<FinanceCategory>(
        `SELECT id::text AS id, name, direction_scope, color_token, status
           FROM category
          WHERE household_id = $1 AND ($2::text IS NULL OR direction_scope IN ($2, 'both'))
            AND ($3::boolean OR status = 'active')
          ORDER BY name`,
        [this.scope.householdId, scope, includeArchived],
      );
      return result.rows.map((row) => ({ ...row, direction_scope: row.direction_scope as FinanceCategory["direction_scope"], status: row.status as FinanceCategory["status"] }));
    });
  }

  async createCategory(input: { name: string; directionScope: FinanceCategory["direction_scope"]; colorToken: string }): Promise<FinanceCategory> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "edit");
      const name = String(input.name ?? "").trim();
      const colorToken = String(input.colorToken ?? "violet").trim().slice(0, 32) || "violet";
      if (!name || name.length > 40) throw new DomainError("INVALID_CATEGORY_NAME", "分类名称不能为空且不能超过 40 个字符", 400);
      const duplicate = await client.query(`SELECT 1 FROM category WHERE household_id = $1 AND name = $2`, [this.scope.householdId, name]);
      if (duplicate.rows[0]) throw new DomainError("CATEGORY_ALREADY_EXISTS", "同名分类已存在", 409);
      const id = randomUUID();
      const result = await client.query<FinanceCategory>(
        `INSERT INTO category (id, household_id, name, direction_scope, color_token, status)
         VALUES ($1, $2, $3, $4, $5, 'active')
         RETURNING id::text AS id, name, direction_scope, color_token, status`,
        [id, this.scope.householdId, name, input.directionScope, colorToken],
      );
      const category = requireRow(result.rows, "CATEGORY_CREATE_FAILED", "分类创建失败");
      await writeFinanceAudit(client, this.scope, "finance_category_created", "category", id, null, { name, direction_scope: input.directionScope, color_token: colorToken });
      return { ...category, direction_scope: category.direction_scope as FinanceCategory["direction_scope"], status: category.status as FinanceCategory["status"] };
    });
  }

  async updateCategory(categoryId: string, input: { name: string; directionScope: FinanceCategory["direction_scope"]; colorToken: string }): Promise<FinanceCategory> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "edit");
      const name = String(input.name ?? "").trim();
      const colorToken = String(input.colorToken ?? "violet").trim().slice(0, 32) || "violet";
      if (!name || name.length > 40) throw new DomainError("INVALID_CATEGORY_NAME", "分类名称不能为空且不能超过 40 个字符", 400);
      const current = await client.query<Record<string, unknown>>(`SELECT id::text AS id, name, direction_scope, color_token, status FROM category WHERE household_id = $1 AND id = $2 FOR UPDATE`, [this.scope.householdId, categoryId]);
      const row = requireRow(current.rows, "CATEGORY_NOT_FOUND", "分类不存在或不属于当前家庭");
      if (row.status !== "active") throw new DomainError("CATEGORY_ARCHIVED", "已归档分类不能编辑", 409);
      const duplicate = await client.query(`SELECT 1 FROM category WHERE household_id = $1 AND name = $2 AND id <> $3`, [this.scope.householdId, name, categoryId]);
      if (duplicate.rows[0]) throw new DomainError("CATEGORY_ALREADY_EXISTS", "同名分类已存在", 409);
      const result = await client.query<FinanceCategory>(
        `UPDATE category SET name = $3, direction_scope = $4, color_token = $5
          WHERE household_id = $1 AND id = $2
          RETURNING id::text AS id, name, direction_scope, color_token, status`,
        [this.scope.householdId, categoryId, name, input.directionScope, colorToken],
      );
      const category = requireRow(result.rows, "CATEGORY_UPDATE_FAILED", "分类更新失败");
      await writeFinanceAudit(client, this.scope, "finance_category_updated", "category", categoryId, { name: row.name, direction_scope: row.direction_scope, color_token: row.color_token }, { name, direction_scope: input.directionScope, color_token: colorToken });
      return { ...category, direction_scope: category.direction_scope as FinanceCategory["direction_scope"], status: category.status as FinanceCategory["status"] };
    });
  }

  async archiveCategory(categoryId: string): Promise<{ category_id: string }> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "edit");
      const current = await client.query<Record<string, unknown>>(`SELECT id::text AS id, name, status FROM category WHERE household_id = $1 AND id = $2 FOR UPDATE`, [this.scope.householdId, categoryId]);
      const row = requireRow(current.rows, "CATEGORY_NOT_FOUND", "分类不存在或不属于当前家庭");
      if (row.status === "archived") return { category_id: categoryId };
      const activeBudget = await client.query(`SELECT 1 FROM budget WHERE household_id = $1 AND category_id = $2 AND status = 'active' LIMIT 1`, [this.scope.householdId, categoryId]);
      if (activeBudget.rows[0]) throw new DomainError("CATEGORY_HAS_ACTIVE_BUDGET", "该分类仍有生效预算，请先归档预算", 409);
      await client.query(`UPDATE category SET status = 'archived' WHERE household_id = $1 AND id = $2`, [this.scope.householdId, categoryId]);
      await writeFinanceAudit(client, this.scope, "finance_category_archived", "category", categoryId, { name: row.name, status: row.status }, { status: "archived" });
      return { category_id: categoryId };
    });
  }

  async listBudgets(start: string, end: string, includeArchived = false): Promise<FinanceBudget[]> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "view");
      const result = await client.query<FinanceBudget>(
        `SELECT b.id::text AS id, b.category_id::text AS category_id, c.name AS category_name, c.color_token,
                b.cycle, b.amount::text AS amount, b.currency, bp.period_start::text AS period_start,
                bp.period_end::text AS period_end, b.status,
                COALESCE(SUM(lt.amount) FILTER (WHERE lt.direction = 'expense' AND lt.status = 'confirmed'), 0)::text AS used
           FROM budget b
           JOIN category c ON c.household_id = b.household_id AND c.id = b.category_id
           JOIN budget_period bp ON bp.household_id = b.household_id AND bp.budget_id = b.id
           LEFT JOIN ledger_transaction lt
             ON lt.household_id = b.household_id AND lt.category_id = b.category_id
            AND lt.occurred_at >= GREATEST($2::date, bp.period_start)
            AND lt.occurred_at < LEAST($3::date + interval '1 day', bp.period_end + interval '1 day')
          WHERE b.household_id = $1 AND ($4::boolean OR b.status = 'active')
            AND bp.period_start <= $3::date AND bp.period_end >= $2::date
          GROUP BY b.id, c.id, c.name, c.color_token, bp.id
          ORDER BY bp.period_start DESC, c.name`,
        [this.scope.householdId, start, end, includeArchived],
      );
      return result.rows.map((row) => {
        const used = Number(row.used ?? 0);
        const amount = Number(row.amount ?? 0);
        return { ...row, cycle: row.cycle as FinanceBudget["cycle"], status: row.status as FinanceBudget["status"], amount: String(row.amount), used: String(row.used), remaining: String(Math.max(0, amount - used).toFixed(4)), progress: amount <= 0 ? 0 : Math.round(Math.min(100, used / amount * 100)) };
      });
    });
  }

  async createBudget(input: { categoryId: string; name: string; cycle: FinanceBudget["cycle"]; amount: string; currency: string; periodStart: string; periodEnd: string }): Promise<FinanceBudget> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "edit");
      const category = await client.query<Record<string, unknown>>(`SELECT id::text AS id, name, direction_scope, color_token, status FROM category WHERE household_id = $1 AND id = $2`, [this.scope.householdId, input.categoryId]);
      const categoryRow = requireRow(category.rows, "CATEGORY_NOT_FOUND", "预算分类不存在");
      if (categoryRow.status !== "active" || !["expense", "both"].includes(String(categoryRow.direction_scope))) throw new DomainError("BUDGET_CATEGORY_INVALID", "预算只能绑定有效的支出分类", 400);
      const amount = String(input.amount ?? "").trim();
      if (!/^\d+(?:\.\d{1,4})?$/.test(amount)) throw new DomainError("INVALID_BUDGET_AMOUNT", "预算额度格式不正确", 400);
      if (input.periodEnd < input.periodStart) throw new DomainError("INVALID_BUDGET_PERIOD", "预算结束日期不能早于开始日期", 400);
      const id = randomUUID();
      await client.query(`INSERT INTO budget (id, household_id, category_id, name, amount, cycle, currency, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')`, [id, this.scope.householdId, input.categoryId, String(input.name ?? "").trim() || `${categoryRow.name}预算`, amount, input.cycle, safeCurrency(input.currency)]);
      await client.query(`INSERT INTO budget_period (id, household_id, budget_id, period_start, period_end, amount) VALUES ($1, $2, $3, $4, $5, $6)`, [randomUUID(), this.scope.householdId, id, input.periodStart, input.periodEnd, amount]);
      await writeFinanceAudit(client, this.scope, "finance_budget_created", "budget", id, null, { category_id: input.categoryId, amount, cycle: input.cycle, period_start: input.periodStart, period_end: input.periodEnd });
      const budgets = await this.listBudgetsInTransaction(client, input.periodStart, input.periodEnd, false);
      return requireRow(budgets.filter((item) => item.id === id), "BUDGET_CREATE_FAILED", "预算创建失败");
    });
  }

  async updateBudget(budgetId: string, input: { categoryId: string; name: string; cycle: FinanceBudget["cycle"]; amount: string; currency: string; periodStart: string; periodEnd: string }): Promise<FinanceBudget> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "edit");
      const current = await client.query<Record<string, unknown>>(`SELECT id::text AS id, category_id::text AS category_id, name, amount::text AS amount, cycle, currency, status FROM budget WHERE household_id = $1 AND id = $2 FOR UPDATE`, [this.scope.householdId, budgetId]);
      const row = requireRow(current.rows, "BUDGET_NOT_FOUND", "预算不存在或不属于当前家庭");
      if (row.status !== "active") throw new DomainError("BUDGET_ARCHIVED", "已归档预算不能编辑", 409);
      const category = await client.query<Record<string, unknown>>(
        `SELECT id::text AS id, name, direction_scope, status
           FROM category
          WHERE household_id = $1 AND id = $2`,
        [this.scope.householdId, input.categoryId],
      );
      const categoryRow = requireRow(category.rows, "CATEGORY_NOT_FOUND", "预算分类不存在");
      if (categoryRow.status !== "active" || !["expense", "both"].includes(String(categoryRow.direction_scope))) {
        throw new DomainError("BUDGET_CATEGORY_INVALID", "预算只能绑定有效的支出分类", 400);
      }
      const amount = String(input.amount ?? "").trim();
      if (!/^\d+(?:\.\d{1,4})?$/.test(amount)) throw new DomainError("INVALID_BUDGET_AMOUNT", "预算额度格式不正确", 400);
      if (input.periodEnd < input.periodStart) throw new DomainError("INVALID_BUDGET_PERIOD", "预算结束日期不能早于开始日期", 400);
      await client.query(`UPDATE budget SET category_id = $3, name = $4, amount = $5, cycle = $6, currency = $7, updated_at = now() WHERE household_id = $1 AND id = $2`, [this.scope.householdId, budgetId, input.categoryId, String(input.name ?? "").trim() || "预算", amount, input.cycle, safeCurrency(input.currency)]);
      await client.query(`INSERT INTO budget_period (id, household_id, budget_id, period_start, period_end, amount) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (household_id, budget_id, period_start, period_end) DO UPDATE SET amount = EXCLUDED.amount`, [randomUUID(), this.scope.householdId, budgetId, input.periodStart, input.periodEnd, amount]);
      await writeFinanceAudit(client, this.scope, "finance_budget_updated", "budget", budgetId, { category_id: row.category_id, name: row.name, amount: row.amount, cycle: row.cycle }, { category_id: input.categoryId, name: input.name, amount, cycle: input.cycle });
      const budgets = await this.listBudgetsInTransaction(client, input.periodStart, input.periodEnd, false);
      return requireRow(budgets.filter((item) => item.id === budgetId), "BUDGET_UPDATE_FAILED", "预算更新失败");
    });
  }

  async archiveBudget(budgetId: string): Promise<{ budget_id: string }> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "edit");
      const current = await client.query<Record<string, unknown>>(`SELECT id::text AS id, status FROM budget WHERE household_id = $1 AND id = $2 FOR UPDATE`, [this.scope.householdId, budgetId]);
      const row = requireRow(current.rows, "BUDGET_NOT_FOUND", "预算不存在或不属于当前家庭");
      if (row.status === "archived") return { budget_id: budgetId };
      await client.query(`UPDATE budget SET status = 'archived', updated_at = now() WHERE household_id = $1 AND id = $2`, [this.scope.householdId, budgetId]);
      await writeFinanceAudit(client, this.scope, "finance_budget_archived", "budget", budgetId, { status: row.status }, { status: "archived" });
      return { budget_id: budgetId };
    });
  }

  private async listBudgetsInTransaction(client: DbClient, start: string, end: string, includeArchived: boolean): Promise<FinanceBudget[]> {
    const result = await client.query<FinanceBudget>(
      `SELECT b.id::text AS id, b.category_id::text AS category_id, c.name AS category_name, c.color_token,
              b.cycle, b.amount::text AS amount, b.currency, bp.period_start::text AS period_start,
              bp.period_end::text AS period_end, b.status,
              COALESCE(SUM(lt.amount) FILTER (WHERE lt.direction = 'expense' AND lt.status = 'confirmed'), 0)::text AS used
         FROM budget b JOIN category c ON c.household_id = b.household_id AND c.id = b.category_id
         JOIN budget_period bp ON bp.household_id = b.household_id AND bp.budget_id = b.id
         LEFT JOIN ledger_transaction lt ON lt.household_id = b.household_id AND lt.category_id = b.category_id
          AND lt.occurred_at >= GREATEST($2::date, bp.period_start)
          AND lt.occurred_at < LEAST($3::date + interval '1 day', bp.period_end + interval '1 day')
        WHERE b.household_id = $1 AND ($4::boolean OR b.status = 'active') AND bp.period_start <= $3::date AND bp.period_end >= $2::date
        GROUP BY b.id, c.id, c.name, c.color_token, bp.id ORDER BY bp.period_start DESC, c.name`,
      [this.scope.householdId, start, end, includeArchived],
    );
    return result.rows.map((row) => { const used = Number(row.used ?? 0); const amount = Number(row.amount ?? 0); return { ...row, cycle: row.cycle as FinanceBudget["cycle"], status: row.status as FinanceBudget["status"], remaining: String(Math.max(0, amount - used).toFixed(4)), progress: amount <= 0 ? 0 : Math.round(Math.min(100, used / amount * 100)) }; });
  }

  async listAssets(): Promise<FinanceAsset[]> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "view");
      const result = await client.query<FinanceAsset>(
        `SELECT pa.id::text AS id, pa.name, pa.asset_type, pa.status,
                COUNT(ae.id)::int AS event_count,
                COALESCE(SUM(ae.amount), 0)::text AS gross_cost,
                COALESCE(SUM(ae.recovery_amount), 0)::text AS recovery,
                COALESCE(SUM(ae.amount - ae.recovery_amount), 0)::text AS net_cash_cost,
                MAX(ae.occurred_at)::text AS last_event_at
           FROM physical_asset pa
           LEFT JOIN asset_event ae
             ON ae.household_id = pa.household_id AND ae.asset_id = pa.id
          WHERE pa.household_id = $1
          GROUP BY pa.id
          ORDER BY pa.updated_at DESC, pa.name`,
        [this.scope.householdId],
      );
      return result.rows.map((row) => ({
        ...row,
        status: row.status as FinanceAsset["status"],
        event_count: Number(row.event_count ?? 0),
        gross_cost: String(row.gross_cost ?? "0"),
        recovery: String(row.recovery ?? "0"),
        net_cash_cost: String(row.net_cash_cost ?? "0"),
        last_event_at: row.last_event_at ? String(row.last_event_at) : null,
      }));
    });
  }

  async createAsset(input: { name: string; assetType: string }): Promise<FinanceAssetDetail> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "edit");
      const name = String(input.name ?? "").trim();
      const assetType = String(input.assetType ?? "").trim();
      if (!name || name.length > 120) throw new DomainError("INVALID_ASSET_NAME", "资产名称不能为空且不能超过 120 个字符", 400);
      if (!assetType || assetType.length > 60) throw new DomainError("INVALID_ASSET_TYPE", "资产类型不能为空且不能超过 60 个字符", 400);
      const duplicate = await client.query(`SELECT 1 FROM physical_asset WHERE household_id = $1 AND name = $2 AND status = 'held'`, [this.scope.householdId, name]);
      if (duplicate.rows[0]) throw new DomainError("ASSET_ALREADY_EXISTS", "同名持有资产已存在", 409);
      const id = randomUUID();
      const result = await client.query<FinanceAsset>(
        `INSERT INTO physical_asset (id, household_id, name, asset_type, status)
         VALUES ($1, $2, $3, $4, 'held')
         RETURNING id::text AS id, name, asset_type, status`,
        [id, this.scope.householdId, name, assetType],
      );
      const asset = requireRow(result.rows, "ASSET_CREATE_FAILED", "资产创建失败");
      await writeFinanceAudit(client, this.scope, "finance_asset_created", "physical_asset", id, null, { name, asset_type: assetType, status: "held" });
      return { ...asset, status: asset.status as FinanceAsset["status"], event_count: 0, gross_cost: "0.0000", recovery: "0.0000", net_cash_cost: "0.0000", last_event_at: null, events: [] };
    });
  }

  async updateAsset(assetId: string, input: { name: string; assetType: string }): Promise<FinanceAsset> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "edit");
      const name = String(input.name ?? "").trim();
      const assetType = String(input.assetType ?? "").trim();
      if (!name || name.length > 120) throw new DomainError("INVALID_ASSET_NAME", "资产名称不能为空且不能超过 120 个字符", 400);
      if (!assetType || assetType.length > 60) throw new DomainError("INVALID_ASSET_TYPE", "资产类型不能为空且不能超过 60 个字符", 400);
      const current = await client.query<Record<string, unknown>>(`SELECT id::text AS id, name, asset_type, status FROM physical_asset WHERE household_id = $1 AND id = $2 FOR UPDATE`, [this.scope.householdId, assetId]);
      const row = requireRow(current.rows, "ASSET_NOT_FOUND", "资产不存在或不属于当前家庭");
      const duplicate = await client.query(`SELECT 1 FROM physical_asset WHERE household_id = $1 AND name = $2 AND id <> $3 AND status = 'held'`, [this.scope.householdId, name, assetId]);
      if (duplicate.rows[0]) throw new DomainError("ASSET_ALREADY_EXISTS", "同名持有资产已存在", 409);
      const result = await client.query<FinanceAsset>(
        `UPDATE physical_asset SET name = $3, asset_type = $4, updated_at = now()
          WHERE household_id = $1 AND id = $2
          RETURNING id::text AS id, name, asset_type, status`,
        [this.scope.householdId, assetId, name, assetType],
      );
      const asset = requireRow(result.rows, "ASSET_UPDATE_FAILED", "资产更新失败");
      await writeFinanceAudit(client, this.scope, "finance_asset_updated", "physical_asset", assetId, { name: row.name, asset_type: row.asset_type }, { name, asset_type: assetType });
      const totals = await client.query<{ event_count: number; gross_cost: string; recovery: string; net_cash_cost: string; last_event_at: string | null }>(
        `SELECT COUNT(*)::int AS event_count, COALESCE(SUM(amount), 0)::text AS gross_cost,
                COALESCE(SUM(recovery_amount), 0)::text AS recovery,
                COALESCE(SUM(amount - recovery_amount), 0)::text AS net_cash_cost,
                MAX(occurred_at)::text AS last_event_at
           FROM asset_event WHERE household_id = $1 AND asset_id = $2`,
        [this.scope.householdId, assetId],
      );
      return { ...asset, status: asset.status as FinanceAsset["status"], event_count: Number(totals.rows[0]?.event_count ?? 0), gross_cost: String(totals.rows[0]?.gross_cost ?? "0"), recovery: String(totals.rows[0]?.recovery ?? "0"), net_cash_cost: String(totals.rows[0]?.net_cash_cost ?? "0"), last_event_at: totals.rows[0]?.last_event_at ? String(totals.rows[0].last_event_at) : null };
    });
  }

  async getAssetDetail(assetId: string): Promise<FinanceAssetDetail | null> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "view");
      const assetResult = await client.query<FinanceAsset>(
        `SELECT pa.id::text AS id, pa.name, pa.asset_type, pa.status,
                COUNT(ae.id)::int AS event_count,
                COALESCE(SUM(ae.amount), 0)::text AS gross_cost,
                COALESCE(SUM(ae.recovery_amount), 0)::text AS recovery,
                COALESCE(SUM(ae.amount - ae.recovery_amount), 0)::text AS net_cash_cost,
                MAX(ae.occurred_at)::text AS last_event_at
           FROM physical_asset pa
           LEFT JOIN asset_event ae ON ae.household_id = pa.household_id AND ae.asset_id = pa.id
          WHERE pa.household_id = $1 AND pa.id = $2
          GROUP BY pa.id`,
        [this.scope.householdId, assetId],
      );
      const asset = assetResult.rows[0];
      if (!asset) return null;
      const events = await client.query<FinanceAssetEvent>(
        `SELECT id::text AS id, asset_id::text AS asset_id, occurred_at::text AS occurred_at, event_type,
                amount::text AS amount, recovery_amount::text AS recovery_amount, ledger_transaction_id::text AS ledger_transaction_id
           FROM asset_event
          WHERE household_id = $1 AND asset_id = $2
          ORDER BY occurred_at DESC, created_at DESC`,
        [this.scope.householdId, assetId],
      );
      return { ...asset, status: asset.status as FinanceAsset["status"], event_count: Number(asset.event_count ?? 0), gross_cost: String(asset.gross_cost ?? "0"), recovery: String(asset.recovery ?? "0"), net_cash_cost: String(asset.net_cash_cost ?? "0"), last_event_at: asset.last_event_at ? String(asset.last_event_at) : null, events: events.rows.map((event) => ({ ...event, event_type: event.event_type as FinanceAssetEventType, amount: String(event.amount), recovery_amount: String(event.recovery_amount), ledger_transaction_id: event.ledger_transaction_id ? String(event.ledger_transaction_id) : null })) };
    });
  }

  private mapFinancePermission(row: Record<string, unknown>): FinancePermission {
    return {
      user_id: String(row.user_id),
      email: String(row.email ?? ""),
      role: String(row.role) as FinancePermission["role"],
      can_view: Boolean(row.can_view),
      can_bookkeep: Boolean(row.can_bookkeep),
      can_edit: Boolean(row.can_edit),
      can_import: Boolean(row.can_import),
      can_reconcile: Boolean(row.can_reconcile),
      can_export: Boolean(row.can_export),
      explicit: Boolean(row.explicit),
      granted_at: row.granted_at ? String(row.granted_at) : null,
      revoked_at: row.revoked_at ? String(row.revoked_at) : null,
    };
  }

  private async getFinancePermissionInTransaction(client: DbClient, userId: string): Promise<FinancePermission> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT hm.user_id::text AS user_id, au.email, hm.role,
              CASE WHEN hm.role = 'owner' THEN true
                   WHEN fp.id IS NULL THEN hm.role = 'adult'
                   WHEN fp.revoked_at IS NOT NULL THEN false
                   ELSE COALESCE(fp.can_view, false) END AS can_view,
              CASE WHEN hm.role = 'owner' THEN true
                   WHEN fp.id IS NULL THEN hm.role = 'adult'
                   WHEN fp.revoked_at IS NOT NULL THEN false
                   ELSE COALESCE(fp.can_bookkeep, false) END AS can_bookkeep,
              CASE WHEN hm.role = 'owner' THEN true
                   WHEN fp.id IS NULL THEN hm.role = 'adult'
                   WHEN fp.revoked_at IS NOT NULL THEN false
                   ELSE COALESCE(fp.can_edit, false) END AS can_edit,
              CASE WHEN hm.role = 'owner' THEN true
                   WHEN fp.id IS NULL THEN hm.role = 'adult'
                   WHEN fp.revoked_at IS NOT NULL THEN false
                   ELSE COALESCE(fp.can_import, false) END AS can_import,
              CASE WHEN hm.role = 'owner' THEN true
                   WHEN fp.id IS NULL THEN hm.role = 'adult'
                   WHEN fp.revoked_at IS NOT NULL THEN false
                   ELSE COALESCE(fp.can_reconcile, false) END AS can_reconcile,
              CASE WHEN hm.role = 'owner' THEN true
                   WHEN fp.id IS NULL THEN hm.role = 'adult'
                   WHEN fp.revoked_at IS NOT NULL THEN false
                   ELSE COALESCE(fp.can_export, false) END AS can_export,
              (fp.id IS NOT NULL AND fp.revoked_at IS NULL) AS explicit,
              fp.granted_at::text AS granted_at, fp.revoked_at::text AS revoked_at
         FROM household_member hm
         JOIN app_user au ON au.id = hm.user_id
         LEFT JOIN financial_permission fp
           ON fp.household_id = hm.household_id AND fp.user_id = hm.user_id
        WHERE hm.household_id = $1 AND hm.user_id = $2 AND hm.status = 'active'`,
      [this.scope.householdId, userId],
    );
    return this.mapFinancePermission(requireRow(result.rows, "MEMBER_NOT_FOUND", "家庭成员不存在或已离开当前家庭"));
  }

  async listFinancePermissions(): Promise<FinancePermission[]> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinanceOwner(client, this.scope);
      const result = await client.query<Record<string, unknown>>(
        `SELECT hm.user_id::text AS user_id, au.email, hm.role,
                CASE WHEN hm.role = 'owner' THEN true
                     WHEN fp.id IS NULL THEN hm.role = 'adult'
                     WHEN fp.revoked_at IS NOT NULL THEN false
                     ELSE COALESCE(fp.can_view, false) END AS can_view,
                CASE WHEN hm.role = 'owner' THEN true
                     WHEN fp.id IS NULL THEN hm.role = 'adult'
                     WHEN fp.revoked_at IS NOT NULL THEN false
                     ELSE COALESCE(fp.can_bookkeep, false) END AS can_bookkeep,
                CASE WHEN hm.role = 'owner' THEN true
                     WHEN fp.id IS NULL THEN hm.role = 'adult'
                     WHEN fp.revoked_at IS NOT NULL THEN false
                     ELSE COALESCE(fp.can_edit, false) END AS can_edit,
                CASE WHEN hm.role = 'owner' THEN true
                     WHEN fp.id IS NULL THEN hm.role = 'adult'
                     WHEN fp.revoked_at IS NOT NULL THEN false
                     ELSE COALESCE(fp.can_import, false) END AS can_import,
                CASE WHEN hm.role = 'owner' THEN true
                     WHEN fp.id IS NULL THEN hm.role = 'adult'
                     WHEN fp.revoked_at IS NOT NULL THEN false
                     ELSE COALESCE(fp.can_reconcile, false) END AS can_reconcile,
                CASE WHEN hm.role = 'owner' THEN true
                     WHEN fp.id IS NULL THEN hm.role = 'adult'
                     WHEN fp.revoked_at IS NOT NULL THEN false
                     ELSE COALESCE(fp.can_export, false) END AS can_export,
                (fp.id IS NOT NULL AND fp.revoked_at IS NULL) AS explicit,
                fp.granted_at::text AS granted_at, fp.revoked_at::text AS revoked_at
           FROM household_member hm
           JOIN app_user au ON au.id = hm.user_id
           LEFT JOIN financial_permission fp
             ON fp.household_id = hm.household_id AND fp.user_id = hm.user_id
          WHERE hm.household_id = $1 AND hm.status = 'active'
          ORDER BY CASE hm.role WHEN 'owner' THEN 0 WHEN 'adult' THEN 1 WHEN 'child' THEN 2 ELSE 3 END, au.email`,
        [this.scope.householdId],
      );
      return result.rows.map((row) => this.mapFinancePermission(row));
    });
  }

  async updateFinancePermission(userId: string, input: FinancePermissionInput): Promise<FinancePermission> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinanceOwner(client, this.scope);
      const member = await client.query<{ role: string }>(
        `SELECT role FROM household_member WHERE household_id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`,
        [this.scope.householdId, userId],
      );
      const memberRow = requireRow(member.rows, "MEMBER_NOT_FOUND", "家庭成员不存在或已离开当前家庭");
      if (memberRow.role === "owner") throw new DomainError("FINANCE_PERMISSION_OWNER_LOCKED", "家庭所有者权限不可修改", 400);
      const before = await client.query<Record<string, unknown>>(
        `SELECT can_view, can_bookkeep, can_edit, can_import, can_reconcile, can_export, revoked_at::text AS revoked_at
           FROM financial_permission WHERE household_id = $1 AND user_id = $2`,
        [this.scope.householdId, userId],
      );
      const normalized = {
        can_view: Boolean(input.can_view),
        can_bookkeep: Boolean(input.can_bookkeep),
        can_edit: Boolean(input.can_edit),
        can_import: Boolean(input.can_import),
        can_reconcile: Boolean(input.can_reconcile),
        can_export: Boolean(input.can_export),
      };
      await client.query(
        `INSERT INTO financial_permission
          (id, household_id, user_id, can_view, can_bookkeep, can_edit, can_import, can_reconcile, can_export, granted_by, granted_at, revoked_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), NULL, now())
         ON CONFLICT (household_id, user_id) DO UPDATE SET
           can_view = EXCLUDED.can_view, can_bookkeep = EXCLUDED.can_bookkeep, can_edit = EXCLUDED.can_edit,
           can_import = EXCLUDED.can_import, can_reconcile = EXCLUDED.can_reconcile, can_export = EXCLUDED.can_export,
           granted_by = EXCLUDED.granted_by, granted_at = now(), revoked_at = NULL, updated_at = now()`,
        [randomUUID(), this.scope.householdId, userId, normalized.can_view, normalized.can_bookkeep, normalized.can_edit, normalized.can_import, normalized.can_reconcile, normalized.can_export, this.scope.userId],
      );
      await writeFinanceAudit(client, this.scope, "finance_permission_updated", "financial_permission", userId, before.rows[0] ?? null, normalized);
      return this.getFinancePermissionInTransaction(client, userId);
    });
  }

  async revokeFinancePermission(userId: string): Promise<{ user_id: string }> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinanceOwner(client, this.scope);
      const member = await client.query<{ role: string }>(
        `SELECT role FROM household_member WHERE household_id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`,
        [this.scope.householdId, userId],
      );
      const memberRow = requireRow(member.rows, "MEMBER_NOT_FOUND", "家庭成员不存在或已离开当前家庭");
      if (memberRow.role === "owner") throw new DomainError("FINANCE_PERMISSION_OWNER_LOCKED", "家庭所有者权限不可撤销", 400);
      const before = await client.query<Record<string, unknown>>(
        `SELECT can_view, can_bookkeep, can_edit, can_import, can_reconcile, can_export, revoked_at::text AS revoked_at
           FROM financial_permission WHERE household_id = $1 AND user_id = $2`,
        [this.scope.householdId, userId],
      );
      await client.query(
        `INSERT INTO financial_permission
          (id, household_id, user_id, can_view, can_bookkeep, can_edit, can_import, can_reconcile, can_export, granted_by, granted_at, revoked_at, updated_at)
         VALUES ($1, $2, $3, false, false, false, false, false, false, $4, now(), now(), now())
         ON CONFLICT (household_id, user_id) DO UPDATE SET
           can_view = false, can_bookkeep = false, can_edit = false, can_import = false,
           can_reconcile = false, can_export = false, granted_by = EXCLUDED.granted_by, revoked_at = now(), updated_at = now()`,
        [randomUUID(), this.scope.householdId, userId, this.scope.userId],
      );
      await writeFinanceAudit(client, this.scope, "finance_permission_revoked", "financial_permission", userId, before.rows[0] ?? null, { can_view: false, can_bookkeep: false, can_edit: false, can_import: false, can_reconcile: false, can_export: false });
      return { user_id: userId };
    });
  }

  async listFinanceAudit(limit = 50): Promise<FinanceAuditEntry[]> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinanceOwner(client, this.scope);
      const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
      const result = await client.query<Record<string, unknown>>(
        `SELECT id::text AS id, actor_id::text AS actor_id, action, resource_type, resource_id::text AS resource_id,
                before_summary, after_summary, trace_id, created_at::text AS created_at
           FROM audit_log
          WHERE household_id = $1 AND (action LIKE 'finance_%' OR action LIKE 'permission_%')
          ORDER BY created_at DESC
          LIMIT $2`,
        [this.scope.householdId, safeLimit],
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        actor_id: row.actor_id ? String(row.actor_id) : null,
        action: String(row.action),
        resource_type: String(row.resource_type),
        resource_id: row.resource_id ? String(row.resource_id) : null,
        before_summary: row.before_summary ?? null,
        after_summary: row.after_summary ?? null,
        trace_id: String(row.trace_id),
        created_at: String(row.created_at),
      }));
    });
  }

  async enqueueFinanceExport(input: { start: string; end: string; format: "csv"; idempotencyKey?: string }): Promise<FinanceExportJob> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "export");
      await assertSensitivePermission(client, this.scope, "household_export");
      if (input.end < input.start) throw new DomainError("BAD_REQUEST", "导出结束日期不能早于开始日期", 400);
      const id = randomUUID();
      const idempotencyKey = nullableText(input.idempotencyKey);
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO finance_export_job (id, household_id, requested_by, format, period_start, period_end, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (household_id, idempotency_key) DO UPDATE SET updated_at = finance_export_job.updated_at
         RETURNING id::text AS id, format, period_start::text AS period_start, period_end::text AS period_end,
                   status, row_count, download_expires_at::text AS download_expires_at,
                   error_code, error_message, created_at::text AS created_at, completed_at::text AS completed_at`,
        [id, this.scope.householdId, this.scope.userId, input.format, input.start, input.end, idempotencyKey],
      );
      const row = requireRow(result.rows, "EXPORT_CREATE_FAILED", "无法创建导出任务");
      const job = mapFinanceExportJob(row);
      await writeFinanceAudit(client, this.scope, "finance_export_queued", "finance_export_job", job.id, null, { period_start: input.start, period_end: input.end, format: input.format, status: job.status });
      return job;
    });
  }

  async getFinanceExport(jobId: string): Promise<FinanceExportJob | null> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "export");
      await assertSensitivePermission(client, this.scope, "household_export");
      const result = await client.query<Record<string, unknown>>(
        `SELECT id::text AS id, format, period_start::text AS period_start, period_end::text AS period_end,
                status, object_key, row_count, download_expires_at::text AS download_expires_at,
                error_code, error_message, created_at::text AS created_at, completed_at::text AS completed_at
           FROM finance_export_job
          WHERE household_id = $1 AND id = $2
          FOR UPDATE`,
        [this.scope.householdId, jobId],
      );
      const row = result.rows[0];
      if (!row) return null;
      if (String(row.status) === "ready" && row.download_expires_at && new Date(String(row.download_expires_at)).getTime() <= Date.now()) {
        await client.query(`UPDATE finance_export_job SET status = 'expired', updated_at = now() WHERE household_id = $1 AND id = $2 AND status = 'ready'`, [this.scope.householdId, jobId]);
        row.status = "expired";
      }
      return mapFinanceExportJob(row);
    });
  }

  async getFinanceAiConnection(): Promise<FinanceAiConnection | null> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinanceOwner(client, this.scope);
      const result = await client.query<Record<string, unknown>>(
        `SELECT provider, endpoint_url, model, api_key_ref, status, last_tested_at::text AS last_tested_at, last_error
           FROM household_ai_connection WHERE household_id = $1`,
        [this.scope.householdId],
      );
      return result.rows[0] ? mapFinanceAiConnection(result.rows[0]) : null;
    });
  }

  async upsertFinanceAiConnection(input: { endpointUrl: string; model: string; apiKeyRef: string; status: "active" | "disabled" }): Promise<FinanceAiConnection> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinanceOwner(client, this.scope);
      const endpointUrl = String(input.endpointUrl ?? "").trim().replace(/\/$/, "");
      const model = String(input.model ?? "").trim();
      const apiKeyRef = String(input.apiKeyRef ?? "").trim();
      let parsed: URL;
      try { parsed = new URL(endpointUrl); } catch { throw new DomainError("AI_CONNECTION_INVALID", "AI Endpoint 不是有效地址", 400); }
      if (!/^https?:$/.test(parsed.protocol) || (process.env.NODE_ENV === "production" && parsed.protocol !== "https:")) throw new DomainError("AI_CONNECTION_INVALID", "生产 AI Endpoint 必须使用 HTTPS", 400);
      if (!model || model.length > 120 || !/^[A-Za-z0-9._:-]{1,120}$/.test(apiKeyRef)) throw new DomainError("AI_CONNECTION_INVALID", "AI 模型或密钥引用格式不正确", 400);
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO household_ai_connection (id, household_id, provider, endpoint_url, model, api_key_ref, status, created_by)
         VALUES ($1, $2, 'openai_compatible', $3, $4, $5, $6, $7)
         ON CONFLICT (household_id) DO UPDATE SET endpoint_url = EXCLUDED.endpoint_url, model = EXCLUDED.model,
           api_key_ref = EXCLUDED.api_key_ref, status = EXCLUDED.status, last_error = NULL, updated_at = now()
         RETURNING provider, endpoint_url, model, api_key_ref, status, last_tested_at::text AS last_tested_at, last_error`,
        [randomUUID(), this.scope.householdId, endpointUrl, model, apiKeyRef, input.status, this.scope.userId],
      );
      const connection = mapFinanceAiConnection(requireRow(result.rows, "AI_CONNECTION_SAVE_FAILED", "AI 连接保存失败"));
      await writeFinanceAudit(client, this.scope, "finance_ai_connection_updated", "household_ai_connection", this.scope.householdId, null, { provider: connection.provider, model: connection.model, api_key_ref: connection.api_key_ref, status: connection.status });
      return connection;
    });
  }

  async testFinanceAiConnection(): Promise<FinanceAiConnection> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinanceOwner(client, this.scope);
      const result = await client.query<Record<string, unknown>>(`SELECT provider, endpoint_url, model, api_key_ref, status, last_tested_at::text AS last_tested_at, last_error FROM household_ai_connection WHERE household_id = $1 FOR UPDATE`, [this.scope.householdId]);
      const row = requireRow(result.rows, "AI_CONNECTION_NOT_CONFIGURED", "当前家庭还没有配置 AI 连接");
      if (String(row.status) === "disabled") throw new DomainError("AI_CONNECTION_DISABLED", "当前家庭 AI 连接已停用", 409);
      const secret = resolveHouseholdAiSecret(String(row.api_key_ref));
      if (!secret) {
        await client.query(`UPDATE household_ai_connection SET status = 'error', last_error = $2, updated_at = now() WHERE household_id = $1`, [this.scope.householdId, "AI secret ref is not configured"]);
        throw new DomainError("AI_CONNECTION_SECRET_MISSING", "当前家庭 AI 连接的密钥引用未配置", 503);
      }
      const provider = new OpenAiCompatibleFinanceAiProvider({ endpoint_url: String(row.endpoint_url), model: String(row.model), api_key_ref: String(row.api_key_ref) }, secret);
      try {
        await provider.summarizeFinance({ period: { start: "2000-01-01", end: "2000-01-01" }, income: "0", expense: "0", net_cash_flow: "0", top_categories: [], budgets: [], assets: { gross_cost: "0", recovery: "0", net_cash_cost: "0" } });
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : "AI connection test failed";
        await client.query(`UPDATE household_ai_connection SET status = 'error', last_error = $2, updated_at = now() WHERE household_id = $1`, [this.scope.householdId, message]);
        await writeFinanceAudit(client, this.scope, "finance_ai_connection_test_failed", "household_ai_connection", this.scope.householdId, { status: row.status }, { status: "error", error: message });
        throw new DomainError("AI_CONNECTION_TEST_FAILED", "家庭 AI 连接测试失败，请检查 Endpoint、模型和密钥引用", 502);
      }
      const updated = await client.query<Record<string, unknown>>(`UPDATE household_ai_connection SET status = 'active', last_tested_at = now(), last_error = NULL, updated_at = now() WHERE household_id = $1 RETURNING provider, endpoint_url, model, api_key_ref, status, last_tested_at::text AS last_tested_at, last_error`, [this.scope.householdId]);
      const connection = mapFinanceAiConnection(requireRow(updated.rows, "AI_CONNECTION_TEST_FAILED", "AI 连接测试状态保存失败"));
      await writeFinanceAudit(client, this.scope, "finance_ai_connection_tested", "household_ai_connection", this.scope.householdId, { status: row.status }, { status: connection.status, tested_at: connection.last_tested_at });
      return connection;
    });
  }

  private mapFinanceAiProposal(row: Record<string, unknown>): FinanceAiProposal {
    return { id: String(row.id), action_type: "finance_review", status: String(row.status) as FinanceAiProposal["status"], version: Number(row.version), payload: asJsonObject(row.payload) };
  }

  private async getFinanceAiProvider(client: DbClient): Promise<FinanceAiProvider> {
    const result = await client.query<Record<string, unknown>>(`SELECT endpoint_url, model, api_key_ref, status FROM household_ai_connection WHERE household_id = $1`, [this.scope.householdId]);
    const row = result.rows[0];
    if (!row || String(row.status) !== "active") return new DeterministicFinanceAiProvider();
    const secret = resolveHouseholdAiSecret(String(row.api_key_ref));
    if (!secret) throw new DomainError("AI_CONNECTION_SECRET_MISSING", "当前家庭 AI 连接的密钥引用未配置，系统不会回退到其它家庭或全局密钥", 503);
    return new OpenAiCompatibleFinanceAiProvider({ endpoint_url: String(row.endpoint_url), model: String(row.model), api_key_ref: String(row.api_key_ref) }, secret);
  }

  async getFinanceAiSummary(start: string, end: string): Promise<FinanceAiSummary> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "view");
      await assertSensitivePermission(client, this.scope, "ai_finance_insight");
      if (end < start) throw new DomainError("BAD_REQUEST", "财务周期结束日期不能早于开始日期", 400);
      const drilldownRef = await insertFilter(client, this.scope, "ledger_period", { start, end });
      const totals = await client.query<{ income: string; expense: string; net_cash_flow: string }>(
        "SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'income'), 0)::text AS income, COALESCE(SUM(amount) FILTER (WHERE direction = 'expense'), 0)::text AS expense, COALESCE(SUM(CASE WHEN direction = 'income' THEN amount WHEN direction = 'expense' THEN -amount ELSE 0 END), 0)::text AS net_cash_flow FROM ledger_transaction WHERE household_id = $1 AND status = 'confirmed' AND currency = 'CNY' AND occurred_at >= $2::date AND occurred_at < ($3::date + interval '1 day')",
        [this.scope.householdId, start, end],
      );
      const total = totals.rows[0] ?? { income: "0", expense: "0", net_cash_flow: "0" };
      const topCategories = await client.query<{ category: string; amount: string }>(
        "SELECT COALESCE(category, '未分类') AS category, SUM(amount)::text AS amount FROM ledger_transaction WHERE household_id = $1 AND status = 'confirmed' AND direction = 'expense' AND occurred_at >= $2::date AND occurred_at < ($3::date + interval '1 day') GROUP BY category ORDER BY SUM(amount) DESC LIMIT 3",
        [this.scope.householdId, start, end],
      );
      const budgets = await client.query<{ id: string; category_name: string; amount: string; used: string }>(
        "SELECT b.id::text AS id, c.name AS category_name, b.amount::text AS amount, COALESCE(SUM(lt.amount) FILTER (WHERE lt.direction = 'expense' AND lt.status = 'confirmed'), 0)::text AS used FROM budget b JOIN category c ON c.household_id = b.household_id AND c.id = b.category_id JOIN budget_period bp ON bp.household_id = b.household_id AND bp.budget_id = b.id LEFT JOIN ledger_transaction lt ON lt.household_id = b.household_id AND lt.category_id = b.category_id AND lt.occurred_at >= GREATEST($2::date, bp.period_start) AND lt.occurred_at < LEAST($3::date + interval '1 day', bp.period_end + interval '1 day') WHERE b.household_id = $1 AND b.status = 'active' AND bp.period_start <= $3::date AND bp.period_end >= $2::date GROUP BY b.id, c.name ORDER BY SUM(lt.amount) DESC NULLS LAST",
        [this.scope.householdId, start, end],
      );
      const assets = await client.query<{ gross_cost: string; recovery: string; net_cash_cost: string }>(
        "SELECT COALESCE(SUM(amount), 0)::text AS gross_cost, COALESCE(SUM(recovery_amount), 0)::text AS recovery, COALESCE(SUM(amount - recovery_amount), 0)::text AS net_cash_cost FROM asset_event WHERE household_id = $1 AND occurred_at >= $2::date AND occurred_at < ($3::date + interval '1 day')",
        [this.scope.householdId, start, end],
      );
      const recentTransactions = await client.query<{ id: string; primary_source_record_id: string | null; merchant: string | null; category: string | null }>(
        "SELECT id::text AS id, primary_source_record_id::text AS primary_source_record_id, merchant, category FROM ledger_transaction WHERE household_id = $1 AND status = 'confirmed' AND occurred_at >= $2::date AND occurred_at < ($3::date + interval '1 day') ORDER BY occurred_at DESC, created_at DESC LIMIT 10",
        [this.scope.householdId, start, end],
      );
      const sourceRefs: FinanceAiSourceRef[] = [{ kind: "period", id: drilldownRef.filter_id, label: start + " 至 " + end + " 统一账本", drilldown_ref: drilldownRef }];
      for (const item of recentTransactions.rows) {
        sourceRefs.push({ kind: "transaction", id: item.id, label: item.merchant || item.category || "确认账单", drilldown_ref: drilldownRef });
        if (item.primary_source_record_id) sourceRefs.push({ kind: "source_record", id: item.primary_source_record_id, label: "原始来源行", drilldown_ref: drilldownRef });
      }
      for (const item of budgets.rows.slice(0, 3)) sourceRefs.push({ kind: "budget", id: item.id, label: item.category_name + "预算", drilldown_ref: drilldownRef });
      const assetTotals = assets.rows[0] ?? { gross_cost: "0", recovery: "0", net_cash_cost: "0" };
      const provider = await this.getFinanceAiProvider(client);
      const facts: FinanceAiFacts = {
        period: { start, end },
        income: String(total.income),
        expense: String(total.expense),
        net_cash_flow: String(total.net_cash_flow),
        top_categories: topCategories.rows.map((item) => ({ category: item.category, amount: item.amount })),
        budgets: budgets.rows.map((item) => ({ category: item.category_name, amount: item.amount, used: item.used })),
        assets: { gross_cost: String(assetTotals.gross_cost), recovery: String(assetTotals.recovery), net_cash_cost: String(assetTotals.net_cash_cost) },
      };
      const generated = await provider.summarizeFinance(facts);
      const summary = generated.summary;
      const keyPoints = generated.key_points;
      const explanations = generated.explanations;
      const insightId = randomUUID();
      const proposalId = randomUUID();
      const content = { summary, key_points: keyPoints, explanations, period: { start, end }, formal_ledger_mutation: false };
      const memoryKey = `finance/summary/${start}_${end}`;
      const memoryPayload = { memory_key: memoryKey, household_id: this.scope.householdId, period: { start, end }, provider: provider.name, summary, key_points: keyPoints, source_refs: sourceRefs.map((item) => ({ kind: item.kind, id: item.id })) };
      const memoryAllowed = await hasSensitivePermission(client, this.scope, "ai_memory_personalization");
      if (memoryAllowed) {
        const memoryUpdate = await client.query(
          `UPDATE ai_memory_document SET content = $3::jsonb, source_refs = $4::jsonb, version = version + 1, updated_at = now()
            WHERE household_id = $1 AND owner_user_id IS NULL AND memory_key = $2`,
          [this.scope.householdId, memoryKey, JSON.stringify(memoryPayload), JSON.stringify(sourceRefs)],
        );
        if ((memoryUpdate.rowCount ?? 0) === 0) {
          await client.query(
            `INSERT INTO ai_memory_document (id, household_id, owner_user_id, memory_key, content, source_refs)
             VALUES ($1, $2, NULL, $3, $4::jsonb, $5::jsonb)`,
            [randomUUID(), this.scope.householdId, memoryKey, JSON.stringify(memoryPayload), JSON.stringify(sourceRefs)],
          );
        }
      }
      let memoryArtifactId: string | null = null;
      if (memoryAllowed && this.aiMemoryStore) {
        memoryArtifactId = randomUUID();
        const memoryBytes = Buffer.from(JSON.stringify(memoryPayload), "utf8");
        const memoryObjectKey = aiMemoryObjectKey(this.scope.householdId, memoryArtifactId);
        await this.aiMemoryStore.put(memoryObjectKey, memoryBytes);
        await client.query(
          `INSERT INTO ai_memory_artifact (id, household_id, owner_user_id, artifact_type, object_key, content_sha256, retention_until)
           VALUES ($1, $2, NULL, 'summary', $3, $4, now() + interval '365 days')`,
          [memoryArtifactId, this.scope.householdId, memoryObjectKey, createHash("sha256").update(memoryBytes).digest("hex")],
        );
      }
      await client.query(
        "INSERT INTO ai_insight (id, household_id, topic_id, scope_type, insight_type, content, source_refs, provider, model, created_by) VALUES ($1, $2, NULL, 'finance', 'finance_summary', $3::jsonb, $4::jsonb, $5, $6, $7)",
        [insightId, this.scope.householdId, JSON.stringify(content), JSON.stringify(sourceRefs), provider.name, provider.model, this.scope.userId],
      );
      const payload = { insight_id: insightId, period: { start, end }, drilldown_ref: drilldownRef, source_refs: sourceRefs, formal_ledger_mutation: false };
      await client.query(
        "INSERT INTO ai_action_proposal (id, household_id, insight_id, action_type, payload, created_by) VALUES ($1, $2, $3, 'finance_review', $4::jsonb, $5)",
        [proposalId, this.scope.householdId, insightId, JSON.stringify(payload), this.scope.userId],
      );
      await writeFinanceAudit(client, this.scope, "finance_ai_generated", "ai_insight", insightId, null, { provider: provider.name, model: provider.model, source_count: sourceRefs.length, proposal_id: proposalId, memory_key: memoryKey, memory_artifact_id: memoryArtifactId });
      return {
        insight: { id: insightId, insight_type: "finance_summary" as const, summary, key_points: keyPoints, explanations, source_refs: sourceRefs, provider: provider.name, model: provider.model, created_at: new Date().toISOString() },
        proposal: { id: proposalId, action_type: "finance_review" as const, status: "proposed" as const, version: 1, payload },
      };
    });
  }

  async decideFinanceAiProposal(proposalId: string, decision: "confirm" | "reject", expectedVersion: number): Promise<{ proposal: FinanceAiProposal; execution: { formal_ledger_mutation: false } | null }> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "reconcile");
      await assertSensitivePermission(client, this.scope, "ai_finance_insight");
      const result = await client.query<Record<string, unknown>>(
        "SELECT ap.id::text AS id, ap.action_type, ap.status, ap.version, ap.payload FROM ai_action_proposal ap JOIN ai_insight ai ON ai.household_id = ap.household_id AND ai.id = ap.insight_id WHERE ap.household_id = $1 AND ap.id = $2 AND ai.scope_type = 'finance' FOR UPDATE",
        [this.scope.householdId, proposalId],
      );
      const row = requireRow(result.rows, "NOT_FOUND", "财务 AI 提案不存在或不属于当前家庭");
      if (String(row.status) !== "proposed") throw new DomainError("PROPOSAL_STATE_CONFLICT", "财务 AI 提案已被处理", 409);
      if (Number(row.version) !== expectedVersion) throw new DomainError("PROPOSAL_VERSION_CONFLICT", "财务 AI 提案版本已变化", 409);
      const nextStatus = decision === "confirm" ? "confirmed" : "rejected";
      const updated = await client.query<Record<string, unknown>>(
        "UPDATE ai_action_proposal SET status = $3, version = version + 1, decided_by = $4, decided_at = now(), updated_at = now() WHERE household_id = $1 AND id = $2 AND version = $5 RETURNING id::text AS id, action_type, status, version, payload",
        [this.scope.householdId, proposalId, nextStatus, this.scope.userId, expectedVersion],
      );
      const proposal = this.mapFinanceAiProposal(requireRow(updated.rows, "PROPOSAL_VERSION_CONFLICT", "财务 AI 提案版本已变化"));
      let execution: { formal_ledger_mutation: false } | null = null;
      if (decision === "confirm") {
        execution = { formal_ledger_mutation: false };
        await client.query("INSERT INTO ai_action_execution (id, household_id, proposal_id, executed_by, result) VALUES ($1, $2, $3, $4, $5::jsonb)", [randomUUID(), this.scope.householdId, proposalId, this.scope.userId, JSON.stringify(execution)]);
      }
      await writeFinanceAudit(client, this.scope, "finance_ai_" + decision, "ai_action_proposal", proposalId, { status: row.status, version: expectedVersion }, { status: nextStatus, formal_ledger_mutation: false });
      return { proposal, execution };
    });
  }

  async revokeFinanceAiProposal(proposalId: string): Promise<{ proposal: FinanceAiProposal }> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "reconcile");
      await assertSensitivePermission(client, this.scope, "ai_finance_insight");
      const result = await client.query<Record<string, unknown>>(
        "SELECT ap.id::text AS id, ap.action_type, ap.status, ap.version, ap.payload FROM ai_action_proposal ap JOIN ai_insight ai ON ai.household_id = ap.household_id AND ai.id = ap.insight_id WHERE ap.household_id = $1 AND ap.id = $2 AND ai.scope_type = 'finance' FOR UPDATE",
        [this.scope.householdId, proposalId],
      );
      const row = requireRow(result.rows, "NOT_FOUND", "财务 AI 提案不存在或不属于当前家庭");
      if (!["proposed", "confirmed"].includes(String(row.status))) throw new DomainError("PROPOSAL_STATE_CONFLICT", "当前财务 AI 提案不能撤销", 409);
      const updated = await client.query<Record<string, unknown>>(
        "UPDATE ai_action_proposal SET status = 'revoked', version = version + 1, decided_by = $3, decided_at = now(), updated_at = now() WHERE household_id = $1 AND id = $2 RETURNING id::text AS id, action_type, status, version, payload",
        [this.scope.householdId, proposalId, this.scope.userId],
      );
      const proposal = this.mapFinanceAiProposal(requireRow(updated.rows, "PROPOSAL_STATE_CONFLICT", "财务 AI 提案撤销失败"));
      await writeFinanceAudit(client, this.scope, "finance_ai_revoked", "ai_action_proposal", proposalId, { status: row.status }, { status: "revoked" });
      return { proposal };
    });
  }

  async createAssetEvent(assetId: string, input: { occurredAt: string; eventType: FinanceAssetEventType; amount: string; recoveryAmount: string; ledgerTransactionId?: string | null }): Promise<FinanceAssetEvent> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "edit");
      const assetResult = await client.query<Record<string, unknown>>(`SELECT id::text AS id, name, status FROM physical_asset WHERE household_id = $1 AND id = $2 FOR UPDATE`, [this.scope.householdId, assetId]);
      const asset = requireRow(assetResult.rows, "ASSET_NOT_FOUND", "资产不存在或不属于当前家庭");
      if (asset.status !== "held") throw new DomainError("ASSET_TERMINAL", "已转让、出售或处置的资产不能继续新增事件", 409);
      const occurredAt = safeDateTime(input.occurredAt);
      const amount = nonNegativeMoney(input.amount, "事件金额");
      const recoveryAmount = nonNegativeMoney(input.recoveryAmount, "回收金额");
      if (Number(recoveryAmount) > Number(amount) && input.eventType !== "sale") throw new DomainError("ASSET_RECOVERY_INVALID", "非出售事件的回收金额不能大于事件金额", 400);
      const ledgerTransactionId = input.ledgerTransactionId ? String(input.ledgerTransactionId) : null;
      if (ledgerTransactionId) {
        const transaction = await client.query(`SELECT 1 FROM ledger_transaction WHERE household_id = $1 AND id = $2 AND status = 'confirmed'`, [this.scope.householdId, ledgerTransactionId]);
        if (!transaction.rows[0]) throw new DomainError("TRANSACTION_NOT_FOUND", "关联账单不存在、未确认或不属于当前家庭", 404);
      }
      const id = randomUUID();
      const result = await client.query<FinanceAssetEvent>(
        `INSERT INTO asset_event (id, household_id, asset_id, occurred_at, event_type, amount, recovery_amount, ledger_transaction_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id::text AS id, asset_id::text AS asset_id, occurred_at::text AS occurred_at, event_type,
                   amount::text AS amount, recovery_amount::text AS recovery_amount, ledger_transaction_id::text AS ledger_transaction_id`,
        [id, this.scope.householdId, assetId, occurredAt, input.eventType, amount, recoveryAmount, ledgerTransactionId],
      );
      const event = requireRow(result.rows, "ASSET_EVENT_CREATE_FAILED", "资产事件创建失败");
      const nextStatus = input.eventType === "transfer" ? "transferred" : input.eventType === "sale" ? "sold" : input.eventType === "disposal" ? "disposed" : "held";
      await client.query(`UPDATE physical_asset SET status = $3, updated_at = now() WHERE household_id = $1 AND id = $2`, [this.scope.householdId, assetId, nextStatus]);
      await writeFinanceAudit(client, this.scope, "finance_asset_event_created", "asset_event", id, null, { asset_id: assetId, event_type: input.eventType, amount, recovery_amount: recoveryAmount, ledger_transaction_id: ledgerTransactionId, asset_status: nextStatus });
      return { ...event, event_type: event.event_type as FinanceAssetEventType, amount: String(event.amount), recovery_amount: String(event.recovery_amount), ledger_transaction_id: event.ledger_transaction_id ? String(event.ledger_transaction_id) : null };
    });
  }

  async createManualTransaction(input: ManualTransactionInput): Promise<{ transaction_id: string }> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "bookkeep");
      const idempotencyKey = nullableText(input.idempotencyKey);
      if (idempotencyKey) {
        const existing = await client.query<{ id: string }>(
          `SELECT id::text AS id FROM ledger_transaction
            WHERE household_id = $1 AND origin = 'manual' AND idempotency_key = $2`,
          [this.scope.householdId, idempotencyKey],
        );
        if (existing.rows[0]) return { transaction_id: existing.rows[0].id };
      }
      const occurredAt = safeDateTime(input.occurred_at);
      const amount = positiveMoney(input.amount, "金额");
      const currency = safeCurrency(input.currency);
      const account = await getActiveAccount(client, this.scope, input.account_id);
      const category = await getCategoryForTransaction(client, this.scope, input.category_id, input.direction);
      if (account.currency !== currency) throw new DomainError("ACCOUNT_CURRENCY_INVALID", "账户币种与交易币种不一致", 400);
      if (input.direction === "transfer") {
        if (!input.to_account_id || input.to_account_id === input.account_id) throw new DomainError("TRANSFER_ACCOUNT_INVALID", "转账必须选择两个不同账户", 400);
        const destination = await getActiveAccount(client, this.scope, input.to_account_id);
        if (destination.currency !== currency) throw new DomainError("ACCOUNT_CURRENCY_INVALID", "转账两端账户币种必须一致", 400);
      }
      const id = randomUUID();
      await client.query(
        `INSERT INTO ledger_transaction (id, household_id, occurred_at, direction, amount, currency, merchant, category, category_id, note, origin, status, created_by, updated_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'manual', 'confirmed', $11, $11, $12)`,
        [id, this.scope.householdId, occurredAt, input.direction, amount, currency, nullableText(input.merchant), category.name, category.id, nullableText(input.note), this.scope.userId, idempotencyKey],
      );
      await insertLedgerEntries(client, this.scope, id, { direction: input.direction, amount, accountId: account.id, toAccountId: input.to_account_id });
      await writeFinanceAudit(client, this.scope, "finance_transaction_created", "ledger_transaction", id, null, { origin: "manual", direction: input.direction, amount, currency, account_id: input.account_id, to_account_id: input.to_account_id ?? null, category_id: category.id });
      return { transaction_id: id };
    });
  }

  async listTransactions(input: { page: number; pageSize: number; start?: string; end?: string; direction?: "income" | "expense" | "transfer"; accountId?: string; importBatchId?: string }): Promise<FinanceTransactionList> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "view");
      const offset = (input.page - 1) * input.pageSize;
      const result = await client.query<Record<string, unknown>>(
        `SELECT lt.id::text AS id, lt.occurred_at::text AS occurred_at, lt.direction,
                lt.amount::text AS amount, lt.currency, COALESCE(lt.merchant, '') AS merchant,
                COALESCE(lt.category, '') AS category, lt.origin, lt.status,
                (SELECT le.account_id::text FROM ledger_entry le
                  WHERE le.household_id = lt.household_id AND le.ledger_transaction_id = lt.id
                  ORDER BY le.created_at LIMIT 1) AS account_id,
                COUNT(*) OVER()::int AS total_count
           FROM ledger_transaction lt
          WHERE lt.household_id = $1 AND lt.status <> 'voided'
            AND ($2::date IS NULL OR lt.occurred_at >= $2::date)
            AND ($3::date IS NULL OR lt.occurred_at < ($3::date + interval '1 day'))
            AND ($4::text IS NULL OR lt.direction = $4)
            AND ($5::uuid IS NULL OR EXISTS (
              SELECT 1 FROM ledger_entry le
               WHERE le.household_id = lt.household_id AND le.ledger_transaction_id = lt.id AND le.account_id = $5
            ))
            AND ($6::uuid IS NULL OR lt.import_batch_id = $6)
          ORDER BY lt.occurred_at DESC, lt.created_at DESC
          LIMIT $7 OFFSET $8`,
        [this.scope.householdId, input.start ?? null, input.end ?? null, input.direction ?? null, input.accountId ?? null, input.importBatchId ?? null, input.pageSize, offset],
      );
      return {
        items: result.rows.map((row) => ({
          id: String(row.id),
          occurred_at: String(row.occurred_at),
          direction: String(row.direction) as FinanceTransactionListItem["direction"],
          amount: String(row.amount),
          currency: String(row.currency),
          merchant: String(row.merchant ?? ""),
          category: String(row.category ?? ""),
          origin: String(row.origin) as FinanceTransactionListItem["origin"],
          status: String(row.status) as FinanceTransactionListItem["status"],
          account_id: row.account_id ? String(row.account_id) : null,
        })),
        pagination: { page: input.page, page_size: input.pageSize, total: asNumber(result.rows[0]?.total_count) },
      };
    });
  }

  async updateManualTransaction(transactionId: string, input: ManualTransactionInput): Promise<{ transaction_id: string }> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "edit");
      const currentResult = await client.query<Record<string, unknown>>(
        `SELECT id::text AS id, origin, status, occurred_at::text AS occurred_at, direction, amount::text AS amount,
                currency, merchant, category_id::text AS category_id, note
           FROM ledger_transaction
          WHERE household_id = $1 AND id = $2
          FOR UPDATE`,
        [this.scope.householdId, transactionId],
      );
      const current = requireRow(currentResult.rows, "TRANSACTION_NOT_FOUND", "账单不存在或不属于当前家庭");
      if (current.origin !== "manual") throw new DomainError("TRANSACTION_NOT_EDITABLE", "导入或系统账单不能通过手动记账入口编辑", 409);
      if (current.status === "voided") throw new DomainError("TRANSACTION_VOIDED", "已撤销账单不能再次编辑", 409);
      const occurredAt = safeDateTime(input.occurred_at);
      const amount = positiveMoney(input.amount, "金额");
      const currency = safeCurrency(input.currency);
      const account = await getActiveAccount(client, this.scope, input.account_id);
      const category = await getCategoryForTransaction(client, this.scope, input.category_id, input.direction);
      if (account.currency !== currency) throw new DomainError("ACCOUNT_CURRENCY_INVALID", "账户币种与交易币种不一致", 400);
      if (input.direction === "transfer") {
        if (!input.to_account_id || input.to_account_id === input.account_id) throw new DomainError("TRANSFER_ACCOUNT_INVALID", "转账必须选择两个不同账户", 400);
        const destination = await getActiveAccount(client, this.scope, input.to_account_id);
        if (destination.currency !== currency) throw new DomainError("ACCOUNT_CURRENCY_INVALID", "转账两端账户币种必须一致", 400);
      }
      await client.query("DELETE FROM ledger_entry WHERE household_id = $1 AND ledger_transaction_id = $2", [this.scope.householdId, transactionId]);
      await client.query(
        `UPDATE ledger_transaction
            SET occurred_at = $3, direction = $4, amount = $5, currency = $6, merchant = $7,
                category = $8, category_id = $9, note = $10, updated_by = $11, updated_at = now()
          WHERE household_id = $1 AND id = $2`,
        [this.scope.householdId, transactionId, occurredAt, input.direction, amount, currency, nullableText(input.merchant), category.name, category.id, nullableText(input.note), this.scope.userId],
      );
      await insertLedgerEntries(client, this.scope, transactionId, { direction: input.direction, amount, accountId: account.id, toAccountId: input.to_account_id });
      await writeFinanceAudit(client, this.scope, "finance_transaction_updated", "ledger_transaction", transactionId, { occurred_at: current.occurred_at, direction: current.direction, amount: current.amount, currency: current.currency, merchant: current.merchant, category_id: current.category_id, note: current.note }, { occurred_at: occurredAt, direction: input.direction, amount, currency, merchant: input.merchant ?? null, category_id: category.id, note: input.note ?? null });
      return { transaction_id: transactionId };
    });
  }

  async voidManualTransaction(transactionId: string, reason: string): Promise<{ transaction_id: string }> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "edit");
      const currentResult = await client.query<Record<string, unknown>>(
        `SELECT id::text AS id, origin, status, direction, amount::text AS amount, currency, merchant, category_id::text AS category_id
           FROM ledger_transaction
          WHERE household_id = $1 AND id = $2
          FOR UPDATE`,
        [this.scope.householdId, transactionId],
      );
      const current = requireRow(currentResult.rows, "TRANSACTION_NOT_FOUND", "账单不存在或不属于当前家庭");
      if (current.origin !== "manual") throw new DomainError("TRANSACTION_NOT_VOIDABLE", "导入账单请从导入批次执行撤销", 409);
      if (current.status === "voided") return { transaction_id: transactionId };
      const normalizedReason = String(reason ?? "").trim();
      if (!normalizedReason || normalizedReason.length > 500) throw new DomainError("INVALID_VOID_REASON", "撤销原因不能为空且不能超过 500 个字符", 400);
      await client.query(
        `UPDATE ledger_transaction
            SET status = 'voided', voided_at = now(), voided_by = $3, void_reason = $4, updated_by = $3, updated_at = now()
          WHERE household_id = $1 AND id = $2`,
        [this.scope.householdId, transactionId, this.scope.userId, normalizedReason],
      );
      await writeFinanceAudit(client, this.scope, "finance_transaction_voided", "ledger_transaction", transactionId, { status: current.status, direction: current.direction, amount: current.amount, currency: current.currency, merchant: current.merchant, category_id: current.category_id }, { status: "voided", reason: normalizedReason });
      return { transaction_id: transactionId };
    });
  }

  async getOverview(start: string, end: string, granularity: string): Promise<FinanceOverview> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "view");
      const summary = await client.query<{ income: string; expense: string; net_cash_flow: string }>(
        `SELECT
           COALESCE(SUM(amount) FILTER (WHERE direction = 'income'), 0)::text AS income,
           COALESCE(SUM(amount) FILTER (WHERE direction = 'expense'), 0)::text AS expense,
           COALESCE(SUM(CASE WHEN direction = 'income' THEN amount WHEN direction = 'expense' THEN -amount ELSE 0 END), 0)::text AS net_cash_flow
           FROM ledger_transaction
          WHERE household_id = $1 AND status = 'confirmed'
            AND occurred_at >= $2::date AND occurred_at < ($3::date + interval '1 day')
            AND currency = 'CNY'`,
        [this.scope.householdId, start, end],
      );
      const summaryRow = requireRow(summary.rows, "FINANCE_QUERY_FAILED", "无法读取财务汇总");
      const granularitySpec = normalizeFinanceGranularity(granularity);
      const accountBalanceResult = await client.query<{ account_balance: string }>(
        `SELECT COALESCE(SUM(fa.opening_balance + COALESCE((
                  SELECT SUM(CASE WHEN le.entry_side = 'debit' THEN le.amount ELSE -le.amount END)
                    FROM ledger_entry le
                    JOIN ledger_transaction lt ON lt.household_id = le.household_id AND lt.id = le.ledger_transaction_id
                   WHERE le.household_id = fa.household_id AND le.account_id = fa.id AND lt.status = 'confirmed'
                ), 0)), 0)::numeric(20,4)::text AS account_balance
           FROM financial_account fa
          WHERE fa.household_id = $1 AND fa.status = 'active' AND fa.currency = 'CNY'`,
        [this.scope.householdId],
      );
      const previousAccountBalanceResult = await client.query<{ account_balance: string }>(
        `SELECT COALESCE(SUM(fa.opening_balance + COALESCE((
                  SELECT SUM(CASE WHEN le.entry_side = 'debit' THEN le.amount ELSE -le.amount END)
                    FROM ledger_entry le
                    JOIN ledger_transaction lt ON lt.household_id = le.household_id AND lt.id = le.ledger_transaction_id
                   WHERE le.household_id = fa.household_id AND le.account_id = fa.id AND lt.status = 'confirmed'
                     AND lt.occurred_at < $2::date
                ), 0)), 0)::numeric(20,4)::text AS account_balance
           FROM financial_account fa
          WHERE fa.household_id = $1 AND fa.status = 'active' AND fa.currency = 'CNY'`,
        [this.scope.householdId, start],
      );
      const heldAssetResult = await client.query<{ held_asset_cost: string }>(
        `SELECT COALESCE(SUM(ae.amount - ae.recovery_amount), 0)::numeric(20,4)::text AS held_asset_cost
           FROM physical_asset pa
           LEFT JOIN asset_event ae ON ae.household_id = pa.household_id AND ae.asset_id = pa.id
          WHERE pa.household_id = $1 AND pa.status = 'held'`,
        [this.scope.householdId],
      );
      const pendingImportResult = await client.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*)::text AS count
           FROM import_batch
          WHERE household_id = $1
            AND status IN ('header_detected', 'mapping_pending', 'normalized', 'matching', 'reconciliation_pending', 'confirmed')
          GROUP BY status
          ORDER BY status`,
        [this.scope.householdId],
      );
      const budgetResult = await client.query<{ category: string; category_id: string; label: string; limit: string; used: string; color_token: string }>(
        `SELECT c.name AS category, c.id::text AS category_id, c.name AS label,
                COALESCE(SUM(bp.amount), 0)::text AS limit,
                COALESCE(SUM(lt.amount) FILTER (WHERE lt.direction = 'expense' AND lt.status = 'confirmed'), 0)::text AS used,
                c.color_token
           FROM budget_period bp
           JOIN budget b ON b.household_id = bp.household_id AND b.id = bp.budget_id
           JOIN category c ON c.household_id = b.household_id AND c.id = b.category_id
           LEFT JOIN ledger_transaction lt
             ON lt.household_id = bp.household_id
            AND (lt.category_id = c.id OR (lt.category_id IS NULL AND lt.category = c.name))
            AND lt.occurred_at >= $2::date
            AND lt.occurred_at < ($3::date + interval '1 day')
          WHERE bp.household_id = $1
            AND b.status = 'active' AND c.status = 'active'
            AND bp.period_start <= $3::date
            AND bp.period_end >= $2::date
          GROUP BY c.id, c.name, c.color_token
          ORDER BY c.name`,
        [this.scope.householdId, start, end],
      );
      const budgetTotals = await client.query<{ total_limit: string; total_used: string }>(
        `SELECT COALESCE(SUM(bp.amount), 0)::text AS total_limit,
                COALESCE(SUM(lt.amount) FILTER (WHERE lt.direction = 'expense' AND lt.status = 'confirmed'), 0)::text AS total_used
           FROM budget_period bp
           JOIN budget b ON b.household_id = bp.household_id AND b.id = bp.budget_id
           JOIN category c ON c.household_id = b.household_id AND c.id = b.category_id
           LEFT JOIN ledger_transaction lt
             ON lt.household_id = bp.household_id
            AND (lt.category_id = c.id OR (lt.category_id IS NULL AND lt.category = c.name))
            AND lt.occurred_at >= $2::date
            AND lt.occurred_at < ($3::date + interval '1 day')
          WHERE bp.household_id = $1
            AND b.status = 'active' AND c.status = 'active'
            AND bp.period_start <= $3::date
            AND bp.period_end >= $2::date`,
        [this.scope.householdId, start, end],
      );
      const trendResult = await client.query<{ bucket: string; drilldown_start: string; drilldown_end: string; income: string; expense: string; net_cash_flow: string }>(
        `WITH buckets AS (
           SELECT date_trunc('${granularitySpec.dateTruncUnit}', d)::date AS bucket
             FROM generate_series($2::date, $3::date, interval '${granularitySpec.step}') AS d
            GROUP BY 1
         )
         SELECT b.bucket::text AS bucket,
                GREATEST(b.bucket, $2::date)::text AS drilldown_start,
                LEAST((b.bucket + interval '${granularitySpec.step}' - interval '1 day')::date, $3::date)::text AS drilldown_end,
                COALESCE(SUM(lt.amount) FILTER (WHERE lt.direction = 'income'), 0)::text AS income,
                COALESCE(SUM(lt.amount) FILTER (WHERE lt.direction = 'expense'), 0)::text AS expense,
                COALESCE(SUM(CASE WHEN lt.direction = 'income' THEN lt.amount WHEN lt.direction = 'expense' THEN -lt.amount ELSE 0 END), 0)::text AS net_cash_flow
           FROM buckets b
           LEFT JOIN ledger_transaction lt
             ON lt.household_id = $1
            AND lt.status = 'confirmed'
            AND lt.occurred_at >= $2::date
            AND lt.occurred_at < ($3::date + interval '1 day')
            AND lt.occurred_at >= b.bucket
            AND lt.occurred_at < b.bucket + interval '${granularitySpec.step}'
          GROUP BY b.bucket
          ORDER BY b.bucket`,
        [this.scope.householdId, start, end],
      );
      const assetsResult = await client.query<{ bucket: string; drilldown_start: string; drilldown_end: string; purchase_cost: string; maintenance_cost: string; gross_cost: string; recovery: string; net_cash_cost: string }>(
        `WITH buckets AS (
           SELECT date_trunc('${granularitySpec.dateTruncUnit}', d)::date AS bucket
             FROM generate_series($2::date, $3::date, interval '${granularitySpec.step}') AS d
            GROUP BY 1
         )
         SELECT b.bucket::text AS bucket,
                GREATEST(b.bucket, $2::date)::text AS drilldown_start,
                LEAST((b.bucket + interval '${granularitySpec.step}' - interval '1 day')::date, $3::date)::text AS drilldown_end,
                COALESCE(SUM(ae.amount) FILTER (WHERE ae.event_type = 'purchase'), 0)::text AS purchase_cost,
                COALESCE(SUM(ae.amount) FILTER (WHERE ae.event_type = 'maintenance'), 0)::text AS maintenance_cost,
                COALESCE(SUM(ae.amount), 0)::text AS gross_cost,
                COALESCE(SUM(ae.recovery_amount), 0)::text AS recovery,
                COALESCE(SUM(ae.amount - ae.recovery_amount), 0)::text AS net_cash_cost
           FROM buckets b
           JOIN asset_event ae
             ON ae.household_id = $1
            AND ae.occurred_at >= $2::date
            AND ae.occurred_at < ($3::date + interval '1 day')
            AND ae.occurred_at >= b.bucket
            AND ae.occurred_at < b.bucket + interval '${granularitySpec.step}'
          GROUP BY b.bucket
          ORDER BY b.bucket`,
        [this.scope.householdId, start, end],
      );
      const assetTotalResult = await client.query<{ bucket: string; drilldown_start: string; drilldown_end: string; total_asset: string }>(
        `WITH buckets AS (
           SELECT date_trunc('${granularitySpec.dateTruncUnit}', d)::date AS bucket
             FROM generate_series($2::date, $3::date, interval '${granularitySpec.step}') AS d
            GROUP BY 1
         ), account_balances AS (
           SELECT b.bucket,
                  COALESCE(SUM(fa.opening_balance + COALESCE((
                    SELECT SUM(CASE WHEN le.entry_side = 'debit' THEN le.amount ELSE -le.amount END)
                      FROM ledger_entry le
                      JOIN ledger_transaction lt ON lt.household_id = le.household_id AND lt.id = le.ledger_transaction_id
                     WHERE le.household_id = fa.household_id AND le.account_id = fa.id AND lt.status = 'confirmed'
                       AND lt.occurred_at < (b.bucket + interval '${granularitySpec.step}')
                  ), 0)), 0)::numeric(20,4) AS account_balance
             FROM buckets b
             CROSS JOIN financial_account fa
            WHERE fa.household_id = $1 AND fa.status = 'active' AND fa.currency = 'CNY'
            GROUP BY b.bucket
         ), physical_assets AS (
           SELECT b.bucket,
                  COALESCE(SUM(ae.amount - ae.recovery_amount) FILTER (WHERE ae.occurred_at < (b.bucket + interval '${granularitySpec.step}')), 0)::numeric(20,4) AS physical_asset
             FROM buckets b
             LEFT JOIN physical_asset pa ON pa.household_id = $1 AND pa.status = 'held'
             LEFT JOIN asset_event ae ON ae.household_id = pa.household_id AND ae.asset_id = pa.id
            GROUP BY b.bucket
         )
         SELECT b.bucket::text AS bucket,
                GREATEST(b.bucket, $2::date)::text AS drilldown_start,
                LEAST((b.bucket + interval '${granularitySpec.step}' - interval '1 day')::date, $3::date)::text AS drilldown_end,
                (COALESCE(ab.account_balance, 0) + COALESCE(pa.physical_asset, 0))::numeric(20,4)::text AS total_asset
           FROM buckets b
           LEFT JOIN account_balances ab ON ab.bucket = b.bucket
           LEFT JOIN physical_assets pa ON pa.bucket = b.bucket
          ORDER BY b.bucket`,
        [this.scope.householdId, start, end],
      );

      const incomeRef = await insertFilter(client, this.scope, "ledger_direction", { direction: "income", start, end });
      const expenseRef = await insertFilter(client, this.scope, "ledger_direction", { direction: "expense", start, end });
      const netRef = await insertFilter(client, this.scope, "ledger_period", { start, end });
      const accountBalanceRef = await insertFilter(client, this.scope, "ledger_period", { start, end, scope: "account_balance" });
      const netAssetRef = await insertFilter(client, this.scope, "ledger_period", { start, end, scope: "net_asset" });
      const budgetCenterRef = await insertFilter(client, this.scope, "ledger_period", { start, end, scope: "budget" });
      const trendContainerRef = await insertFilter(client, this.scope, "ledger_period", { start, end, granularity });
      const assetContainerRef = await insertFilter(client, this.scope, "asset_period", { start, end, granularity });

      const budgetRings: FinanceOverview["budget_rings"] = [];
      for (const row of budgetResult.rows) {
        const limit = asMoney(row.limit);
        const used = asMoney(row.used);
        const progress = asNumber(limit) === 0 ? 0 : Math.min(100, Math.round((asNumber(used) / asNumber(limit)) * 100));
        budgetRings.push({
          category: row.category,
          category_id: row.category_id,
          label: row.label,
          limit,
          used,
          progress,
          color_token: row.color_token,
          drilldown_ref: await insertFilter(client, this.scope, "budget_category", { category: row.category, category_id: row.category_id, start, end }),
        });
      }
      if (budgetRings.length > 6) {
        const groupDrilldownRef = await insertFilter(client, this.scope, "budget_category_group", { category_ids: budgetRings.slice(5).map((item) => item.category_id).join(","), start, end });
        budgetRings.slice(5).forEach((item) => { item.group_drilldown_ref = groupDrilldownRef; });
      }

      const trendPoints = [];
      for (const row of trendResult.rows) {
        trendPoints.push({
          bucket: row.bucket,
          income: asMoney(row.income),
          expense: asMoney(row.expense),
          net_cash_flow: asMoney(row.net_cash_flow),
          drilldown_ref: await insertFilter(client, this.scope, "ledger_period", { start: row.drilldown_start, end: row.drilldown_end, granularity }),
        });
      }

      const assetPoints = [];
      for (const row of assetsResult.rows) {
        assetPoints.push({
          bucket: row.bucket,
          purchase_cost: asMoney(row.purchase_cost),
          maintenance_cost: asMoney(row.maintenance_cost),
          gross_cost: asMoney(row.gross_cost),
          recovery: asMoney(row.recovery),
          net_cash_cost: asMoney(row.net_cash_cost),
          drilldown_ref: await insertFilter(client, this.scope, granularitySpec.value === "day" ? "asset_day" : "asset_period", granularitySpec.value === "day" ? { day: row.bucket } : { start: row.drilldown_start, end: row.drilldown_end, granularity }),
        });
      }

      const assetTotalPoints = [];
      for (const row of assetTotalResult.rows) {
        assetTotalPoints.push({
          bucket: row.bucket,
          total_asset: asMoney(row.total_asset),
          drilldown_ref: await insertFilter(client, this.scope, granularitySpec.value === "day" ? "asset_day" : "asset_period", granularitySpec.value === "day" ? { day: row.bucket } : { start: row.drilldown_start, end: row.drilldown_end, granularity }),
        });
      }

      const pendingImportCount = pendingImportResult.rows.reduce((sum, row) => sum + asNumber(row.count), 0);
      const overBudgetRows = budgetRings.filter((row) => row.progress >= 100);
      const attentionItems: FinanceAttentionItem[] = [];
      if (pendingImportCount > 0) {
        attentionItems.push({
          key: "import_review",
          label: "待处理导入",
          detail: `${pendingImportCount} 个账单批次需要继续确认或关联审核`,
          count: pendingImportCount,
          severity: "warning",
          action: "import",
          drilldown_ref: null,
        });
      }
      if (overBudgetRows.length > 0) {
        attentionItems.push({
          key: "budget_overrun",
          label: "预算超支",
          detail: `${overBudgetRows.length} 个预算分类已达到或超过额度`,
          count: overBudgetRows.length,
          severity: "danger",
          action: "budget",
          drilldown_ref: budgetCenterRef,
        });
      }
      const accountBalance = asMoney(accountBalanceResult.rows[0]?.account_balance);
      const previousAccountBalance = asMoney(previousAccountBalanceResult.rows[0]?.account_balance);
      const accountBalanceDelta = asNumber(accountBalance) - asNumber(previousAccountBalance);
      const accountBalanceRate = asNumber(previousAccountBalance) === 0 ? null : ((accountBalanceDelta / Math.abs(asNumber(previousAccountBalance))) * 100).toFixed(1);
      const netAsset = (asNumber(accountBalance) + asNumber(heldAssetResult.rows[0]?.held_asset_cost)).toFixed(4);

      return {
        period: { start, end, timezone: "Asia/Shanghai" },
        granularity: granularitySpec.value,
        summary_cards: [
          { key: "net_asset", value: netAsset, currency: "CNY", drilldown_ref: netAssetRef },
          { key: "account_balance", value: accountBalance, currency: "CNY", drilldown_ref: accountBalanceRef },
          { key: "income", value: asMoney(summaryRow.income), currency: "CNY", drilldown_ref: incomeRef },
          { key: "expense", value: asMoney(summaryRow.expense), currency: "CNY", drilldown_ref: expenseRef },
          { key: "net_cash_flow", value: asMoney(summaryRow.net_cash_flow), currency: "CNY", drilldown_ref: netRef },
        ],
        account_balance_change: { amount: accountBalanceDelta.toFixed(4), rate: accountBalanceRate, comparison_label: "较上月" },
        attention_items: attentionItems,
        budget_center: {
          label: `${start} 至 ${end} 预算`,
          total_limit: asMoney(budgetTotals.rows[0]?.total_limit),
          total_used: asMoney(budgetTotals.rows[0]?.total_used),
          progress: asNumber(budgetTotals.rows[0]?.total_limit) === 0 ? 0 : Math.min(100, Math.round((asNumber(budgetTotals.rows[0]?.total_used) / asNumber(budgetTotals.rows[0]?.total_limit)) * 100)),
          drilldown_ref: budgetCenterRef,
        },
        budget_rings: budgetRings,
        trend_container: { drilldown_ref: trendContainerRef },
        trend_points: trendPoints,
        asset_cost_container: { drilldown_ref: assetContainerRef },
        asset_cost_points: assetPoints,
        asset_total_points: assetTotalPoints,
      };
    });
  }

  async getDrilldown(filterId: string, page: number, pageSize: number): Promise<FinanceDrilldown | null> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "view");
      const filterResult = await client.query<FilterRow>(
        `SELECT id::text AS id, filter_type, filters
           FROM finance_drilldown_filter
          WHERE household_id = $1 AND id = $2 AND expires_at > now()`,
        [this.scope.householdId, filterId],
      );
      const filter = filterResult.rows[0];
      if (!filter) return null;
      const filters = asJsonObject(filter.filters);
      const offset = (page - 1) * pageSize;
      if (filter.filter_type === "asset_day" || filter.filter_type === "asset_period") {
        const day = filters.day;
        const result = await client.query<Record<string, unknown>>(
          `SELECT ae.id::text, ae.asset_id::text, pa.name AS asset_name, ae.occurred_at::text, ae.event_type,
                  ae.amount::text, ae.recovery_amount::text, ae.ledger_transaction_id::text,
                  COUNT(*) OVER()::int AS total_count
             FROM asset_event ae
             JOIN physical_asset pa ON pa.household_id = ae.household_id AND pa.id = ae.asset_id
            WHERE ae.household_id = $1
              AND (($2::text IS NULL AND ae.occurred_at >= $3::date AND ae.occurred_at < ($4::date + interval '1 day'))
                   OR ($2::text IS NOT NULL AND ae.occurred_at >= $2::date AND ae.occurred_at < ($2::date + interval '1 day')))
            ORDER BY ae.occurred_at DESC
            LIMIT $5 OFFSET $6`,
          [this.scope.householdId, day ?? null, filters.start ?? filters.day ?? "1970-01-01", filters.end ?? filters.day ?? "1970-01-01", pageSize, offset],
        );
        return { filter: { type: filter.filter_type, filter_id: filter.id, filters }, items: result.rows, pagination: { page, page_size: pageSize, total: asNumber(result.rows[0]?.total_count) } };
      }

      const direction = filter.filter_type === "ledger_direction" ? filters.direction ?? null : null;
      const category = filter.filter_type === "budget_category" ? filters.category ?? null : null;
      const categoryId = filter.filter_type === "budget_category" ? filters.category_id ?? null : null;
      const categoryIds = filter.filter_type === "budget_category_group" && filters.category_ids ? String(filters.category_ids).split(",").filter(Boolean) : [];
      const result = await client.query<Record<string, unknown>>(
        `SELECT lt.id::text, lt.occurred_at::text, lt.direction, lt.amount::text, lt.currency,
                lt.merchant, lt.category, COUNT(sr.id)::int AS source_count,
                COUNT(*) OVER()::int AS total_count
           FROM ledger_transaction lt
           LEFT JOIN source_record sr ON sr.household_id = lt.household_id AND sr.id = lt.primary_source_record_id
          WHERE lt.household_id = $1 AND lt.status = 'confirmed'
            AND lt.occurred_at >= $2::date AND lt.occurred_at < ($3::date + interval '1 day')
            AND ($4::text IS NULL OR lt.direction = $4)
            AND ($5::text IS NULL OR lt.category = $5 OR lt.category_id = $6::uuid OR (cardinality($7::uuid[]) > 0 AND lt.category_id = ANY($7::uuid[])))
          GROUP BY lt.id
          ORDER BY lt.occurred_at DESC
            LIMIT $8 OFFSET $9`,
        [this.scope.householdId, filters.start ?? "1970-01-01", filters.end ?? "9999-12-31", direction, category, categoryId, categoryIds, pageSize, offset],
      );
      return { filter: { type: filter.filter_type, filter_id: filter.id, filters }, items: result.rows, pagination: { page, page_size: pageSize, total: asNumber(result.rows[0]?.total_count) } };
    });
  }

  async getTransactionDetail(transactionId: string): Promise<FinanceTransactionDetail | null> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "view");
      const transaction = await client.query<{ id: string; occurred_at: string; direction: "income" | "expense" | "transfer"; amount: string; currency: string; merchant: string | null; category: string | null; category_id: string | null; origin: "import" | "manual" | "system"; status: "confirmed" | "pending_account" | "reversed" | "voided"; note: string | null; primary_source_record_id: string | null }>(
        `SELECT id::text AS id, occurred_at::text, direction, amount::text, currency,
                COALESCE(merchant, '') AS merchant, COALESCE(category, '') AS category, category_id::text AS category_id,
                origin, status, COALESCE(note, '') AS note, primary_source_record_id::text
           FROM ledger_transaction
          WHERE household_id = $1 AND id = $2 AND status <> 'voided'`,
        [this.scope.householdId, transactionId],
      );
      const row = transaction.rows[0];
      if (!row) return null;
      const primarySourceRecordId = row.primary_source_record_id || null;

      const entries = await client.query<{ account_id: string; amount: string; entry_side: "debit" | "credit" }>(
        `SELECT account_id::text, amount::text, entry_side
           FROM ledger_entry
          WHERE household_id = $1 AND ledger_transaction_id = $2
          ORDER BY created_at`,
        [this.scope.householdId, transactionId],
      );
      const sources = await client.query<{ id: string; source_type: string; detail_level: "anchor" | "detail" | "original"; merchant_detail: string; order_reference: string }>(
        `SELECT sr.id::text AS id, fs.source_type,
                CASE WHEN sr.id = lt.primary_source_record_id THEN 'anchor' ELSE 'detail' END AS detail_level,
                COALESCE(sr.merchant, '') AS merchant_detail,
                COALESCE(sr.external_id, '') AS order_reference
           FROM ledger_transaction lt
           JOIN source_record sr
             ON sr.household_id = lt.household_id
            AND (sr.id = lt.primary_source_record_id OR EXISTS (
              SELECT 1 FROM transaction_link tl
               WHERE tl.household_id = lt.household_id
                 AND ((tl.left_source_record_id = lt.primary_source_record_id AND tl.right_source_record_id = sr.id)
                   OR (tl.right_source_record_id = lt.primary_source_record_id AND tl.left_source_record_id = sr.id))
            ))
           JOIN financial_source fs ON fs.household_id = sr.household_id AND fs.id = sr.source_id
          WHERE lt.household_id = $1 AND lt.id = $2
          ORDER BY CASE WHEN sr.id = lt.primary_source_record_id THEN 0 ELSE 1 END, sr.created_at`,
        [this.scope.householdId, transactionId],
      );
      const links = primarySourceRecordId
        ? await client.query<{ id: string; link_type: string; status: string; confidence: number; reason_codes: unknown }>(
            `SELECT id::text, link_type, status, confidence::float, reason_codes
               FROM transaction_link
              WHERE household_id = $1 AND (left_source_record_id = $2 OR right_source_record_id = $2)
              ORDER BY created_at`,
            [this.scope.householdId, primarySourceRecordId],
          )
        : { rows: [] as Array<{ id: string; link_type: string; status: string; confidence: number; reason_codes: unknown }> };

      return {
        id: row.id,
        occurred_at: row.occurred_at,
        direction: row.direction,
        amount: row.amount,
        currency: row.currency,
        merchant: row.merchant ?? "",
        category: row.category ?? "",
        category_id: row.category_id,
        origin: row.origin,
        status: row.status,
        note: row.note ?? "",
        source_count: sources.rows.length,
        entries: entries.rows.map((entry) => ({ account_id: entry.account_id, amount: entry.amount, entry_side: entry.entry_side })),
        source_records: sources.rows,
        transaction_links: links.rows.map((item) => ({
          id: item.id,
          link_type: item.link_type,
          status: item.status,
          confidence: asNumber(item.confidence),
          reason_codes: Array.isArray(item.reason_codes) ? item.reason_codes.map(String) : [],
        })),
      };
    });
  }

  async createImportBatch(input: CreateImportBatchInput): Promise<ImportBatch> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "import");
      const source = await client.query<{ id: string }>(
        `INSERT INTO financial_source (id, household_id, source_type, display_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (household_id, source_type, display_name) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id::text AS id`,
        [randomUUID(), this.scope.householdId, input.sourceType, input.sourceType],
      );
      const sourceRow = requireRow(source.rows, "SOURCE_CREATE_FAILED", "无法创建账单来源");
      const batchId = randomUUID();
      const batch = await client.query<{ id: string }>(
        `INSERT INTO import_batch (id, household_id, source_id, file_name, file_sha256, object_key, status, raw_retention_until, created_by, file_size)
         VALUES ($1, $2, $3, $4, $5, $6, 'created', now() + interval '365 days', $7, $8)
         RETURNING id::text AS id`,
        [batchId, this.scope.householdId, sourceRow.id, input.fileName, input.fileSha256.toLowerCase(), importObjectKey(this.scope.householdId, batchId), this.scope.userId, input.fileSize],
      );
      const batchRow = requireRow(batch.rows, "IMPORT_CREATE_FAILED", "无法创建导入批次");
      return this.getBatchInTransaction(client, batchRow.id);
    });
  }

  async markImportBatchUploaded(batchId: string, input: UploadImportInput): Promise<ImportBatch> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "import");
      const current = await client.query<{ status: ImportStatus; file_sha256: string; file_size: number }>(
        `SELECT status, file_sha256, COALESCE(file_size, 0)::int AS file_size
           FROM import_batch
          WHERE household_id = $1 AND id = $2
          FOR UPDATE`,
        [this.scope.householdId, batchId],
      );
      const currentRow = requireRow(current.rows, "NOT_FOUND", "导入批次不存在");
      if (Number(currentRow.file_size) !== input.actualSize) throw new DomainError("IMPORT_FILE_SIZE_MISMATCH", "文件大小与创建批次时不一致", 409);
      if (String(currentRow.file_sha256).toLowerCase() !== input.actualSha256.toLowerCase()) throw new DomainError("IMPORT_FILE_HASH_MISMATCH", "文件摘要与创建批次时不一致", 409);
      if (currentRow.status === "uploaded") return this.getBatchInTransaction(client, batchId);
      if (currentRow.status !== "created") throw new DomainError("IMPORT_STATE_CONFLICT", "当前批次不能上传原始文件", 409);
      await client.query(
        `UPDATE import_batch SET status = 'uploaded', version = version + 1, updated_at = now()
          WHERE household_id = $1 AND id = $2`,
        [this.scope.householdId, batchId],
      );
      return this.getBatchInTransaction(client, batchId);
    });
  }

  async getImportBatch(batchId: string): Promise<ImportBatch | null> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "view");
      return this.getBatchInTransaction(client, batchId, false);
    });
  }

  async listImportBatches(limit = 20): Promise<ImportBatch[]> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "view");
      const result = await client.query<BatchRow>(batchListSelectSql(), [this.scope.householdId, Math.min(Math.max(limit, 1), 50)]);
      return result.rows.map(mapBatch);
    });
  }

  async listImportErrors(batchId: string, limit = 200): Promise<ImportErrorRow[]> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "view");
      const result = await client.query<{ row_number: number; status: string; error_codes: unknown; normalized_payload: unknown }>(
        `SELECT ir.source_row_number AS row_number, ir.status, ir.error_codes, ir.normalized_payload
           FROM import_row ir
          WHERE ir.household_id = $1 AND ir.import_batch_id = $2 AND ir.status = 'invalid'
          ORDER BY ir.source_row_number
          LIMIT $3`,
        [this.scope.householdId, batchId, Math.min(Math.max(limit, 1), 500)],
      );
      return result.rows.map((row) => ({
        row_number: Number(row.row_number),
        status: String(row.status),
        error_codes: Array.isArray(row.error_codes) ? row.error_codes.map(String) : [],
        normalized_payload: (row.normalized_payload ?? {}) as Record<string, unknown>,
      }));
    });
  }

  async stageParsedImport(batchId: string, parsed: ParsedImportResult): Promise<ImportBatch> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "import");
      const batchResult = await client.query<{ status: ImportStatus; source_id: string; file_name: string }>(
        `SELECT status, source_id::text AS source_id, file_name
           FROM import_batch
          WHERE household_id = $1 AND id = $2
          FOR UPDATE`,
        [this.scope.householdId, batchId],
      );
      const batch = requireRow(batchResult.rows, "NOT_FOUND", "导入批次不存在");
      if (!["uploaded", "scanning", "header_detected"].includes(batch.status)) {
        if (["mapping_pending", "normalized", "matching", "reconciliation_pending", "confirmed", "committed"].includes(batch.status)) return this.getBatchInTransaction(client, batchId);
        throw new DomainError("IMPORT_STATE_CONFLICT", "当前批次不能进入解析阶段", 409);
      }

      const rawObjectKey = importObjectKey(this.scope.householdId, batchId);
      for (const [index, record] of parsed.records.entries()) {
        const sourceRowNumber = index + 1;
        // Rows without a stable external ID are weak duplicates, not safe
        // canonical duplicates. Keep their original row identity so two
        // legitimate same-day purchases are not collapsed by the fingerprint
        // uniqueness constraint; re-importing the same row remains idempotent.
        const sourceFingerprint = record.external_id ? record.source_fingerprint : `${record.source_fingerprint}:row:${record.source_row_number}`;
        const payload = { ...record, source_row_number: record.source_row_number, source_fingerprint: sourceFingerprint, parser_version: parsed.parser_version };
        const importRow = await client.query<{ id: string }>(
          `INSERT INTO import_row (id, household_id, import_batch_id, source_row_number, normalized_payload, status)
           VALUES ($1, $2, $3, $4, $5::jsonb, 'parsed')
           ON CONFLICT (household_id, import_batch_id, source_row_number)
           DO UPDATE SET normalized_payload = EXCLUDED.normalized_payload, status = 'parsed'
           RETURNING id::text AS id`,
          [randomUUID(), this.scope.householdId, batchId, sourceRowNumber, JSON.stringify(payload)],
        );
        const importRowId = requireRow(importRow.rows, "IMPORT_ROW_WRITE_FAILED", "无法写入导入行").id;
        const sourceRecord = await client.query<{ id: string }>(
          `INSERT INTO source_record (id, household_id, source_id, import_batch_id, import_row_id, external_id,
                                      source_fingerprint, occurred_at, direction, amount, currency, merchant, channel,
                                      remark, raw_object_key, raw_row_number)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           ON CONFLICT (household_id, source_id, source_fingerprint) DO NOTHING
           RETURNING id::text AS id`,
          [
            randomUUID(),
            this.scope.householdId,
            batch.source_id,
            batchId,
            importRowId,
            nullableText(record.external_id),
            sourceFingerprint,
            record.occurred_at,
            record.direction,
            record.amount,
            record.currency || "CNY",
            nullableText(record.merchant),
            nullableText(record.channel),
            nullableText(record.remark),
            rawObjectKey,
            record.source_row_number,
          ],
        );
        // A same-source re-import keeps the original canonical source row. The
        // current import_row still records that this raw row was observed.
        if (!sourceRecord.rows[0]) {
          await client.query(
            `SELECT id FROM source_record
              WHERE household_id = $1 AND source_id = $2 AND source_fingerprint = $3`,
            [this.scope.householdId, batch.source_id, record.source_fingerprint],
          );
        }
      }

      const firstSheet = parsed.sheets.find((sheet) => sheet.records.length > 0) ?? parsed.sheets[0];
      const headerPreview = {
        sheets: parsed.sheets.map((sheet) => ({
          sheet_name: sheet.sheet_name,
          header_row: sheet.header_row,
          data_start_row: sheet.data_start_row,
          header_score: sheet.header_score,
          field_mapping: sheet.field_mapping,
          preview_rows: sheet.preview_rows,
          skipped_rows: sheet.skipped_rows,
          ...(sheet.empty ? { empty: true } : {}),
        })),
      };
      await client.query(
        `UPDATE import_batch
            SET status = 'header_detected', detected_sheet = $3, detected_header_row = $4,
                data_start_row = $5, parser_version = $6, field_mapping = $7::jsonb,
                header_preview = $8::jsonb,
                version = version + 1, updated_at = now()
          WHERE household_id = $1 AND id = $2`,
        [
          this.scope.householdId,
          batchId,
          firstSheet?.sheet_name ?? parsed.detected_sheet,
          firstSheet?.header_row ?? parsed.detected_header_row,
          firstSheet?.data_start_row ?? null,
          parsed.parser_version,
          JSON.stringify(firstSheet?.field_mapping ?? {}),
          JSON.stringify(headerPreview),
        ],
      );
      return this.getBatchInTransaction(client, batchId);
    });
  }

  async confirmHeader(batchId: string, input: HeaderConfirmationInput): Promise<ImportBatch> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "import");
      const result = await client.query(
        `UPDATE import_batch
            SET status = 'mapping_pending', detected_sheet = $3, detected_header_row = $4,
                data_start_row = $5, data_end_row = $6, version = version + 1, updated_at = now()
          WHERE household_id = $1 AND id = $2 AND status IN ('created', 'uploaded', 'scanning', 'header_detected')
          RETURNING id::text AS id`,
        [this.scope.householdId, batchId, input.sheetName, input.headerRow, input.dataStartRow, input.dataEndRow ?? null],
      );
      requireRow(result.rows, "IMPORT_STATE_CONFLICT", "当前批次不能确认表头");
      return this.getBatchInTransaction(client, batchId);
    });
  }

  async confirmMapping(batchId: string, input: MappingConfirmationInput): Promise<ImportBatch> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "import");
      const result = await client.query(
        `UPDATE import_batch
            SET status = 'matching', parser_version = $3, field_mapping = $4::jsonb,
                version = version + 1, updated_at = now()
          WHERE household_id = $1 AND id = $2 AND status = 'mapping_pending'
          RETURNING id::text AS id`,
        [this.scope.householdId, batchId, input.parserVersion, JSON.stringify(input.mapping)],
      );
      requireRow(result.rows, "IMPORT_STATE_CONFLICT", "当前批次不能确认字段映射");
      const candidateCount = await this.generateReconciliationCandidates(client, batchId);
      await client.query(
        `UPDATE import_batch SET status = $3, version = version + 1, updated_at = now()
          WHERE household_id = $1 AND id = $2`,
        [this.scope.householdId, batchId, candidateCount > 0 ? "reconciliation_pending" : "confirmed"],
      );
      return this.getBatchInTransaction(client, batchId);
    });
  }

  private async generateReconciliationCandidates(client: DbClient, batchId: string) {
    const pairs = await client.query<{
      current_id: string;
      other_id: string;
      current_source_type: ImportSourceType;
      other_source_type: ImportSourceType;
      merchant_match: boolean;
    }>(
      `WITH current_records AS (
         SELECT sr.id::text AS id, sr.occurred_at, sr.direction, sr.amount, sr.merchant, fs.source_type
           FROM source_record sr
           JOIN financial_source fs ON fs.household_id = sr.household_id AND fs.id = sr.source_id
          WHERE sr.household_id = $1 AND sr.import_batch_id = $2
       )
       SELECT c.id AS current_id, o.id::text AS other_id,
              c.source_type AS current_source_type, ofs.source_type AS other_source_type,
              (
                NULLIF(regexp_replace(lower(COALESCE(c.merchant, '')), '[^0-9a-zA-Z一-龥]', '', 'g'), '') IS NOT NULL
                AND NULLIF(regexp_replace(lower(COALESCE(o.merchant, '')), '[^0-9a-zA-Z一-龥]', '', 'g'), '') IS NOT NULL
                AND (
                  regexp_replace(lower(c.merchant), '[^0-9a-zA-Z一-龥]', '', 'g') = regexp_replace(lower(o.merchant), '[^0-9a-zA-Z一-龥]', '', 'g')
                  OR regexp_replace(lower(c.merchant), '[^0-9a-zA-Z一-龥]', '', 'g') LIKE '%' || regexp_replace(lower(o.merchant), '[^0-9a-zA-Z一-龥]', '', 'g') || '%'
                  OR regexp_replace(lower(o.merchant), '[^0-9a-zA-Z一-龥]', '', 'g') LIKE '%' || regexp_replace(lower(c.merchant), '[^0-9a-zA-Z一-龥]', '', 'g') || '%'
                )
              ) AS merchant_match
         FROM current_records c
         JOIN source_record o ON o.household_id = $1 AND o.id::text <> c.id
         JOIN financial_source ofs ON ofs.household_id = o.household_id AND ofs.id = o.source_id
        WHERE ofs.source_type <> c.source_type
          AND c.direction = o.direction
          AND ABS(c.amount - o.amount) <= 0.01
          AND ABS(EXTRACT(EPOCH FROM (c.occurred_at - o.occurred_at))) <= 86400
          AND (
            NULLIF(regexp_replace(lower(COALESCE(c.merchant, '')), '[^0-9a-zA-Z一-龥]', '', 'g'), '') IS NULL
            OR NULLIF(regexp_replace(lower(COALESCE(o.merchant, '')), '[^0-9a-zA-Z一-龥]', '', 'g'), '') IS NULL
            OR regexp_replace(lower(c.merchant), '[^0-9a-zA-Z一-龥]', '', 'g') = regexp_replace(lower(o.merchant), '[^0-9a-zA-Z一-龥]', '', 'g')
            OR regexp_replace(lower(c.merchant), '[^0-9a-zA-Z一-龥]', '', 'g') LIKE '%' || regexp_replace(lower(o.merchant), '[^0-9a-zA-Z一-龥]', '', 'g') || '%'
            OR regexp_replace(lower(o.merchant), '[^0-9a-zA-Z一-龥]', '', 'g') LIKE '%' || regexp_replace(lower(c.merchant), '[^0-9a-zA-Z一-龥]', '', 'g') || '%'
          )
          AND (o.import_batch_id <> $2 OR c.id < o.id::text)
          AND NOT EXISTS (
            SELECT 1 FROM transaction_link tl
             WHERE tl.household_id = $1
               AND ((tl.left_source_record_id::text = c.id AND tl.right_source_record_id::text = o.id::text)
                 OR (tl.right_source_record_id::text = c.id AND tl.left_source_record_id::text = o.id::text))
          )
        ORDER BY c.id, o.id`,
      [this.scope.householdId, batchId],
    );

    for (const pair of pairs.rows) {
      const groupId = randomUUID();
      await client.query(
        `INSERT INTO reconciliation_group (id, household_id, import_batch_id, recommended_link_type, confidence, reason_codes)
         VALUES ($1, $2, $3, 'duplicate', $4, $5::jsonb)`,
        [groupId, this.scope.householdId, batchId, pair.merchant_match ? 0.92 : 0.78, JSON.stringify(["same_direction", "same_amount", ...(pair.merchant_match ? ["same_merchant"] : ["merchant_unavailable"]), "within_24_hours"])],
      );
      await client.query(
        `INSERT INTO transaction_link (id, household_id, reconciliation_group_id, left_source_record_id, right_source_record_id, link_type, status, confidence, reason_codes)
         VALUES ($1, $2, $3, $4, $5, 'duplicate', 'pending_review', $6, $7::jsonb)`,
        [randomUUID(), this.scope.householdId, groupId, pair.current_id, pair.other_id, pair.merchant_match ? 0.92 : 0.78, JSON.stringify(["same_direction", "same_amount", ...(pair.merchant_match ? ["same_merchant"] : ["merchant_unavailable"]), "within_24_hours"])],
      );
    }
    return pairs.rows.length;
  }

  async getReconciliation(batchId: string, page: number, pageSize: number): Promise<ReconciliationResponse> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "view");
      const result = await client.query<Record<string, unknown>>(
        `SELECT rg.id::text AS id, rg.recommended_link_type, rg.status, rg.confidence::float AS confidence,
                rg.reason_codes,
                COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
                  'id', sr.id::text, 'source_type', fs.source_type, 'occurred_at', sr.occurred_at::text,
                  'direction', sr.direction, 'amount', sr.amount::text, 'merchant_detail', sr.merchant
                )) FILTER (WHERE sr.id IS NOT NULL), '[]'::jsonb) AS records,
                COUNT(*) OVER()::int AS total_count
           FROM reconciliation_group rg
           LEFT JOIN transaction_link tl ON tl.household_id = rg.household_id AND tl.reconciliation_group_id = rg.id
           LEFT JOIN source_record sr ON sr.household_id = rg.household_id AND sr.id IN (tl.left_source_record_id, tl.right_source_record_id)
           LEFT JOIN financial_source fs ON fs.household_id = sr.household_id AND fs.id = sr.source_id
          WHERE rg.household_id = $1 AND rg.import_batch_id = $2
          GROUP BY rg.id
          ORDER BY rg.created_at
          LIMIT $3 OFFSET $4`,
        [this.scope.householdId, batchId, pageSize, (page - 1) * pageSize],
      );
      const candidates = result.rows.map((row) => ({
        id: String(row.id),
        recommended_link_type: String(row.recommended_link_type),
        status: String(row.status),
        confidence: asNumber(row.confidence),
        reason_codes: Array.isArray(row.reason_codes) ? row.reason_codes.map(String) : Object.values(asJsonObject(row.reason_codes)).map(String),
        records: Array.isArray(row.records) ? row.records as ReconciliationCandidate["records"] : [],
      }));
      return { batch_id: batchId, candidates, pagination: { page, page_size: pageSize, total: asNumber(result.rows[0]?.total_count) } };
    });
  }

  async decideReconciliation(batchId: string, input: ReconciliationDecisionInput): Promise<ReconciliationCandidate> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "reconcile");
      const batch = await client.query<{ version: number; status: ImportStatus }>(
        `SELECT version, status FROM import_batch WHERE household_id = $1 AND id = $2 FOR UPDATE`,
        [this.scope.householdId, batchId],
      );
      const batchRow = requireRow(batch.rows, "NOT_FOUND", "导入批次不存在");
      if (Number(batchRow.version) !== input.expectedVersion) throw new DomainError("VERSION_CONFLICT", "导入批次已发生变化，请刷新后重试", 409);
      if (!["reconciliation_pending", "confirmed"].includes(batchRow.status)) throw new DomainError("IMPORT_STATE_CONFLICT", "当前批次不在关联审核阶段", 409);
      const candidate = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM reconciliation_group WHERE household_id = $1 AND id = $2 AND import_batch_id = $3 FOR UPDATE`,
        [this.scope.householdId, input.candidateId, batchId],
      );
      requireRow(candidate.rows, "NOT_FOUND", "关联候选不存在");
      await client.query(
        `UPDATE reconciliation_group SET status = 'confirmed', recommended_link_type = $3, decided_by = $4, decided_at = now()
          WHERE household_id = $1 AND id = $2`,
        [this.scope.householdId, input.candidateId, input.decision, this.scope.userId],
      );
      await client.query(
        `UPDATE transaction_link SET status = 'confirmed', link_type = $3
          WHERE household_id = $1 AND reconciliation_group_id = $2`,
        [this.scope.householdId, input.candidateId, input.decision],
      );
      const pending = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM reconciliation_group WHERE household_id = $1 AND import_batch_id = $2 AND status = 'pending_review'`,
        [this.scope.householdId, batchId],
      );
      await client.query(
        `UPDATE import_batch SET status = $3, version = version + 1, updated_at = now()
          WHERE household_id = $1 AND id = $2`,
        [this.scope.householdId, batchId, Number(pending.rows[0]?.count ?? 0) === 0 ? "confirmed" : "reconciliation_pending"],
      );
      const result = await client.query<Record<string, unknown>>(
        `SELECT rg.id::text AS id, rg.recommended_link_type, rg.status, rg.confidence::float AS confidence, rg.reason_codes,
                '[]'::jsonb AS records
           FROM reconciliation_group rg WHERE rg.household_id = $1 AND rg.id = $2`,
        [this.scope.householdId, input.candidateId],
      );
      return this.mapCandidate(requireRow(result.rows, "NOT_FOUND", "关联候选不存在"));
    });
  }

  async commitImportBatch(batchId: string, input: CommitImportInput): Promise<CommitImportResponse> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "reconcile");
      const batch = await client.query<{ version: number; status: ImportStatus; commit_idempotency_key: string | null }>(
        `SELECT version, status, commit_idempotency_key FROM import_batch WHERE household_id = $1 AND id = $2 FOR UPDATE`,
        [this.scope.householdId, batchId],
      );
      const batchRow = requireRow(batch.rows, "NOT_FOUND", "导入批次不存在");
      const failedRows = await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM import_row WHERE household_id = $1 AND import_batch_id = $2 AND status = 'invalid'`, [this.scope.householdId, batchId]);
      const failedRecords = Number(failedRows.rows[0]?.count ?? 0);
      if (batchRow.status === "committed") return { batch: await this.getBatchInTransaction(client, batchId), inserted_transactions: 0, linked_records: 0, pending_records: 0, failed_records: failedRecords };
      if (Number(batchRow.version) !== input.expectedVersion) throw new DomainError("VERSION_CONFLICT", "导入批次已发生变化，请刷新后重试", 409);
      if (batchRow.status !== "confirmed") throw new DomainError("IMPORT_STATE_CONFLICT", "仍有导入或关联步骤未确认", 409);
      const sourceRows = await client.query<{ id: string; household_id: string; occurred_at: string; direction: "income" | "expense" | "transfer"; amount: string; currency: string; merchant: string | null; channel: string | null; import_batch_id: string; source_type: ImportSourceType; account_id: string | null; has_ledger_anchor: boolean }>(
        `SELECT sr.id::text, sr.household_id::text, sr.occurred_at::text, sr.direction, sr.amount::text,
                sr.currency, sr.merchant, sr.channel, sr.import_batch_id::text, fs.source_type, fs.account_id::text,
                EXISTS (SELECT 1 FROM ledger_transaction lt
                          WHERE lt.household_id = sr.household_id
                            AND lt.primary_source_record_id = sr.id) AS has_ledger_anchor
           FROM source_record sr
           JOIN financial_source fs ON fs.household_id = sr.household_id AND fs.id = sr.source_id
          WHERE sr.household_id = $1 AND (
            sr.import_batch_id = $2
            OR EXISTS (
              SELECT 1
                FROM transaction_link tl
                JOIN reconciliation_group rg
                  ON rg.household_id = tl.household_id AND rg.id = tl.reconciliation_group_id
               WHERE tl.household_id = $1
                 AND rg.import_batch_id = $2
                 AND rg.status = 'confirmed'
                 AND tl.status = 'confirmed'
                 AND tl.link_type = 'duplicate'
                 AND (tl.left_source_record_id = sr.id OR tl.right_source_record_id = sr.id)
            )
          )`,
        [this.scope.householdId, batchId],
      );
      const sourceById = new Map(sourceRows.rows.map((source) => [source.id, source]));
      const parent = new Map<string, string>();
      const find = (id: string): string => {
        const current = parent.get(id);
        if (!current || current === id) return id;
        const root = find(current);
        parent.set(id, root);
        return root;
      };
      const union = (left: string, right: string) => {
        if (!parent.has(left)) parent.set(left, left);
        if (!parent.has(right)) parent.set(right, right);
        const leftRoot = find(left);
        const rightRoot = find(right);
        if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
      };
      for (const source of sourceRows.rows) parent.set(source.id, source.id);
      const confirmedDuplicateLinks = await client.query<{ left_source_record_id: string; right_source_record_id: string }>(
        `SELECT tl.left_source_record_id::text, tl.right_source_record_id::text
           FROM transaction_link tl
           JOIN reconciliation_group rg
             ON rg.household_id = tl.household_id AND rg.id = tl.reconciliation_group_id
          WHERE tl.household_id = $1 AND rg.import_batch_id = $2
            AND rg.status = 'confirmed' AND tl.status = 'confirmed' AND tl.link_type = 'duplicate'`,
        [this.scope.householdId, batchId],
      );
      for (const link of confirmedDuplicateLinks.rows) union(link.left_source_record_id, link.right_source_record_id);
      const components = new Map<string, typeof sourceRows.rows>();
      for (const source of sourceRows.rows) {
        const root = find(source.id);
        const component = components.get(root) ?? [];
        component.push(source);
        components.set(root, component);
      }
      const currentBatchIds = new Set(sourceRows.rows.filter((source) => source.import_batch_id === batchId).map((source) => source.id));
      let insertedTransactions = 0;
      for (const component of components.values()) {
        if (!component.some((source) => currentBatchIds.has(source.id))) continue;
        const existingAnchor = component.find((source) => source.has_ledger_anchor);
        const anchor = existingAnchor ?? [...component].sort((left, right) => {
          if (left.source_type === 'bank' && right.source_type !== 'bank') return -1;
          if (left.source_type !== 'bank' && right.source_type === 'bank') return 1;
          return left.id.localeCompare(right.id);
        })[0];
        if (!anchor || anchor.has_ledger_anchor) continue;
        const transactionId = randomUUID();
        const transactionStatus = anchor.account_id && anchor.direction !== "transfer" ? "confirmed" : "pending_account";
        const inserted = await client.query(
          `INSERT INTO ledger_transaction (id, household_id, occurred_at, direction, amount, currency, merchant, category, origin, status, primary_source_record_id, import_batch_id, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 'import', $8, $9, $10, $11, $11)
           ON CONFLICT (id) DO NOTHING`,
          [transactionId, anchor.household_id, anchor.occurred_at, anchor.direction, anchor.amount, anchor.currency, anchor.merchant, transactionStatus, anchor.id, batchId, this.scope.userId],
        );
        if ((inserted.rowCount ?? 0) > 0 && anchor.account_id && anchor.direction !== "transfer") {
          await insertLedgerEntries(client, this.scope, transactionId, { direction: anchor.direction, amount: anchor.amount, accountId: anchor.account_id });
        }
        insertedTransactions += inserted.rowCount ?? 0;
      }
      const linked = await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM transaction_link WHERE household_id = $1 AND reconciliation_group_id IN (SELECT id FROM reconciliation_group WHERE household_id = $1 AND import_batch_id = $2 AND status = 'confirmed')`, [this.scope.householdId, batchId]);
      const pending = await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM reconciliation_group WHERE household_id = $1 AND import_batch_id = $2 AND status = 'pending_review'`, [this.scope.householdId, batchId]);
      await client.query(
        `UPDATE import_batch SET status = 'committed', version = version + 1, terminal_at = now(), confirmed_summary_hash = $3, commit_idempotency_key = COALESCE($4, commit_idempotency_key), updated_at = now()
          WHERE household_id = $1 AND id = $2`,
        [this.scope.householdId, batchId, input.confirmSummaryHash, input.idempotencyKey ?? null],
      );
      return { batch: await this.getBatchInTransaction(client, batchId), inserted_transactions: insertedTransactions, linked_records: Number(linked.rows[0]?.count ?? 0), pending_records: Number(pending.rows[0]?.count ?? 0), failed_records: failedRecords };
    });
  }

  async revokeImportBatch(batchId: string, idempotencyKey?: string): Promise<ImportBatch> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertFinancialPermission(client, this.scope, "reconcile");
      const current = await client.query<{ status: ImportStatus }>(`SELECT status FROM import_batch WHERE household_id = $1 AND id = $2 FOR UPDATE`, [this.scope.householdId, batchId]);
      const currentRow = requireRow(current.rows, "NOT_FOUND", "导入批次不存在");
      if (currentRow.status === "revoked") return this.getBatchInTransaction(client, batchId);
      if (currentRow.status !== "committed") throw new DomainError("IMPORT_STATE_CONFLICT", "只有已提交批次可以撤销", 409);
      await client.query(`UPDATE ledger_transaction SET status = 'voided', voided_at = now(), voided_by = $3, updated_by = $3, updated_at = now() WHERE household_id = $1 AND import_batch_id = $2 AND status IN ('confirmed', 'pending_account')`, [this.scope.householdId, batchId, this.scope.userId]);
      await client.query(`UPDATE import_batch SET status = 'revoked', version = version + 1, terminal_at = now(), commit_idempotency_key = COALESCE($3, commit_idempotency_key), updated_at = now() WHERE household_id = $1 AND id = $2`, [this.scope.householdId, batchId, idempotencyKey ?? null]);
      return this.getBatchInTransaction(client, batchId);
    });
  }

  private async getBatchInTransaction(client: DbClient, batchId: string): Promise<ImportBatch>;
  private async getBatchInTransaction(client: DbClient, batchId: string, required: false): Promise<ImportBatch | null>;
  private async getBatchInTransaction(client: DbClient, batchId: string, required = true): Promise<ImportBatch | null> {
    const result = await client.query<BatchRow>(batchSelectSql(), [this.scope.householdId, batchId]);
    if (!result.rows[0] && !required) return null;
    return mapBatch(requireRow(result.rows, "NOT_FOUND", "导入批次不存在"));
  }

  private mapCandidate(row: Record<string, unknown>): ReconciliationCandidate {
    return {
      id: String(row.id),
      recommended_link_type: String(row.recommended_link_type),
      status: String(row.status),
      confidence: asNumber(row.confidence),
      reason_codes: Array.isArray(row.reason_codes) ? row.reason_codes.map(String) : [],
      records: Array.isArray(row.records) ? row.records as ReconciliationCandidate["records"] : [],
    };
  }
}
