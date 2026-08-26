import { useCallback, useEffect, useState } from "react";
import { financeApi, type FinanceAiSummary, type FinanceDrilldownRef } from "../api";
import { FinanceSheet } from "./FinanceSheet";
import { BunnyMark } from "./BunnyMark";

const financeAiSummaryCache = new Map<string, FinanceAiSummary>();

const statusLabels: Record<FinanceAiSummary["proposal"]["status"], string> = {
  proposed: "待确认",
  confirmed: "已确认",
  rejected: "已拒绝",
  revoked: "已撤销",
  expired: "已过期",
};

export function FinanceAiSheet(props: {
  period: { start: string; end: string };
  dataVersion: number;
  onClose: () => void;
  onOpenSource: (ref: FinanceDrilldownRef, title: string) => void;
}) {
  const [summary, setSummary] = useState<FinanceAiSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cacheKey = `${props.period.start}:${props.period.end}:v${props.dataVersion}`;
  const loadSummary = useCallback(async (force = false) => {
    if (!force) {
      const cached = financeAiSummaryCache.get(cacheKey);
      if (cached) {
        setSummary(cached);
        setError(null);
        setLoading(false);
        return;
      }
    }
    setLoading(true);
    setError(null);
    try {
      const next = await financeApi.getFinanceAiSummary(props.period.start, props.period.end);
      financeAiSummaryCache.set(cacheKey, next);
      setSummary(next);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "小兔子暂时无法整理财务数据"); }
    finally { setLoading(false); }
  }, [cacheKey, props.period.end, props.period.start]);

  useEffect(() => { void loadSummary(); }, [loadSummary]);

  const decide = async (decision: "confirm" | "reject") => {
    if (!summary) return;
    setWorking(true);
    try {
      const result = await financeApi.decideFinanceAiProposal(summary.proposal.id, decision, summary.proposal.version);
      const next = { ...summary, proposal: result.proposal };
      financeAiSummaryCache.set(cacheKey, next);
      setSummary(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "财务 AI 提案暂时无法处理"); }
    finally { setWorking(false); }
  };

  const revoke = async () => {
    if (!summary) return;
    setWorking(true);
    try {
      const result = await financeApi.revokeFinanceAiProposal(summary.proposal.id);
      const next = { ...summary, proposal: result.proposal };
      financeAiSummaryCache.set(cacheKey, next);
      setSummary(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "财务 AI 提案暂时无法撤销"); }
    finally { setWorking(false); }
  };

  return <FinanceSheet className="finance-ai-sheet" ariaLabel="小兔子财务解读" onClose={props.onClose}>
      <div className="sheet-handle" />
      <div className="sheet-title"><div><span className="eyebrow"><span className="bunny-mini"><BunnyMark size={24} /></span> 小兔子 · 财务解读</span><h2>这段时间的钱去哪儿了？</h2></div><button type="button" aria-label="关闭财务 AI 解读" onClick={props.onClose}>×</button></div>
      <p className="finance-ai-period">{props.period.start} ～ {props.period.end} · 只读解释，不自动改账</p>
      {error && <div className="error-banner finance-form-error" role="alert"><span>{error}</span><button type="button" onClick={() => void loadSummary(true)}>重新生成</button><button type="button" onClick={props.onClose}>返回首页查看原始数据</button></div>}
      {loading ? <div className="finance-empty-inline" role="status">小兔子正在读取当前家庭已授权的账本、预算和资产数据…</div> : summary && <><section className="finance-ai-summary-card"><strong>{summary.insight.summary}</strong><small>来源：{summary.insight.provider} · 模型：{summary.insight.model ?? "未提供"} · 生成于 {new Date(summary.insight.created_at).toLocaleString("zh-CN")} · 结论仅使用当前家庭数据</small></section><section className="finance-ai-section"><div className="finance-section-heading compact"><div><span className="eyebrow">发现</span><h3>值得留意的变化</h3></div></div><div className="finance-ai-points">{summary.insight.key_points.map((point) => <p key={point}>✦ {point}</p>)}</div></section><section className="finance-ai-section"><div className="finance-section-heading compact"><div><span className="eyebrow">解释</span><h3>为什么这样判断</h3></div></div><div className="finance-ai-points muted">{summary.insight.explanations.map((point) => <p key={point}>• {point}</p>)}</div></section><section className="finance-ai-section"><div className="finance-section-heading compact"><div><span className="eyebrow">来源</span><h3>可回溯到真实明细</h3></div></div><div className="finance-ai-source-list">{summary.insight.source_refs.slice(0, 8).map((source) => <button type="button" key={source.kind + source.id} onClick={() => { props.onClose(); props.onOpenSource(source.drilldown_ref, source.label); }}><span>{source.label}</span><small>{source.kind === "period" ? "周期总账" : source.kind === "transaction" ? "统一账单" : source.kind === "source_record" ? "原始来源" : source.kind === "budget" ? "预算规则" : "资产事件"} · 查看</small></button>)}</div></section><section className="finance-ai-proposal"><div><strong>财务 AI 建议</strong><p>确认只记录“已查看并接受这份解释”，不会自动合并、改账或改变预算；执行前仍会检查当前成员权限。</p></div><span className={"status " + summary.proposal.status}>{statusLabels[summary.proposal.status]}</span></section>{summary.proposal.status === "proposed" && <div className="sheet-actions"><button type="button" className="secondary-button" disabled={working} onClick={() => void decide("reject")}>暂不采纳</button><button type="button" className="primary-button" disabled={working} onClick={() => void decide("confirm")}>确认已了解</button></div>}{(summary.proposal.status === "confirmed" || summary.proposal.status === "proposed") && <button type="button" className="text-button finance-ai-revoke" disabled={working} onClick={() => void revoke()}>撤销这次 AI 建议</button>}</>}
  </FinanceSheet>;
}
