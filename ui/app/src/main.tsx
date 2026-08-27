import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiRequestError, authApi, familyApi, type AuthIdentity, type TopicAiSummary, type TopicCard, type TopicDetail } from "./api";
import { FinancePage } from "./components/FinancePage";
import { FoodPage } from "./components/FoodPage";
import { BunnyMark } from "./components/BunnyMark";
import { AuthLoading, AuthPage } from "./components/AuthPage";
import "./styles.css";
import "./design-system.css";
import "./auth.css";
import "./finance.css";
import "./food.css";

type Route = "space" | "food" | "finance" | "more";

const navItems: Array<{ id: Route; label: string; icon: string }> = [
  { id: "space", label: "家庭空间", icon: "⌂" },
  { id: "food", label: "吃什么", icon: "✦" },
  { id: "finance", label: "财务", icon: "￥" },
  { id: "more", label: "更多", icon: "•••" },
];

function App() {
  const [resetToken, setResetToken] = useState<string | null>(() => new URLSearchParams(window.location.search).get("reset_token"));
  const [identity, setIdentity] = useState<AuthIdentity | null>(null);
  const [sessionStatus, setSessionStatus] = useState<"checking" | "anonymous" | "authenticated">("checking");
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>("space");
  const [topics, setTopics] = useState<TopicCard[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<TopicDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiSummary, setAiSummary] = useState<TopicAiSummary | null>(null);
  const [commentSending, setCommentSending] = useState(false);
  const topicRequestVersion = useRef(0);
  const skipNextSessionCheck = useRef(false);

  const checkSession = async () => {
    setSessionStatus("checking");
    setSessionMessage(null);
    try {
      const current = await authApi.getMe();
      setIdentity(current);
      setSessionStatus("authenticated");
    } catch (reason) {
      setIdentity(null);
      setSessionStatus("anonymous");
      if (!(reason instanceof ApiRequestError && reason.status === 401)) setSessionMessage(reason instanceof Error ? reason.message : "暂时无法确认登录状态");
    }
  };

  const refreshTopics = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await familyApi.listTopics();
      setTopics(result.topics);
      if (selectedTopic) setSelectedTopic(await familyApi.getTopic(selectedTopic.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "家庭空间暂时无法加载");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (resetToken) {
      window.history.replaceState({}, "", window.location.pathname);
      setIdentity(null);
      setSessionStatus("anonymous");
      return;
    }
    if (skipNextSessionCheck.current) {
      skipNextSessionCheck.current = false;
      setIdentity(null);
      setSessionStatus("anonymous");
      return;
    }
    void checkSession();
  }, [resetToken]);
  useEffect(() => {
    if (!identity) {
      setTopics([]);
      setSelectedTopic(null);
      return;
    }
    void refreshTopics();
  }, [identity?.household.id]);

  const openTopic = async (topic: TopicCard) => {
    const requestId = ++topicRequestVersion.current;
    setError(null);
    try {
      const detail = await familyApi.getTopic(topic.id);
      if (requestId === topicRequestVersion.current) setSelectedTopic(detail);
    } catch (reason) {
      if (requestId === topicRequestVersion.current) setError(reason instanceof Error ? reason.message : "主题暂时无法打开");
    }
  };

  const createTopic = async (input: { title: string; body: string; topicType: TopicCard["topic_type"] }) => {
    setError(null);
    try {
      const topic = await familyApi.createTopic({ topic_type: input.topicType, title: input.title, body: input.body });
      setTopics((current) => [topic, ...current]);
      setSelectedTopic(topic);
      setComposerOpen(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "主题发布失败"); }
  };

  const addComment = async (body: string): Promise<boolean> => {
    if (!selectedTopic) return false;
    const topicId = selectedTopic.id;
    if (commentSending) return false;
    setCommentSending(true);
    setError(null);
    try {
      const comment = await familyApi.createComment(topicId, body);
      setSelectedTopic((current) => current && current.id === topicId ? { ...current, comments: [...current.comments, comment], comment_count: current.comment_count + 1 } : current);
      setTopics((current) => current.map((topic) => topic.id === topicId ? { ...topic, comment_count: topic.comment_count + 1 } : topic));
      return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "评论发布失败"); return false; }
    finally { setCommentSending(false); }
  };

  const generateAiSummary = async () => {
    if (!selectedTopic) return;
    setError(null);
    try { setAiSummary(await familyApi.summarizeTopic(selectedTopic.id)); setAiOpen(true); } catch (reason) { setError(reason instanceof Error ? reason.message : "小兔子暂时无法整理"); }
  };

  const decideAiAction = async (decision: "confirm" | "reject") => {
    if (!aiSummary) return;
    setError(null);
    try {
      const result = await familyApi.decideAiAction(aiSummary.action_proposal.id, decision, aiSummary.action_proposal.version);
      setAiSummary({ ...aiSummary, action_proposal: { ...aiSummary.action_proposal, ...result.proposal } });
      if (decision === "confirm" && selectedTopic) setSelectedTopic(await familyApi.getTopic(selectedTopic.id));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "小兔子行动未完成"); }
  };

  const logout = async () => {
    setError(null);
    try {
      await authApi.logout();
      setIdentity(null);
      setSessionStatus("anonymous");
      setRoute("space");
      setTopics([]);
      setSelectedTopic(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "退出登录失败");
    }
  };

  if (sessionStatus === "checking") return <AuthLoading />;
  if (sessionStatus === "anonymous" || !identity) {
    return <AuthPage serviceMessage={sessionMessage} resetToken={resetToken} onLogin={authApi.login} onRegister={authApi.register} onRequestPasswordReset={authApi.requestPasswordReset} onConfirmPasswordReset={authApi.confirmPasswordReset} onPasswordResetCompleted={() => { skipNextSessionCheck.current = true; window.history.replaceState({}, "", window.location.pathname); setIdentity(null); setSessionStatus("anonymous"); setResetToken(null); }} onAuthenticated={(current) => { setIdentity(current); setSessionMessage(null); setSessionStatus("authenticated"); }} onRetrySession={checkSession} />;
  }

  return (
    <div className="app-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <main className="phone-frame">
        <header className="topbar">
          <div className="brand-mark"><span className="bunny-mark"><BunnyMark size={36} /></span><span><strong>Life</strong><small>{identity.household.name}</small></span></div>
          {route !== "finance" && <button type="button" className="bunny-button" aria-label="打开小兔子 AI" onClick={() => selectedTopic ? void generateAiSummary() : setError("先选择一个家庭主题，小兔子才能帮你整理")}><BunnyMark size={24} /><span>小兔子</span></button>}
        </header>
        <div className="content-scroll">
          {error && route !== "finance" && <div className="error-banner" role="alert" aria-live="polite">{error}<button type="button" onClick={() => setError(null)}>关闭</button></div>}
          {route === "space" && <SpacePage topics={topics} selectedTopic={selectedTopic} loading={loading} onOpenTopic={openTopic} onPublish={() => setComposerOpen(true)} onAiSummary={() => void generateAiSummary()} onAddComment={addComment} commentSending={commentSending} onBack={() => setSelectedTopic(null)} />}
          {route === "food" && <FoodPage />}
          {route === "finance" && <FinancePage />}
          {route === "more" && <MorePage identity={identity} onLogout={logout} />}
        </div>
        <nav className="bottom-nav" aria-label="主导航">
          {navItems.map((item) => <button type="button" key={item.id} className={route === item.id ? "active" : ""} aria-current={route === item.id ? "page" : undefined} onClick={() => { setRoute(item.id); setSelectedTopic(null); setError(null); }}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}
        </nav>
      </main>
      {composerOpen && <TopicComposer onClose={() => setComposerOpen(false)} onSubmit={createTopic} />}
      {aiOpen && aiSummary && <AiSheet summary={aiSummary} onClose={() => setAiOpen(false)} onDecision={decideAiAction} />}
    </div>
  );
}

function SpacePage(props: { topics: TopicCard[]; selectedTopic: TopicDetail | null; loading: boolean; onOpenTopic: (topic: TopicCard) => void; onPublish: () => void; onAiSummary: () => void; onAddComment: (body: string) => Promise<boolean>; commentSending: boolean; onBack: () => void }) {
  if (props.selectedTopic) return <TopicDetailPage topic={props.selectedTopic} onBack={props.onBack} onAiSummary={props.onAiSummary} onAddComment={props.onAddComment} commentSending={props.commentSending} />;
  return <>
    <section className="hero-card">
      <div><span className="eyebrow">今天的家庭节奏</span><h1>把想法放在一起，<br /><em>一起把生活过好。</em></h1><p>发布一个想法、需求或灵感，家人可以在这里继续讨论。</p></div>
      <div className="hero-orb"><BunnyMark size={58} /><span>陪你整理</span></div>
    </section>
    <section className="section-heading"><div><span className="eyebrow">家庭空间</span><h2>最近动态</h2></div><button className="primary-button" onClick={props.onPublish}>＋ 发布主题</button></section>
    <section className="topic-list">
      {props.loading ? <div className="empty-state" role="status" aria-live="polite">正在读取当前家庭的主题…</div> : props.topics.length === 0 ? <div className="empty-state"><span aria-hidden="true">🌷</span><strong>还没有家庭主题</strong><p>从一个周末计划或小小灵感开始吧。</p><button type="button" className="secondary-button" onClick={props.onPublish}>发布第一个主题</button></div> : props.topics.map((topic) => <button type="button" className="topic-card" key={topic.id} onClick={() => props.onOpenTopic(topic)}><div className={`topic-icon ${topic.topic_type}`} aria-hidden="true">{topic.topic_type === "request" ? "⌁" : topic.topic_type === "inspiration" ? "✧" : "♡"}</div><div className="topic-copy"><div className="topic-meta"><span>{topic.topic_type === "request" ? "家庭需求" : topic.topic_type === "inspiration" ? "灵感" : "家庭想法"}</span><time>{formatTime(topic.created_at)}</time></div><h3>{topic.title}</h3><p>{topic.body_preview}</p><small>{topic.author_name} · {topic.comment_count} 条讨论</small></div><span className="chevron" aria-hidden="true">›</span></button>)}
    </section>
    <section className="ai-callout"><span className="bunny-mini"><BunnyMark size={24} /></span><div><strong>让小兔子帮你整理</strong><p>打开一个主题后，它会标注来源并给出可确认的行动建议。</p></div><span className="sparkle">✦</span></section>
  </>;
}

function TopicDetailPage(props: { topic: TopicDetail; onBack: () => void; onAiSummary: () => void; onAddComment: (body: string) => Promise<boolean>; commentSending: boolean }) {
  const [comment, setComment] = useState("");
  return <>
    <div className="page-back"><button type="button" aria-label="返回家庭空间" onClick={props.onBack}>‹</button><span>家庭主题</span><button type="button" className="icon-button" aria-label="让小兔子整理主题" onClick={props.onAiSummary}><BunnyMark size={22} /></button></div>
    <section className="detail-header"><div className={`topic-icon large ${props.topic.topic_type}`}>♡</div><span className="eyebrow">{props.topic.author_name} 发布</span><h1>{props.topic.title}</h1><p>{props.topic.body}</p><time>{formatTime(props.topic.created_at)}</time></section>
    <div className="ai-action-card"><div><span className="bunny-mini"><BunnyMark size={24} /></span><strong>小兔子可以帮你整理这场讨论</strong></div><button className="secondary-button" onClick={props.onAiSummary}>生成摘要</button><small>会展示来源，并在写入前等待你的确认</small></div>
    <section className="comments-section"><div className="section-heading compact"><div><span className="eyebrow">家庭讨论</span><h2>{props.topic.comments.length} 条回应</h2></div></div>{props.topic.comments.length === 0 ? <div className="empty-state small">还没有回应，留下第一句话吧。</div> : props.topic.comments.map((item) => <article className="comment-row" key={item.id}><div className="avatar">{item.author_name.slice(0, 1).toUpperCase()}</div><div><div className="comment-meta"><strong>{item.author_name}</strong><time>{formatTime(item.created_at)}</time></div><p>{item.body}</p></div></article>)}</section>
    <form className="comment-composer" onSubmit={async (event) => { event.preventDefault(); const value = comment.trim(); if (!value || props.commentSending) return; if (await props.onAddComment(value)) setComment(""); }}><input value={comment} onChange={(event) => setComment(event.target.value)} placeholder="说点什么…" aria-label="评论内容" disabled={props.commentSending} /><button type="submit" disabled={!comment.trim() || props.commentSending} aria-label="发送评论" aria-busy={props.commentSending}>{props.commentSending ? "…" : "↑"}</button></form>
  </>;
}

function TopicComposer(props: { onClose: () => void; onSubmit: (input: { title: string; body: string; topicType: TopicCard["topic_type"] }) => void }) {
  const [title, setTitle] = useState(""); const [body, setBody] = useState(""); const [topicType, setTopicType] = useState<TopicCard["topic_type"]>("idea");
  return <div className="modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && props.onClose()}><form className="sheet" onSubmit={(event) => { event.preventDefault(); if (title.trim() && body.trim()) props.onSubmit({ title, body, topicType }); }}><div className="sheet-handle" /><div className="sheet-title"><div><span className="eyebrow">家庭空间</span><h2>发布一个主题</h2></div><button type="button" aria-label="关闭发布主题" onClick={props.onClose}>×</button></div><label>主题类型<div className="segmented">{(["idea", "request", "inspiration"] as const).map((type) => <button type="button" key={type} className={topicType === type ? "selected" : ""} onClick={() => setTopicType(type)}>{type === "idea" ? "想法" : type === "request" ? "需求" : "灵感"}</button>)}</div></label><label>标题<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：周末去哪里走走" maxLength={120} /></label><label>内容<textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="把想法告诉家人…" rows={5} maxLength={10000} /></label><button className="primary-button wide" disabled={!title.trim() || !body.trim()}>发布到家庭空间</button></form></div>;
}

function AiSheet(props: { summary: TopicAiSummary; onClose: () => void; onDecision: (decision: "confirm" | "reject") => void }) {
  const canDecide = props.summary.action_proposal.status === "proposed";
  return <div className="modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && props.onClose()}><section className="sheet ai-sheet"><div className="sheet-handle" /><div className="sheet-title"><div><span className="eyebrow"><span className="bunny-mini"><BunnyMark size={24} /></span> 小兔子整理</span><h2>这场讨论的摘要</h2></div><button type="button" aria-label="关闭 AI 摘要" onClick={props.onClose}>×</button></div><div className="source-pill">来源于当前主题和 {Math.max(0, props.summary.insight.source_refs.length - 1)} 条回应 · {props.summary.insight.provider}</div><p className="ai-summary">{props.summary.insight.summary}</p><div className="key-points">{props.summary.insight.key_points.map((point) => <div key={point}><span aria-hidden="true">✦</span>{point}</div>)}</div><div className="proposal-card"><div><strong>建议写回主题讨论</strong><p>将整理结果作为一条评论发布，发布前需要你的确认。</p></div><span className={`status ${props.summary.action_proposal.status}`}>{props.summary.action_proposal.status === "proposed" ? "待确认" : props.summary.action_proposal.status === "confirmed" ? "已发布" : "已拒绝"}</span></div>{canDecide && <div className="sheet-actions"><button type="button" className="secondary-button" onClick={() => props.onDecision("reject")}>暂不发布</button><button type="button" className="primary-button" onClick={() => props.onDecision("confirm")}>确认发布</button></div>}</section></div>;
}

function MorePage(props: { identity: AuthIdentity; onLogout: () => Promise<void> }) {
  const roleLabel = props.identity.household.role === "owner" ? "家庭所有者" : props.identity.household.role === "adult" ? "成人成员" : props.identity.household.role === "child" ? "儿童成员" : "访客成员";
  return <section className="more-page"><div className="section-heading"><div><span className="eyebrow">账号与家庭</span><h1>更多</h1></div></div><article className="identity-card"><div className="identity-avatar">{props.identity.user.email.slice(0, 1).toUpperCase()}</div><div><strong>{props.identity.household.name}</strong><p>{props.identity.user.email}</p><span>{roleLabel}</span></div></article><div className="security-summary"><div><span aria-hidden="true">⌂</span><p><strong>唯一家庭归属</strong><small>当前账号不能切换或加入第二个家庭</small></p></div><div><span aria-hidden="true">◉</span><p><strong>家庭数据隔离</strong><small>账本、讨论、AI 连接和记忆独立保存</small></p></div></div><button type="button" className="logout-button" onClick={() => void props.onLogout()}>退出登录</button></section>;
}

function formatTime(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }); }

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
