import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DomainError } from "./domain-error.js";
import { inTenantTransaction, type DbClient, type DbPool, type FinanceScope } from "./database.js";
import { DeterministicTopicAiProvider, type TopicAiProvider } from "./ai-gateway.js";
import { assertSensitivePermission, type SensitiveCapability } from "./sensitive-permissions.js";

export type FamilyTopicType = "idea" | "request" | "inspiration" | "memory" | "other";
export type FamilyTopicCard = {
  id: string;
  topic_type: FamilyTopicType;
  title: string;
  body_preview: string;
  author_id: string;
  author_name: string;
  comment_count: number;
  created_at: string;
};
export type FamilyTopicComment = { id: string; author_id: string; author_name: string; body: string; created_at: string };
export type FamilyTopicDetail = FamilyTopicCard & { body: string; comments: FamilyTopicComment[] };
export type AiActionProposal = {
  id: string;
  action_type: "publish_summary_comment" | "update_memory";
  status: "proposed" | "confirmed" | "rejected" | "expired";
  version: number;
  payload: Record<string, unknown>;
};
export type TopicAiSummaryResponse = {
  insight: {
    id: string;
    insight_type: "summary";
    summary: string;
    key_points: string[];
    source_refs: string[];
    provider: string;
    model: string | null;
    created_at: string;
  };
  action_proposal: AiActionProposal;
};
export type ActionDecisionResponse = { proposal: AiActionProposal; execution: { comment_id: string } | null };
export type FamilyMemberRole = "owner" | "adult" | "child" | "guest";
export type FamilyMember = { user_id: string; email: string; role: FamilyMemberRole; status: "active"; joined_at: string };
export type FamilyInvitation = {
  id: string;
  role: Exclude<FamilyMemberRole, "owner">;
  status: "active" | "expired" | "revoked" | "used";
  expires_at: string;
  created_at: string;
  accepted_at: string | null;
};
export type CreatedFamilyInvitation = FamilyInvitation & { invite_code: string };
export type SensitivePermissionItem = {
  capability: SensitiveCapability;
  enabled: boolean;
  explicit: boolean;
  version: number;
  granted_at: string | null;
  revoked_at: string | null;
  updated_at: string | null;
};
export type MemberSensitivePermissionSnapshot = {
  user_id: string;
  email: string;
  role: FamilyMemberRole;
  permissions: SensitivePermissionItem[];
};

export type CreateTopicInput = { topicType: FamilyTopicType; title: string; body: string };

export interface FamilyRepository {
  getSpaceHome(): Promise<{ topics: FamilyTopicCard[] }>;
  getTopic(topicId: string): Promise<FamilyTopicDetail | null>;
  createTopic(input: CreateTopicInput): Promise<FamilyTopicDetail>;
  createComment(topicId: string, body: string): Promise<FamilyTopicComment>;
  summarizeTopic(topicId: string): Promise<TopicAiSummaryResponse>;
  decideAction(proposalId: string, decision: "confirm" | "reject", expectedVersion: number): Promise<ActionDecisionResponse>;
  listMembers(): Promise<FamilyMember[]>;
  listInvitations(): Promise<FamilyInvitation[]>;
  createInvitation(role: Exclude<FamilyMemberRole, "owner">, expiresInDays: number): Promise<CreatedFamilyInvitation>;
  revokeInvitation(invitationId: string): Promise<{ invitation_id: string }>;
  updateMemberRole(userId: string, role: Exclude<FamilyMemberRole, "owner">): Promise<FamilyMember>;
  getSensitivePermissions(userId: string): Promise<MemberSensitivePermissionSnapshot>;
  updateSensitivePermission(userId: string, capability: SensitiveCapability, enabled: boolean, expectedVersion: number): Promise<MemberSensitivePermissionSnapshot>;
}

type TopicRow = {
  id: string;
  topic_type: FamilyTopicType;
  title: string;
  body: string;
  author_id: string;
  author_name: string;
  comment_count: number;
  created_at: string;
};
type CommentRow = { id: string; author_id: string; author_name: string; body: string; created_at: string };

function required<Row extends Record<string, unknown>>(rows: Row[], code: string, message: string): Row {
  if (!rows[0]) throw new DomainError(code, message, code === "NOT_FOUND" ? 404 : 409);
  return rows[0];
}

function asPayload(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
  }
  return (value ?? {}) as Record<string, unknown>;
}

function mapCard(row: TopicRow): FamilyTopicCard {
  return {
    id: row.id,
    topic_type: row.topic_type,
    title: row.title,
    body_preview: row.body.length > 120 ? `${row.body.slice(0, 119)}…` : row.body,
    author_id: row.author_id,
    author_name: row.author_name,
    comment_count: Number(row.comment_count ?? 0),
    created_at: row.created_at,
  };
}

function mapComment(row: CommentRow): FamilyTopicComment {
  return { id: row.id, author_id: row.author_id, author_name: row.author_name, body: row.body, created_at: row.created_at };
}

const topicSelect = `
  SELECT t.id::text AS id, t.topic_type, t.title, t.body, t.author_id::text AS author_id,
         COALESCE(u.email, '家庭成员') AS author_name,
         (SELECT COUNT(*)::int FROM family_topic_comment c WHERE c.household_id = t.household_id AND c.topic_id = t.id AND c.status = 'published') AS comment_count,
         t.created_at::text AS created_at
    FROM family_topic t
    JOIN app_user u ON u.id = t.author_id
   WHERE t.household_id = $1 AND t.id = $2 AND t.status = 'published'
`;

export class SqlFamilyRepository implements FamilyRepository {
  constructor(
    private readonly pool: DbPool,
    private readonly scope: FinanceScope,
    private readonly aiProvider: TopicAiProvider = new DeterministicTopicAiProvider(),
  ) {}

  async getSpaceHome() {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      const result = await client.query<TopicRow>(`
        SELECT t.id::text AS id, t.topic_type, t.title, t.body, t.author_id::text AS author_id,
               COALESCE(u.email, '家庭成员') AS author_name,
               (SELECT COUNT(*)::int FROM family_topic_comment c WHERE c.household_id = t.household_id AND c.topic_id = t.id AND c.status = 'published') AS comment_count,
               t.created_at::text AS created_at
          FROM family_topic t
          JOIN app_user u ON u.id = t.author_id
         WHERE t.household_id = $1 AND t.status = 'published'
         ORDER BY t.created_at DESC
         LIMIT 50`, [this.scope.householdId]);
      return { topics: result.rows.map(mapCard) };
    });
  }

  async getTopic(topicId: string) {
    return inTenantTransaction(this.pool, this.scope, async (client) => this.getTopicWithClient(client, topicId));
  }

  async createTopic(input: CreateTopicInput) {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO family_topic (id, household_id, author_id, topic_type, title, body)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, this.scope.householdId, this.scope.userId, input.topicType, input.title.trim(), input.body.trim()],
      );
      await this.writeAudit(client, "family_topic.create", "family_topic", id);
      const topic = await this.getTopicWithClient(client, id);
      if (!topic) throw new DomainError("TOPIC_CREATE_FAILED", "主题创建后无法读取");
      return topic;
    });
  }

  async createComment(topicId: string, body: string) {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      const topic = await this.getTopicWithClient(client, topicId);
      if (!topic) throw new DomainError("NOT_FOUND", "主题不存在", 404);
      const id = randomUUID();
      const result = await client.query<CommentRow>(`
        INSERT INTO family_topic_comment (id, household_id, topic_id, author_id, body)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id::text AS id, author_id::text AS author_id,
                  (SELECT email FROM app_user WHERE id = author_id) AS author_name,
                  body, created_at::text AS created_at`,
        [id, this.scope.householdId, topicId, this.scope.userId, body.trim()],
      );
      const comment = required(result.rows, "COMMENT_CREATE_FAILED", "评论创建失败");
      await this.writeAudit(client, "family_topic_comment.create", "family_topic_comment", id);
      return mapComment(comment);
    });
  }

  async summarizeTopic(topicId: string) {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertSensitivePermission(client, this.scope, "ai_topic_summary");
      const topic = await this.getTopicWithClient(client, topicId);
      if (!topic) throw new DomainError("NOT_FOUND", "主题不存在", 404);
      const generated = await this.aiProvider.summarizeTopic({
        topic: { id: topic.id, title: topic.title, body: topic.body },
        comments: topic.comments.map((comment) => ({ id: comment.id, author_name: comment.author_name, body: comment.body })),
      });
      const insightId = randomUUID();
      const sourceRefs = [topic.id, ...topic.comments.map((comment) => comment.id)];
      await client.query(
        `INSERT INTO ai_insight (id, household_id, topic_id, insight_type, content, source_refs, provider, model, created_by)
         VALUES ($1, $2, $3, 'summary', $4::jsonb, $5::jsonb, $6, $7, $8)`,
        [insightId, this.scope.householdId, topic.id, JSON.stringify({ summary: generated.summary, key_points: generated.keyPoints, comment_body: generated.commentBody }), JSON.stringify(sourceRefs), this.aiProvider.name, this.aiProvider.model, this.scope.userId],
      );
      const proposalId = randomUUID();
      const payload = { topic_id: topic.id, body: generated.commentBody };
      await client.query(
        `INSERT INTO ai_action_proposal (id, household_id, insight_id, action_type, payload, created_by)
         VALUES ($1, $2, $3, 'publish_summary_comment', $4::jsonb, $5)`,
        [proposalId, this.scope.householdId, insightId, JSON.stringify(payload), this.scope.userId],
      );
      await this.writeAudit(client, "ai_insight.generate", "ai_insight", insightId, { source_refs: sourceRefs, provider: this.aiProvider.name });
      return {
        insight: { id: insightId, insight_type: "summary" as const, summary: generated.summary, key_points: generated.keyPoints, source_refs: sourceRefs, provider: this.aiProvider.name, model: this.aiProvider.model, created_at: new Date().toISOString() },
        action_proposal: { id: proposalId, action_type: "publish_summary_comment" as const, status: "proposed" as const, version: 1, payload },
      };
    });
  }

  async decideAction(proposalId: string, decision: "confirm" | "reject", expectedVersion: number) {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await assertSensitivePermission(client, this.scope, "ai_topic_summary");
      const proposalResult = await client.query<{ id: string; action_type: AiActionProposal["action_type"]; status: AiActionProposal["status"]; version: number; payload: unknown }>(
        `SELECT id::text AS id, action_type, status, version, payload
           FROM ai_action_proposal
          WHERE household_id = $1 AND id = $2
          FOR UPDATE`, [this.scope.householdId, proposalId],
      );
      const row = required(proposalResult.rows, "NOT_FOUND", "AI 行动提案不存在或不属于当前家庭");
      if (row.status !== "proposed") throw new DomainError("PROPOSAL_STATE_CONFLICT", "AI 行动提案已被处理", 409);
      if (Number(row.version) !== expectedVersion) throw new DomainError("PROPOSAL_VERSION_CONFLICT", "AI 行动提案版本已变化", 409);

      if (decision === "reject") {
        const updated = await this.updateProposal(client, proposalId, "rejected", expectedVersion);
        await this.writeAudit(client, "ai_action.reject", "ai_action_proposal", proposalId);
        return { proposal: updated, execution: null };
      }

      const member = await client.query<{ role: string }>(`SELECT role FROM household_member WHERE household_id = $1 AND user_id = $2 AND status = 'active'`, [this.scope.householdId, this.scope.userId]);
      const role = member.rows[0]?.role;
      if (role !== "owner" && role !== "adult") throw new DomainError("FORBIDDEN", "当前成员没有确认 AI 写入的权限", 403);

      const payload = asPayload(row.payload);
      if (row.action_type !== "publish_summary_comment" || typeof payload.topic_id !== "string" || typeof payload.body !== "string") throw new DomainError("INVALID_PROPOSAL", "AI 行动提案内容不合法", 409);
      const commentId = randomUUID();
      await client.query(`INSERT INTO family_topic_comment (id, household_id, topic_id, author_id, body) VALUES ($1, $2, $3, $4, $5)`, [commentId, this.scope.householdId, payload.topic_id, this.scope.userId, payload.body]);
      const updated = await this.updateProposal(client, proposalId, "confirmed", expectedVersion);
      await client.query(`INSERT INTO ai_action_execution (id, household_id, proposal_id, executed_by, result) VALUES ($1, $2, $3, $4, $5::jsonb)`, [randomUUID(), this.scope.householdId, proposalId, this.scope.userId, JSON.stringify({ comment_id: commentId })]);
      await this.writeAudit(client, "ai_action.confirm", "ai_action_proposal", proposalId, { comment_id: commentId });
      return { proposal: updated, execution: { comment_id: commentId } };
    });
  }

  async listMembers(): Promise<FamilyMember[]> {
    return inTenantTransaction(this.pool, this.scope, async (client) => this.listMembersWithClient(client));
  }

  async listInvitations(): Promise<FamilyInvitation[]> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await this.assertOwner(client);
      const result = await client.query<Record<string, unknown>>(
        `SELECT id::text AS id, role,
                CASE WHEN accepted_at IS NOT NULL THEN 'used'
                     WHEN revoked_at IS NOT NULL THEN 'revoked'
                     WHEN expires_at <= now() THEN 'expired' ELSE 'active' END AS status,
                expires_at::text AS expires_at, created_at::text AS created_at,
                accepted_at::text AS accepted_at
           FROM household_invitation
          WHERE household_id = $1
          ORDER BY created_at DESC
          LIMIT 30`,
        [this.scope.householdId],
      );
      return result.rows.map((row) => this.mapInvitation(row));
    });
  }

  async createInvitation(role: Exclude<FamilyMemberRole, "owner">, expiresInDays: number): Promise<CreatedFamilyInvitation> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await this.assertOwner(client);
      const inviteCode = randomBytes(24).toString("base64url");
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
      const created = await client.query<{ created: boolean }>(
        "SELECT life_family_create_invitation($1, $2, $3, $4, $5, $6::timestamptz) AS created",
        [id, this.scope.householdId, this.scope.userId, createHash("sha256").update(inviteCode).digest("hex"), role, expiresAt],
      );
      if (created.rows[0]?.created !== true) throw new DomainError("INVITATION_INVALID", "邀请码参数不符合要求", 400);
      await this.writeAudit(client, "household_invitation.create", "household_invitation", id, { role, expires_at: expiresAt });
      return { id, role, status: "active", expires_at: expiresAt, created_at: new Date().toISOString(), accepted_at: null, invite_code: inviteCode };
    });
  }

  async revokeInvitation(invitationId: string): Promise<{ invitation_id: string }> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await this.assertOwner(client);
      const result = await client.query<{ revoked: boolean }>(
        "SELECT life_family_revoke_invitation($1, $2, $3) AS revoked",
        [this.scope.householdId, this.scope.userId, invitationId],
      );
      if (result.rows[0]?.revoked !== true) throw new DomainError("INVITATION_NOT_ACTIVE", "邀请码不存在或已经失效", 409);
      await this.writeAudit(client, "household_invitation.revoke", "household_invitation", invitationId);
      return { invitation_id: invitationId };
    });
  }

  async updateMemberRole(userId: string, role: Exclude<FamilyMemberRole, "owner">): Promise<FamilyMember> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await this.assertOwner(client);
      const members = await this.listMembersWithClient(client);
      const before = members.find((member) => member.user_id === userId);
      if (!before) throw new DomainError("MEMBER_NOT_FOUND", "家庭成员不存在", 404);
      if (before.role === "owner") throw new DomainError("OWNER_ROLE_LOCKED", "家庭所有者角色不能修改", 409);
      const result = await client.query<{ updated: boolean }>(
        "SELECT life_family_update_member_role($1, $2, $3, $4) AS updated",
        [this.scope.householdId, this.scope.userId, userId, role],
      );
      if (result.rows[0]?.updated !== true) throw new DomainError("MEMBER_ROLE_UPDATE_FAILED", "成员角色更新失败", 409);
      await this.writeAudit(client, "household_member.role_update", "household_member", userId, { before_role: before.role, role, finance_permission_reset: true, sensitive_permission_reset: true });
      const after = (await this.listMembersWithClient(client)).find((member) => member.user_id === userId);
      if (!after) throw new DomainError("MEMBER_NOT_FOUND", "家庭成员不存在", 404);
      return after;
    });
  }

  async getSensitivePermissions(userId: string): Promise<MemberSensitivePermissionSnapshot> {
    return inTenantTransaction(this.pool, this.scope, async (client) => this.getSensitivePermissionsWithClient(client, userId));
  }

  async updateSensitivePermission(userId: string, capability: SensitiveCapability, enabled: boolean, expectedVersion: number): Promise<MemberSensitivePermissionSnapshot> {
    return inTenantTransaction(this.pool, this.scope, async (client) => {
      await this.assertOwner(client);
      const before = await this.getSensitivePermissionsWithClient(client, userId);
      if (before.role === "owner") throw new DomainError("OWNER_PERMISSION_LOCKED", "家庭所有者的敏感权限不能关闭", 409);
      const previous = before.permissions.find((item) => item.capability === capability);
      if (!previous) throw new DomainError("SENSITIVE_PERMISSION_INVALID", "敏感权限类型无效", 400);
      const result = await client.query<{ new_version: number }>(
        "SELECT life_family_update_sensitive_permission($1, $2, $3, $4, $5, $6, $7) AS new_version",
        [randomUUID(), this.scope.householdId, this.scope.userId, userId, capability, enabled, expectedVersion],
      );
      const version = Number(result.rows[0]?.new_version ?? 0);
      if (version === -1) throw new DomainError("SENSITIVE_PERMISSION_VERSION_CONFLICT", "权限已被其他操作更新，请刷新后重试", 409);
      if (version === -2) throw new DomainError("SENSITIVE_PERMISSION_NO_CHANGE", "权限状态没有变化", 409);
      if (version < 1) throw new DomainError("SENSITIVE_PERMISSION_UPDATE_FAILED", "敏感权限更新失败", 409);
      await this.writeAudit(client, "household_member.sensitive_permission_update", "member_sensitive_permission", userId, {
        capability,
        before_enabled: previous.enabled,
        enabled,
        version,
      });
      return this.getSensitivePermissionsWithClient(client, userId);
    });
  }

  private async getTopicWithClient(client: DbClient, topicId: string): Promise<FamilyTopicDetail | null> {
    const topicResult = await client.query<TopicRow>(`${topicSelect}`, [this.scope.householdId, topicId]);
    const row = topicResult.rows[0];
    if (!row) return null;
    const comments = await client.query<CommentRow>(`
      SELECT c.id::text AS id, c.author_id::text AS author_id,
             COALESCE(u.email, '家庭成员') AS author_name, c.body, c.created_at::text AS created_at
        FROM family_topic_comment c
        JOIN app_user u ON u.id = c.author_id
       WHERE c.household_id = $1 AND c.topic_id = $2 AND c.status = 'published'
       ORDER BY c.created_at ASC`, [this.scope.householdId, topicId]);
    return { ...mapCard(row), body: row.body, comments: comments.rows.map(mapComment) };
  }

  private async updateProposal(client: DbClient, id: string, status: "confirmed" | "rejected", expectedVersion: number): Promise<AiActionProposal> {
    const result = await client.query<{ id: string; action_type: AiActionProposal["action_type"]; status: AiActionProposal["status"]; version: number; payload: unknown }>(
      `UPDATE ai_action_proposal SET status = $3, version = version + 1, decided_by = $4, decided_at = now(), updated_at = now()
        WHERE household_id = $1 AND id = $2 AND version = $5
        RETURNING id::text AS id, action_type, status, version, payload`, [this.scope.householdId, id, status, this.scope.userId, expectedVersion],
    );
    const row = required(result.rows, "PROPOSAL_VERSION_CONFLICT", "AI 行动提案版本已变化");
    return { id: row.id, action_type: row.action_type, status: row.status, version: Number(row.version), payload: asPayload(row.payload) };
  }

  private async listMembersWithClient(client: DbClient): Promise<FamilyMember[]> {
    const result = await client.query<Record<string, unknown>>(
      "SELECT * FROM life_family_list_members($1, $2)",
      [this.scope.householdId, this.scope.userId],
    );
    return result.rows.map((row) => ({
      user_id: String(row.user_id),
      email: String(row.email),
      role: String(row.role) as FamilyMemberRole,
      status: "active" as const,
      joined_at: String(row.joined_at),
    }));
  }

  private async getSensitivePermissionsWithClient(client: DbClient, userId: string): Promise<MemberSensitivePermissionSnapshot> {
    const members = await this.listMembersWithClient(client);
    const actor = members.find((item) => item.user_id === this.scope.userId);
    const member = members.find((item) => item.user_id === userId);
    if (!actor || (actor.role !== "owner" && actor.user_id !== userId)) throw new DomainError("SENSITIVE_PERMISSION_DENIED", "只能查看自己的敏感授权", 403);
    if (!member) throw new DomainError("MEMBER_NOT_FOUND", "家庭成员不存在", 404);
    const result = await client.query<Record<string, unknown>>(
      "SELECT * FROM life_family_list_sensitive_permissions($1, $2, $3)",
      [this.scope.householdId, this.scope.userId, userId],
    );
    return {
      user_id: member.user_id,
      email: member.email,
      role: member.role,
      permissions: result.rows.map((row) => ({
        capability: String(row.capability) as SensitiveCapability,
        enabled: Boolean(row.enabled),
        explicit: Boolean(row.explicit),
        version: Number(row.version),
        granted_at: row.granted_at ? String(row.granted_at) : null,
        revoked_at: row.revoked_at ? String(row.revoked_at) : null,
        updated_at: row.updated_at ? String(row.updated_at) : null,
      })),
    };
  }

  private mapInvitation(row: Record<string, unknown>): FamilyInvitation {
    return {
      id: String(row.id),
      role: String(row.role) as FamilyInvitation["role"],
      status: String(row.status) as FamilyInvitation["status"],
      expires_at: String(row.expires_at),
      created_at: String(row.created_at),
      accepted_at: row.accepted_at ? String(row.accepted_at) : null,
    };
  }

  private async assertOwner(client: DbClient) {
    const result = await client.query<{ role: string }>(
      "SELECT role FROM household_member WHERE household_id = $1 AND user_id = $2 AND status = 'active'",
      [this.scope.householdId, this.scope.userId],
    );
    if (result.rows[0]?.role !== "owner") throw new DomainError("HOUSEHOLD_OWNER_REQUIRED", "只有家庭所有者可以执行此操作", 403);
  }

  private async writeAudit(client: DbClient, action: string, resourceType: string, resourceId: string, afterSummary: Record<string, unknown> = {}) {
    await client.query(
      `INSERT INTO audit_log (id, household_id, actor_id, actor_type, action, resource_type, resource_id, after_summary, trace_id)
       VALUES ($1, $2, $3, 'user', $4, $5, $6, $7::jsonb, $8)`,
      [randomUUID(), this.scope.householdId, this.scope.userId, action, resourceType, resourceId, JSON.stringify(afterSummary), randomUUID()],
    );
  }
}
