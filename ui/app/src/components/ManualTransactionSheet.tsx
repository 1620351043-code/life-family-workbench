import { useEffect, useMemo, useState } from "react";
import { financeApi, type FinanceAccount, type FinanceCategory, type FinanceTransactionDetail, type ManualTransactionInput } from "../api";
import { FinanceSheet } from "./FinanceSheet";

type Direction = ManualTransactionInput["direction"];

const directionLabels: Record<Direction, string> = { expense: "支出", income: "收入", transfer: "转账" };

function localDateTime(value?: string) {
  const parsed = value ? new Date(value) : new Date();
  const now = Number.isNaN(parsed.valueOf()) ? new Date() : parsed;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function amountText(value: string) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0.00";
}

function projectedBalance(account: FinanceAccount | undefined, direction: Direction, amount: string) {
  if (!account) return "—";
  const value = Number(account.balance) || 0;
  const delta = Number(amount) || 0;
  if (direction === "expense") return amountText(String(value - delta));
  if (direction === "income") return amountText(String(value + delta));
  return amountText(account.balance);
}

export function ManualTransactionSheet(props: { accounts: FinanceAccount[]; categories: FinanceCategory[]; canCreateAccount: boolean; initial?: FinanceTransactionDetail; onClose: () => void; onSaved: () => void; onCreateAccount: () => void }) {
  const initial = props.initial;
  const [direction, setDirection] = useState<Direction>(initial?.direction ?? "expense");
  const [amount, setAmount] = useState(initial?.amount ?? "");
  const [merchant, setMerchant] = useState(initial?.merchant ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [occurredAt, setOccurredAt] = useState(localDateTime(initial?.occurred_at));
  const [accountId, setAccountId] = useState(initial?.entries[0]?.account_id ?? props.accounts[0]?.id ?? "");
  const [toAccountId, setToAccountId] = useState(initial?.direction === "transfer" ? initial.entries[1]?.account_id ?? "" : "");
  const [categoryId, setCategoryId] = useState(initial?.category_id ?? "");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId && props.accounts[0]) setAccountId(props.accounts[0].id);
  }, [accountId, props.accounts]);

  const categories = useMemo(() => props.categories.filter((category) => category.direction_scope === "both" || category.direction_scope === direction), [direction, props.categories]);
  const account = props.accounts.find((item) => item.id === accountId);
  const destinationAccounts = props.accounts.filter((item) => item.id !== accountId);
  const validAmount = /^\d+(?:\.\d{1,4})?$/.test(amount) && Number(amount) > 0;
  const canSubmit = Boolean(accountId && occurredAt && validAmount && (direction !== "transfer" || Boolean(toAccountId)) && !saving);

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const input: ManualTransactionInput = {
        direction,
        amount,
        currency: account?.currency ?? "CNY",
        account_id: accountId,
        to_account_id: direction === "transfer" ? toAccountId : null,
        category_id: direction === "transfer" ? null : categoryId || null,
        merchant: merchant.trim() || null,
        note: note.trim() || null,
        occurred_at: occurredAt,
      };
      if (initial) await financeApi.updateTransaction(initial.id, input);
      else await financeApi.createTransaction(input, idempotencyKey);
      props.onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "这笔记录暂时没有保存成功");
    } finally {
      setSaving(false);
    }
  };

  return <FinanceSheet className="finance-manual-sheet" ariaLabel={initial ? "编辑记账" : "新增记账"} onClose={props.onClose}>
      <div className="sheet-handle" />
      <div className="sheet-title">
        <div><span className="eyebrow">财务 · 真实账本</span><h2 id="manual-transaction-title">{initial ? "编辑记账" : "新增记账"}</h2></div>
        <button type="button" aria-label="关闭新增记账" onClick={props.onClose}>×</button>
      </div>
      {error && <div className="error-banner finance-form-error" role="alert">{error}</div>}
      {props.accounts.length === 0 ? <div className="manual-empty-account">
        <span className="manual-empty-icon">＋</span>
        <strong>先建立一个账户</strong>
        <p>每一笔记账都必须落到真实账户，避免统计出虚假的余额。</p>
        {props.canCreateAccount ? <button type="button" className="primary-button wide" onClick={props.onCreateAccount}>创建第一个账户</button> : <p className="manual-form-hint">当前成员没有账户管理权限，请联系家庭所有者建立账户后再记账。</p>}
      </div> : <>
        <div className="manual-direction-switch" role="tablist" aria-label="记账方向">
          {(Object.keys(directionLabels) as Direction[]).map((item) => <button type="button" role="tab" aria-selected={direction === item} className={direction === item ? "selected" : ""} key={item} onClick={() => { setDirection(item); setCategoryId(""); }}>{directionLabels[item]}</button>)}
        </div>
        <label className="manual-amount-field"><span>金额</span><div><b>¥</b><input autoFocus inputMode="decimal" type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" aria-label="记账金额" /></div></label>
        <div className="manual-form-grid">
          <label><span>{direction === "transfer" ? "转出账户" : "记入账户"}</span><select value={accountId} onChange={(event) => { setAccountId(event.target.value); if (event.target.value === toAccountId) setToAccountId(""); }}><option value="">选择账户</option>{props.accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · ¥ {amountText(item.balance)}</option>)}</select></label>
          {direction === "transfer" ? <label><span>转入账户</span><select value={toAccountId} onChange={(event) => setToAccountId(event.target.value)}><option value="">选择账户</option>{destinationAccounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : <label><span>分类 <em>可选</em></span><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">未分类</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
          <label><span>发生时间</span><input type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /></label>
          <label><span>商户 / 用途 <em>可选</em></span><input value={merchant} onChange={(event) => setMerchant(event.target.value)} placeholder="例如：晚餐、工资" maxLength={120} /></label>
        </div>
        <label><span>备注 <em>可选</em></span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="补充这笔账的背景，方便以后回看" rows={2} maxLength={500} /></label>
        <div className="manual-balance-preview"><span>保存后账户余额</span><strong>{direction === "transfer" ? "转账两端同步变更" : `¥ ${projectedBalance(account, direction, amount)}`}</strong><small>{direction === "expense" ? "支出会减少账户余额" : direction === "income" ? "收入会增加账户余额" : "转账不会改变家庭净现金流"}</small></div>
        <button type="button" className="primary-button wide manual-submit" disabled={!canSubmit} onClick={() => void submit()}>{saving ? "正在保存…" : initial ? "保存修改" : `保存${directionLabels[direction]}`}</button>
      </>}
  </FinanceSheet>;
}

export function AccountSheet(props: { initial?: FinanceAccount; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(props.initial?.name ?? "");
  const [accountType, setAccountType] = useState<FinanceAccount["account_type"]>(props.initial?.account_type ?? "bank");
  const [openingBalance, setOpeningBalance] = useState(props.initial?.opening_balance ?? "0");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = Boolean(name.trim() && /^\d+(?:\.\d{1,4})?$/.test(openingBalance) && !saving);
  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      if (props.initial) await financeApi.updateAccount(props.initial.id, { name: name.trim(), account_type: accountType });
      else await financeApi.createAccount({ name: name.trim(), account_type: accountType, currency: "CNY", opening_balance: openingBalance });
      props.onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "账户暂时没有创建成功");
    } finally {
      setSaving(false);
    }
  };
  return <FinanceSheet className="finance-account-sheet" ariaLabel={props.initial ? "编辑账户" : "建立一个账户"} onClose={props.onClose}><form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="sheet-handle" />
      <div className="sheet-title"><div><span className="eyebrow">财务 · 账户</span><h2>{props.initial ? "编辑账户" : "建立一个账户"}</h2></div><button type="button" aria-label="关闭创建账户" onClick={props.onClose}>×</button></div>
      {error && <div className="error-banner finance-form-error" role="alert">{error}</div>}
      <p className="manual-form-hint">账户是账本的落点。可以先从银行卡、现金或支付平台开始。</p>
      <label><span>账户名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：招商银行、家庭现金" maxLength={80} /></label>
      <label><span>账户类型</span><select value={accountType} onChange={(event) => setAccountType(event.target.value as FinanceAccount["account_type"])}><option value="bank">银行卡</option><option value="cash">现金</option><option value="wallet">钱包</option><option value="payment_platform">支付平台</option><option value="other">其他</option></select></label>
      <label><span>{props.initial ? "期初余额（不可在有流水后修改）" : "当前余额 / 期初余额"}</span><input inputMode="decimal" type="number" min="0" step="0.01" value={openingBalance} onChange={(event) => setOpeningBalance(event.target.value)} disabled={Boolean(props.initial)} /></label>
      <button className="primary-button wide" disabled={!canSubmit}>{saving ? "正在保存…" : props.initial ? "保存修改" : "保存账户"}</button>
    </form></FinanceSheet>;
}
