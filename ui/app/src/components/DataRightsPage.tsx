import { useEffect, useState } from "react";
import { dataRightsApi, type DataDeletionRequest, type DataRightsSummary } from "../api";
import { BunnyMark } from "./BunnyMark";

type DeletionType = DataDeletionRequest["request_type"];

export function DataRightsPage(props: { householdName: string; onBack: () => void; onOpenFinance: () => void }) {
  const [summary, setSummary] = useState<DataRightsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmType, setConfirmType] = useState<DeletionType | null>(null);
  const [phrase, setPhrase] = useState("");
  const [mutating, setMutating] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try { setSummary(await dataRightsApi.getSummary()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "数据与安全说明暂时无法加载"); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);

  const schedule = async () => {
    if (!confirmType || mutating) return;
    setMutating(true);
    setError(null);
    setSuccess(null);
    try {
      const next = await dataRightsApi.scheduleDeletion(confirmType);
      setSummary(next);
      setSuccess(confirmType === "household" ? "家庭删除计划已创建，可在等待期内撤销。" : "账号删除计划已创建，可在等待期内撤销。");
      setConfirmType(null);
      setPhrase("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除计划创建失败"); }
    finally { setMutating(false); }
  };

  const cancel = async (request: DataDeletionRequest) => {
    if (mutating) return;
    setMutating(true);
    setError(null);
    setSuccess(null);
    try {
      setSummary(await dataRightsApi.cancelDeletion(request.id, request.version));
      setSuccess("删除计划已撤销，当前数据不会进入删除处理。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除计划撤销失败"); }
    finally { setMutating(false); }
  };

  if (loading) return <section className="data-rights-page"><DataRightsHeader onBack={props.onBack} /><div className="data-rights-loading" role="status">正在读取服务端生效的数据规则…</div></section>;
  if (!summary) return <section className="data-rights-page"><DataRightsHeader onBack={props.onBack} /><div className="data-rights-empty" role="alert"><BunnyMark size={46} /><strong>暂时无法读取数据规则</strong><p>{error}</p><button type="button" className="primary-button" onClick={() => void load()}>重新加载</button></div></section>;

  const activeRequests = summary.requests.filter((item) => item.status === "scheduled" || item.status === "processing");
  const confirmationPhrase = confirmType === "household" ? "删除家庭" : "删除我的账号";
  const policy = confirmType ? summary.deletion[confirmType] : null;

  return <section className="data-rights-page">
    <DataRightsHeader onBack={props.onBack} />
    {error && <div className="data-rights-feedback error" role="alert">{error}<button type="button" onClick={() => setError(null)}>关闭</button></div>}
    {success && <div className="data-rights-feedback success" role="status">{success}<button type="button" onClick={() => setSuccess(null)}>关闭</button></div>}

    <section className="data-rights-hero">
      <div className="retention-orb"><strong>{summary.policies.original_bill_retention_days}</strong><span>天</span></div>
      <div><span className="eyebrow">数据保留基线</span><h1>你的数据边界，清楚可见。</h1><p>原始账单及导入中间数据从批次终态起保留一年，到期前 {summary.policies.original_bill_notice_days} 天提醒所有者。</p></div>
    </section>

    <div className="isolation-pills" aria-label="家庭数据隔离状态">
      <span><i aria-hidden="true">✓</i>家庭业务数据独立</span>
      <span><i aria-hidden="true">✓</i>AI 连接与记忆独立</span>
    </div>

    {activeRequests.length > 0 && <section className="data-section active-plans">
      <div className="data-section-title"><div><span className="eyebrow">处理中</span><h2>删除计划</h2></div><span className="status-chip waiting">等待期</span></div>
      {activeRequests.map((request) => <article className="deletion-plan" key={request.id}>
        <div className="plan-timeline"><span className="done" /><i /><span className={request.status === "processing" ? "done" : ""} /></div>
        <div><strong>{request.request_type === "household" ? "家庭删除" : "账号删除"}</strong><p>{request.status === "processing" ? "已经进入异步清理，不能再从这里撤销。" : `计划于 ${formatDate(request.execute_after)} 后进入异步处理。`}</p><small>申请时间 {formatDate(request.requested_at)} · 版本 {request.version}</small></div>
        {request.status === "scheduled" && <button type="button" className="cancel-plan-button" disabled={mutating} onClick={() => void cancel(request)}>{mutating ? "正在撤销…" : "撤销计划"}</button>}
      </article>)}
    </section>}

    <section className="data-section">
      <div className="data-section-title"><div><span className="eyebrow">可携带的数据</span><h2>数据导出</h2></div></div>
      <article className="export-row available">
        <span className="data-icon">↗</span><div><strong>财务账本 CSV</strong><p>{summary.exports.finance_ledger.description}</p></div>
        {summary.exports.finance_ledger.available ? <button type="button" onClick={props.onOpenFinance}>前往导出</button> : <span className="status-chip locked">需要授权</span>}
      </article>
      <article className="export-row">
        <span className="data-icon muted">⌁</span><div><strong>家庭全量归档</strong><p>{summary.exports.household_archive.description}</p></div><span className="status-chip planned">规划中</span>
      </article>
    </section>

    <section className="data-section retention-card">
      <div className="data-section-title"><div><span className="eyebrow">到期规则</span><h2>保留与清理</h2></div></div>
      <ul>
        <li><span>原始文件</span><p>保留 365 天；到期异步删除文件、原始行和临时关联材料。</p></li>
        <li><span>正式账本</span><p>原始文件到期不会删除已确认账本、关联结论和必要审计。</p></li>
        <li><span>备份副本</span><p>删除计划完成后，备份按独立保留策略自然过期，不承诺即时擦除。</p></li>
      </ul>
    </section>

    <section className="data-section danger-zone">
      <div className="data-section-title"><div><span className="eyebrow danger">不可逆操作</span><h2>账号与家庭删除</h2></div></div>
      <article>
        <div><strong>删除我的账号</strong><p>{summary.deletion.account.consequence}</p><small>{summary.deletion.account.wait_days} 天等待期 · 等待期内可撤销</small></div>
        <button type="button" disabled={!summary.deletion.account.available || activeRequests.some((item) => item.request_type === "account")} onClick={() => { setConfirmType("account"); setPhrase(""); }}>{summary.role === "owner" ? "所有者不可单独删除" : "申请删除"}</button>
      </article>
      <article>
        <div><strong>删除整个家庭</strong><p>{summary.deletion.household.consequence}</p><small>{summary.deletion.household.wait_days} 天等待期 · 仅家庭所有者</small></div>
        <button type="button" disabled={!summary.deletion.household.available || activeRequests.some((item) => item.request_type === "household")} onClick={() => { setConfirmType("household"); setPhrase(""); }}>申请删除家庭</button>
      </article>
      {summary.role === "owner" && <p className="owner-note">家庭所有者账号与家庭绑定。若只想停止使用，请先完成所有必要导出，再申请删除家庭。</p>}
    </section>

    {confirmType && policy && <div className="modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && !mutating && setConfirmType(null)}>
      <section className="sheet data-confirm-sheet" role="dialog" aria-modal="true" aria-labelledby="deletion-confirm-title">
        <div className="sheet-handle" />
        <div className="danger-symbol" aria-hidden="true">!</div>
        <span className="eyebrow danger">开始 {policy.wait_days} 天等待期</span>
        <h2 id="deletion-confirm-title">确认申请{confirmType === "household" ? `删除“${props.householdName}”` : "删除当前账号"}</h2>
        <p>{policy.consequence}</p>
        <div className="impact-list"><span>现在不会物理删除数据</span><span>等待期内可以撤销</span><span>进入异步处理后不能从页面撤回</span></div>
        <label>请输入“{confirmationPhrase}”确认<input autoFocus value={phrase} onChange={(event) => setPhrase(event.target.value)} placeholder={confirmationPhrase} autoComplete="off" /></label>
        <div className="sheet-actions"><button type="button" className="secondary-button" disabled={mutating} onClick={() => setConfirmType(null)}>返回检查</button><button type="button" className="danger-button" disabled={phrase !== confirmationPhrase || mutating} onClick={() => void schedule()}>{mutating ? "正在创建…" : `开始 ${policy.wait_days} 天等待期`}</button></div>
      </section>
    </div>}
  </section>;
}

function DataRightsHeader(props: { onBack: () => void }) {
  return <div className="page-back data-rights-header"><button type="button" aria-label="返回更多" onClick={props.onBack}>‹</button><span>数据与安全</span><span className="header-lock" aria-hidden="true">⌾</span></div>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
