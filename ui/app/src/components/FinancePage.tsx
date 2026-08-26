import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ApiRequestError, authApi, financeApi, type FinanceAccount, type FinanceAsset, type FinanceBudget, type FinanceCategory, type FinanceDrilldownRef, type FinanceExportJob, type FinanceGranularity, type FinanceOverview, type FinancePermission, type FinanceTransactionDetail, type FinanceTransactionListItem } from "../api";
import { AdaptiveValue } from "./AdaptiveValue";
import { FinanceImportWizard } from "./FinanceImportWizard";
import { AccountSheet, ManualTransactionSheet } from "./ManualTransactionSheet";
import { FinanceManagementSheet } from "./FinanceManagementSheet";
import { FinanceAssetSheet } from "./FinanceAssetSheet";
import { FinanceAiSheet } from "./FinanceAiSheet";
import { FinanceSheet } from "./FinanceSheet";
import { BunnyMark } from "./BunnyMark";

type PeriodCursor = { year: number; month: number };
type CustomRange = { start: string; end: string };
type DrilldownState = { title: string; ref: FinanceDrilldownRef; loading: boolean; error: string | null; data: Awaited<ReturnType<typeof financeApi.getDrilldown>> | null };
type RefreshScope = "period" | "stable" | "all";

const ringColors: Record<string, string> = {
  pink: "#f06f8c",
  orange: "#e99b36",
  blue: "#6488f0",
  violet: "#936fe7",
  green: "#3eb391",
  cyan: "#4cafc1",
};

const granularityLabels: Record<FinanceGranularity, string> = { day: "日", week: "周", month: "月", quarter: "季" };
const sourceLabels: Record<string, string> = { bank: "银行", alipay: "支付宝", wechat: "微信支付", bookkeeping_app: "记账 App", other: "其他来源" };

function initialPeriod(): PeriodCursor {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() };
}

function periodRange(period: PeriodCursor) {
  const start = new Date(period.year, period.month, 1);
  const end = new Date(period.year, period.month + 1, 0);
  return { start: isoDate(start), end: isoDate(end) };
}

function isoDate(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function money(value: unknown) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0.00";
}

function numberValue(value: unknown) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

function formatBucket(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value.slice(5) : `${date.getMonth() + 1}/${date.getDate()}`;
}

function colorFor(token: string, fallback = "#936fe7") {
  return ringColors[token] ?? fallback;
}

export function FinancePage() {
  const [period, setPeriod] = useState<PeriodCursor>(initialPeriod);
  const [customRange, setCustomRange] = useState<CustomRange | null>(null);
  const [customRangeOpen, setCustomRangeOpen] = useState(false);
  const [draftStart, setDraftStart] = useState("");
  const [draftEnd, setDraftEnd] = useState("");
  const [granularity, setGranularity] = useState<FinanceGranularity>("day");
  const [overview, setOverview] = useState<FinanceOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [periodLoading, setPeriodLoading] = useState(true);
  const [stableLoading, setStableLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drilldown, setDrilldown] = useState<DrilldownState | null>(null);
  const [transaction, setTransaction] = useState<FinanceTransactionDetail | null>(null);
  const [editingTransaction, setEditingTransaction] = useState<FinanceTransactionDetail | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [managementOpen, setManagementOpen] = useState(false);
  const [assetOpen, setAssetOpen] = useState(false);
  const [assetInitialId, setAssetInitialId] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [transactionsOpen, setTransactionsOpen] = useState(false);
  const [transactionsBatchId, setTransactionsBatchId] = useState<string | null>(null);
  const [financeAiOpen, setFinanceAiOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<FinanceAccount | null>(null);
  const [accounts, setAccounts] = useState<FinanceAccount[]>([]);
  const [categories, setCategories] = useState<FinanceCategory[]>([]);
  const [budgets, setBudgets] = useState<FinanceBudget[]>([]);
  const [assets, setAssets] = useState<FinanceAsset[]>([]);
  const [recentTransactions, setRecentTransactions] = useState<FinanceTransactionListItem[]>([]);
  const [financePermission, setFinancePermission] = useState<FinancePermission | null>(null);
  const [financeForbidden, setFinanceForbidden] = useState(false);
  const [exportJob, setExportJob] = useState<FinanceExportJob | null>(null);
  const [financeDataVersion, setFinanceDataVersion] = useState(0);
  const requestVersion = useRef({ overview: 0, period: 0, stable: 0, drilldown: 0, transaction: 0 });
  const range = useMemo(() => customRange ?? periodRange(period), [customRange, period]);

  const loadOverview = async () => {
    const requestId = ++requestVersion.current.overview;
    const hasExistingData = overview !== null;
    if (hasExistingData) setRefreshing(true);
    else setLoading(true);
    try {
      const nextOverview = await financeApi.getOverview(range.start, range.end, granularity);
      if (requestId !== requestVersion.current.overview) return;
      setFinanceForbidden(false);
      setOverview(nextOverview);
    } catch (reason) {
      if (requestId !== requestVersion.current.overview) return;
      if (reason instanceof ApiRequestError && reason.status === 403) setFinanceForbidden(true);
      setError(reason instanceof Error ? reason.message : "财务数据暂时无法加载");
    } finally {
      if (requestId === requestVersion.current.overview) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  };

  const loadPeriodFoundation = async () => {
    const requestId = ++requestVersion.current.period;
    setPeriodLoading(true);
    try {
      const [budgetResult, transactionResult] = await Promise.all([
        financeApi.getBudgets(range.start, range.end),
        financeApi.listTransactions({ page: 1, page_size: 5, start: range.start, end: range.end }),
      ]);
      if (requestId !== requestVersion.current.period) return;
      setRecentTransactions(transactionResult.items);
      setBudgets(budgetResult.budgets);
    } catch (reason) {
      if (requestId !== requestVersion.current.period) return;
      if (reason instanceof ApiRequestError && reason.status === 403) setFinanceForbidden(true);
      setError(reason instanceof Error ? reason.message : "当前周期的预算和流水暂时无法加载");
    } finally {
      if (requestId === requestVersion.current.period) setPeriodLoading(false);
    }
  };

  const loadStableFoundation = async () => {
    const requestId = ++requestVersion.current.stable;
    setStableLoading(true);
    try {
      const [accountResult, categoryResult, assetResult, permissionResult] = await Promise.all([
        financeApi.getAccounts(),
        financeApi.getCategories(),
        financeApi.getAssets(),
        financeApi.getFinancePermissions(),
      ]);
      if (requestId !== requestVersion.current.stable) return;
      setAccounts(accountResult.accounts);
      setCategories(categoryResult.categories);
      setAssets(assetResult.assets);
      let currentUserId = import.meta.env.VITE_LIFE_USER_ID as string | undefined;
      if (!currentUserId) {
        try { currentUserId = (await authApi.getMe()).user.id; } catch { currentUserId = undefined; }
      }
      const currentPermission = currentUserId ? permissionResult.permissions.find((item) => item.user_id === currentUserId) ?? null : null;
      setFinancePermission(currentPermission);
      if (!currentPermission || !currentPermission.can_view) setFinanceForbidden(true);
    } catch (reason) {
      if (requestId !== requestVersion.current.stable) return;
      if (reason instanceof ApiRequestError && reason.status === 403) setFinanceForbidden(true);
      setError(reason instanceof Error ? reason.message : "账户、资产和权限暂时无法加载");
    } finally {
      if (requestId === requestVersion.current.stable) setStableLoading(false);
    }
  };

  const refreshFinance = async (scope: RefreshScope = "all") => {
    setError(null);
    const tasks: Promise<void>[] = [];
    if (scope === "period" || scope === "all") {
      tasks.push(loadOverview(), loadPeriodFoundation());
    }
    if (scope === "stable" || scope === "all") tasks.push(loadStableFoundation());
    await Promise.all(tasks);
  };

  useEffect(() => { void refreshFinance("period"); }, [granularity, range.end, range.start]);
  useEffect(() => { void refreshFinance("stable"); }, []);

  const closeDrilldown = () => {
    requestVersion.current.drilldown += 1;
    setDrilldown(null);
  };

  const closeTransaction = () => {
    requestVersion.current.transaction += 1;
    setTransaction(null);
  };

  const openDrilldown = async (ref: FinanceDrilldownRef, title: string) => {
    const requestId = ++requestVersion.current.drilldown;
    closeTransaction();
    setDrilldown({ title, ref, loading: true, error: null, data: null });
    try {
      const data = await financeApi.getDrilldown(ref);
      if (requestId !== requestVersion.current.drilldown) return;
      setDrilldown({ title, ref, loading: false, error: null, data });
    } catch (reason) {
      if (requestId !== requestVersion.current.drilldown) return;
      setDrilldown({ title, ref, loading: false, error: reason instanceof Error ? reason.message : "明细暂时无法加载", data: null });
    }
  };

  const openTransaction = async (id: string) => {
    const requestId = ++requestVersion.current.transaction;
    closeDrilldown();
    setTransaction(null);
    try {
      const detail = await financeApi.getTransaction(id);
      if (requestId !== requestVersion.current.transaction) return;
      setTransaction(detail);
    } catch (reason) {
      if (requestId !== requestVersion.current.transaction) return;
      setError(reason instanceof Error ? reason.message : "账单详情暂时无法加载");
    }
  };

  const openTransactions = (importBatchId?: string) => {
    setTransactionsBatchId(importBatchId ?? null);
    setTransactionsOpen(true);
  };

  const editTransaction = (detail: FinanceTransactionDetail) => {
    closeTransaction();
    setEditingTransaction(detail);
    setManualOpen(true);
  };

  const voidTransaction = async (detail: FinanceTransactionDetail, reason: string) => {
    try {
      await financeApi.voidTransaction(detail.id, reason);
      closeTransaction();
      setFinanceDataVersion((value) => value + 1);
      await refreshFinance("period");
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : "撤销记账失败");
    }
  };

  const movePeriod = (offset: number) => {
    const next = new Date(period.year, period.month + offset, 1);
    setCustomRange(null);
    setPeriod({ year: next.getFullYear(), month: next.getMonth() });
    closeDrilldown();
    closeTransaction();
  };

  const openCustomRange = () => {
    setDraftStart(range.start);
    setDraftEnd(range.end);
    setCustomRangeOpen(true);
  };

  const applyCustomRange = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draftStart) || !/^\d{4}-\d{2}-\d{2}$/.test(draftEnd) || draftEnd < draftStart) {
      setError("自定义周期的日期格式不正确，且结束日期不能早于开始日期");
      return;
    }
    setCustomRange({ start: draftStart, end: draftEnd });
    setCustomRangeOpen(false);
    closeDrilldown();
    closeTransaction();
  };

  const requestExport = async () => {
    try {
      const idempotencyKey = `finance-export-${range.start}-${range.end}-${Date.now()}`;
      let job = await financeApi.createFinanceExport(range.start, range.end, idempotencyKey);
      setExportJob(job);
      for (let attempt = 0; attempt < 12 && ["queued", "running"].includes(job.status); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        job = await financeApi.getFinanceExport(job.id);
        setExportJob(job);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导出任务创建失败");
    }
  };

  return (
    <section className="finance-page">
      <header className="finance-header">
        <div>
          <span className="eyebrow">家庭财务 · 真实账本</span>
          <h1>这段时间，钱都去哪儿了？</h1>
          <p>每一张卡片、每一条趋势都可以进入对应明细。</p>
        </div>
        {!financeForbidden ? <div className="finance-header-actions">
          <button type="button" className="finance-add-button" disabled={!financePermission || !financePermission.can_bookkeep} onClick={() => { setEditingTransaction(null); setManualOpen(true); }}>＋ 新增记账</button>
          <button type="button" className="finance-tools-button" onClick={() => setToolsOpen(true)}>财务工具</button>
          <button type="button" className="icon-button" aria-label="刷新财务数据" onClick={() => void refreshFinance("all")}>↻</button>
        </div> : <span className="finance-forbidden-badge">当前成员无财务查看权限</span>}
      </header>
      <div className="finance-period" aria-label="选择财务周期">
        <button onClick={() => movePeriod(-1)} aria-label="上一个月">‹</button>
        <strong>{customRange ? `${range.start} 至 ${range.end}` : `${period.year} 年 ${period.month + 1} 月`}</strong>
        <button onClick={() => movePeriod(1)} aria-label="下一个月">›</button>
        <button className="finance-custom-range-button" type="button" onClick={openCustomRange}>{customRange ? "修改周期" : "自定义"}</button>
      </div>
      {customRangeOpen && <section className="finance-custom-range finance-card" aria-label="自定义财务周期">
        <div><span className="eyebrow">自定义范围</span><h2>选择要分析的时间</h2></div>
        <div className="finance-custom-range-fields"><label>开始日期<input type="date" value={draftStart} onChange={(event) => setDraftStart(event.target.value)} /></label><span aria-hidden="true">→</span><label>结束日期<input type="date" value={draftEnd} onChange={(event) => setDraftEnd(event.target.value)} /></label></div>
        <div className="finance-custom-range-actions"><button type="button" className="secondary-button" onClick={() => setCustomRangeOpen(false)}>取消</button><button type="button" className="primary-button" onClick={applyCustomRange}>应用范围</button></div>
      </section>}
      {exportJob && <div className={`finance-export-status ${exportJob.status}`} role="status"><span>{exportJob.status === "ready" ? "导出已完成" : exportJob.status === "failed" ? "导出失败" : exportJob.status === "expired" ? "导出已过期" : "正在准备导出…"}</span>{exportJob.status === "ready" && exportJob.download_url ? <a href={exportJob.download_url}>下载 CSV</a> : <small>{exportJob.status === "ready" ? `${exportJob.row_count} 条流水` : exportJob.error_message ?? "请稍候"}</small>}</div>}
      {refreshing && <div className="finance-refreshing" role="status" aria-live="polite">正在同步当前周期…</div>}
      {error && <div className="error-banner" role="alert" aria-live="polite"><span>{error}</span><button type="button" onClick={() => void refreshFinance("all")}>重试</button><button type="button" onClick={() => setError(null)}>关闭</button></div>}
      {(loading || stableLoading || periodLoading) && !overview ? <FinanceLoading /> : financeForbidden ? <FinanceForbidden onRetry={() => { setFinanceForbidden(false); void refreshFinance("all"); }} /> : overview ? <>
        <AssetOverviewCard overview={overview} onOpen={openDrilldown} />
        <AttentionSection items={overview.attention_items} onOpenImport={() => setImportOpen(true)} onOpen={openDrilldown} />
        <BudgetSection overview={overview} onOpen={openDrilldown} />
        <TrendSection overview={overview} granularity={granularity} onGranularityChange={setGranularity} onOpen={openDrilldown} />
        <AssetTrendSection overview={overview} granularity={granularity} onGranularityChange={setGranularity} onOpen={openDrilldown} />
        <FinanceAiEntry onOpen={() => setFinanceAiOpen(true)} />
        <RecentTransactions transactions={recentTransactions} onOpen={openTransaction} onViewAll={() => openTransactions()} />
      </> : <div className="empty-state"><span>◈</span><strong>还没有可展示的财务数据</strong><p>完成账单导入或新增一笔记录后，这里会自动更新。</p></div>}
      {drilldown && <FinanceDrilldownSheet state={drilldown} onClose={closeDrilldown} onTransaction={openTransaction} onAsset={(assetId) => { closeDrilldown(); setAssetInitialId(assetId); setAssetOpen(true); }} />}
      {transaction && <TransactionSheet detail={transaction} onClose={closeTransaction} onEdit={editTransaction} onVoid={(reason) => void voidTransaction(transaction, reason)} />}
      {importOpen && <FinanceImportWizard onClose={() => setImportOpen(false)} onError={setError} onOpenImportedTransactions={(batchId) => { setImportOpen(false); setFinanceDataVersion((value) => value + 1); void refreshFinance("period"); openTransactions(batchId); }} />}
      {manualOpen && <ManualTransactionSheet initial={editingTransaction ?? undefined} accounts={accounts} categories={categories} canCreateAccount={Boolean(financePermission?.can_edit)} onClose={() => { setManualOpen(false); setEditingTransaction(null); }} onSaved={() => { setManualOpen(false); setEditingTransaction(null); setFinanceDataVersion((value) => value + 1); void refreshFinance("period"); }} onCreateAccount={() => { setManualOpen(false); setAccountOpen(true); }} />}
      {managementOpen && <FinanceManagementSheet accounts={accounts} budgets={budgets} categories={categories} period={range} canEdit={Boolean(financePermission?.can_edit)} canManagePermissions={financePermission?.role === "owner"} onClose={() => setManagementOpen(false)} onChanged={(scope = "stable") => { setFinanceDataVersion((value) => value + 1); void refreshFinance(scope); }} onCreateAccount={() => { setManagementOpen(false); setEditingAccount(null); setAccountOpen(true); }} onEditAccount={(account) => { setManagementOpen(false); setEditingAccount(account); setAccountOpen(true); }} />}
      {assetOpen && <FinanceAssetSheet assets={assets} transactions={recentTransactions} canEdit={Boolean(financePermission?.can_edit)} initialAssetId={assetInitialId ?? undefined} onClose={() => { setAssetOpen(false); setAssetInitialId(null); }} onChanged={() => { setFinanceDataVersion((value) => value + 1); void refreshFinance("all"); }} />}
      {financeAiOpen && <FinanceAiSheet period={range} dataVersion={financeDataVersion} onClose={() => setFinanceAiOpen(false)} onOpenSource={(ref, title) => void openDrilldown(ref, title)} />}
      {accountOpen && <AccountSheet initial={editingAccount ?? undefined} onClose={() => { setAccountOpen(false); setEditingAccount(null); }} onSaved={() => { setAccountOpen(false); setEditingAccount(null); setFinanceDataVersion((value) => value + 1); void refreshFinance("all"); }} />}
      {toolsOpen && <FinanceToolsSheet canImport={Boolean(financePermission?.can_import)} canExport={Boolean(financePermission?.can_export)} canEdit={Boolean(financePermission?.can_edit)} onClose={() => setToolsOpen(false)} onManagement={() => { setToolsOpen(false); setManagementOpen(true); }} onAssets={() => { setToolsOpen(false); setAssetOpen(true); }} onImport={() => { setToolsOpen(false); setImportOpen(true); }} onExport={() => { setToolsOpen(false); void requestExport(); }} />}
      {transactionsOpen && <FinanceTransactionsSheet range={range} importBatchId={transactionsBatchId ?? undefined} onClose={() => { setTransactionsOpen(false); setTransactionsBatchId(null); }} onTransaction={(id) => { setTransactionsOpen(false); setTransactionsBatchId(null); void openTransaction(id); }} />}
    </section>
  );
}

function FinanceAiEntry({ onOpen }: { onOpen: () => void }) {
  return <section className="finance-ai-entry" aria-label="财务 AI 解读入口">
    <div className="finance-ai-entry-copy"><span className="bunny-mini" aria-hidden="true"><BunnyMark size={28} /></span><div><strong>让小兔子解释这段财务</strong><p>读取当前周期的账单、预算和资产，只给出可回溯的只读解释。</p></div></div>
    <button type="button" className="finance-ai-entry-button" onClick={onOpen}>AI 解读 <span aria-hidden="true">›</span></button>
  </section>;
}

function RecentTransactions({ transactions, onOpen, onViewAll }: { transactions: FinanceTransactionListItem[]; onOpen: (id: string) => void; onViewAll: () => void }) {
  return <section className="finance-card recent-transactions-card">
    <div className="finance-section-heading"><div><span className="eyebrow">账本流水</span><h2>最近记账</h2></div><button type="button" className="text-button" onClick={onViewAll}>查看全部</button></div>
    {transactions.length === 0 ? <div className="finance-empty-inline">还没有已确认的流水，先新增一笔记账吧。</div> : <div className="recent-transactions-list">{transactions.map((item) => <button type="button" className="recent-transaction-row" key={item.id} onClick={() => onOpen(item.id)}><span className={`recent-transaction-icon ${item.direction}`}>{item.direction === "income" ? "↗" : item.direction === "transfer" ? "⇄" : "↘"}</span><span className="recent-transaction-copy"><strong>{item.merchant || "未命名账单"}</strong><small>{item.category || "未分类"} · {formatBucket(item.occurred_at)} · {item.origin === "manual" ? "手动记账" : "导入账单"}</small></span><span className={`recent-transaction-amount ${item.direction === "income" ? "income" : ""}`}>{item.direction === "income" ? "+" : item.direction === "transfer" ? "" : "-"}¥ {money(item.amount)}</span><span className="chevron">›</span></button>)}</div>}
  </section>;
}

function AssetOverviewCard({ overview, onOpen }: { overview: FinanceOverview; onOpen: (ref: FinanceDrilldownRef, title: string) => void }) {
  const summary = new Map(overview.summary_cards.map((card) => [card.key, card]));
  const accountBalance = summary.get("account_balance");
  const totalAsset = summary.get("net_asset");
  const income = summary.get("income");
  const expense = summary.get("expense");
  const change = numberValue(overview.account_balance_change.amount);
  const changeSign = change > 0 ? "+" : change < 0 ? "−" : "±";
  const changeValue = overview.account_balance_change.rate === null
    ? `${changeSign}¥ ${money(Math.abs(change))}`
    : `${changeSign}${Math.abs(numberValue(overview.account_balance_change.rate)).toFixed(1)}%`;
  const changeTone = change > 0 ? "positive" : change < 0 ? "negative" : "neutral";
  const metricItems = [
    { key: "net_asset", label: "总资产", card: totalAsset, tone: "asset", title: "总资产明细" },
    { key: "income", label: "总收入", card: income, tone: "income", title: "总收入明细" },
    { key: "expense", label: "总支出", card: expense, tone: "expense", title: "总支出明细" },
  ] as const;

  return <section className="finance-card asset-overview-card" aria-label="资产总览">
    <div className="finance-section-heading asset-overview-heading">
      <div><span className="eyebrow">资产总览</span></div>
      {totalAsset && <button type="button" className="text-button" onClick={() => onOpen(totalAsset.drilldown_ref, "总资产明细")}>查看资产明细 <span aria-hidden="true">›</span></button>}
    </div>
    <div className="asset-overview-hero">
      <span className="asset-overview-label">账户余额</span>
      <div className="asset-overview-value-row">
        <AdaptiveValue minFontSize={28} maxFontSize={40} ariaLabel={`账户余额 ${money(accountBalance?.value)} 元`}>¥ {money(accountBalance?.value)}</AdaptiveValue>
      </div>
      <span className={`asset-overview-change ${changeTone}`}><span>{overview.account_balance_change.comparison_label} {changeValue}</span><span aria-hidden="true">{change > 0 ? "↗" : change < 0 ? "↘" : "→"}</span></span>
    </div>
    <AssetOverviewTrend points={overview.asset_total_points ?? []} onOpen={onOpen} />
    <div className="asset-overview-metrics" aria-label="财务总览指标">
      {metricItems.map((item) => item.card ? <button type="button" className={`asset-overview-metric ${item.tone}`} key={item.key} onClick={() => onOpen(item.card!.drilldown_ref, item.title)} aria-label={`${item.label} ${money(item.card.value)} 元，查看明细`}>
        <span>{item.label}</span>
        <AdaptiveValue minFontSize={14} maxFontSize={19} ariaLabel={`${item.label} ${money(item.card.value)} 元`}>¥ {money(item.card.value)}</AdaptiveValue>
        <b aria-hidden="true">›</b>
      </button> : null)}
    </div>
  </section>;
}

function AssetOverviewTrend({ points, onOpen }: { points: FinanceOverview["asset_total_points"]; onOpen: (ref: FinanceDrilldownRef, title: string) => void }) {
  if (points.length === 0) return <div className="asset-overview-trend-empty">当前周期暂无总资产趋势</div>;
  const values = points.map((point) => numberValue(point.total_asset));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const xFor = (index: number) => points.length <= 1 ? 50 : (index / (points.length - 1)) * 100;
  const yFor = (value: number) => 78 - ((value - min) / span) * 58;
  const coordinates = points.map((point, index) => ({ x: xFor(index) * 3.6, y: yFor(numberValue(point.total_asset)) }));
  const curvePath = coordinates.reduce((path, point, index) => {
    if (index === 0) return `M ${point.x} ${point.y}`;
    const previous = coordinates[index - 1];
    const midpoint = (previous.x + point.x) / 2;
    return `${path} C ${midpoint} ${previous.y}, ${midpoint} ${point.y}, ${point.x} ${point.y}`;
  }, "");
  const areaPath = `${curvePath} L 360 110 L 0 110 Z`;
  const interactiveIndices = Array.from(new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]));

  return <div className="asset-overview-trend" role="group" aria-label="总资产趋势，点击数据点查看明细">
    <span className="asset-overview-trend-label">总资产趋势</span>
    <svg viewBox="0 0 360 110" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="asset-overview-trend-fill" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="#b8adff" stopOpacity=".16" /><stop offset="100%" stopColor="#8de2cc" stopOpacity=".24" /></linearGradient></defs>
      <path d={areaPath} fill="url(#asset-overview-trend-fill)" />
      <path d={curvePath} fill="none" stroke="url(#asset-overview-trend-stroke)" strokeWidth="2" strokeLinecap="round" />
      <defs><linearGradient id="asset-overview-trend-stroke" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="#9f88ee" /><stop offset="100%" stopColor="#54c9a5" /></linearGradient></defs>
    </svg>
    <div className="asset-overview-trend-points">{interactiveIndices.map((index) => { const point = points[index]; return <button type="button" className="asset-overview-trend-point" key={`${point.bucket}-${index}`} style={{ left: `${xFor(index)}%`, top: `${(yFor(numberValue(point.total_asset)) / 110) * 100}%` }} onClick={() => onOpen(point.drilldown_ref, `总资产趋势 · ${formatBucket(point.bucket)}`)} aria-label={`总资产趋势 ${formatBucket(point.bucket)}，${money(point.total_asset)} 元，查看明细`} />; })}</div>
  </div>;
}

function AttentionSection({ items, onOpenImport, onOpen }: { items: FinanceOverview["attention_items"]; onOpenImport: () => void; onOpen: (ref: FinanceDrilldownRef, title: string) => void }) {
  if (items.length === 0) return null;
  return <section className="finance-attention-list" aria-label="待处理与异常提示">
    {items.map((item) => <button type="button" className={`finance-attention-item ${item.severity}`} key={item.key} onClick={() => item.action === "import" ? onOpenImport() : item.drilldown_ref ? onOpen(item.drilldown_ref, item.label) : undefined}>
      <span className="finance-attention-icon">{item.severity === "danger" ? "!" : "⌁"}</span>
      <span className="finance-attention-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>
      <span className="finance-attention-count">{item.count}<b>›</b></span>
    </button>)}
  </section>;
}

function BudgetSection({ overview, onOpen }: { overview: FinanceOverview; onOpen: (ref: FinanceDrilldownRef, title: string) => void }) {
  const budgetRows = overview.budget_rings;
  if (budgetRows.length === 0) return <section className="finance-card budget-section budget-empty-section"><div className="finance-section-heading"><div><span className="eyebrow">本月预算</span><h2>一眼看懂家庭预算进度</h2></div></div><div className="budget-empty-visual"><div className="budget-empty-ring" aria-hidden="true" /><div><strong>还没有预算规则</strong><p>给餐饮、出行或家庭计划设置一个额度，月底更容易看懂剩余空间。</p><button type="button" className="primary-button" onClick={() => onOpen(overview.budget_center.drilldown_ref, "创建预算")}>创建预算</button></div></div></section>;
  const visibleRows = budgetRows.length > 6 ? budgetRows.slice(0, 5) : budgetRows;
  const extraRows = budgetRows.length > 6 ? budgetRows.slice(5) : [];
  const extraLimit = extraRows.reduce((sum, item) => sum + numberValue(item.limit), 0);
  const extraUsed = extraRows.reduce((sum, item) => sum + numberValue(item.used), 0);
  const displayRows = extraRows.length === 0 ? visibleRows : [...visibleRows, { ...visibleRows[0], category: "other", label: `其他 ${extraRows.length} 类`, limit: String(extraLimit), used: String(extraUsed), progress: extraLimit === 0 ? 0 : Math.round((extraUsed / extraLimit) * 100), color_token: "cyan", drilldown_ref: extraRows[0].group_drilldown_ref ?? extraRows[0].drilldown_ref }];
  const totalLimit = numberValue(overview.budget_center.total_limit);
  const totalUsed = numberValue(overview.budget_center.total_used);
  const remaining = totalLimit - totalUsed;

  return <section className="finance-card budget-section">
    <div className="finance-section-heading"><div><span className="eyebrow">本月预算</span><h2>一眼看懂家庭预算进度</h2></div><button className="text-button" onClick={() => onOpen(overview.budget_center.drilldown_ref, "全部预算账单")}>查看明细</button></div>
    <div className="budget-visual">
      <div className="finance-ring-button" aria-label={`查看${overview.budget_center.label}明细`}>
        <BudgetRings rows={displayRows} onOpen={onOpen} />
        <button type="button" className="finance-ring-center" onClick={() => onOpen(overview.budget_center.drilldown_ref, "全部预算账单")}><small>{overview.budget_center.progress}% 已用</small><AdaptiveValue minFontSize={19} maxFontSize={30} ariaLabel={`预算已使用 ${money(overview.budget_center.total_used)} 元`}>¥ {money(overview.budget_center.total_used)}</AdaptiveValue><em className={remaining < 0 ? "over-budget" : ""}>{remaining < 0 ? `超出 ¥ ${money(Math.abs(remaining))}` : `剩余 ¥ ${money(remaining)}`}</em></button>
      </div>
      <div className="budget-ring__legend finance-budget-legend">
        {displayRows.map((row) => { const rowRemaining = numberValue(row.limit) - numberValue(row.used); return <button type="button" className={`budget-ring__item finance-budget-item${rowRemaining < 0 ? " is-over" : ""}`} key={row.category} onClick={() => onOpen(row.drilldown_ref, row.label)}><span className="budget-dot" style={{ background: colorFor(row.color_token) }} /><span className="budget-ring__item-label">{row.label}</span><span className="budget-ring__item-value">{rowRemaining < 0 ? `超出 ¥ ${money(Math.abs(rowRemaining))}` : `余额 ¥ ${money(rowRemaining)}`} · {row.progress}%</span></button>; })}
      </div>
    </div>
  </section>;
}

function BudgetRings({ rows, onOpen }: { rows: Array<{ category: string; label: string; progress: number; color_token: string; drilldown_ref: FinanceDrilldownRef }>; onOpen: (ref: FinanceDrilldownRef, title: string) => void }) {
  const center = 100;
  return <svg className="finance-ring-svg" viewBox="0 0 200 200" role="group" aria-label="预算分类环">
    <circle cx={center} cy={center} r={92} fill="none" stroke="rgba(112,105,171,.08)" strokeWidth="2" />
    {rows.slice(0, 6).map((row, index) => { const radius = 82 - index * 12; const circumference = 2 * Math.PI * radius; const progress = Math.max(0, Math.min(100, row.progress)); return <g key={`${row.color_token}-${index}`} transform="rotate(-90 100 100)"><circle cx={center} cy={center} r={radius} fill="none" stroke="rgba(112,105,171,.10)" strokeWidth="8" /><circle cx={center} cy={center} r={radius} fill="none" stroke={colorFor(row.color_token)} strokeWidth="8" strokeLinecap="round" strokeDasharray={`${circumference * progress / 100} ${circumference}`} /><circle cx={center} cy={center} r={radius} fill="none" stroke="transparent" strokeWidth="18" tabIndex={0} role="button" aria-label={`${row.label}预算，${row.progress}% 已用，查看明细`} onClick={() => onOpen(row.drilldown_ref, row.label)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(row.drilldown_ref, row.label); } }} /></g>; })}
  </svg>;
}

function TrendSection({ overview, granularity, onGranularityChange, onOpen }: { overview: FinanceOverview; granularity: FinanceGranularity; onGranularityChange: (value: FinanceGranularity) => void; onOpen: (ref: FinanceDrilldownRef, title: string) => void }) {
  return <ChartCard title="收入与支出趋势" subtitle={`按${granularityLabels[granularity]}展示，点击数据点进入账单`} points={overview.trend_points.map((point) => ({ bucket: point.bucket, values: [numberValue(point.income), numberValue(point.expense), numberValue(point.net_cash_flow)], ref: point.drilldown_ref }))} labels={["收入", "支出", "净现金流"]} colors={["#5b72f4", "#f06f8c", "#936fe7"]} onOpen={onOpen} containerRef={overview.trend_container.drilldown_ref} toolbar={<GranularityPicker value={granularity} onChange={onGranularityChange} />} />;
}

function AssetTrendSection({ overview, granularity, onGranularityChange, onOpen }: { overview: FinanceOverview; granularity: FinanceGranularity; onGranularityChange: (value: FinanceGranularity) => void; onOpen: (ref: FinanceDrilldownRef, title: string) => void }) {
  const [metric, setMetric] = useState<"gross" | "net" | "purchase" | "maintenance" | "recovery">("gross");
  const metricLabels = { gross: "总成本", net: "净现金", purchase: "购买", maintenance: "维护", recovery: "回收" } as const;
  const metricColors = { gross: "#e99b36", net: "#3eb391", purchase: "#f19a6b", maintenance: "#936fe7", recovery: "#5b72f4" } as const;
  const metricFields = { gross: "gross_cost", net: "net_cash_cost", purchase: "purchase_cost", maintenance: "maintenance_cost", recovery: "recovery" } as const;
  return <ChartCard title="实物资产成本趋势" subtitle={`按${granularityLabels[granularity]}查看${metricLabels[metric]}，点击数据点进入资产事件`} points={overview.asset_cost_points.map((point) => ({ bucket: point.bucket, values: [numberValue(point[metricFields[metric]])], ref: point.drilldown_ref }))} labels={[metricLabels[metric]]} colors={[metricColors[metric]]} onOpen={onOpen} containerRef={overview.asset_cost_container.drilldown_ref} toolbar={<div className="finance-chart-toolbar"><GranularityPicker value={granularity} onChange={onGranularityChange} /><div className="finance-segmented-control" aria-label="切换资产成本指标">{(Object.keys(metricLabels) as Array<keyof typeof metricLabels>).map((key) => <button type="button" className={metric === key ? "selected" : ""} key={key} onClick={() => setMetric(key)}>{metricLabels[key]}</button>)}</div></div>} />;
}

function GranularityPicker({ value, onChange }: { value: FinanceGranularity; onChange: (value: FinanceGranularity) => void }) {
  return <div className="finance-segmented-control" aria-label="切换趋势周期">{(Object.keys(granularityLabels) as FinanceGranularity[]).map((key) => <button type="button" className={value === key ? "selected" : ""} key={key} onClick={() => onChange(key)}>{granularityLabels[key]}</button>)}</div>;
}

function ChartCard({ title, subtitle, points, labels, colors, onOpen, containerRef, toolbar }: { title: string; subtitle: string; points: Array<{ bucket: string; values: number[]; ref: FinanceDrilldownRef }>; labels: string[]; colors: string[]; onOpen: (ref: FinanceDrilldownRef, title: string) => void; containerRef: FinanceDrilldownRef; toolbar?: ReactNode }) {
  const [visibleLines, setVisibleLines] = useState<boolean[]>(() => labels.map(() => true));
  const domainMin = Math.min(0, ...points.flatMap((point) => point.values));
  const domainMax = Math.max(0, ...points.flatMap((point) => point.values));
  const domainSpan = Math.max(1, domainMax - domainMin);
  const xFor = (index: number) => points.length <= 1 ? 50 : (index / (points.length - 1)) * 100;
  const yFor = (value: number) => 10 + ((domainMax - value) / domainSpan) * 78;
  const zeroTop = yFor(0);
  const pathFor = (lineIndex: number) => points.map((point, index) => `${index === 0 ? "M" : "L"} ${xFor(index) * 3.6} ${yFor(point.values[lineIndex])}`).join(" ");
  return <section className="finance-card chart-card">
    <div className="finance-section-heading chart-heading"><button className="chart-heading-main" onClick={() => onOpen(containerRef, title)}><div><span className="eyebrow">数据趋势</span><h2>{title}</h2><p>{subtitle}</p></div><span className="chart-chevron">›</span></button>{toolbar}</div>
    {points.length === 0 ? <div className="finance-chart-empty"><div className="chart-gridline gridline-a" /><div className="chart-gridline gridline-b" /><div className="chart-gridline gridline-c" /><strong>当前周期暂无数据</strong><span>数据出现后，点击曲线或“全部明细”继续查看。</span></div> : <>
      <div className="finance-chart" role="group" aria-label={`${title}，点击数据点查看明细`}>
        <div className="chart-gridline gridline-a" /><div className="chart-gridline gridline-b" /><div className="chart-gridline gridline-c" />
        <div className="chart-zero-line" style={{ top: `${zeroTop}%` }} aria-hidden="true" />
        <svg viewBox="0 0 360 100" preserveAspectRatio="none">{labels.map((_, lineIndex) => visibleLines[lineIndex] ? <path key={lineIndex} d={pathFor(lineIndex)} fill="none" stroke={colors[lineIndex]} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /> : null)}</svg>
        <div className="chart-point-layer">{points.flatMap((point, index) => labels.map((label, lineIndex) => visibleLines[lineIndex] ? <button type="button" key={`${point.bucket}-${lineIndex}`} className="chart-point" style={{ left: `${xFor(index)}%`, top: `${yFor(point.values[lineIndex])}%`, "--point-color": colors[lineIndex] } as CSSProperties} onClick={() => onOpen(point.ref, `${title} · ${label} · ${formatBucket(point.bucket)}`)} aria-label={`${label} ${formatBucket(point.bucket)}，${money(point.values[lineIndex])} 元，查看明细`} /> : null))}</div>
      </div>
      <div className="finance-chart-scale" aria-hidden="true"><span>¥ {money(domainMax)}</span><span>¥ 0.00</span><span>¥ {money(domainMin)}</span></div>
      <div className="finance-chart-axis">{points.filter((_, index) => points.length <= 5 || index === 0 || index === Math.floor((points.length - 1) / 2) || index === points.length - 1).map((point) => <span key={point.bucket}>{formatBucket(point.bucket)}</span>)}</div>
      <div className="finance-chart-legend">{labels.map((label, index) => <button type="button" className={visibleLines[index] ? "active" : "inactive"} key={label} onClick={() => setVisibleLines((current) => current.map((enabled, itemIndex) => itemIndex === index ? !enabled : enabled))}><i style={{ background: colors[index] }} />{label}</button>)}</div>
    </>}
  </section>;
}

function FinanceToolsSheet(props: { canImport: boolean; canExport: boolean; canEdit: boolean; onClose: () => void; onManagement: () => void; onAssets: () => void; onImport: () => void; onExport: () => void }) {
  return <FinanceSheet className="finance-tools-sheet" ariaLabel="财务工具" onClose={props.onClose}><div className="sheet-handle" /><div className="sheet-title"><div><span className="eyebrow">财务 · 工具</span><h2>把复杂操作放在这里</h2></div><button type="button" aria-label="关闭财务工具" onClick={props.onClose}>×</button></div><p className="finance-form-help">首页只保留新增记账，账户、资产、导入和导出都从这里进入，阅读不会被打断。</p>{!props.canEdit && <div className="finance-readonly-hint">当前成员可以查看财务数据，但写入、编辑和归档动作已按权限收起。</div>}<div className="finance-tool-grid"><button type="button" onClick={props.onManagement}><span>▦</span><strong>账户、分类与预算</strong><small>查看余额、预算和权限</small></button><button type="button" onClick={props.onAssets}><span>◌</span><strong>实物资产</strong><small>查看事件和成本趋势</small></button><button type="button" disabled={!props.canImport} onClick={props.onImport}><span>⇧</span><strong>导入账单</strong><small>{props.canImport ? "解析多来源账单" : "当前成员无导入权限"}</small></button><button type="button" disabled={!props.canExport} onClick={props.onExport}><span>⇩</span><strong>导出流水</strong><small>{props.canExport ? "生成当前周期 CSV" : "当前成员无导出权限"}</small></button></div></FinanceSheet>;
}

function FinanceTransactionsSheet(props: { range: { start: string; end: string }; importBatchId?: string; onClose: () => void; onTransaction: (id: string) => void }) {
  const [items, setItems] = useState<FinanceTransactionListItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const load = async (nextPage: number) => {
    const requestId = ++requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const result = await financeApi.listTransactions({ page: nextPage, page_size: 20, start: props.range.start, end: props.range.end, import_batch_id: props.importBatchId });
      if (requestId !== requestVersion.current) return;
      setItems((current) => nextPage === 1 ? result.items : [...current, ...result.items]);
      setPage(nextPage);
      setTotal(result.pagination.total);
    } catch (reason) {
      if (requestId === requestVersion.current) setError(reason instanceof Error ? reason.message : "全部流水暂时无法加载");
    }
    finally { if (requestId === requestVersion.current) setLoading(false); }
  };
  useEffect(() => { void load(1); }, [props.range.start, props.range.end, props.importBatchId]);
  const scopeLabel = props.importBatchId ? "当前导入批次" : "当前周期";
  return <FinanceSheet className="finance-transactions-sheet" ariaLabel="全部流水" onClose={props.onClose}><div className="sheet-handle" /><div className="sheet-title"><div><span className="eyebrow">账本流水 · {props.range.start} ～ {props.range.end}</span><h2>{props.importBatchId ? "导入结果流水" : "全部流水"}</h2></div><button type="button" aria-label="关闭全部流水" onClick={props.onClose}>×</button></div>{error && <div className="error-banner finance-form-error" role="alert"><span>{error}</span><button type="button" onClick={() => void load(page)}>重试</button><button type="button" onClick={() => setError(null)}>关闭</button></div>}{loading && items.length === 0 ? <div className="finance-empty-inline" role="status">正在读取{scopeLabel}…</div> : items.length === 0 ? <div className="finance-empty-inline">{props.importBatchId ? "该导入批次暂未写入统一账本流水。" : "当前周期没有已确认的流水。"}</div> : <><p className="finance-form-help">共 {total} 条 · 点击任意一条查看统一账单、来源和审计关系</p><div className="finance-drilldown-list">{items.map((item) => <button type="button" className="finance-drilldown-row" key={item.id} onClick={() => props.onTransaction(item.id)}><span className={`drilldown-row-icon ${item.direction}`}>{item.direction === "income" ? "↗" : item.direction === "transfer" ? "⇄" : "↘"}</span><span className="drilldown-row-copy"><strong>{item.merchant || "未命名账单"}</strong><small>{item.category || "未分类"} · {formatBucket(item.occurred_at)} · {item.origin === "manual" ? "手动记账" : "导入账单"}</small></span><span className={`drilldown-row-amount ${item.direction === "income" ? "income" : ""}`}>{item.direction === "income" ? "+" : item.direction === "transfer" ? "" : "-"}¥ {money(item.amount)}</span><span className="chevron">›</span></button>)}</div>{items.length < total && <button type="button" className="secondary-button wide" disabled={loading} onClick={() => void load(page + 1)}>{loading ? "正在加载…" : "继续加载"}</button>}</>}</FinanceSheet>;
}

function FinanceForbidden({ onRetry }: { onRetry: () => void }) {
  return <section className="finance-card finance-forbidden" role="alert"><div className="finance-forbidden-icon">⌁</div><h2>当前成员没有财务查看权限</h2><p>家庭所有者可以在权限设置中授予查看范围；当前不会展示任何账单、账户或预算数据。</p><button type="button" className="secondary-button" onClick={onRetry}>重新检查权限</button></section>;
}

function FinanceLoading() {
  return <div className="finance-loading" aria-label="正在加载财务数据"><div /><div /><div /><div /></div>;
}

function FinanceDrilldownSheet({ state, onClose, onTransaction, onAsset }: { state: DrilldownState; onClose: () => void; onTransaction: (id: string) => void; onAsset: (assetId: string) => void }) {
  const title = state.title;
  return <FinanceSheet className="finance-drilldown-sheet" ariaLabel={`财务下钻：${title}`} onClose={onClose}><div className="sheet-handle" /><div className="sheet-title"><div><span className="eyebrow">财务下钻</span><h2>{title}</h2></div><button type="button" aria-label="关闭财务明细" onClick={onClose}>×</button></div>{state.loading ? <div className="finance-empty-inline" role="status">正在整理明细…</div> : state.error ? <div className="empty-state small"><strong>{state.error}</strong><p>这条入口可能已过期，请重新获取首页数据。</p><button type="button" className="secondary-button" onClick={onClose}>返回财务首页</button></div> : state.data?.items.length ? <div className="finance-drilldown-list">{state.data.items.map((item, index) => <DrilldownRow key={String(item.id ?? index)} item={item} onTransaction={onTransaction} onAsset={onAsset} />)}</div> : <div className="finance-empty-inline">这个筛选条件下暂无明细</div>}</FinanceSheet>;
}

function DrilldownRow({ item, onTransaction, onAsset }: { item: Record<string, unknown>; onTransaction: (id: string) => void; onAsset: (assetId: string) => void }) {
  const isTransaction = typeof item.merchant === "string" && typeof item.direction === "string";
  const transactionId = isTransaction && typeof item.id === "string" ? item.id : typeof item.ledger_transaction_id === "string" ? item.ledger_transaction_id : null;
  const assetId = !transactionId && typeof item.asset_id === "string" ? item.asset_id : null;
  const title = isTransaction ? String(item.merchant || "未命名账单") : `${String(item.event_type ?? "资产事件")} · ${String(item.asset_name ?? item.asset_id ?? "")}`;
  const amount = money(item.amount ?? item.net_cash_cost ?? 0);
  return <button type="button" className="finance-drilldown-row" disabled={!transactionId && !assetId} onClick={() => transactionId ? onTransaction(transactionId) : assetId ? onAsset(assetId) : undefined}><span className="drilldown-row-icon">{isTransaction ? (item.direction === "income" ? "↗" : "↘") : "◌"}</span><span className="drilldown-row-copy"><strong>{title}</strong><small>{isTransaction ? `${String(item.category ?? "未分类")} · ${formatBucket(String(item.occurred_at ?? ""))}` : `${formatBucket(String(item.occurred_at ?? ""))} · 查看资产事件`}</small></span><span className={`drilldown-row-amount ${item.direction === "income" ? "income" : ""}`}>{item.direction === "income" ? "+" : "-"}¥ {amount}</span><span className="chevron">›</span></button>;
}

function TransactionSheet({ detail, onClose, onEdit, onVoid }: { detail: FinanceTransactionDetail; onClose: () => void; onEdit: (detail: FinanceTransactionDetail) => void; onVoid: (reason: string) => void }) {
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [reason, setReason] = useState("");
  const canManage = detail.origin === "manual" && detail.status === "confirmed";
  return <FinanceSheet className="finance-transaction-sheet" ariaLabel={`统一账单详情：${detail.merchant || "未命名账单"}`} onClose={onClose}>
      <div className="sheet-handle" />
      <div className="sheet-title"><div><span className="eyebrow">统一账单详情</span><h2>{detail.merchant || "未命名账单"}</h2></div><button type="button" aria-label="关闭账单详情" onClick={onClose}>×</button></div>
      <div className={`transaction-amount ${detail.direction === "income" ? "income" : ""}`}><span>{detail.direction === "income" ? "收入" : detail.direction === "expense" ? "支出" : "转账"}</span><AdaptiveValue minFontSize={24} maxFontSize={36} ariaLabel={`金额 ${money(detail.amount)} 元`}>¥ {money(detail.amount)}</AdaptiveValue></div>
      <div className="transaction-meta"><span>{detail.category || "未分类"}</span><time>{formatBucket(detail.occurred_at)}</time><span>{detail.currency}</span><span>{detail.origin === "manual" ? "手动记账" : detail.origin === "import" ? "导入账单" : "系统记录"}</span></div>
      {detail.note && <p className="transaction-note">{detail.note}</p>}
      {canManage && <div className="transaction-actions"><button type="button" className="secondary-button" onClick={() => onEdit(detail)}>编辑记录</button><button type="button" className="danger-button" onClick={() => setConfirmVoid(true)}>撤销记录</button></div>}
      {confirmVoid && <div className="transaction-void-confirm"><strong>确认撤销这笔手动记账？</strong><p>将撤销 ¥ {money(detail.amount)}，并从对应账户余额、预算和首页汇总中移除；审计记录会保留。</p><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="填写撤销原因" rows={2} maxLength={500} /><div><button type="button" className="secondary-button" onClick={() => setConfirmVoid(false)}>暂不撤销</button><button type="button" className="danger-button" disabled={!reason.trim()} onClick={() => onVoid(reason.trim())}>确认撤销</button></div></div>}
      <section className="transaction-section"><div className="finance-section-heading compact"><h3>账本分录 · {detail.entries.length}</h3></div>{detail.entries.length ? detail.entries.map((entry) => <div className="link-row" key={`${entry.account_id}-${entry.entry_side}`}><span>{entry.entry_side === "debit" ? "增加账户" : "减少账户"}</span><small>¥ {money(entry.amount)}</small></div>) : <p className="finance-muted">当前记录尚未绑定账户分录。</p>}</section>
      <section className="transaction-section"><div className="finance-section-heading compact"><h3>来源记录 · {detail.source_count}</h3></div>{detail.source_records.length ? detail.source_records.map((record) => <div className="source-record-row" key={record.id}><span className="source-record-dot" /><div><strong>{sourceLabels[record.source_type] ?? record.source_type}</strong><small>{record.merchant_detail || "暂无来源商户"} {record.order_reference ? `· ${record.order_reference}` : ""}</small></div><em>{record.detail_level === "anchor" ? "账本锚点" : "关联详情"}</em></div>) : <p className="finance-muted">当前账单暂无来源记录。</p>}</section>
      {detail.transaction_links.length > 0 && <section className="transaction-section"><div className="finance-section-heading compact"><h3>关联关系</h3></div>{detail.transaction_links.map((link) => <div className="link-row" key={link.id}><span>{link.link_type}</span><small>{link.status} · 置信度 {Math.round(link.confidence * 100)}%</small></div>)}</section>}
  </FinanceSheet>;
}
