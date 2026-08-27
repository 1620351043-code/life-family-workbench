export type TopicCard = {
  id: string;
  topic_type: "idea" | "request" | "inspiration" | "memory" | "other";
  title: string;
  body_preview: string;
  author_id: string;
  author_name: string;
  comment_count: number;
  created_at: string;
};

export type TopicComment = { id: string; author_id: string; author_name: string; body: string; created_at: string };
export type TopicDetail = TopicCard & { body: string; comments: TopicComment[] };
export type TopicAiSummary = {
  insight: { id: string; summary: string; key_points: string[]; source_refs: string[]; provider: string; model: string | null; created_at: string };
  action_proposal: { id: string; action_type: "publish_summary_comment"; status: "proposed" | "confirmed" | "rejected"; version: number; payload: Record<string, unknown> };
};
export type AuthIdentity = { user: { id: string; email: string }; household: { id: string; name: string; role: "owner" | "adult" | "child" | "guest" } };

export type FinanceDrilldownRef = { type: string; filter_id: string; filters: Record<string, string> };
export type FinanceGranularity = "day" | "week" | "month" | "quarter";
export type FinanceSummaryCardKey = "net_asset" | "account_balance" | "income" | "expense" | "net_cash_flow";
export type FinanceAttentionItem = { key: "import_review" | "budget_overrun"; label: string; detail: string; count: number; severity: "warning" | "danger"; action: "import" | "budget"; drilldown_ref: FinanceDrilldownRef | null };
export type FinanceOverview = {
  period: { start: string; end: string; timezone: string };
  granularity: FinanceGranularity;
  summary_cards: Array<{ key: FinanceSummaryCardKey; value: string; currency: string; drilldown_ref: FinanceDrilldownRef }>;
  account_balance_change: { amount: string; rate: string | null; comparison_label: string };
  attention_items: FinanceAttentionItem[];
  budget_center: { label: string; total_limit: string; total_used: string; progress: number; drilldown_ref: FinanceDrilldownRef };
  budget_rings: Array<{ category: string; category_id: string; label: string; limit: string; used: string; progress: number; color_token: string; drilldown_ref: FinanceDrilldownRef; group_drilldown_ref?: FinanceDrilldownRef }>;
  trend_container: { drilldown_ref: FinanceDrilldownRef };
  trend_points: Array<{ bucket: string; income: string; expense: string; net_cash_flow: string; drilldown_ref: FinanceDrilldownRef }>;
  asset_cost_container: { drilldown_ref: FinanceDrilldownRef };
  asset_cost_points: Array<{ bucket: string; purchase_cost: string; maintenance_cost: string; gross_cost: string; recovery: string; net_cash_cost: string; drilldown_ref: FinanceDrilldownRef }>;
  asset_total_points: Array<{ bucket: string; total_asset: string; drilldown_ref: FinanceDrilldownRef }>;
};
export type FinanceDrilldown = { filter: FinanceDrilldownRef; items: Array<Record<string, unknown>>; pagination: { page: number; page_size: number; total: number } };
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
  note: string | null;
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
  direction_scope: "expense" | "income" | "both";
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
export type FinanceAssetEvent = { id: string; asset_id: string; occurred_at: string; event_type: FinanceAssetEventType; amount: string; recovery_amount: string; ledger_transaction_id: string | null };
export type FinanceAssetDetail = FinanceAsset & { events: FinanceAssetEvent[] };
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
export type FinanceAuditEntry = { id: string; actor_id: string | null; action: string; resource_type: string; resource_id: string | null; before_summary: unknown; after_summary: unknown; trace_id: string; created_at: string };
export type FinanceExportJob = { id: string; format: "csv"; period_start: string; period_end: string; status: "queued" | "running" | "ready" | "failed" | "expired" | "cancelled"; row_count: number; download_expires_at: string | null; download_url: string | null; error_code: string | null; error_message: string | null; created_at: string; completed_at: string | null };
export type FinanceAiSourceRef = { kind: "transaction" | "source_record" | "budget" | "asset_event" | "period"; id: string; label: string; drilldown_ref: FinanceDrilldownRef };
export type FinanceAiProposal = { id: string; action_type: "finance_review"; status: "proposed" | "confirmed" | "rejected" | "revoked" | "expired"; version: number; payload: Record<string, unknown> };
export type FinanceAiSummary = {
  insight: { id: string; insight_type: "finance_summary"; summary: string; key_points: string[]; explanations: string[]; source_refs: FinanceAiSourceRef[]; provider: string; model: string | null; created_at: string };
  proposal: FinanceAiProposal;
};
export type ManualTransactionInput = {
  direction: "income" | "expense" | "transfer";
  amount: string;
  currency?: string;
  merchant?: string | null;
  category_id?: string | null;
  account_id: string;
  to_account_id?: string | null;
  occurred_at: string;
  note?: string | null;
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
  account_id: string | null;
};
export type FinanceTransactionList = { items: FinanceTransactionListItem[]; pagination: { page: number; page_size: number; total: number } };

export type FinanceImportSource = "bank" | "alipay" | "wechat" | "bookkeeping_app" | "other";
export type FinanceImportStatus = "created" | "uploaded" | "scanning" | "header_detected" | "mapping_pending" | "normalized" | "matching" | "reconciliation_pending" | "confirmed" | "committed" | "failed" | "cancelled" | "revoked";
export type FinanceImportBatch = {
  id: string;
  file_name?: string;
  source_type: FinanceImportSource;
  status: FinanceImportStatus;
  version: number;
  detected_header_row: number | null;
  detected_sheet: string | null;
  raw_retention_until: string;
  counts: { rows: number; invalid?: number };
  field_mapping?: Record<string, string>;
  header_preview?: { sheets: Array<{ sheet_name: string | null; header_row: number | null; data_start_row: number | null; header_score: number; field_mapping: Record<string, string>; preview_rows: Array<{ row_number: number; values: string[]; role: "blank" | "metadata" | "header" | "data" }>; skipped_rows: number; empty?: boolean }> };
};
export type FinanceReconciliationCandidate = {
  id: string;
  recommended_link_type: string;
  status: string;
  confidence: number;
  reason_codes: string[];
  records: Array<{ id: string; source_type: string; occurred_at: string; direction: string; amount: string; merchant_detail?: string }>;
};
export type FinanceReconciliationResponse = { batch_id: string; candidates: FinanceReconciliationCandidate[]; pagination: { page: number; page_size: number; total: number } };
export type FinanceImportErrorRow = { row_number: number; status: string; error_codes: string[]; normalized_payload: Record<string, unknown> };

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type") && init?.body !== undefined) headers.set("content-type", "application/json");
  if (import.meta.env.VITE_LIFE_HOUSEHOLD_ID && import.meta.env.VITE_LIFE_USER_ID) {
    headers.set("x-life-household-id", import.meta.env.VITE_LIFE_HOUSEHOLD_ID);
    headers.set("x-life-user-id", import.meta.env.VITE_LIFE_USER_ID);
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: init?.credentials ?? "same-origin",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const retryAfterHeader = Number(response.headers.get("retry-after"));
    const retryAfterSeconds = Number.isFinite(body.retry_after_seconds)
      ? Number(body.retry_after_seconds)
      : Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : undefined;
    throw new ApiRequestError(body.message ?? `请求失败（${response.status}）`, response.status, body.code, retryAfterSeconds);
  }
  return response.json() as Promise<T>;
}

export const familyApi = {
  listTopics: () => request<{ topics: TopicCard[] }>("/api/family/topics"),
  getTopic: (topicId: string) => request<TopicDetail>(`/api/family/topics/${topicId}`),
  createTopic: (input: { topic_type: TopicCard["topic_type"]; title: string; body: string }) => request<TopicDetail>("/api/family/topics", { method: "POST", body: JSON.stringify(input) }),
  createComment: (topicId: string, body: string) => request<TopicComment>(`/api/family/topics/${topicId}/comments`, { method: "POST", body: JSON.stringify({ body }) }),
  summarizeTopic: (topicId: string) => request<TopicAiSummary>(`/api/family/topics/${topicId}/ai-summary`, { method: "POST" }),
  decideAiAction: (proposalId: string, decision: "confirm" | "reject", expectedVersion: number) => request<{ proposal: TopicAiSummary["action_proposal"]; execution: { comment_id: string } | null }>(`/api/ai/action-proposals/${proposalId}/decision`, { method: "POST", body: JSON.stringify({ decision, expected_version: expectedVersion }) }),
};

export const authApi = {
  getMe: () => request<AuthIdentity>("/api/me"),
  login: (email: string, password: string) => request<AuthIdentity>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  register: (email: string, password: string, householdName: string) => request<AuthIdentity>("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password, household_name: householdName }) }),
  requestPasswordReset: (email: string) => request<{ ok: true; message: string }>("/api/auth/password-reset/request", { method: "POST", body: JSON.stringify({ email }) }),
  confirmPasswordReset: (token: string, password: string) => request<{ ok: true; message: string }>("/api/auth/password-reset/confirm", { method: "POST", body: JSON.stringify({ token, password }) }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
};

export const financeApi = {
  getOverview: (start: string, end: string, granularity: FinanceGranularity = "day") => request<FinanceOverview>(`/api/finance/overview?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&granularity=${granularity}`),
  getAccounts: () => request<{ accounts: FinanceAccount[] }>("/api/finance/accounts"),
  createAccount: (input: { name: string; account_type: FinanceAccount["account_type"]; currency?: string; opening_balance?: string }) => request<FinanceAccount>("/api/finance/accounts", { method: "POST", body: JSON.stringify(input) }),
  updateAccount: (accountId: string, input: { name: string; account_type: FinanceAccount["account_type"] }) => request<FinanceAccount>(`/api/finance/accounts/${accountId}`, { method: "PATCH", body: JSON.stringify(input) }),
  archiveAccount: (accountId: string) => request<{ account_id: string }>(`/api/finance/accounts/${accountId}/archive`, { method: "POST" }),
  getCategories: (direction?: "income" | "expense", includeArchived = false) => request<{ categories: FinanceCategory[] }>(`/api/finance/categories?${new URLSearchParams({ ...(direction ? { direction } : {}), ...(includeArchived ? { include_archived: "true" } : {}) }).toString()}`),
  createCategory: (input: { name: string; direction_scope: FinanceCategory["direction_scope"]; color_token?: string }) => request<FinanceCategory>("/api/finance/categories", { method: "POST", body: JSON.stringify(input) }),
  updateCategory: (categoryId: string, input: { name: string; direction_scope: FinanceCategory["direction_scope"]; color_token?: string }) => request<FinanceCategory>(`/api/finance/categories/${categoryId}`, { method: "PATCH", body: JSON.stringify(input) }),
  archiveCategory: (categoryId: string) => request<{ category_id: string }>(`/api/finance/categories/${categoryId}/archive`, { method: "POST" }),
  getBudgets: (start: string, end: string, includeArchived = false) => request<{ budgets: FinanceBudget[] }>(`/api/finance/budgets?${new URLSearchParams({ start, end, ...(includeArchived ? { include_archived: "true" } : {}) }).toString()}`),
  createBudget: (input: { category_id: string; name?: string; cycle: FinanceBudget["cycle"]; amount: string; currency?: string; period_start: string; period_end: string }) => request<FinanceBudget>("/api/finance/budgets", { method: "POST", body: JSON.stringify(input) }),
  updateBudget: (budgetId: string, input: { category_id: string; name?: string; cycle: FinanceBudget["cycle"]; amount: string; currency?: string; period_start: string; period_end: string }) => request<FinanceBudget>(`/api/finance/budgets/${budgetId}`, { method: "PATCH", body: JSON.stringify(input) }),
  archiveBudget: (budgetId: string) => request<{ budget_id: string }>(`/api/finance/budgets/${budgetId}/archive`, { method: "POST" }),
  getAssets: () => request<{ assets: FinanceAsset[] }>("/api/finance/assets"),
  createAsset: (input: { name: string; asset_type: string }) => request<FinanceAssetDetail>("/api/finance/assets", { method: "POST", body: JSON.stringify(input) }),
  updateAsset: (assetId: string, input: { name: string; asset_type: string }) => request<FinanceAsset>(`/api/finance/assets/${assetId}`, { method: "PATCH", body: JSON.stringify(input) }),
  getAsset: (assetId: string) => request<FinanceAssetDetail>(`/api/finance/assets/${assetId}`),
  createAssetEvent: (assetId: string, input: { occurred_at: string; event_type: FinanceAssetEventType; amount: string; recovery_amount: string; ledger_transaction_id?: string | null }) => request<FinanceAssetEvent>(`/api/finance/assets/${assetId}/events`, { method: "POST", body: JSON.stringify(input) }),
  getFinancePermissions: () => request<{ permissions: FinancePermission[] }>("/api/finance/permissions"),
  updateFinancePermission: (userId: string, input: Omit<FinancePermission, "user_id" | "email" | "role" | "explicit" | "granted_at" | "revoked_at">) => request<FinancePermission>(`/api/finance/permissions/${userId}`, { method: "PATCH", body: JSON.stringify(input) }),
  revokeFinancePermission: (userId: string) => request<{ user_id: string }>(`/api/finance/permissions/${userId}/revoke`, { method: "POST" }),
  getFinanceAudit: (limit = 50) => request<{ entries: FinanceAuditEntry[] }>(`/api/finance/audit?limit=${limit}`),
  createFinanceExport: (start: string, end: string, idempotencyKey: string) => request<FinanceExportJob>("/api/finance/exports", { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify({ start, end, format: "csv" }) }),
  getFinanceExport: (exportId: string) => request<FinanceExportJob>(`/api/finance/exports/${exportId}`),
  getFinanceAiSummary: (start: string, end: string) => request<FinanceAiSummary>(`/api/finance/ai/summary?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
  decideFinanceAiProposal: (proposalId: string, decision: "confirm" | "reject", expectedVersion: number) => request<{ proposal: FinanceAiProposal; execution: { formal_ledger_mutation: false } | null }>(`/api/finance/ai/proposals/${proposalId}/decision`, { method: "POST", body: JSON.stringify({ decision, expected_version: expectedVersion }) }),
  revokeFinanceAiProposal: (proposalId: string) => request<{ proposal: FinanceAiProposal }>(`/api/finance/ai/proposals/${proposalId}/revoke`, { method: "POST" }),
  listTransactions: (params: { page?: number; page_size?: number; start?: string; end?: string; direction?: "income" | "expense" | "transfer"; account_id?: string; import_batch_id?: string } = {}) => {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => { if (value !== undefined) query.set(key, String(value)); });
    return request<FinanceTransactionList>(`/api/finance/transactions?${query.toString()}`);
  },
  createTransaction: (input: ManualTransactionInput, idempotencyKey?: string) => request<{ transaction_id: string }>("/api/finance/transactions", { method: "POST", headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : undefined, body: JSON.stringify(input) }),
  updateTransaction: (transactionId: string, input: ManualTransactionInput) => request<{ transaction_id: string }>(`/api/finance/transactions/${transactionId}`, { method: "PATCH", body: JSON.stringify(input) }),
  voidTransaction: (transactionId: string, reason: string) => request<{ transaction_id: string }>(`/api/finance/transactions/${transactionId}/void`, { method: "POST", body: JSON.stringify({ reason }) }),
  getDrilldown: (ref: FinanceDrilldownRef, page = 1) => request<FinanceDrilldown>(`/api/finance/drilldowns/${ref.filter_id}?page=${page}&page_size=50`),
  getTransaction: (transactionId: string) => request<FinanceTransactionDetail>(`/api/finance/transactions/${transactionId}`),
  createImportBatch: (input: { source_type: FinanceImportSource; file_name: string; file_size: number; file_sha256: string; object_key: string }) => request<FinanceImportBatch>("/api/finance/import-batches", { method: "POST", body: JSON.stringify(input) }),
  listImportBatches: (pageSize = 20) => request<{ batches: FinanceImportBatch[] }>(`/api/finance/import-batches?page=1&page_size=${pageSize}`),
  listImportErrors: (batchId: string, pageSize = 200) => request<{ rows: FinanceImportErrorRow[] }>(`/api/finance/import-batches/${batchId}/errors?page=1&page_size=${pageSize}`),
  uploadImportFile: (batchId: string, file: File) => request<FinanceImportBatch>(`/api/finance/import-batches/${batchId}/upload`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file }),
  parseImportBatch: (batchId: string) => request<FinanceImportBatch>(`/api/finance/import-batches/${batchId}/parse`, { method: "POST" }),
  getImportBatch: (batchId: string) => request<FinanceImportBatch>(`/api/finance/import-batches/${batchId}`),
  confirmImportHeader: (batchId: string, input: { sheet_name: string; header_row: number; data_start_row: number; data_end_row?: number }) => request<FinanceImportBatch>(`/api/finance/import-batches/${batchId}/header-confirmation`, { method: "POST", body: JSON.stringify(input) }),
  confirmImportMapping: (batchId: string, input: { mapping: Record<string, string>; parser_version: string }) => request<FinanceImportBatch>(`/api/finance/import-batches/${batchId}/mapping-confirmation`, { method: "POST", body: JSON.stringify(input) }),
  getImportReconciliation: (batchId: string) => request<FinanceReconciliationResponse>(`/api/finance/import-batches/${batchId}/reconciliation?page=1&page_size=50`),
  decideImportReconciliation: (batchId: string, input: { candidate_id: string; decision: string; expected_version: number; reason?: string }) => request<FinanceReconciliationCandidate>(`/api/finance/import-batches/${batchId}/reconciliation/decisions`, { method: "POST", body: JSON.stringify(input) }),
  commitImportBatch: (batchId: string, input: { expected_version: number; confirm_summary_hash: string }, idempotencyKey: string) => request<{ batch: FinanceImportBatch; inserted_transactions: number; linked_records: number; pending_records: number; failed_records: number }>(`/api/finance/import-batches/${batchId}/commit`, { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(input) }),
  revokeImportBatch: (batchId: string, idempotencyKey: string) => request<FinanceImportBatch>(`/api/finance/import-batches/${batchId}/revoke`, { method: "POST", headers: { "idempotency-key": idempotencyKey } }),
};
