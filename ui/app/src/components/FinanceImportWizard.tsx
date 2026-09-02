import { useEffect, useMemo, useRef, useState } from "react";
import { financeApi, type FinanceAccount, type FinanceImportBatch, type FinanceImportErrorRow, type FinanceImportJob, type FinanceImportSource, type FinanceReconciliationCandidate } from "../api";
import { FinanceSheet } from "./FinanceSheet";

type ImportStep = "select" | "batch" | "header" | "mapping" | "review" | "commit";
type FinanceImportSheetPreview = NonNullable<FinanceImportBatch["header_preview"]>["sheets"][number];

const sourceLabels: Record<FinanceImportSource, string> = { bank: "银行", alipay: "支付宝", wechat: "微信支付", bookkeeping_app: "记账 App", other: "其他" };
const mappingFields = [
  ["occurred_at", "交易时间"],
  ["amount", "金额"],
  ["direction", "收支方向"],
  ["merchant", "交易对方"],
  ["external_id", "流水号"],
  ["remark", "备注"],
] as const;

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

async function sha256(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function displayStep(step: ImportStep) {
  return { select: "选择文件", batch: "登记批次", header: "确认表头", mapping: "字段映射", review: "关联审核", commit: "提交账本" }[step];
}

export function FinanceImportWizard({ accounts, onClose, onError, onOpenImportedTransactions, onChanged }: { accounts: FinanceAccount[]; onClose: () => void; onError: (message: string) => void; onOpenImportedTransactions: (batchId: string) => void; onChanged?: () => void }) {
  const [source, setSource] = useState<FinanceImportSource>("bank");
  const [accountId, setAccountId] = useState("");
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileHash, setFileHash] = useState("");
  const [batch, setBatch] = useState<FinanceImportBatch | null>(null);
  const [step, setStep] = useState<ImportStep>("select");
  const [busy, setBusy] = useState(false);
  const [sheetName, setSheetName] = useState("Sheet1");
  const [headerRow, setHeaderRow] = useState(1);
  const [dataStartRow, setDataStartRow] = useState(2);
  const [mapping, setMapping] = useState<Record<string, string>>({ occurred_at: "交易时间", amount: "金额" });
  const [candidates, setCandidates] = useState<FinanceReconciliationCandidate[]>([]);
  const [summary, setSummary] = useState<{ inserted_transactions: number; linked_records: number; pending_records: number; failed_records: number } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<FinanceImportBatch[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [errorRows, setErrorRows] = useState<FinanceImportErrorRow[]>([]);
  const [errorsOpen, setErrorsOpen] = useState(false);
  const [errorsLoading, setErrorsLoading] = useState(false);
  const fileSelectionVersion = useRef(0);

  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id);
  }, [accountId, accounts]);
  useEffect(() => {
    if (step !== "batch" || !batch) return;
    const jobStatus = batch.parse_job?.status;
    const shouldPoll = batch.status === "scanning" || jobStatus === "queued" || jobStatus === "running";
    if (!shouldPoll) return;
    let cancelled = false;
    let timer: ReturnType<typeof window.setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await financeApi.getImportBatch(batch.id);
        if (cancelled) return;
        if (next.status === "header_detected") { syncParsedPage(next); return; }
        setBatch(next);
        const nextJobStatus = next.parse_job?.status;
        if (next.status === "scanning" || nextJobStatus === "queued" || nextJobStatus === "running") timer = window.setTimeout(poll, 900);
      } catch (reason) {
        if (!cancelled) onError(reason instanceof Error ? reason.message : "解析状态暂时无法读取");
      }
    };
    timer = window.setTimeout(poll, 650);
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [batch?.id, batch?.status, batch?.parse_job?.status, step, onError]);

  const progress = useMemo(() => ["select", "batch", "header", "mapping", "review", "commit"].indexOf(step), [step]);
  const applyParsed = (parsed: { batch: FinanceImportBatch; job: FinanceImportJob }) => {
    setBatch(parsed.batch);
    setHeaderRow(parsed.batch.detected_header_row ?? 1);
    setDataStartRow((parsed.batch.detected_header_row ?? 1) + 1);
    setSheetName(parsed.batch.detected_sheet ?? "Sheet1");
    setMapping(parsed.batch.field_mapping && Object.keys(parsed.batch.field_mapping).length > 0 ? parsed.batch.field_mapping : mapping);
    setStep(parsed.batch.status === "header_detected" ? "header" : "batch");
  };
  const syncParsedPage = (next: FinanceImportBatch) => {
    setBatch(next);
    if (next.status === "header_detected") {
      setHeaderRow(next.detected_header_row ?? 1);
      setDataStartRow((next.detected_header_row ?? 1) + 1);
      setSheetName(next.detected_sheet ?? "Sheet1");
      if (next.field_mapping && Object.keys(next.field_mapping).length > 0) setMapping(next.field_mapping);
      setStep("header");
    }
  };
  const previewSheets = batch?.header_preview?.sheets ?? [];
  const activePreview = previewSheets.find((item) => item.sheet_name === sheetName) ?? previewSheets[0];
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); } catch (reason) { onError(reason instanceof Error ? reason.message : "导入步骤暂时无法完成"); } finally { setBusy(false); }
  };

  const selectFile = async (nextFile: File | null) => {
    const selectionId = ++fileSelectionVersion.current;
    if (nextFile && !/\.(csv|xls|xlsx|txt|pdf|zip)$/i.test(nextFile.name)) {
      setFile(null);
      setFileHash("");
      onError("暂不支持这个文件格式，请选择 CSV、XLS、XLSX、TXT、PDF 或 ZIP");
      return;
    }
    setFile(nextFile);
    setFileHash("");
    if (nextFile) {
      try {
        const nextHash = await sha256(nextFile);
        if (selectionId === fileSelectionVersion.current) setFileHash(nextHash);
      } catch (_) {
        if (selectionId === fileSelectionVersion.current) onError("无法读取文件摘要，请重新选择");
      }
    }
  };

  const createBatch = () => {
    if (!file || !fileHash) return;
    void run(async () => {
      const created = await financeApi.createImportBatch({ source_type: source, file_name: file.name, file_size: file.size, file_sha256: fileHash, object_key: `pending-upload/${fileHash}/${encodeURIComponent(file.name)}`, account_id: accountId || null });
      const uploaded = await financeApi.uploadImportFile(created.id, file);
      const parsed = await financeApi.parseImportBatch(uploaded.id);
      applyParsed(parsed);
    });
  };

  const confirmHeader = () => {
    if (!batch) return;
    void run(async () => {
      const updated = await financeApi.confirmImportHeader(batch.id, { sheet_name: sheetName.trim() || "Sheet1", header_row: headerRow, data_start_row: dataStartRow });
      setBatch(updated);
      setStep("mapping");
    });
  };

  const selectPreviewSheet = (nextSheetName: string) => {
    const nextSheet = previewSheets.find((item) => item.sheet_name === nextSheetName);
    if (!nextSheet) return;
    setSheetName(nextSheet.sheet_name ?? "Sheet1");
    const nextHeaderRow = nextSheet.header_row ?? 1;
    setHeaderRow(nextHeaderRow);
    setDataStartRow(nextSheet.data_start_row ?? nextHeaderRow + 1);
    setMapping(nextSheet.field_mapping ?? mapping);
  };

  const selectPreviewHeader = (nextHeaderRow: number) => {
    setHeaderRow(nextHeaderRow);
    setDataStartRow(nextHeaderRow + 1);
  };

  const confirmMapping = () => {
    if (!batch || !mapping.occurred_at || !mapping.amount) return;
    void run(async () => {
      const updated = await financeApi.confirmImportMapping(batch.id, { mapping, parser_version: "real-bill-parser-v1" });
      setBatch(updated);
      const result = await financeApi.getImportReconciliation(batch.id);
      setCandidates(result.candidates);
      setStep("review");
    });
  };

  const decide = (candidate: FinanceReconciliationCandidate, decision: string) => {
    if (!batch) return;
    void run(async () => {
      const updated = await financeApi.decideImportReconciliation(batch.id, { candidate_id: candidate.id, decision, expected_version: batch.version });
      setCandidates((items) => items.map((item) => item.id === updated.id ? { ...item, ...updated } : item));
      setBatch(await financeApi.getImportBatch(batch.id));
    });
  };

  const commit = () => {
    if (!batch) return;
    void run(async () => {
      const result = await financeApi.commitImportBatch(batch.id, { expected_version: batch.version, confirm_summary_hash: fileHash || "client-confirmed" }, `commit-${batch.id}-${batch.version}`);
      setBatch(result.batch);
      setSummary({ inserted_transactions: result.inserted_transactions, linked_records: result.linked_records, pending_records: result.pending_records, failed_records: result.failed_records });
      setStep("commit");
    });
  };

  const canCommit = Boolean(batch && batch.status === "confirmed" && candidates.every((candidate) => candidate.status !== "pending_review"));

  const goBack = () => {
    const previous: Record<ImportStep, ImportStep | null> = { select: null, batch: "select", header: "batch", mapping: "header", review: "mapping", commit: "review" };
    const target = previous[step];
    if (target) setStep(target);
  };

  const loadHistory = () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    void financeApi.listImportBatches().then((result) => setHistory(result.batches)).catch((reason) => onError(reason instanceof Error ? reason.message : "历史批次暂时无法加载")).finally(() => setHistoryLoading(false));
  };

  const revoke = () => {
    if (!batch) return;
    void run(async () => {
      const updated = await financeApi.revokeImportBatch(batch.id, `revoke-${batch.id}-${batch.version}`);
      setBatch(updated);
      setSummary(null);
      setRevokeConfirmOpen(false);
      onChanged?.();
    });
  };

  const resumeBatch = (nextBatch: FinanceImportBatch) => {
    setBatch(nextBatch);
    setSummary(null);
    setHistoryOpen(false);
    if (nextBatch.status === "header_detected") {
      setHeaderRow(nextBatch.detected_header_row ?? 1);
      setDataStartRow((nextBatch.detected_header_row ?? 1) + 1);
      setSheetName(nextBatch.detected_sheet ?? "Sheet1");
      setStep("header");
    } else if (nextBatch.status === "mapping_pending") {
      setStep("mapping");
    } else if (["normalized", "matching", "reconciliation_pending", "confirmed"].includes(nextBatch.status)) {
      void run(async () => {
        const result = await financeApi.getImportReconciliation(nextBatch.id);
        setCandidates(result.candidates);
        setStep("review");
      });
    } else {
      setStep("commit");
    }
  };

  const reopenReview = () => {
    if (!batch) return;
    void run(async () => {
      const result = await financeApi.getImportReconciliation(batch.id);
      setCandidates(result.candidates);
      setStep("review");
    });
  };

  const openErrors = () => {
    if (!batch) return;
    setErrorsOpen(true);
    setErrorsLoading(true);
    void financeApi.listImportErrors(batch.id).then((result) => setErrorRows(result.rows)).catch((reason) => onError(reason instanceof Error ? reason.message : "问题行暂时无法加载")).finally(() => setErrorsLoading(false));
  };

  const downloadErrorReport = () => {
    if (!errorRows.length) return;
    const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const rows = [["行号", "状态", "错误码", "原始字段"], ...errorRows.map((row) => [row.row_number, row.status, row.error_codes.join("、"), JSON.stringify(row.normalized_payload)])];
    const csv = `\uFEFF${rows.map((row) => row.map(quote).join(",")).join("\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${batch?.file_name ?? "finance-import"}-问题行.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const resumeParse = () => {
    if (!batch) return;
    void run(async () => {
      const parsed = await financeApi.parseImportBatch(batch.id);
      applyParsed(parsed);
    });
  };
  const pauseParseJob = () => {
    if (!batch?.parse_job) return;
    void run(async () => {
      await financeApi.pauseImportParseJob(batch.parse_job!.id);
      syncParsedPage(await financeApi.getImportBatch(batch.id));
    });
  };
  const resumeParseJob = () => {
    if (!batch?.parse_job) return;
    void run(async () => {
      await financeApi.resumeImportParseJob(batch.parse_job!.id);
      applyParsed(await financeApi.parseImportBatch(batch.id));
    });
  };
  const cancelParseJob = () => {
    if (!batch?.parse_job) return;
    void run(async () => {
      await financeApi.cancelImportParseJob(batch.parse_job!.id);
      syncParsedPage(await financeApi.getImportBatch(batch.id));
    });
  };
  const retryParseJob = () => {
    if (!batch?.parse_job) return;
    void run(async () => {
      await financeApi.retryImportParseJob(batch.parse_job!.id);
      applyParsed(await financeApi.parseImportBatch(batch.id));
    });
  };

  return <FinanceSheet className="finance-import-sheet" ariaLabel="账单导入向导" onClose={onClose}><div className="sheet-handle" /><div className="sheet-title"><div><span className="eyebrow">财务 · 账单导入</span><h2>{step === "commit" ? "导入已完成" : "把多份账单整理成一笔"}</h2></div><button type="button" aria-label="关闭账单导入" onClick={onClose}>×</button></div>
    <div className="import-stepper" aria-label="导入进度">{["select", "batch", "header", "mapping", "review", "commit"].map((item, index) => <span className={index <= progress ? "active" : ""} aria-current={step === item ? "step" : undefined} key={item}><i>{index + 1}</i>{displayStep(item as ImportStep)}</span>)}</div>
    {historyOpen && <section className="import-history-panel" aria-label="历史导入批次"><div className="finance-section-heading compact"><div><span className="eyebrow">恢复进度</span><h3>最近导入批次</h3></div><button type="button" className="text-button" onClick={() => setHistoryOpen(false)}>关闭</button></div>{historyLoading ? <div className="finance-empty-inline" role="status">正在读取历史批次…</div> : history.length === 0 ? <div className="finance-empty-inline">还没有可恢复的导入批次。</div> : <div className="import-history-list">{history.map((item) => <button type="button" className="import-history-item" key={item.id} onClick={() => resumeBatch(item)}><span><strong>{item.file_name}</strong><small>{sourceLabels[item.source_type]} · {item.counts.rows} 行 · 保留至 {new Date(item.raw_retention_until).toLocaleDateString("zh-CN")}</small></span><span className={`import-status ${item.status}`}>{item.status === "committed" ? "已提交" : item.status === "failed" ? "失败" : "继续"} ›</span></button>)}</div>}</section>}
    {errorsOpen && <section className="import-errors-panel" aria-label="导入问题行"><div className="finance-section-heading compact"><div><span className="eyebrow">提交结果 · 问题行</span><h3>需要修正的原始行</h3></div><button type="button" className="text-button" onClick={() => setErrorsOpen(false)}>关闭</button></div>{errorsLoading ? <div className="finance-empty-inline" role="status">正在读取问题行…</div> : errorRows.length === 0 ? <div className="finance-empty-inline">当前批次没有可下载的问题行。</div> : <><div className="import-error-list">{errorRows.map((row) => <div className="import-error-row" key={row.row_number}><strong>第 {row.row_number} 行</strong><span>{row.error_codes.length ? row.error_codes.join(" · ") : "字段校验失败"}</span><small>{JSON.stringify(row.normalized_payload)}</small></div>)}</div><button type="button" className="secondary-button wide" onClick={downloadErrorReport}>下载问题行 CSV</button></>}</section>}
    {step === "select" && <section className="import-panel"><p className="import-lead">选择一份导出的账单。上传后会直接展示行号和原始内容，点击任意行即可确认表头。</p><div className="import-source-grid">{(Object.keys(sourceLabels) as FinanceImportSource[]).map((item) => <button type="button" key={item} className={source === item ? "selected" : ""} onClick={() => setSource(item)}>{sourceLabels[item]}</button>)}</div>{accounts.length > 0 && <label>入账账户<select className="import-select" value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">暂不绑定（导入流水为待入账）</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · ¥ {Number(item.balance || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</option>)}</select><small className="import-honesty">绑定后，确认提交的导入流水会直接进入该账户余额和报表；不绑定仍会写入统一账本，但等待账户归属。</small></label>}<label className="file-drop"><input type="file" accept=".csv,.xls,.xlsx,.txt,.pdf,.zip" onChange={(event) => void selectFile(event.target.files?.[0] ?? null)} /><span>＋</span><strong>{file ? file.name : "选择 CSV / XLS / XLSX / TXT / PDF / ZIP 文件"}</strong><small>{file ? `${formatBytes(file.size)} · 正在生成文件摘要` : "原始文件按家庭隔离，保留一年"}</small></label>{file && <div className="import-file-meta"><span>{sourceLabels[source]}</span><span>{fileHash ? "SHA-256 已生成" : "正在读取…"}</span></div>}<button type="button" className="primary-button wide" disabled={!file || !fileHash || busy} onClick={createBatch}>{busy ? "正在上传并解析…" : "上传并登记导入批次"}</button><button type="button" className="secondary-button wide" onClick={loadHistory}>恢复历史批次</button><small className="import-honesty">文件会先上传到当前家庭的隔离存储并校验摘要，再由解析 worker 识别表头并写入待审核来源记录。</small></section>}
    {step === "batch" && batch && <section className="import-panel"><ImportStatusCard batch={batch} file={file} />{batch.status === "failed" ? <div className="import-warning import-job-failed"><strong>解析失败</strong><p>{batch.parse_job?.error_message ?? "解析 worker 未能完成账单读取，请重试或取消本次导入。"}</p></div> : batch.status === "cancelled" || batch.parse_job?.status === "cancelled" ? <div className="import-warning"><strong>解析已取消</strong><p>账单仍保留在隔离存储中，需要时可以重新开始解析；未写入正式账本。</p></div> : batch.parse_job?.status === "paused" ? <div className="import-warning"><strong>解析已暂停</strong><p>worker 已停止领取该任务；恢复后会自动继续，不会产生重复记录。</p></div> : <div className="import-warning"><strong>{batch.parse_job && ["queued", "running"].includes(batch.parse_job.status) ? "正在解析，已自动排队" : "文件已安全上传，等待解析"}</strong><p>原始文件已完成大小和 SHA-256 校验，但还没有把内容写入正式账本；点击继续会重新调用解析 worker，不会重复入账。</p></div>}<div className="import-job-actions">{batch.parse_job && ["queued", "running"].includes(batch.parse_job.status) && <button type="button" className="secondary-button" disabled={busy} onClick={pauseParseJob}>暂停解析</button>}{batch.parse_job?.status === "paused" && <button type="button" className="primary-button" disabled={busy} onClick={resumeParseJob}>恢复解析</button>}{batch.parse_job && ["queued", "running", "paused"].includes(batch.parse_job.status) && <button type="button" className="secondary-button" disabled={busy} onClick={cancelParseJob}>取消解析</button>}{batch.parse_job?.status === "failed" && <button type="button" className="primary-button" disabled={busy} onClick={retryParseJob}>重试解析</button>}{!batch.parse_job || batch.parse_job.status === "succeeded" || batch.parse_job.status === "failed" || batch.parse_job.status === "cancelled" ? <button type="button" className="primary-button wide" disabled={busy} onClick={resumeParse}>{busy ? "正在解析…" : "继续识别表头"}</button> : null}</div></section>}
    {step === "header" && batch && <section className="import-panel"><ImportStatusCard batch={batch} file={file} /><p className="import-lead">系统已标记建议表头。先看清原始行号和内容，再点击表头行确认；数据起始行会自动从下一行开始。</p>{previewSheets.length > 1 ? <label>工作表<select className="import-select" value={sheetName} onChange={(event) => selectPreviewSheet(event.target.value)}>{previewSheets.map((item) => <option key={item.sheet_name ?? "sheet"} value={item.sheet_name ?? "Sheet1"}>{item.sheet_name ?? "Sheet1"}{item.empty ? "（空）" : ` · ${item.preview_rows.length} 行预览`}</option>)}</select></label> : <div className="import-file-meta"><span>工作表 · {activePreview?.sheet_name ?? sheetName}</span><span>{activePreview?.header_score ? `识别置信度 ${activePreview.header_score}` : "已完成扫描"}</span></div>}<HeaderPreview preview={activePreview} headerRow={headerRow} dataStartRow={dataStartRow} onSelectHeader={selectPreviewHeader} /><div className="import-number-grid"><label>表头行<input type="number" min={1} value={headerRow} onChange={(event) => { const value = Number(event.target.value); setHeaderRow(value); if (value > 0) setDataStartRow(value + 1); }} /></label><label>数据起始行<input type="number" min={1} value={dataStartRow} onChange={(event) => setDataStartRow(Number(event.target.value))} /></label></div><button className="primary-button wide" disabled={busy || headerRow < 1 || dataStartRow <= headerRow} onClick={confirmHeader}>确认第 {headerRow} 行为表头并继续</button></section>}
    {step === "mapping" && batch && <section className="import-panel"><ImportStatusCard batch={batch} file={file} /><p className="import-lead">只允许确认必要字段后继续。原始字段名保留，方便审计和重新解析。</p><div className="mapping-list">{mappingFields.map(([key, label]) => <label key={key}><span>{label}{(key === "occurred_at" || key === "amount") && <em>必填</em>}</span><input value={mapping[key] ?? ""} placeholder={`对应${label}列`} onChange={(event) => setMapping((current) => ({ ...current, [key]: event.target.value }))} /></label>)}</div><button className="primary-button wide" disabled={busy || !mapping.occurred_at || !mapping.amount} onClick={confirmMapping}>确认映射并查看关联</button></section>}
    {step === "review" && batch && <section className="import-panel"><ImportStatusCard batch={batch} file={file} /><div className="review-summary"><strong>{candidates.length ? `发现 ${candidates.length} 组关联候选` : "没有待审核的跨来源候选"}</strong><span>{candidates.filter((item) => item.status === "pending_review").length} 组待处理</span></div>{candidates.length ? <div className="candidate-list">{candidates.map((candidate) => <CandidateCard key={candidate.id} candidate={candidate} disabled={busy} onDecision={(decision) => decide(candidate, decision)} />)}</div> : <div className="import-empty">没有候选关联的记录会作为独立账单进入预览。</div>}<button className="primary-button wide" disabled={!canCommit || busy} onClick={() => setStep("commit")}>查看提交预览</button><small className="import-honesty">只有明确确认关联后，才会把银行记录作为账本锚点；平台详情仍会保留。</small></section>}
    {step === "commit" && batch && <section className="import-panel"><ImportStatusCard batch={batch} file={file} />{summary ? <div className="commit-summary"><SummaryMetric label="新增统一账本" value={summary.inserted_transactions} onClick={() => onOpenImportedTransactions(batch.id)} /><SummaryMetric label="保留关联来源" value={summary.linked_records} onClick={() => onOpenImportedTransactions(batch.id)} /><SummaryMetric label="待处理记录" value={summary.pending_records} onClick={reopenReview} /><SummaryMetric label="失败/问题行" value={summary.failed_records} onClick={openErrors} /></div> : batch.status === "committed" ? <><div className="import-success-card"><strong>这个批次已经提交到统一账本</strong><p>可以从历史批次重新打开，或返回财务首页查看对应流水。</p><button type="button" className="secondary-button wide" onClick={() => onOpenImportedTransactions(batch.id)}>查看该批次流水</button></div>{!revokeConfirmOpen ? <button type="button" className="secondary-button wide import-revoke-button" disabled={busy} onClick={() => setRevokeConfirmOpen(true)}>撤销这个导入批次</button> : <div className="import-revoke-confirm" role="alertdialog" aria-label="确认撤销导入批次"><strong>确认撤销这个导入批次？</strong><p>已写入的正式流水会改为撤销状态，不会再次入账；原始来源、关联和审计记录会保留。</p><div className="sheet-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setRevokeConfirmOpen(false)}>暂不撤销</button><button type="button" className="danger-button" disabled={busy} onClick={revoke}>{busy ? "正在撤销…" : "确认撤销"}</button></div></div>}</> : batch.status === "revoked" ? <div className="import-warning"><strong>这个批次已经撤销</strong><p>正式流水已停止参与余额和报表；原始来源与审计仍保留，可以关闭后返回首页确认。</p><button type="button" className="secondary-button wide" onClick={onClose}>返回财务首页</button></div> : <><div className="import-warning"><strong>提交前最后确认</strong><p>已确认的重复关系只会生成一笔统一账本交易；银行优先作为锚点，支付平台保留为详细来源。</p></div><button type="button" className="primary-button wide" disabled={!canCommit || busy} onClick={commit}>{busy ? "正在写入…" : "确认写入统一账本"}</button></>}<button type="button" className="secondary-button wide" onClick={onClose}>{summary || batch.status === "committed" || batch.status === "revoked" ? "返回财务首页" : "取消"}</button></section>}
    {step !== "select" && <div className="import-wizard-footer"><button type="button" className="secondary-button" disabled={busy} onClick={goBack}>上一步</button><button type="button" className="text-button" disabled={busy} onClick={onClose}>暂存并关闭</button></div>}
  </FinanceSheet>;
}

function HeaderPreview({ preview, headerRow, dataStartRow, onSelectHeader }: { preview?: FinanceImportSheetPreview; headerRow: number; dataStartRow: number; onSelectHeader: (row: number) => void }) {
  if (!preview || preview.preview_rows.length === 0) return <div className="header-preview-empty">这个工作表没有可预览的内容，请切换工作表或重新上传文件。</div>;
  return <div className="header-preview-card"><div className="header-preview-toolbar"><div><strong>原始表格预览</strong><small>显示行号 · 点击一行设为表头</small></div><span>预览 {preview.preview_rows.length} 行</span></div><div className="header-preview-legend"><span><i className="preview-dot detected" />系统识别</span><span><i className="preview-dot selected" />当前表头</span><span><i className="preview-dot data" />数据起始</span></div><div className="header-preview-scroll" role="group" aria-label="原始表格行预览">{preview.preview_rows.map((row) => { const isHeader = row.row_number === headerRow; const isDataStart = row.row_number === dataStartRow; return <button type="button" className={`header-preview-row ${isHeader ? "is-header" : ""} ${isDataStart ? "is-data-start" : ""}`} key={row.row_number} onClick={() => onSelectHeader(row.row_number)} aria-label={`第 ${row.row_number} 行${isHeader ? "，当前表头" : ""}`}><span className="header-preview-line">{row.row_number}</span><span className="header-preview-values">{row.values.length ? row.values.map((value, index) => <span key={`${row.row_number}-${index}`}>{value || "—"}</span>) : <em>空行</em>}</span><span className="header-preview-tag">{isHeader ? "表头" : isDataStart ? "数据起始" : row.role === "metadata" ? "说明" : ""}</span></button>; })}</div><small className="header-preview-hint">{preview.preview_rows.some((row) => row.row_number === dataStartRow) ? `第 ${headerRow} 行将作为字段名，第 ${dataStartRow} 行开始读取账单` : `第 ${headerRow} 行将作为字段名；数据起始行设为第 ${dataStartRow} 行`}</small></div>;
}

function ImportStatusCard({ batch, file }: { batch: FinanceImportBatch; file: File | null }) {
  const job = batch.parse_job;
  const jobStatusLabels: Record<string, string> = { queued: "排队中", running: "解析中", paused: "已暂停", succeeded: "已完成", failed: "失败", cancelled: "已取消" };
  return <div className="import-status-card"><div><span className="eyebrow">当前批次</span><strong>{file?.name ?? batch.file_name ?? batch.id.slice(0, 8)}</strong></div><span className={`import-status ${batch.status}`}>{job && batch.status === "scanning" ? jobStatusLabels[job.status] ?? job.status : batch.status}</span><small>{batch.counts.rows} 行{batch.counts.invalid ? ` · ${batch.counts.invalid} 行待修正` : ""} · 原始文件保留至 {new Date(batch.raw_retention_until).toLocaleDateString("zh-CN")}{job ? ` · 解析 ${job.attempts}/${job.max_attempts} 次` : ""}</small></div>;
}

function CandidateCard({ candidate, disabled, onDecision }: { candidate: FinanceReconciliationCandidate; disabled: boolean; onDecision: (decision: string) => void }) {
  return <article className="candidate-card"><div className="candidate-heading"><div><span className="eyebrow">关联候选 · {Math.round(candidate.confidence * 100)}% 匹配</span><strong>{candidate.status === "pending_review" ? "请确认是否为同一笔消费" : "已确认"}</strong></div><span className={`import-status ${candidate.status}`}>{candidate.recommended_link_type}</span></div><div className="candidate-reason-codes">{candidate.reason_codes.length ? candidate.reason_codes.map((code) => <span key={code}>{code}</span>) : <span>系统未提供额外证据</span>}</div><div className="candidate-records">{candidate.records.map((record) => <div key={record.id}><span>{sourceLabels[record.source_type as FinanceImportSource] ?? record.source_type}</span><strong>{record.merchant_detail || "来源记录"}</strong><small>{record.direction} · {record.amount} · {new Date(record.occurred_at).toLocaleString("zh-CN")}</small></div>)}</div>{candidate.status === "pending_review" && <div className="candidate-actions"><button type="button" className="secondary-button" disabled={disabled} onClick={() => onDecision("unrelated")}>不是同一笔</button><button type="button" className="primary-button" disabled={disabled} onClick={() => onDecision("duplicate")}>确认重复</button></div>}</article>;
}

function SummaryMetric({ label, value, onClick }: { label: string; value: number; onClick: () => void }) {
  return <button type="button" className="commit-summary-metric" onClick={onClick}><strong>{value}</strong><span>{label}</span><small>查看 ›</small></button>;
}
