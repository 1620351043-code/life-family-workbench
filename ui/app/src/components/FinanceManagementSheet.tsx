import { useEffect, useRef, useState } from "react";
import { financeApi, type FinanceAccount, type FinanceAuditEntry, type FinanceBudget, type FinanceCategory, type FinancePermission } from "../api";
import { FinanceSheet } from "./FinanceSheet";

type Tab = "accounts" | "budgets" | "categories" | "permissions";
const permissionActions = [
  ["can_view", "查看"],
  ["can_bookkeep", "记账"],
  ["can_edit", "编辑"],
  ["can_import", "导入"],
  ["can_reconcile", "审核"],
  ["can_export", "导出"],
] as const;

function roleLabel(role: FinancePermission["role"]) {
  return ({ owner: "所有者", adult: "成人", child: "儿童", guest: "访客" })[role];
}

function auditActionLabel(action: string) {
  const labels: Record<string, string> = {
    finance_permission_updated: "更新财务授权",
    finance_permission_revoked: "撤销财务授权",
  };
  return labels[action] ?? action.replace(/^finance_/, "财务 · ");
}

function typeLabel(type: FinanceAccount["account_type"]) {
  return ({ bank: "银行卡", cash: "现金", wallet: "钱包", payment_platform: "支付平台", other: "其他" })[type];
}

export function FinanceManagementSheet(props: {
  accounts: FinanceAccount[];
  budgets: FinanceBudget[];
  categories: FinanceCategory[];
  period: { start: string; end: string };
  canEdit: boolean;
  canManagePermissions: boolean;
  onClose: () => void;
  onChanged: (scope?: "period" | "stable" | "all") => void;
  onCreateAccount: () => void;
  onEditAccount: (account: FinanceAccount) => void;
}) {
  const [tab, setTab] = useState<Tab>("accounts");
  const [budgetEditor, setBudgetEditor] = useState<FinanceBudget | null | undefined>(undefined);
  const [categoryEditor, setCategoryEditor] = useState<FinanceCategory | null | undefined>(undefined);
  const [permissionRows, setPermissionRows] = useState<FinancePermission[]>([]);
  const [auditRows, setAuditRows] = useState<FinanceAuditEntry[]>([]);
  const [permissionLoading, setPermissionLoading] = useState(false);
  const [savingPermissionUserId, setSavingPermissionUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ title: string; body: string; action: () => Promise<void> } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const permissionLoaded = useRef(false);

  const loadPermissions = async (force = false) => {
    if (permissionLoaded.current && !force) return;
    setPermissionLoading(true);
    try {
      const [permissionResult, auditResult] = await Promise.all([financeApi.getFinancePermissions(), financeApi.getFinanceAudit()]);
      setPermissionRows(permissionResult.permissions);
      setAuditRows(auditResult.entries);
      permissionLoaded.current = true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "权限与审计暂时无法读取");
    } finally { setPermissionLoading(false); }
  };

  useEffect(() => {
    if (tab !== "permissions") return;
    void loadPermissions();
  }, [tab]);

  const archiveAccount = async (account: FinanceAccount) => {
    setConfirmation({ title: `归档“${account.name}”？`, body: "已有流水会保留，但以后不能再作为新账落点。", action: async () => { try { await financeApi.archiveAccount(account.id); props.onChanged("stable"); } catch (reason) { setError(reason instanceof Error ? reason.message : "账户归档失败"); } } });
  };
  const archiveBudget = async (budget: FinanceBudget) => {
    setConfirmation({ title: `归档“${budget.category_name}”预算？`, body: "历史预算统计不会被删除，只会停止当前规则。", action: async () => { try { await financeApi.archiveBudget(budget.id); props.onChanged("period"); } catch (reason) { setError(reason instanceof Error ? reason.message : "预算归档失败"); } } });
  };
  const archiveCategory = async (category: FinanceCategory) => {
    setConfirmation({ title: `归档“${category.name}”？`, body: "历史账单会保留，分类将不再出现在新增记账选择中。", action: async () => { try { await financeApi.archiveCategory(category.id); props.onChanged("all"); } catch (reason) { setError(reason instanceof Error ? reason.message : "分类归档失败"); } } });
  };

  const togglePermission = (userId: string, action: typeof permissionActions[number][0]) => {
    setPermissionRows((rows) => rows.map((row) => row.user_id === userId && row.role !== "owner" ? { ...row, [action]: !row[action] } : row));
  };

  const savePermission = async (row: FinancePermission) => {
    setSavingPermissionUserId(row.user_id);
    try {
      const updated = await financeApi.updateFinancePermission(row.user_id, {
        can_view: row.can_view,
        can_bookkeep: row.can_bookkeep,
        can_edit: row.can_edit,
        can_import: row.can_import,
        can_reconcile: row.can_reconcile,
        can_export: row.can_export,
      });
      setPermissionRows((rows) => rows.map((item) => item.user_id === row.user_id ? updated : item));
      setAuditRows((await financeApi.getFinanceAudit()).entries);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "财务授权保存失败"); }
    finally { setSavingPermissionUserId(null); }
  };

  const revokePermission = async (row: FinancePermission) => {
    setConfirmation({ title: `撤销“${row.email}”的全部财务权限？`, body: "撤销后立即生效，历史审计记录仍会保留。", action: async () => { setSavingPermissionUserId(row.user_id); try { await financeApi.revokeFinancePermission(row.user_id); const [permissionResult, auditResult] = await Promise.all([financeApi.getFinancePermissions(), financeApi.getFinanceAudit()]); setPermissionRows(permissionResult.permissions); setAuditRows(auditResult.entries); } catch (reason) { setError(reason instanceof Error ? reason.message : "财务授权撤销失败"); } finally { setSavingPermissionUserId(null); } } });
  };

  const confirm = async () => {
    if (!confirmation) return;
    setConfirming(true);
    try { await confirmation.action(); } finally { setConfirming(false); setConfirmation(null); }
  };

  return <FinanceSheet className="finance-management-sheet" ariaLabel="账户与预算管理" onClose={props.onClose}>
      <div className="sheet-handle" />
      <div className="sheet-title"><div><span className="eyebrow">财务 · 账本设置</span><h2>账户与预算</h2></div><button type="button" aria-label="关闭账户与预算" onClick={props.onClose}>×</button></div>
      {error && <div className="error-banner finance-form-error" role="alert"><span>{error}</span>{tab === "permissions" && <button type="button" onClick={() => void loadPermissions(true)}>重试</button>}<button type="button" onClick={() => setError(null)}>关闭</button></div>}
      <div className="management-tabs" role="tablist" aria-label="财务管理分类">{(["accounts", "budgets", "categories", ...(props.canManagePermissions ? ["permissions" as const] : [])] as const).map((item) => <button type="button" role="tab" aria-selected={tab === item} className={tab === item ? "selected" : ""} key={item} onClick={() => setTab(item)}>{item === "accounts" ? "账户" : item === "budgets" ? "预算" : item === "categories" ? "分类" : "权限"}</button>)}</div>
      {tab === "accounts" && <section className="management-panel"><div className="management-intro"><div><strong>让每笔钱都有落点</strong><p>{props.canEdit ? "余额由期初余额和已确认分录实时计算。" : "当前为只读视图，余额由期初余额和已确认分录实时计算。"}</p></div>{props.canEdit && <button type="button" className="primary-button compact-button" onClick={props.onCreateAccount}>＋账户</button>}</div>{props.accounts.length === 0 ? <div className="finance-empty-inline">还没有账户，先建立一个真实资金落点。</div> : <div className="management-list">{props.accounts.map((account) => <article className="management-row" key={account.id}><div><strong>{account.name}</strong><small>{typeLabel(account.account_type)} · {account.currency} · {account.status === "active" ? "使用中" : "已归档"}</small></div><div className="management-row-side"><b>¥ {Number(account.balance).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>{props.canEdit && account.status === "active" && <div><button type="button" className="row-action" onClick={() => props.onEditAccount(account)}>编辑</button><button type="button" className="row-action danger-text" onClick={() => void archiveAccount(account)}>归档</button></div>}</div></article>)}</div>}</section>}
      {tab === "budgets" && <section className="management-panel"><div className="management-intro"><div><strong>{props.period.start.slice(0, 7)} 预算规则</strong><p>{props.canEdit ? "修改只影响当前或未来周期，历史账单不回写。" : "当前为只读视图，历史账单不会被修改。"}</p></div>{props.canEdit && <button type="button" className="primary-button compact-button" onClick={() => setBudgetEditor(null)}>＋预算</button>}</div>{props.budgets.length === 0 ? <div className="finance-empty-inline">当前周期还没有预算规则。</div> : <div className="management-list">{props.budgets.map((budget) => <article className="management-row" key={budget.id}><div><strong>{budget.category_name}</strong><small>{budget.period_start} ～ {budget.period_end} · 已用 {budget.progress}%</small></div><div className="management-row-side"><b>¥ {Number(budget.remaining).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 剩余</b>{props.canEdit && <div><button type="button" className="row-action" onClick={() => setBudgetEditor(budget)}>编辑</button><button type="button" className="row-action danger-text" onClick={() => void archiveBudget(budget)}>归档</button></div>}</div></article>)}</div>}</section>}
      {tab === "categories" && <section className="management-panel"><div className="management-intro"><div><strong>分类是预算和账单的稳定索引</strong><p>{props.canEdit ? "归档不会删除历史账单，只会停止新记账选择。" : "当前为只读视图，历史分类仍会保留。"}</p></div>{props.canEdit && <button type="button" className="primary-button compact-button" onClick={() => setCategoryEditor(null)}>＋分类</button>}</div><div className="management-list">{props.categories.map((category) => <article className="management-row" key={category.id}><div><strong><span className="budget-dot" style={{ background: category.color_token }} />{category.name}</strong><small>{category.direction_scope === "both" ? "收入与支出" : category.direction_scope === "expense" ? "支出" : "收入"} · {category.status === "active" ? "使用中" : "已归档"}</small></div><div className="management-row-side">{props.canEdit && category.status === "active" && <div><button type="button" className="row-action" onClick={() => setCategoryEditor(category)}>编辑</button><button type="button" className="row-action danger-text" onClick={() => void archiveCategory(category)}>归档</button></div>}</div></article>)}</div></section>}
      {tab === "permissions" && props.canManagePermissions && <section className="management-panel permission-panel"><div className="management-intro"><div><strong>家庭财务权限</strong><p>所有者可分别控制查看、记账、编辑、导入、审核与导出；儿童默认不开放。</p></div></div>{permissionLoading ? <div className="finance-empty-inline">正在读取家庭授权与审计记录…</div> : <><div className="permission-list">{permissionRows.map((row) => <article className="permission-card" key={row.user_id}><div className="permission-heading"><div><strong>{row.email}</strong><small>{roleLabel(row.role)} · {row.role === "owner" ? "系统保护" : row.revoked_at ? "已撤销" : row.explicit ? "已单独设置" : "默认权限"}</small></div>{row.role !== "owner" && <button type="button" className="row-action danger-text" disabled={savingPermissionUserId === row.user_id} onClick={() => void revokePermission(row)}>撤销全部</button>}</div><div className="permission-grid">{permissionActions.map(([action, label]) => <button type="button" key={action} className={`permission-toggle${row[action] ? " enabled" : ""}`} aria-pressed={row[action]} disabled={row.role === "owner"} onClick={() => togglePermission(row.user_id, action)}>{label}<span>{row[action] ? "已开" : "未开"}</span></button>)}</div>{row.role !== "owner" && <button type="button" className="primary-button wide" disabled={savingPermissionUserId === row.user_id} onClick={() => void savePermission(row)}>{savingPermissionUserId === row.user_id ? "保存中…" : "保存此成员授权"}</button>}</article>)}</div><div className="audit-section"><div className="section-heading"><strong>最近审计</strong><span>只读留痕</span></div>{auditRows.length === 0 ? <div className="finance-empty-inline">还没有财务授权变更记录。</div> : <div className="audit-list">{auditRows.map((entry) => <div className="audit-row" key={entry.id}><div><strong>{auditActionLabel(entry.action)}</strong><small>{entry.resource_type} · {entry.resource_id ? entry.resource_id.slice(0, 8) : "—"}</small></div><time>{new Date(entry.created_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></div>)}</div>}</div></>}</section>}
      {budgetEditor !== undefined && <BudgetEditor initial={budgetEditor ?? undefined} categories={props.categories} period={props.period} onClose={() => setBudgetEditor(undefined)} onSaved={() => { setBudgetEditor(undefined); props.onChanged("period"); }} />}
      {categoryEditor !== undefined && <CategoryEditor initial={categoryEditor ?? undefined} onClose={() => setCategoryEditor(undefined)} onSaved={() => { setCategoryEditor(undefined); props.onChanged("all"); }} />}
      {confirmation && <div className="finance-confirm-panel" role="alertdialog" aria-label={confirmation.title}><strong>{confirmation.title}</strong><p>{confirmation.body}</p><div className="sheet-actions"><button type="button" className="secondary-button" disabled={confirming} onClick={() => setConfirmation(null)}>取消</button><button type="button" className="danger-button" disabled={confirming} onClick={() => void confirm()}>{confirming ? "处理中…" : "确认操作"}</button></div></div>}
  </FinanceSheet>;
}

function BudgetEditor(props: { initial?: FinanceBudget; categories: FinanceCategory[]; period: { start: string; end: string }; onClose: () => void; onSaved: () => void }) {
  const [categoryId, setCategoryId] = useState(props.initial?.category_id ?? props.categories.find((item) => item.status === "active" && (item.direction_scope === "expense" || item.direction_scope === "both"))?.id ?? "");
  const [amount, setAmount] = useState(props.initial?.amount ?? "");
  const [name, setName] = useState(props.initial?.category_name ? `${props.initial.category_name}预算` : "");
  const [cycle, setCycle] = useState<FinanceBudget["cycle"]>(props.initial?.cycle ?? "month");
  const [start, setStart] = useState(props.initial?.period_start ?? props.period.start);
  const [end, setEnd] = useState(props.initial?.period_end ?? props.period.end);
  const [error, setError] = useState<string | null>(null);
  const activeCategories = props.categories.filter((item) => item.status === "active" && (item.direction_scope === "expense" || item.direction_scope === "both"));
  const canSubmit = Boolean(categoryId && /^\d+(?:\.\d{1,4})?$/.test(amount) && start && end && end >= start);
  const submit = async () => {
    if (!canSubmit) return;
    try {
      const input = { category_id: categoryId, name, cycle, amount, currency: "CNY", period_start: start, period_end: end };
      if (props.initial) await financeApi.updateBudget(props.initial.id, input); else await financeApi.createBudget(input);
      props.onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "预算暂时没有保存成功"); }
  };
  return <div className="management-editor"><div className="management-editor-heading"><strong>{props.initial ? "编辑预算" : "新增预算"}</strong><button type="button" aria-label="关闭预算编辑" onClick={props.onClose}>×</button></div>{error && <div className="error-banner finance-form-error" role="alert">{error}</div>}<label>预算分类<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">选择分类</option>{activeCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>预算额度<input inputMode="decimal" type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="例如：3000" /></label><label>规则名称 <em>可选</em><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：每月餐饮" maxLength={80} /></label><label>周期<select value={cycle} onChange={(event) => setCycle(event.target.value as FinanceBudget["cycle"])}><option value="month">每月</option><option value="quarter">每季度</option><option value="year">每年</option><option value="custom">自定义</option></select></label><div className="management-date-grid"><label>开始<input type="date" value={start} onChange={(event) => setStart(event.target.value)} /></label><label>结束<input type="date" value={end} onChange={(event) => setEnd(event.target.value)} /></label></div><button type="button" className="primary-button wide" disabled={!canSubmit} onClick={() => void submit()}>保存预算</button></div>;
}

function CategoryEditor(props: { initial?: FinanceCategory; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(props.initial?.name ?? "");
  const [scope, setScope] = useState<FinanceCategory["direction_scope"]>(props.initial?.direction_scope ?? "expense");
  const [color, setColor] = useState(props.initial?.color_token ?? "violet");
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!name.trim()) return;
    try { const input = { name: name.trim(), direction_scope: scope, color_token: color }; if (props.initial) await financeApi.updateCategory(props.initial.id, input); else await financeApi.createCategory(input); props.onSaved(); } catch (reason) { setError(reason instanceof Error ? reason.message : "分类暂时没有保存成功"); }
  };
  return <div className="management-editor"><div className="management-editor-heading"><strong>{props.initial ? "编辑分类" : "新增分类"}</strong><button type="button" aria-label="关闭分类编辑" onClick={props.onClose}>×</button></div>{error && <div className="error-banner finance-form-error" role="alert">{error}</div>}<label>分类名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：家庭出行" maxLength={40} /></label><label>适用方向<select value={scope} onChange={(event) => setScope(event.target.value as FinanceCategory["direction_scope"])}><option value="expense">支出</option><option value="income">收入</option><option value="both">收入与支出</option></select></label><label>颜色标识<select value={color} onChange={(event) => setColor(event.target.value)}><option value="pink">粉色</option><option value="orange">橙色</option><option value="blue">蓝色</option><option value="violet">紫色</option><option value="green">绿色</option><option value="cyan">青色</option></select></label><button type="button" className="primary-button wide" disabled={!name.trim()} onClick={() => void submit()}>保存分类</button></div>;
}
