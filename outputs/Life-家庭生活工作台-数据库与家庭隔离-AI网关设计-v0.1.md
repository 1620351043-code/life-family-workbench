# Life 家庭生活工作台

## 数据库、家庭租户隔离与 AI 网关设计 v0.1

> 状态：技术基线设计，供数据库 Spike、API 契约和安全测试使用。
>
> 依据：[PRD v0.10](./Life-家庭生活工作台-PRD-v0.10.md)、[技术路线评审 v0.1](./Life-家庭生活工作台-技术路线评审-v0.1.md) 和 [移动端信息架构与核心流程 v0.1](./Life-家庭生活工作台-移动端信息架构与核心流程-v0.1.md)。

## 1. 设计目标和不可突破的边界

### 1.1 目标

- 让家庭成为所有业务数据的明确租户边界。
- 让普通业务请求、后台任务、文件、缓存、搜索、向量和备份都遵守同一隔离规则。
- 让财务账本具备事务一致性、可追溯来源、可撤销关系和可重算统计。
- 让每个家庭拥有独立 AI API 连接、权限、上下文、记忆文件和向量命名空间。
- 让用户可以通过自动化测试证明家庭 A 无法读取家庭 B 的任何家庭级数据。

### 1.2 不可突破的规则

1. 一个用户账号只能有一条有效家庭成员关系。
2. 客户端提交的 `household_id` 只是路由参数，不是权限依据。
3. 所有家庭业务资源必须有非空 `household_id`。
4. 业务查询必须同时通过应用层租户上下文和数据库 RLS/等效策略。
5. 家庭 AI 连接、密钥引用、记忆、文件、向量、缓存、任务和审计都必须按家庭隔离。
6. AI 不得使用全局共享记忆；无家庭连接时只能使用规则/确定性降级。
7. 财务正式账本只能由确定性流程写入；AI 建议先进入待确认状态。
8. 去重不删除原始来源；关系可以撤销，正式账本可以重算。

## 2. 物理部署与数据层次

```text
Web/API
  ├── PostgreSQL：身份关联、家庭业务、财务真值、审计、任务状态、AI 结构化记忆
  ├── pgvector：家庭级记忆向量，或首期降级为结构化/关键词检索
  ├── COS：家庭原始文件、媒体、AI 记忆文件、HowToCook 快照/发布包
  ├── Secrets Manager/KMS：API 密钥、加密上下文和密钥轮换
  └── PostgreSQL 任务队列：导入、解析、AI、清理和导出任务
```

平台共享内容只有经过审核的、不可变的 HowToCook 发布包和平台字典。家庭的收藏、推荐曝光、搜索历史、烹饪行为、采购清单、账单、预算、AI 派生数据和审计均不可共享。

## 3. 数据库约定

### 3.1 通用字段

所有家庭业务表至少包含：

```text
id                 UUID 主键
household_id      UUID NOT NULL
created_at        timestamptz NOT NULL
updated_at        timestamptz NOT NULL
created_by        UUID 可空但必须可审计
version           integer NOT NULL DEFAULT 1
```

不同领域额外要求：

- 金额：`numeric(20, 4)`，并保存币种，不使用浮点数。
- 状态：使用受限枚举/字典值和状态变更记录。
- 外部来源：保存来源类型、来源 ID、内容哈希和导入批次。
- 删除：优先软删除或状态化撤销；原始导入清理使用物理删除 + 清理审计。
- 幂等：写操作使用 `idempotency_key`，任务使用 `task_id`。

### 3.2 唯一约束原则

所有家庭内唯一约束都要带 `household_id`，例如：

```text
UNIQUE (household_id, normalized_name)
UNIQUE (household_id, source_id, source_fingerprint)
UNIQUE (household_id, budget_id, period_start, period_end)
UNIQUE (household_id, member_id)
```

如果实体之间存在跨表外键，优先使用 `(household_id, id)` 的组合外键，防止把家庭 A 的资源引用到家庭 B。

## 4. 核心实体关系

### 4.1 身份和家庭

```text
User
  1 ─── 0..1 HouseholdMember
                 ├── 1 Household
                 └── role / status / permission policy

Household
  ├── FamilyTopic / TopicComment / MediaAsset
  ├── FoodInteractionEvent / FoodPreferenceProfile / ShoppingList
  ├── FinancialAccount / LedgerTransaction / Budget / PhysicalAsset
  ├── ImportBatch / SourceRecord / TransactionLink
  ├── HouseholdAIConnection / HouseholdMemoryStore
  └── AuditLog / Task
```

应用数据库不把 `User` 当成家庭业务数据的替代租户；身份只用于认证，家庭关系才决定业务范围。

### 4.2 家庭与权限

```text
Household
HouseholdMember
HouseholdPermission
FinancialPermission
AIPermission
PermissionGrantHistory
Invite
AuditLog
```

权限记录至少包含：被授权家庭成员、授权者、资源范围、动作范围、开始时间、结束时间、状态、原因和撤销时间。

儿童默认没有财务读取和写入权限。授权策略只授予明确范围，例如“某账户的本月汇总”，不能用一个全局布尔值代替资源范围。

### 4.3 财务真值模型

```text
FinancialAccount
AccountBalanceSnapshot
LedgerTransaction
LedgerEntry
Category
Budget
BudgetPeriod
PhysicalAsset
AssetEvent
AssetCostSnapshot
FinancialSource
ImportBatch
ImportRow
SourceRecord
TransactionLink
ReconciliationGroup
```

关系：

```text
ImportBatch
  → ImportRow
  → SourceRecord
  → TransactionLink / ReconciliationGroup
  → LedgerTransaction
  → LedgerEntry
  → Budget / Trend / AssetCostSnapshot
```

`SourceRecord` 保留来源事实，`TransactionLink` 表示关系，`LedgerTransaction` 是用户看到的统一交易，`LedgerEntry` 是计算分录。任何一个来源被判定为重复，仍不能从保留期内的来源层直接删除。

### 4.4 AI 数据模型

```text
HouseholdAIConnection
AIConnectionSecretRef
HouseholdMemoryStore
AIMemoryFact
AIMemoryArtifact
AIMemoryIndex
AIContextEvent
AIInsight
AIActionProposal
AIExecutionLog
AIConsentPolicy
```

`AIMemoryFact` 必须区分：

- `fact`：用户或系统确认的事实。
- `behavior`：自动采集的行为事件。
- `inference`：模型推断，必须有置信度、来源和撤回状态。

`AIActionProposal` 只有在用户确认后才能调用领域写服务。AI 网关不能直接写 `LedgerTransaction`、`FamilyTopic` 或 `ShoppingListItem`。

## 5. 家庭上下文建立和请求管线

### 5.1 HTTP 请求

每一个家庭业务请求按以下顺序执行：

```text
请求
  → 读取 HttpOnly 会话
  → 得到 user_id
  → 查询唯一有效 HouseholdMember
  → 确定 current_household_id
  → 校验成员状态和权限
  → 在数据库事务中设置租户上下文
  → 查询资源并再次校验资源 household_id
  → 执行领域操作
  → 写审计 / outbox / 任务
  → 提交事务
```

服务端可以接受 `/api/households/:household_id/...` 这样的路由，但路由参数只能用于定位和形成错误信息；真实家庭 ID 必须来自会话成员关系，若不一致立即拒绝。

### 5.2 当前家庭不能从客户端自由切换

由于一个用户只能属于一个家庭，服务端不实现普通的“切换家庭”接口。用户需要更换家庭时，进入受审计的退出/迁移流程；在迁移完成前，原家庭关系继续是唯一有效上下文。

## 6. PostgreSQL RLS 方案

### 6.1 数据库角色

```text
life_migrator   迁移角色，受控使用
life_app        应用角色，禁止 BYPASSRLS
life_readonly   受限诊断角色，不用于业务写入
```

应用连接池禁止使用超级用户。所有正式业务查询由 `life_app` 执行。

### 6.2 事务租户变量

每次查询使用专用事务连接：

```sql
BEGIN;
SELECT set_config('app.user_id', :user_id, true);
SELECT set_config('app.household_id', :household_id, true);
SELECT set_config('app.request_id', :request_id, true);
-- 业务 SQL
COMMIT;
```

`set_config(..., true)` 是事务级设置，连接归还连接池后自动失效。禁止只在连接池连接上设置永久会话变量，避免下一次请求复用上一个家庭。

### 6.3 RLS 策略示意

```sql
ALTER TABLE family_topic ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_topic FORCE ROW LEVEL SECURITY;

CREATE POLICY family_topic_tenant_policy
ON family_topic
USING (
  household_id = current_setting('app.household_id', true)::uuid
)
WITH CHECK (
  household_id = current_setting('app.household_id', true)::uuid
);
```

对于儿童财务等敏感资源，RLS 只解决“属于哪个家庭”，成员是否可以读写仍需在应用层做权限策略校验；敏感资源的查询应先经过 `FinancialPermission` 再执行领域 SQL。

### 6.4 防止跨家庭外键

推荐：

```sql
ALTER TABLE ledger_transaction
  ADD CONSTRAINT ledger_transaction_household_unique
  UNIQUE (household_id, id);

ALTER TABLE ledger_entry
  ADD CONSTRAINT ledger_entry_transaction_same_household
  FOREIGN KEY (household_id, ledger_transaction_id)
  REFERENCES ledger_transaction (household_id, id);
```

即使应用代码出现错误，也不能把家庭 A 的分录连接到家庭 B 的交易。

## 7. 对象存储、缓存、搜索和任务隔离

### 7.1 对象存储

对象键必须显式包含租户：

```text
households/{household_id}/media/{asset_id}
households/{household_id}/finance-imports/{batch_id}/original/{file_id}
households/{household_id}/finance-imports/{batch_id}/staging/{file_id}
households/{household_id}/ai-memory/{artifact_id}/{version}
platform/howtocook/releases/{release_id}/...
```

服务端生成签名地址并验证资源所属家庭后才返回。禁止客户端自行传入桶名、对象键或公共 URL。

### 7.2 缓存

所有缓存 key 使用：

```text
life:{environment}:household:{household_id}:{resource}:{version}:{scope_hash}
```

财务、权限和 AI 上下文默认不进入共享 CDN 缓存。家庭权限变更、AI 连接轮换、记忆清除和账本确认后必须使相关缓存失效。

### 7.3 搜索/向量

每一条搜索文档和向量记录必须有 `household_id`。平台 HowToCook 内容使用 `scope = platform_release:{release_id}`；家庭派生内容使用 `scope = household:{household_id}`。

向量查询必须在 SQL/索引层先绑定家庭 scope，不能先全局近邻检索后再用应用代码过滤。

### 7.4 后台任务

任务消息和任务表必须包含：

```text
task_id
household_id
actor_id
task_type
payload_version
idempotency_key
trace_id
status
```

Worker 开始任务时重新验证家庭存在、成员/系统权限、任务归属和输入资源归属。不能相信生产任务消息中的家庭 ID；任务消息是路由信息，最终资源归属仍由数据库校验。

## 8. 财务导入与去重数据设计

### 8.1 ImportBatch 状态机

```text
created
  → uploaded
  → scanning
  → header_detected
  → mapping_pending
  → normalized
  → matching
  → reconciliation_pending
  → confirmed
  → committed

任意中间状态 → failed / cancelled
committed → revoked（只撤销导入产生的正式关系，不删除来源历史）
```

写入正式账本前，批次必须有明确的确认动作和操作者。失败批次不得产生正式统计。

### 8.2 表头和解析结果

`ImportBatch` 记录：文件哈希、来源类型、编码、分隔符、工作表、扫描范围、探测到的表头行、数据区域、解析器版本和置信度。

`ImportRow` 记录：原始行号、原始值摘要、规范化字段、字段错误、修正状态和所属家庭。原始完整文件存 COS；数据库不重复存储可还原原文件的完整载荷，除非经过安全评审确有必要。

### 8.3 SourceRecord 唯一指纹

推荐按优先级生成指纹：

1. 来源平台交易号/订单号/银行流水号。
2. 账户 + 交易日期时间 + 金额 + 收支方向 + 对手方标准化名称。
3. 文件哈希 + 原始行号 + 规范化行哈希，作为无法提取稳定交易号时的幂等兜底。

指纹只在同一家庭、同一来源语义下用于幂等，不能把不同平台的相同金额误判为必然重复。

### 8.4 多来源关系

`TransactionLink` 至少支持：

```text
duplicate
parent_settlement
refund_reversal
fee_related
split
unrelated
pending_review
```

匹配结果包含：候选双方、匹配依据、置信度、推荐关系、人工决定、决定者和时间。

银行记录作为资金/余额锚点；支付平台记录作为商户、商品、订单号和备注的详情来源。统一交易可以引用多个来源，但收入/支出统计只能按规范化账本口径计一次。

## 9. AI 网关详细设计

### 9.1 连接对象

`HouseholdAIConnection` 保存非秘密元数据：

```text
household_id
provider_label
protocol
endpoint_url
model
secret_ref
enabled_capabilities
status
last_tested_at
last_error_code
created_by
rotated_at
```

API 密钥只写入 KMS/Secrets Manager，业务数据库只保存不可逆或不可直接使用的 `secret_ref`。日志只记录连接 ID、家庭 ID、结果和追踪 ID，不记录密钥和完整响应。

### 9.2 AI 请求管线

```text
领域页面请求
  → 认证
  → 当前家庭 / 成员关系
  → AI 能力权限
  → 数据范围权限
  → 加载家庭 AI 连接
  → 加载家庭记忆和领域上下文
  → 生成最小必要提示
  → 调用家庭 Endpoint
  → 校验结构化响应
  → 保存 AIInsight / AIActionProposal
  → 写 AIExecutionLog
  → 返回建议和来源
```

请求上下文必须包含 `household_id`、`actor_id`、`purpose`、`allowed_data_scopes` 和 `trace_id`。模型输出不能改变这些边界。

### 9.3 能力和数据授权

AI 能力至少拆为：

```text
topic_summary
food_recommendation
recipe_explanation
finance_reconciliation
finance_insight
memory_write
memory_read
```

家庭所有者可配置家庭级允许能力；儿童和普通成员还要经过成员级授权。财务 AI 默认只读，财务写入只能以待确认 `AIActionProposal` 形式返回。

### 9.4 AI 失败和降级

| 故障 | 行为 |
|---|---|
| 未配置连接 | 使用规则/确定性能力，明确标注未调用 AI |
| 连接测试失败 | 禁止启用相关能力，保留错误码 |
| Endpoint 超时 | 返回规则结果或稍后重试，不阻塞财务主流程 |
| 模型输出结构错误 | 丢弃不可解析结果，记录失败，不写业务表 |
| 权限不足 | 拒绝请求，不返回敏感数据片段 |
| 记忆检索失败 | 仅使用当前页面已授权上下文，禁止扩大检索范围 |
| 配额/限流 | 降级到规则能力，记录用量和原因 |

### 9.5 家庭记忆物理结构

```text
/ai-memory/{household_id}/facts/
/ai-memory/{household_id}/events/
/ai-memory/{household_id}/artifacts/
/ai-memory/{household_id}/embeddings/
```

对象元数据必须写入 `AIMemoryArtifact`：对象键、家庭、版本、内容哈希、加密上下文、来源事件、敏感级别、状态、清理状态和清理时间。

记忆检索采用“先家庭、再资源权限、再相关性”的顺序：

```text
scope = household_id
  → resource permission filter
  → memory type / sensitivity filter
  → relevance ranking
  → minimum necessary context
```

禁止先从全局记忆索引取 Top-K，再在应用层删掉不属于当前家庭的内容。

## 10. AI 记忆和家庭删除生命周期

### 10.1 清除家庭 AI 记忆

```text
用户确认清除
  → 建立清除任务
  → 标记记忆不可读
  → 清除结构化 facts/events
  → 删除 COS 文件
  → 删除向量记录
  → 失效缓存
  → 取消未完成记忆任务
  → 写清除审计
  → 返回完成/部分失败状态
```

部分失败不能伪装成成功；必须显示剩余对象类型和可重试任务。

### 10.2 家庭删除

家庭删除采用异步级联：先冻结业务写入，再导出/确认，随后按依赖顺序清除业务表、对象存储、搜索/向量、缓存、任务和审计摘要。删除任务本身保留最小化的执行记录，不保留可还原的家庭内容。

## 11. 原始账单 365 天清理

保留起点是导入批次进入成功、失败或撤销终态的时间。到期前 30 天展示提醒，之后清理：

- COS 原始文件。
- OCR/PDF/ZIP 临时文件。
- `ImportRow` 原始快照、表头预览、字段映射预览和未确认匹配材料。
- 解析错误报告和中间结果。

清理后保留最小来源摘要：来源类型、导入时间、文件哈希、批次 ID、规范化交易关联和清理时间。正式 `LedgerTransaction`、已确认的 `TransactionLink`、预算统计和必要审计摘要继续保留。

清理任务必须做到幂等；重复执行不会误删正式账本。

## 12. 审计模型

`AuditLog` 至少记录：

```text
audit_id
household_id
actor_id / actor_type
action
resource_type / resource_id
before_summary / after_summary
reason
trace_id
created_at
```

敏感操作必须审计：加入/退出家庭、成员授权/撤销、财务导入确认、关联关系确认/撤销、账本撤销、AI 连接测试/轮换/禁用、记忆读取/写入/清除、家庭删除和管理员受控运维访问。

审计正文不得保存 API 密钥、完整账单原文、完整提示词或不必要的家庭私密内容；保存引用、摘要和哈希即可追溯。

## 13. API 边界建议

### 13.1 家庭上下文

```text
GET  /api/me
GET  /api/me/household
GET  /api/households/:id/members
```

`:id` 必须与会话唯一家庭关系一致，不一致返回统一的 `HOUSEHOLD_SCOPE_DENIED`，不透露目标家庭是否存在。

### 13.2 财务导入

```text
POST /api/finance/import-batches
GET  /api/finance/import-batches/:id
POST /api/finance/import-batches/:id/header-confirmation
POST /api/finance/import-batches/:id/mapping-confirmation
GET  /api/finance/import-batches/:id/reconciliation
POST /api/finance/import-batches/:id/reconciliation/decisions
POST /api/finance/import-batches/:id/commit
POST /api/finance/import-batches/:id/revoke
```

`commit` 必须校验批次状态、操作者权限、确认摘要版本和幂等键，不能直接接受客户端上传的“已匹配结果”作为最终关系。

### 13.3 财务摘要和下钻

```text
GET /api/finance/overview?period=...
GET /api/finance/drilldowns/:filter_id
GET /api/finance/transactions/:id
GET /api/finance/assets/:id/cost-trend
```

摘要接口返回稳定的 `filter_id`/`drilldown_ref`；明细接口再次依据当前家庭、成员权限和过滤定义重新计算，不信任前端传回的金额和分类。

### 13.4 AI

```text
GET  /api/ai/connection
POST /api/ai/connection/test
PUT  /api/ai/connection
POST /api/ai/connection/rotate
POST /api/ai/connection/disable
POST /api/ai/context/insights
POST /api/ai/proposals/:id/confirm
POST /api/ai/proposals/:id/reject
POST /api/ai/proposals/:id/revoke
POST /api/ai/memory/clear
GET  /api/ai/audit
```

AI 端点不允许客户端直接传入持久化 API 密钥、完整系统提示或任意家庭 ID 来改变作用域。

## 14. 对抗式安全测试

### 14.1 跨家庭访问

建立家庭 A/B 和不同角色，测试：

- A 读取 B 的主题、评论、媒体、菜谱行为、采购清单和账单。
- A 读取 B 的 AI 连接元数据、密钥引用、记忆文件、向量和执行日志。
- 修改 URL 中的家庭 ID、资源 ID、批次 ID、资产 ID 和 `filter_id`。
- 修改请求体中的 `household_id`、`actor_id`、权限范围和账本金额。

期望：统一拒绝或空结果，不泄露资源是否存在，不产生副作用。

### 14.2 连接池和缓存串租户

- 同一连接池连续执行家庭 A/B 请求，验证事务变量不会残留。
- 先请求 A 的财务首页，再请求 B 的相同 URL，验证缓存没有返回 A 数据。
- 同一任务 Worker 连续处理 A/B 任务，验证对象存储、日志和数据库上下文都正确。

### 14.3 AI 记忆和 Endpoint 隔离

- A/B 配置不同 Endpoint 或测试服务器，验证调用不会串线。
- 给 A 写入唯一记忆短语，B 进行相似检索，必须返回无结果。
- 删除 A 记忆后重复检索、检查向量、对象存储、缓存和任务状态。
- 让模型返回含有其它家庭字段的恶意结构，验证响应校验和领域写入不会越权。

### 14.4 财务一致性

- 同一文件重复提交，不能重复写正式账本。
- 银行 + 支付平台同一交易，正式统计只计一次，详细信息保留。
- 父子结算、退款、手续费、拆分和不确定候选分别验证统计口径。
- 导入在任何中间步骤失败，正式账本不增加未确认交易。
- 原始数据到期清理后，正式账本、预算、趋势和已确认关系仍可下钻。

## 15. 完成标准

本设计进入代码实现前必须完成：

1. Spike A 通过：RLS、应用层权限和连接池上下文均通过跨家庭测试。
2. 领域表的 `household_id`、唯一约束、组合外键和删除策略完成评审。
3. 财务导入状态机、来源指纹和关系类型得到产品确认。
4. AI 连接不保存明文密钥，测试、轮换、禁用和清除均有审计。
5. 对象存储、缓存、队列、搜索和向量的租户命名规则固定。
6. 365 天清理任务具备幂等测试和恢复/重试策略。
7. 数据库恢复、单家庭逻辑删除和家庭 A/B 隔离测试可以在 CI 或测试环境重复运行。

