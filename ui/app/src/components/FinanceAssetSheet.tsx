import { useEffect, useRef, useState } from "react";
import { financeApi, type FinanceAsset, type FinanceAssetDetail, type FinanceAssetEventType, type FinanceTransactionListItem } from "../api";
import { FinanceSheet } from "./FinanceSheet";

const eventLabels: Record<FinanceAssetEventType, string> = {
  purchase: "购买",
  maintenance: "维修",
  consumable: "耗材",
  upgrade: "升级",
  transfer: "转让",
  sale: "出售",
  disposal: "处置",
};

const statusLabels: Record<FinanceAsset["status"], string> = { held: "持有中", transferred: "已转让", sold: "已出售", disposed: "已处置" };

function money(value: string) {
  return Number(value ?? 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function dateTime(value: string | null) {
  if (!value) return "暂无事件";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function FinanceAssetSheet(props: {
  assets: FinanceAsset[];
  transactions: FinanceTransactionListItem[];
  canEdit: boolean;
  initialAssetId?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(props.initialAssetId ?? null);
  const [detail, setDetail] = useState<FinanceAssetDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [editor, setEditor] = useState<"asset" | "event" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const detailRequestVersion = useRef(0);

  const reloadDetail = () => {
    const requestId = ++detailRequestVersion.current;
    const assetId = selectedId;
    if (!assetId) return;
    setLoading(true);
    setError(null);
    void financeApi.getAsset(assetId).then((next) => {
      if (requestId === detailRequestVersion.current) setDetail(next);
    }).catch((reason) => {
      if (requestId === detailRequestVersion.current) setError(reason instanceof Error ? reason.message : "资产详情暂时无法加载");
    }).finally(() => {
      if (requestId === detailRequestVersion.current) setLoading(false);
    });
  };

  useEffect(() => {
    if (!selectedId) return;
    reloadDetail();
  }, [selectedId]);

  useEffect(() => {
    if (props.initialAssetId) setSelectedId(props.initialAssetId);
  }, [props.initialAssetId]);

  const refresh = (next?: FinanceAssetDetail | FinanceAsset) => {
    props.onChanged();
    if (next && "events" in next) {
      setSelectedId(next.id);
      setDetail(next);
    } else if (selectedId) {
      reloadDetail();
    }
  };

  return <FinanceSheet className="finance-asset-sheet" ariaLabel={`实物资产${detail ? `：${detail.name}` : ""}`} onClose={props.onClose}>
      <div className="sheet-handle" />
      <div className="sheet-title"><div><span className="eyebrow">财务 · 实物资产</span><h2>{detail ? detail.name : "资产与成本"}</h2></div><button type="button" aria-label="关闭实物资产" onClick={props.onClose}>×</button></div>
      {error && <div className="error-banner finance-form-error" role="alert"><span>{error}</span><button type="button" onClick={reloadDetail}>重试</button><button type="button" onClick={() => setError(null)}>关闭</button></div>}
      {!detail && <>
        <div className="asset-intro"><div><strong>把买过的东西记成家庭资产</strong><p>购买、维修和回收会汇总到成本趋势，历史事件不会被删除。</p></div>{props.canEdit && <button type="button" className="primary-button compact-button" onClick={() => setEditor("asset")}>＋资产</button>}</div>
        {props.assets.length === 0 ? <div className="finance-empty-inline">还没有实物资产，先登记一件常用设备吧。</div> : <div className="management-list asset-list">{props.assets.map((asset) => <button type="button" className="asset-row" key={asset.id} onClick={() => setSelectedId(asset.id)}><span className="asset-row-icon">◌</span><span className="asset-row-copy"><strong>{asset.name}</strong><small>{asset.asset_type} · {statusLabels[asset.status]} · {asset.event_count} 条事件</small></span><span className="asset-row-cost"><b>¥ {money(asset.net_cash_cost)}</b><small>净成本</small></span><span className="chevron">›</span></button>)}</div>}
      </>}
      {detail && <>
        <button type="button" className="asset-back-button" onClick={() => { detailRequestVersion.current += 1; setSelectedId(null); setDetail(null); setEditor(null); }}>‹ 返回资产列表</button>
        <div className="asset-summary-grid"><div><small>累计成本</small><strong>¥ {money(detail.gross_cost)}</strong></div><div><small>已回收</small><strong className="income">¥ {money(detail.recovery)}</strong></div><div><small>净现金成本</small><strong>¥ {money(detail.net_cash_cost)}</strong></div></div>
        <div className="asset-detail-meta"><span>{detail.asset_type}</span><span className={`asset-status ${detail.status}`}>{statusLabels[detail.status]}</span><span>最近 {dateTime(detail.last_event_at)}</span>{props.canEdit && <button type="button" className="row-action" onClick={() => setEditor("asset")}>编辑</button>}</div>
        {loading ? <div className="finance-empty-inline">正在整理资产事件…</div> : <section className="asset-events"><div className="finance-section-heading compact"><div><span className="eyebrow">成本轨迹</span><h3>{detail.events.length} 条资产事件</h3></div>{props.canEdit && detail.status === "held" && <button type="button" className="primary-button compact-button" onClick={() => setEditor("event")}>＋事件</button>}</div>{detail.events.length === 0 ? <div className="finance-empty-inline">还没有事件，先记录购买成本。</div> : detail.events.map((event) => <article className="asset-event-row" key={event.id}><span className={`asset-event-dot ${event.event_type}`} /><div><strong>{eventLabels[event.event_type]}</strong><small>{dateTime(event.occurred_at)}{event.ledger_transaction_id ? " · 已关联账单" : ""}</small></div><div className="asset-event-amount"><b>{event.amount === "0.0000" ? "—" : `¥ ${money(event.amount)}`}</b>{Number(event.recovery_amount) > 0 && <small>回收 ¥ {money(event.recovery_amount)}</small>}</div></article>)}</section>}
      </>}
      {editor === "asset" && <AssetEditor initial={detail ?? undefined} onClose={() => setEditor(null)} onSaved={(next) => { setEditor(null); refresh(next); }} />}
      {editor === "event" && detail && <AssetEventEditor asset={detail} transactions={props.transactions} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); refresh(); }} />}
  </FinanceSheet>;
}

function AssetEditor(props: { initial?: FinanceAssetDetail; onClose: () => void; onSaved: (asset: FinanceAssetDetail | FinanceAsset) => void }) {
  const [name, setName] = useState(props.initial?.name ?? "");
  const [assetType, setAssetType] = useState(props.initial?.asset_type ?? "家用设备");
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!name.trim() || !assetType.trim()) return;
    try {
      const result = props.initial ? await financeApi.updateAsset(props.initial.id, { name: name.trim(), asset_type: assetType.trim() }) : await financeApi.createAsset({ name: name.trim(), asset_type: assetType.trim() });
      props.onSaved(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "资产暂时没有保存成功"); }
  };
  return <div className="management-editor asset-editor"><div className="management-editor-heading"><strong>{props.initial ? "编辑资产" : "新增实物资产"}</strong><button type="button" aria-label="关闭资产编辑" onClick={props.onClose}>×</button></div>{error && <div className="error-banner finance-form-error" role="alert">{error}</div>}<label>资产名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：家用咖啡机" maxLength={120} /></label><label>资产类型<select value={assetType} onChange={(event) => setAssetType(event.target.value)}><option value="家用设备">家用设备</option><option value="电子产品">电子产品</option><option value="家具">家具</option><option value="交通工具">交通工具</option><option value="其他">其他</option></select></label><button type="button" className="primary-button wide" disabled={!name.trim() || !assetType.trim()} onClick={() => void submit()}>保存资产</button></div>;
}

function AssetEventEditor(props: { asset: FinanceAssetDetail; transactions: FinanceTransactionListItem[]; onClose: () => void; onSaved: () => void }) {
  const [eventType, setEventType] = useState<FinanceAssetEventType>("purchase");
  const [amount, setAmount] = useState("");
  const [recoveryAmount, setRecoveryAmount] = useState("0");
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [transactionId, setTransactionId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const canSubmit = Boolean(occurredAt && /^\d+(?:\.\d{1,4})?$/.test(amount || "0") && /^\d+(?:\.\d{1,4})?$/.test(recoveryAmount || "0"));
  const submit = async () => {
    if (!canSubmit) return;
    try { await financeApi.createAssetEvent(props.asset.id, { occurred_at: occurredAt, event_type: eventType, amount: amount || "0", recovery_amount: recoveryAmount || "0", ledger_transaction_id: transactionId || null }); props.onSaved(); } catch (reason) { setError(reason instanceof Error ? reason.message : "资产事件暂时没有保存成功"); }
  };
  return <div className="management-editor asset-editor"><div className="management-editor-heading"><strong>新增资产事件</strong><button type="button" aria-label="关闭资产事件编辑" onClick={props.onClose}>×</button></div>{error && <div className="error-banner finance-form-error" role="alert">{error}</div>}<div className="asset-event-hint">{props.asset.name} · 事件会更新资产成本和首页趋势</div><label>事件类型<select value={eventType} onChange={(event) => setEventType(event.target.value as FinanceAssetEventType)}>{(Object.keys(eventLabels) as FinanceAssetEventType[]).map((type) => <option key={type} value={type}>{eventLabels[type]}</option>)}</select></label><label>发生时间<input type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /></label><div className="management-date-grid"><label>事件金额<input inputMode="decimal" type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="例如：699" /></label><label>回收金额<input inputMode="decimal" type="number" min="0" step="0.01" value={recoveryAmount} onChange={(event) => setRecoveryAmount(event.target.value)} placeholder="没有则填 0" /></label></div><label>关联已确认账单 <em>可选</em><select value={transactionId} onChange={(event) => setTransactionId(event.target.value)}><option value="">暂不关联</option>{props.transactions.map((item) => <option key={item.id} value={item.id}>{item.merchant || "未命名账单"} · ¥ {money(item.amount)}</option>)}</select></label><p className="finance-form-help">出售/处置后资产会进入终止状态，不能继续新增事件；关联账单只保留来源关系，不会重复扣款。</p><button type="button" className="primary-button wide" disabled={!canSubmit} onClick={() => void submit()}>保存事件</button></div>;
}
