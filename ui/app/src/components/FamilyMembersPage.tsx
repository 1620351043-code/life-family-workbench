import { useEffect, useState } from "react";
import { ApiRequestError, familyApi, type AuthIdentity, type CreatedFamilyInvitation, type FamilyInvitation, type FamilyMember, type FamilyMemberRole } from "../api";
import { BunnyMark } from "./BunnyMark";

const roleNames: Record<FamilyMemberRole, string> = { owner: "家庭所有者", adult: "成人成员", child: "儿童成员", guest: "访客成员" };
const invitationRoleNames: Record<Exclude<FamilyMemberRole, "owner">, string> = { adult: "成人", child: "儿童", guest: "访客" };
const statusNames: Record<FamilyInvitation["status"], string> = { active: "待加入", used: "已使用", expired: "已过期", revoked: "已撤销" };

export function FamilyMembersPage(props: { identity: AuthIdentity; onBack: () => void }) {
  const owner = props.identity.household.role === "owner";
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [invitations, setInvitations] = useState<FamilyInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [createdInvite, setCreatedInvite] = useState<CreatedFamilyInvitation | null>(null);
  const [pendingRole, setPendingRole] = useState<{ member: FamilyMember; role: Exclude<FamilyMemberRole, "owner"> } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const memberResult = await familyApi.listMembers();
      setMembers(memberResult.members);
      if (owner) setInvitations((await familyApi.listInvitations()).invitations);
    } catch (reason) { setError(messageOf(reason, "家庭成员暂时无法加载")); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, [props.identity.household.id]);

  const updateRole = async () => {
    if (!pendingRole) return;
    setBusyId(pendingRole.member.user_id); setError(null);
    try {
      const updated = await familyApi.updateMemberRole(pendingRole.member.user_id, pendingRole.role);
      setMembers((current) => current.map((item) => item.user_id === updated.user_id ? updated : item));
      setPendingRole(null);
    } catch (reason) { setError(messageOf(reason, "成员角色更新失败")); }
    finally { setBusyId(null); }
  };

  const revoke = async (invitation: FamilyInvitation) => {
    setBusyId(invitation.id); setError(null);
    try {
      await familyApi.revokeInvitation(invitation.id);
      setInvitations((current) => current.map((item) => item.id === invitation.id ? { ...item, status: "revoked" } : item));
    } catch (reason) { setError(messageOf(reason, "邀请码撤销失败")); }
    finally { setBusyId(null); }
  };

  return <section className="family-members-page">
    <div className="page-back family-page-back"><button type="button" aria-label="返回更多" onClick={props.onBack}>‹</button><span>家庭与成员</span><span className="family-member-count" aria-label={`${members.length} 位成员`}>{members.length || "—"}</span></div>
    <article className="family-summary-card"><div><span className="eyebrow">唯一家庭</span><h1>{props.identity.household.name}</h1><p>成员共享同一家庭空间，但财务与 AI 敏感能力仍按成员单独授权。</p></div><span className="family-summary-bunny"><BunnyMark size={58} /></span></article>
    {error && <div className="error-banner" role="alert">{error}<button type="button" onClick={() => setError(null)}>关闭</button></div>}
    <div className="section-heading family-section-heading"><div><span className="eyebrow">当前成员</span><h2>家里的人</h2></div>{owner && <button type="button" className="primary-button" onClick={() => { setCreatedInvite(null); setInviteOpen(true); }}>＋ 邀请成员</button>}</div>
    {loading ? <div className="family-loading" role="status"><i /><i /><i /><span>正在读取家庭成员…</span></div> : <div className="family-member-list">{members.map((member) => <article className="family-member-card" key={member.user_id}><div className={`family-member-avatar role-${member.role}`}>{member.email.slice(0, 1).toUpperCase()}</div><div className="family-member-copy"><strong>{member.email}</strong><span>{roleNames[member.role]} · {member.user_id === props.identity.user.id ? "当前账号" : formatJoined(member.joined_at)}</span></div>{owner && member.role !== "owner" ? <button type="button" className="family-role-button" aria-label={`管理 ${member.email} 的角色`} disabled={busyId === member.user_id} onClick={() => setPendingRole({ member, role: member.role as Exclude<FamilyMemberRole, "owner"> })}>{busyId === member.user_id ? "…" : roleNames[member.role].replace("成员", "") }<b aria-hidden="true">›</b></button> : <span className={`family-role-pill role-${member.role}`}>{member.role === "owner" ? "所有者" : invitationRoleNames[member.role]}</span>}</article>)}</div>}
    {!owner && !loading && <div className="family-permission-note"><span aria-hidden="true">◎</span><p><strong>角色由家庭所有者管理</strong><small>你可以查看家庭成员；邀请、改角色和敏感授权只对所有者开放。</small></p></div>}
    {owner && !loading && <><div className="section-heading family-section-heading"><div><span className="eyebrow">访问控制</span><h2>最近邀请</h2></div></div><div className="family-invitation-list">{invitations.length === 0 ? <div className="empty-state small"><span aria-hidden="true">⌁</span><strong>还没有邀请码</strong><p>邀请码只允许一位新成员加入一次。</p></div> : invitations.map((invitation) => <article className="family-invitation-card" key={invitation.id}><div><span className={`invite-status ${invitation.status}`}>{statusNames[invitation.status]}</span><strong>{invitationRoleNames[invitation.role]}成员邀请</strong><small>{invitation.status === "active" ? `${formatExpiry(invitation.expires_at)}失效` : `创建于 ${formatDate(invitation.created_at)}`}</small></div>{invitation.status === "active" && <button type="button" className="family-revoke-button" disabled={busyId === invitation.id} onClick={() => void revoke(invitation)}>{busyId === invitation.id ? "撤销中" : "撤销"}</button>}</article>)}</div></>}
    {inviteOpen && <InviteSheet created={createdInvite} onCreated={(created) => { setCreatedInvite(created); setInvitations((current) => [{ ...created }, ...current]); }} onClose={() => setInviteOpen(false)} />}
    {pendingRole && <RoleConfirmation member={pendingRole.member} selectedRole={pendingRole.role} busy={busyId === pendingRole.member.user_id} onSelect={(role) => setPendingRole({ ...pendingRole, role })} onCancel={() => setPendingRole(null)} onConfirm={() => void updateRole()} />}
  </section>;
}

function InviteSheet(props: { created: CreatedFamilyInvitation | null; onCreated: (created: CreatedFamilyInvitation) => void; onClose: () => void }) {
  const [role, setRole] = useState<Exclude<FamilyMemberRole, "owner">>("adult");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => { setBusy(true); setError(null); try { props.onCreated(await familyApi.createInvitation(role, days)); } catch (reason) { setError(messageOf(reason, "邀请码创建失败")); } finally { setBusy(false); } };
  const copy = async () => {
    if (!props.created) return;
    const url = `${window.location.origin}${window.location.pathname}?invite_token=${encodeURIComponent(props.created.invite_code)}`;
    try { await navigator.clipboard.writeText(url); setCopied(true); window.setTimeout(() => setCopied(false), 1800); } catch { setError("复制失败，请长按邀请码手动复制"); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && props.onClose()}><section className="sheet family-invite-sheet"><div className="sheet-handle" /><div className="sheet-title"><div><span className="eyebrow">一次性访问</span><h2>{props.created ? "邀请已经准备好" : "邀请一位家人"}</h2></div><button type="button" aria-label="关闭成员邀请" onClick={props.onClose}>×</button></div>{props.created ? <div className="created-invite"><span className="created-invite-icon">✓</span><p>请把链接私下发给家人。它只能使用一次，服务端不会保存原始邀请码。</p><code>{props.created.invite_code}</code><button type="button" className="primary-button wide" onClick={() => void copy()}>{copied ? "已复制邀请链接" : "复制邀请链接"}</button><button type="button" className="secondary-button wide" onClick={props.onClose}>完成</button></div> : <><label>成员角色<div className="family-role-segments">{(["adult", "child", "guest"] as const).map((item) => <button type="button" key={item} className={role === item ? "selected" : ""} onClick={() => setRole(item)}>{invitationRoleNames[item]}<small>{item === "adult" ? "默认可用基础功能" : item === "child" ? "敏感权限默认关闭" : "以查看为主"}</small></button>)}</div></label><label>有效期<div className="family-expiry-segments">{[1, 7, 30].map((item) => <button type="button" key={item} className={days === item ? "selected" : ""} onClick={() => setDays(item)}>{item === 1 ? "24 小时" : `${item} 天`}</button>)}</div></label><div className="family-invite-notice"><span aria-hidden="true">⌁</span><p>新成员会直接加入当前家庭，已注册账号不能通过邀请码加入第二个家庭。</p></div>{error && <div className="auth-message" role="alert"><span>!</span><p>{error}</p></div>}<button type="button" className="primary-button wide" disabled={busy} onClick={() => void create()}>{busy ? "正在生成…" : "生成一次性邀请码"}</button></>}</section></div>;
}

function RoleConfirmation(props: { member: FamilyMember; selectedRole: Exclude<FamilyMemberRole, "owner">; busy: boolean; onSelect: (role: Exclude<FamilyMemberRole, "owner">) => void; onCancel: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && props.onCancel()}><section className="sheet family-role-sheet"><div className="sheet-handle" /><div className="sheet-title"><div><span className="eyebrow">成员权限</span><h2>调整家庭角色</h2></div><button type="button" aria-label="关闭角色调整" onClick={props.onCancel}>×</button></div><div className="role-member-summary"><div className="family-member-avatar">{props.member.email.slice(0, 1).toUpperCase()}</div><p><strong>{props.member.email}</strong><small>当前：{roleNames[props.member.role]}</small></p></div><label>新的角色<div className="family-role-segments">{(["adult", "child", "guest"] as const).map((role) => <button type="button" key={role} className={props.selectedRole === role ? "selected" : ""} onClick={() => props.onSelect(role)}>{invitationRoleNames[role]}</button>)}</div></label><div className="family-role-warning"><strong>变更后会重置此成员的财务授权</strong><p>这是为了避免旧角色的敏感权限被意外保留。需要时可在财务权限页重新授权。</p></div><div className="sheet-actions"><button type="button" className="secondary-button" disabled={props.busy} onClick={props.onCancel}>取消</button><button type="button" className="primary-button" disabled={props.busy || props.selectedRole === props.member.role} onClick={props.onConfirm}>{props.busy ? "保存中…" : "确认修改"}</button></div></section></div>;
}

function messageOf(reason: unknown, fallback: string) { return reason instanceof ApiRequestError || reason instanceof Error ? reason.message : fallback; }
function formatDate(value: string) { return new Date(value).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }); }
function formatJoined(value: string) { return `${formatDate(value)}加入`; }
function formatExpiry(value: string) { return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
