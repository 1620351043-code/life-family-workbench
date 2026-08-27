import { useEffect, useRef, useState } from "react";
import { ApiRequestError, type AuthIdentity, type HouseholdInvitationPreview } from "../api";
import { BunnyMark } from "./BunnyMark";

type AuthMode = "login" | "register" | "join" | "recovery" | "recoverySent" | "reset" | "resetComplete";

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
  resetToken?: string | null;
  inviteToken?: string | null;
  onLogin: (email: string, password: string) => Promise<AuthIdentity>;
  onRegister: (email: string, password: string, householdName: string) => Promise<AuthIdentity>;
  onRequestPasswordReset: (email: string) => Promise<unknown>;
  onConfirmPasswordReset: (token: string, password: string) => Promise<unknown>;
  onPreviewInvitation: (token: string) => Promise<HouseholdInvitationPreview>;
  onAcceptInvitation: (token: string, email: string, password: string) => Promise<AuthIdentity>;
  onPasswordResetCompleted: () => void;
  onAuthenticated: (identity: AuthIdentity) => void;
  onRetrySession: () => Promise<void>;
}) {
  const [mode, setMode] = useState<AuthMode>(() => props.resetToken ? "reset" : props.inviteToken ? "join" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmedPassword, setConfirmedPassword] = useState("");
  const [householdName, setHouseholdName] = useState("");
  const [invitationCode, setInvitationCode] = useState(props.inviteToken ?? "");
  const [invitation, setInvitation] = useState<HouseholdInvitationPreview | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const automaticallyPreviewed = useRef<string | null>(null);

  const selectMode = (next: AuthMode) => {
    setMode(next);
    setError(null);
    setPassword("");
    setConfirmedPassword("");
  };

  const returnToLogin = () => {
    props.onPasswordResetCompleted();
    selectMode("login");
  };

  const showError = (reason: unknown, fallback: string) => {
    if (reason instanceof ApiRequestError && reason.status === 429) {
      const wait = reason.retryAfterSeconds ? `，约 ${formatWait(reason.retryAfterSeconds)}后可重试` : "";
      setError(`${reason.message}${wait}`);
    } else {
      setError(reason instanceof Error ? reason.message : fallback);
    }
  };

  const previewInvitation = async (code = invitationCode) => {
    const normalized = normalizeInvitationCode(code);
    if (!normalized) return setError("请粘贴邀请码或邀请链接中的代码");
    if (normalized !== invitationCode) setInvitationCode(normalized);
    setBusy(true); setError(null); setInvitation(null);
    try { setInvitation(await props.onPreviewInvitation(normalized)); }
    catch (reason) { showError(reason, "邀请码暂时无法检查"); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (!props.inviteToken || automaticallyPreviewed.current === props.inviteToken) return;
    automaticallyPreviewed.current = props.inviteToken;
    void previewInvitation(props.inviteToken);
  }, [props.inviteToken]);

  const submitIdentity = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) return setError("请输入邮箱地址");
    if (!isEmail(normalizedEmail)) return setError("请输入有效的邮箱地址");
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
      showError(reason, mode === "register" ? "注册暂时无法完成" : "登录暂时无法完成");
    } finally {
      setBusy(false);
    }
  };

  const requestReset = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) return setError("请输入邮箱地址");
    if (!isEmail(normalizedEmail)) return setError("请输入有效的邮箱地址");
    setBusy(true);
    setError(null);
    try {
      await props.onRequestPasswordReset(normalizedEmail);
      setMode("recoverySent");
    } catch (reason) {
      showError(reason, "重置请求暂时无法提交");
    } finally {
      setBusy(false);
    }
  };

  const confirmReset = async () => {
    if (!props.resetToken) return setError("重置链接无效，请重新申请");
    if (password.length < 8) return setError("新密码至少需要 8 位");
    if (password.length > 128) return setError("新密码不能超过 128 位");
    if (password !== confirmedPassword) return setError("两次输入的密码不一致");
    setBusy(true);
    setError(null);
    try {
      await props.onConfirmPasswordReset(props.resetToken, password);
      setPassword("");
      setConfirmedPassword("");
      setMode("resetComplete");
    } catch (reason) {
      showError(reason, "密码更新暂时无法完成");
    } finally {
      setBusy(false);
    }
  };

  const acceptInvitation = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!invitation || invitation.status !== "active") return setError("请先检查有效的邀请码");
    if (!isEmail(normalizedEmail)) return setError("请输入有效的邮箱地址");
    if (password.length < 8) return setError("密码至少需要 8 位");
    if (!accepted) return setError("请先确认一个账号只能属于一个家庭");
    setBusy(true); setError(null);
    try { props.onAuthenticated(await props.onAcceptInvitation(invitationCode.trim(), normalizedEmail, password)); }
    catch (reason) { showError(reason, "暂时无法加入这个家庭"); }
    finally { setBusy(false); }
  };

  const copy = heroCopy(mode);
  return (
    <div className="auth-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <main className="phone-frame auth-frame">
        <section className="auth-hero" aria-labelledby="auth-title">
          <div className="auth-brand"><span><BunnyMark size={46} /></span><strong>Life</strong></div>
          <div className="auth-bunny-orb"><BunnyMark size={96} /><i aria-hidden="true">✦</i></div>
          <span className="eyebrow">家庭生活工作台</span>
          <h1 id="auth-title">{copy.title}</h1>
          <p>{copy.body}</p>
        </section>

        <section className="auth-card">
          {(mode === "login" || mode === "register") && (
            <>
              <div className="auth-segmented" role="tablist" aria-label="登录或注册">
                <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "selected" : ""} onClick={() => selectMode("login")}>登录</button>
                <button type="button" role="tab" aria-selected={mode === "register"} className={mode === "register" ? "selected" : ""} onClick={() => selectMode("register")}>创建家庭</button>
              </div>
              <form className="auth-form" onSubmit={(event) => { event.preventDefault(); void submitIdentity(); }} noValidate>
                {mode === "register" && <label><span>家庭名称</span><input autoFocus name="household-name" value={householdName} onChange={(event) => setHouseholdName(event.target.value)} autoComplete="organization" enterKeyHint="next" maxLength={80} placeholder="例如：小兔之家" disabled={busy} /></label>}
                <EmailField value={email} onChange={setEmail} autoFocus={mode === "login"} disabled={busy} />
                <PasswordField name="password" value={password} onChange={setPassword} shown={showPassword} onToggle={() => setShowPassword((value) => !value)} autoComplete={mode === "register" ? "new-password" : "current-password"} placeholder={mode === "register" ? "至少 8 位" : "输入密码"} maxLength={mode === "register" ? 128 : 1024} disabled={busy} />
                {mode === "login" ? <button type="button" className="auth-link" onClick={() => selectMode("recovery")}>忘记密码？</button> : <label className="auth-consent"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} disabled={busy} /><span><strong>确认创建唯一家庭</strong><small>一个账号不能加入多个家庭；家庭数据和 AI 连接相互隔离。</small></span></label>}
                <AuthMessage error={error} serviceMessage={props.serviceMessage} onRetry={props.onRetrySession} />
                <button type="submit" className="primary-button auth-submit" disabled={busy} aria-busy={busy}>{busy ? <><Spinner />{mode === "register" ? "正在创建家庭" : "正在登录"}</> : mode === "register" ? "注册并进入 Life" : "进入我的家庭"}</button>
                {mode === "login" && <button type="button" className="secondary-button wide auth-join-entry" onClick={() => { setInvitation(null); setAccepted(false); selectMode("join"); }}>使用邀请码加入家庭</button>}
              </form>
            </>
          )}

          {mode === "join" && (
            <form className="auth-form auth-join-form" onSubmit={(event) => { event.preventDefault(); invitation ? void acceptInvitation() : void previewInvitation(); }} noValidate>
              <div className="auth-state-copy"><h2>加入一个家庭</h2><p>邀请码只能使用一次。加入后，这个账号不能再创建或加入其他家庭。</p></div>
              <label><span>邀请码</span><div className="auth-invite-code"><input autoFocus={!props.inviteToken} name="invite-code" value={invitationCode} onChange={(event) => { setInvitationCode(event.target.value); setInvitation(null); setError(null); }} autoCapitalize="none" spellCheck={false} maxLength={512} placeholder="粘贴邀请码" disabled={busy} /><button type="button" disabled={busy || !invitationCode.trim()} onClick={() => void previewInvitation()}>检查</button></div></label>
              {invitation && <article className={`auth-invitation-preview ${invitation.status}`}><div className="auth-invitation-mark"><BunnyMark size={42} /></div><div><span>{invitation.status === "active" ? "有效邀请" : invitation.status === "expired" ? "邀请已过期" : invitation.status === "revoked" ? "邀请已撤销" : "邀请已使用"}</span><strong>{invitation.householdName}</strong><p>{invitation.inviterEmail} 邀请你作为{invitationRoleName(invitation.role)}加入</p></div></article>}
              {invitation?.status === "active" && <><EmailField value={email} onChange={setEmail} disabled={busy} /><PasswordField name="password" value={password} onChange={setPassword} shown={showPassword} onToggle={() => setShowPassword((value) => !value)} autoComplete="new-password" placeholder="至少 8 位" maxLength={128} disabled={busy} /><label className="auth-consent"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} disabled={busy} /><span><strong>确认加入唯一家庭</strong><small>如果该邮箱已经注册，系统会拒绝加入第二个家庭。</small></span></label></>}
              <AuthMessage error={error} />
              <button type="submit" className="primary-button auth-submit" disabled={busy || !invitationCode.trim() || Boolean(invitation && invitation.status !== "active")} aria-busy={busy}>{busy ? <><Spinner />正在处理</> : invitation?.status === "active" ? "注册并加入家庭" : "检查邀请码"}</button>
              <button type="button" className="secondary-button wide" disabled={busy} onClick={() => selectMode("login")}>返回登录</button>
            </form>
          )}

          {mode === "recovery" && (
            <form className="auth-form auth-recovery-form" onSubmit={(event) => { event.preventDefault(); void requestReset(); }} noValidate>
              <span className="auth-state-icon" aria-hidden="true">⌁</span>
              <div className="auth-state-copy"><h2>通过邮箱找回</h2><p>链接 30 分钟内有效。为保护隐私，无论邮箱是否注册，页面都会显示相同结果。</p></div>
              <EmailField value={email} onChange={setEmail} autoFocus disabled={busy} />
              <AuthMessage error={error} />
              <button type="submit" className="primary-button auth-submit" disabled={busy} aria-busy={busy}>{busy ? <><Spinner />正在提交</> : "发送重置链接"}</button>
              <button type="button" className="secondary-button wide" disabled={busy} onClick={() => selectMode("login")}>返回登录</button>
            </form>
          )}

          {mode === "recoverySent" && <AuthState icon="✓" title="请检查你的邮箱" body="如果该邮箱已注册，重置链接会很快送达。链接只能使用一次，并将在 30 分钟后失效。" action="返回登录" onAction={() => selectMode("login")} />}

          {mode === "reset" && (
            <form className="auth-form auth-recovery-form" onSubmit={(event) => { event.preventDefault(); void confirmReset(); }} noValidate>
              <span className="auth-state-icon" aria-hidden="true">✦</span>
              <div className="auth-state-copy"><h2>设置一个新密码</h2><p>成功后，当前账号在所有设备上的会话都会退出，需要重新登录。</p></div>
              <PasswordField name="new-password" value={password} onChange={setPassword} shown={showPassword} onToggle={() => setShowPassword((value) => !value)} autoComplete="new-password" placeholder="至少 8 位" maxLength={128} autoFocus disabled={busy} />
              <label><span>再次输入新密码</span><input name="confirm-password" type={showPassword ? "text" : "password"} value={confirmedPassword} onChange={(event) => setConfirmedPassword(event.target.value)} autoComplete="new-password" enterKeyHint="done" maxLength={128} placeholder="再次输入" disabled={busy} /></label>
              <AuthMessage error={error} />
              <button type="submit" className="primary-button auth-submit" disabled={busy} aria-busy={busy}>{busy ? <><Spinner />正在更新密码</> : "更新密码"}</button>
              <button type="button" className="secondary-button wide" disabled={busy} onClick={returnToLogin}>返回登录</button>
            </form>
          )}

          {mode === "resetComplete" && <AuthState icon="✓" title="密码已经更新" body="旧密码和已有登录会话均已失效。请使用新密码重新进入你的家庭。" action="使用新密码登录" onAction={returnToLogin} />}
        </section>

        <div className="auth-trust" aria-label="数据安全说明"><span>独立家庭数据</span><i aria-hidden="true" /><span>单次重置令牌</span><i aria-hidden="true" /><span>AI 连接隔离</span></div>
      </main>
    </div>
  );
}

function EmailField(props: { value: string; onChange: (value: string) => void; autoFocus?: boolean; disabled?: boolean }) {
  return <label><span>邮箱</span><input autoFocus={props.autoFocus} name="email" type="email" inputMode="email" value={props.value} onChange={(event) => props.onChange(event.target.value)} autoComplete="email" autoCapitalize="none" spellCheck={false} enterKeyHint="next" maxLength={320} placeholder="name@example.com" disabled={props.disabled} /></label>;
}

function PasswordField(props: { name: string; value: string; onChange: (value: string) => void; shown: boolean; onToggle: () => void; autoComplete: string; placeholder: string; maxLength: number; autoFocus?: boolean; disabled?: boolean }) {
  return <label><span>{props.name === "password" ? "密码" : "新密码"}</span><div className="auth-password"><input autoFocus={props.autoFocus} name={props.name} type={props.shown ? "text" : "password"} value={props.value} onChange={(event) => props.onChange(event.target.value)} autoComplete={props.autoComplete} enterKeyHint="done" maxLength={props.maxLength} placeholder={props.placeholder} disabled={props.disabled} /><button type="button" aria-label={props.shown ? "隐藏密码" : "显示密码"} aria-pressed={props.shown} onClick={props.onToggle}>{props.shown ? "隐藏" : "显示"}</button></div></label>;
}

function AuthMessage(props: { error?: string | null; serviceMessage?: string | null; onRetry?: () => Promise<void> }) {
  const message = props.error ?? props.serviceMessage;
  if (!message) return null;
  return <div className="auth-message" role="alert" aria-live="assertive"><span aria-hidden="true">!</span><p>{message}</p>{props.serviceMessage && !props.error && props.onRetry && <button type="button" onClick={() => void props.onRetry?.()}>重试</button>}</div>;
}

function AuthState(props: { icon: string; title: string; body: string; action: string; onAction: () => void }) {
  return <div className="auth-recovery"><span className="auth-state-icon" aria-hidden="true">{props.icon}</span><h2>{props.title}</h2><p>{props.body}</p><button type="button" className="primary-button wide" onClick={props.onAction}>{props.action}</button></div>;
}

function Spinner() { return <span className="auth-spinner" aria-hidden="true" />; }
function isEmail(value: string) { return /^\S+@\S+\.\S+$/.test(value); }

function heroCopy(mode: AuthMode) {
  if (mode === "register") return { title: "从一个独立家庭开始", body: "注册会同时创建你的唯一家庭，并由你担任家庭所有者。" };
  if (mode === "recovery" || mode === "recoverySent") return { title: "找回你的登录", body: "重置过程不会泄露账号是否存在，链接只允许使用一次。" };
  if (mode === "reset" || mode === "resetComplete") return { title: "重新保护你的账号", body: "更新密码后，所有旧会话会立即失效。" };
  if (mode === "join") return { title: "和家人在同一个空间", body: "先确认家庭和角色，再用一个全新账号安全加入。" };
  return { title: "欢迎回到家里", body: "你的账本、讨论和 AI 记忆只属于当前家庭。" };
}

function invitationRoleName(role: HouseholdInvitationPreview["role"]) { return role === "adult" ? "成人成员" : role === "child" ? "儿童成员" : "访客成员"; }
function normalizeInvitationCode(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try { return new URL(trimmed).searchParams.get("invite_token")?.trim() || trimmed; }
  catch { return trimmed; }
}

function formatWait(seconds: number) {
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.ceil(seconds / 60)} 分钟`;
}
