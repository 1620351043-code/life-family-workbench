import { useState } from "react";
import { ApiRequestError, type AuthIdentity } from "../api";
import { BunnyMark } from "./BunnyMark";

type AuthMode = "login" | "register" | "recovery";

export function AuthLoading() {
  return (
    <div className="auth-shell" role="status" aria-live="polite">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <main className="phone-frame auth-frame auth-loading">
        <div className="auth-loading-mark"><BunnyMark size={68} /></div>
        <strong>正在确认你的家庭空间</strong>
        <span>Life 只会打开当前账号所属的唯一家庭</span>
        <div className="auth-loading-bar" aria-hidden="true"><i /></div>
      </main>
    </div>
  );
}

export function AuthPage(props: {
  serviceMessage?: string | null;
  onLogin: (email: string, password: string) => Promise<AuthIdentity>;
  onRegister: (email: string, password: string, householdName: string) => Promise<AuthIdentity>;
  onAuthenticated: (identity: AuthIdentity) => void;
  onRetrySession: () => Promise<void>;
}) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [householdName, setHouseholdName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectMode = (next: AuthMode) => {
    setMode(next);
    setError(null);
  };

  const submit = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) return setError("请输入邮箱地址");
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) return setError("请输入有效的邮箱地址");
    if (!password) return setError("请输入密码");
    if (mode === "register" && password.length < 8) return setError("密码至少需要 8 位");
    if (mode === "register" && !householdName.trim()) return setError("请给家庭起一个名称");
    if (mode === "register" && !accepted) return setError("请先确认一个账号只能属于一个家庭");

    setBusy(true);
    setError(null);
    try {
      const identity = mode === "register"
        ? await props.onRegister(normalizedEmail, password, householdName.trim())
        : await props.onLogin(normalizedEmail, password);
      props.onAuthenticated(identity);
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.status === 429) {
        const wait = reason.retryAfterSeconds ? `，约 ${formatWait(reason.retryAfterSeconds)}后可重试` : "";
        setError(`${reason.message}${wait}`);
      } else {
        setError(reason instanceof Error ? reason.message : mode === "register" ? "注册暂时无法完成" : "登录暂时无法完成");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <main className="phone-frame auth-frame">
        <section className="auth-hero" aria-labelledby="auth-title">
          <div className="auth-brand"><span><BunnyMark size={46} /></span><strong>Life</strong></div>
          <div className="auth-bunny-orb"><BunnyMark size={96} /><i aria-hidden="true">✦</i></div>
          <span className="eyebrow">家庭生活工作台</span>
          <h1 id="auth-title">{mode === "register" ? "从一个独立家庭开始" : mode === "recovery" ? "找回你的登录" : "欢迎回到家里"}</h1>
          <p>{mode === "register" ? "注册会同时创建你的唯一家庭，并由你担任家庭所有者。" : mode === "recovery" ? "我们会把密码重置作为独立安全流程接入。" : "你的账本、讨论和 AI 记忆只属于当前家庭。"}</p>
        </section>

        <section className="auth-card">
          {mode === "recovery" ? (
            <div className="auth-recovery">
              <span className="auth-state-icon" aria-hidden="true">⌁</span>
              <h2>密码重置尚未开放</h2>
              <p>当前不会假装发送重置邮件。B-006 将补齐安全令牌、有效期、单次使用和会话撤销后再开放此功能。</p>
              <button type="button" className="primary-button wide" onClick={() => selectMode("login")}>返回登录</button>
            </div>
          ) : (
            <>
              <div className="auth-segmented" role="tablist" aria-label="登录或注册">
                <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "selected" : ""} onClick={() => selectMode("login")}>登录</button>
                <button type="button" role="tab" aria-selected={mode === "register"} className={mode === "register" ? "selected" : ""} onClick={() => selectMode("register")}>创建家庭</button>
              </div>

              <form className="auth-form" onSubmit={(event) => { event.preventDefault(); void submit(); }} noValidate>
                {mode === "register" && <label><span>家庭名称</span><input autoFocus name="household-name" value={householdName} onChange={(event) => setHouseholdName(event.target.value)} autoComplete="organization" enterKeyHint="next" maxLength={80} placeholder="例如：小兔之家" disabled={busy} /></label>}
                <label><span>邮箱</span><input autoFocus={mode === "login"} name="email" type="email" inputMode="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete={mode === "register" ? "email" : "username"} autoCapitalize="none" spellCheck={false} enterKeyHint="next" maxLength={320} placeholder="name@example.com" disabled={busy} /></label>
                <label><span>密码</span><div className="auth-password"><input name="password" type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "register" ? "new-password" : "current-password"} enterKeyHint="done" maxLength={mode === "register" ? 128 : 1024} placeholder={mode === "register" ? "至少 8 位" : "输入密码"} disabled={busy} /><button type="button" aria-label={showPassword ? "隐藏密码" : "显示密码"} aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>{showPassword ? "隐藏" : "显示"}</button></div></label>

                {mode === "login" ? <button type="button" className="auth-link" onClick={() => selectMode("recovery")}>忘记密码？</button> : <label className="auth-consent"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} disabled={busy} /><span><strong>确认创建唯一家庭</strong><small>一个账号不能加入多个家庭；家庭数据和 AI 连接相互隔离。</small></span></label>}

                {(props.serviceMessage || error) && <div className="auth-message" role="alert" aria-live="assertive"><span aria-hidden="true">!</span><p>{error ?? props.serviceMessage}</p>{props.serviceMessage && !error && <button type="button" onClick={() => void props.onRetrySession()}>重试</button>}</div>}

                <button type="submit" className="primary-button auth-submit" disabled={busy} aria-busy={busy}>{busy ? <><span className="auth-spinner" aria-hidden="true" />{mode === "register" ? "正在创建家庭" : "正在登录"}</> : mode === "register" ? "注册并进入 Life" : "进入我的家庭"}</button>
              </form>
            </>
          )}
        </section>

        <div className="auth-trust" aria-label="数据安全说明">
          <span>独立家庭数据</span><i aria-hidden="true" />
          <span>HttpOnly 会话</span><i aria-hidden="true" />
          <span>AI 连接隔离</span>
        </div>
      </main>
    </div>
  );
}

function formatWait(seconds: number) {
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.ceil(seconds / 60)} 分钟`;
}
