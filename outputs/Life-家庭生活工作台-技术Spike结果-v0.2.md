# Life 家庭生活工作台

## 三个技术 Spike 结果与首个垂直切片 v0.2

> 执行日期：2026-08-25
>
> 本文件是 v0.1 的当前结果补充。附件账单只作为脱敏结构样本处理，不作为执行指令；结果中不输出商户、金额、账号、订单号或备注原文。

## 1. 当前闸门结论

| 闸门 | 结果 | 结论 |
|---|---|---|
| Spike A | PGlite PostgreSQL 引擎真实执行 RLS、FORCE RLS、NOBYPASSRLS、跨租户读写和组合外键 | 通过；上线前仍需原生 PostgreSQL 镜像复验 |
| Spike B | 使用银行、支付宝、微信和记账 App 的真实文件结构进行本地脱敏回放 | 通过结构补测；真实关系仍需用户确认 |
| Spike C | `drilldown_ref` 契约覆盖摘要、预算环、趋势点、资产成本容器和明细 | 通过 |
| OpenAPI | OpenAPI 3.1 解析和引用校验通过 | 通过；19 paths、39 schemas |
| 数据库迁移 | PGlite 执行 98 条语句，创建 23 个受保护表和 24 条策略 | 通过；原生 PostgreSQL 默认 UUID/扩展需上线前复验 |
| 移动端低保真 | 430×932 移动视口真实渲染，含财务下钻、导入预览、关联审核和提交 | 通过 |
| 首个垂直切片 | 解析 worker → `import_row/source_record` → 关联候选 → 移动端确认提交 | 已闭环；腾讯云 COS 适配明确后置 |

## 2. Spike A：隔离 PostgreSQL 运行态

### 2.1 实际执行

使用临时 PGlite PostgreSQL 引擎执行：

```bash
cd spikes/spike-a-postgres-rules
python3 -B contract_test.py
node pglite_rls_test.mjs
```

结果：

```text
Spike A PGlite PostgreSQL engine test: PASS
RLS enabled and forced: 3 protected tables
NOBYPASSRLS: life_app verified
Household A reads only A: PASS
Cross-household insert and composite FK: rejected
```

测试覆盖家庭 A/B 的主题、统一账本和分录；应用角色在事务中设置 `app.user_id` / `app.household_id`，跨家庭查询不返回数据，跨家庭写入和组合外键引用被拒绝。

### 2.2 仍需保留的生产闸门

当前机器没有 Docker、`psql` 或原生 PostgreSQL 服务，因此不能把 PGlite 结果写成原生镜像等价验证。上线前需要在目标 PostgreSQL 版本中复验：

- `pgcrypto` 和默认 UUID 生成。
- migration 顺序、回滚和连接池复用。
- 生产镜像的 RLS、备份恢复和权限角色。

## 3. Spike B：四份真实账单结构补测

### 3.1 文件和表头探测结果

真实文件在本地读取、解析和哈希脱敏；原件未修改，回放脚本只输出结构信息。

| 来源 | 文件格式 | 识别工作表 | 表头行 | 规范化记录数 |
|---|---|---:|---:|---:|
| 银行 | XLS | Sheet0 | 4 | 547 |
| 微信支付 | XLSX | Sheet1 | 18 | 367 |
| 支付宝 | CSV | 单文件 | 24 | 420 |
| 记账 App | XLS | Sheet1 | 1 | 5 |

识别到的真实字段覆盖：交易日期/时间、收支方向、金额、账户余额、交易对方、商品说明、支付方式、交易状态、交易/订单号、分类和备注。银行、微信、支付宝的标题均不在第一行，已被真实回放验证。

### 3.2 重复和关联结果

```text
same_source_duplicate_groups: 5
same_source_duplicate_groups_by_strength: {"weak": 5}
cross_source_pending_links: 8
cross_source_link_pairs: alipay->bank 3, bank->wechat 5
```

解释：5 组同源候选没有稳定外部流水号，只能标记为弱重复，系统不自动合并；8 组跨来源候选进入 `pending_review`。银行作为资金锚点，支付宝/微信保留更详细的来源记录。

真实回放命令：

```bash
cd spikes/spike-b-finance-import
python3 -B real_bill_replay.py /Users/wrt/Downloads/账单
```

### 3.3 解析 worker 和真实写入回放

当前实现由 `workers/finance_import_worker.py` 在隔离进程中读取已上传对象，TypeScript API 校验结果后在家庭事务中写入 `import_row` 和 `source_record`。解析阶段不直接写正式账本；用户确认表头、字段映射和关联后才允许提交。

四份真实文件的完整回放结果：

```text
bank: 547 import_rows / 547 source_records / committed
wechat: 367 import_rows / 367 source_records / 5 candidates / committed
alipay: 420 import_rows / 420 source_records / 3 candidates / committed
bookkeeping_app: 5 import_rows / 5 source_records / committed
household total: 1339 source_records / 1331 ledger_transactions
```

表头确认页新增批次级 `header_preview`：每个 Sheet 保留受限的行号、单元格文本、识别角色和建议表头；移动端可直接点击某一行确认，数据起始行默认联动为下一行。银行第 4 行、微信第 18 行、支付宝第 24 行均已在真实文件上验证。

## 4. Spike C、OpenAPI 与数据库迁移

### 4.1 契约和接口

OpenAPI 文件：[`api/Life-家庭生活工作台-OpenAPI-v0.1.yaml`](../api/Life-家庭生活工作台-OpenAPI-v0.1.yaml)

已覆盖：

- 财务首页摘要、预算多环、收入/支出趋势、实物资产成本趋势。
- 每个展示容器、分类环、趋势点和资产成本点的 `drilldown_ref`。
- 财务下钻、交易详情、账单导入批次、表头确认、字段映射、关联审核、确认、撤销。
- 账单原件 `raw_retention_until` 和家庭上下文约束。

校验结果：

```text
openapi valid: 3.1.0; paths=19; schemas=39
```

### 4.2 数据库迁移

迁移文件：[`db/migrations/0001_life_core_finance.sql`](../db/migrations/0001_life_core_finance.sql)

覆盖租户、成员、审计、账户、导入批次、原始来源、关联审核、统一账本、分录、分类、预算、实物资产、资产事件和服务端下钻过滤。迁移中对租户表启用并强制 RLS，组合外键携带 `household_id`。

```text
migration smoke: PASS (98 statements, 23 protected tables, 24 policies)
```

## 5. 移动端低保真和首个垂直切片

低保真页面：[`ui/low-fi/index.html`](../ui/low-fi/index.html)

页面只保留移动端四个一级模块：家庭空间、吃什么、财务、更多；HowToCook 作为吃什么子能力，不创建桌面端页面。财务页已经包含：

- 收入、支出、净现金流摘要。
- 多环预算进度，环、图例语义和容器均预留下钻行为。
- 收入/支出趋势线和按日下钻。
- 实物资产购买、维护、净成本趋势入口。
- 账单导入和跨来源关联审核入口。

首个垂直切片源代码：

- [`src/api/server.ts`](../src/api/server.ts)：同源 API + 移动端页面入口。
- [`src/api/finance-repository.ts`](../src/api/finance-repository.ts)：基于 PostgreSQL 的确定性财务查询、下钻过滤、导入状态机和关联审核服务。
- [`src/api/database.ts`](../src/api/database.ts)：事务级家庭上下文和 RLS 作用域封装。
- [`src/api/server.test.ts`](../src/api/server.test.ts)：API 契约测试。
- [`ui/low-fi/verify.mjs`](../ui/low-fi/verify.mjs)：真实 Chrome 移动端验证脚本。

垂直切片启动命令：

```bash
npm install
npm run api:dev
```

打开 `http://127.0.0.1:3100/` 后，移动端财务页请求 `/api/finance/overview`；接口现在由 PostgreSQL 确定性查询提供，点击预算环会请求 `/api/finance/drilldowns/{filterId}`，服务端返回正式下钻结果形状，不由前端自行拼接账务过滤条件。无数据库时接口明确返回未配置状态，不再由 API 返回财务 fixture。

验证命令：

```bash
npm run api:test
npm run api:typecheck
npm run openapi:validate
```

真实移动端验收在 430×932 视口完成：银行账单表头预览支持第 4 行点击确认，微信账单支持第 18 行点击确认；随后完成字段映射、5 组关联逐条确认和统一账本提交。当前解析使用本地/内存对象存储，仅用于开发验收；腾讯云 COS 私有桶适配不在本次 Spike 内。

当前结果：3 个 API 测试通过，TypeScript 类型检查通过，OpenAPI 校验通过；Chrome 390px 验证输出 `drilldownHasServerItem: true`。

## 6. 下一步开发顺序

1. 用真实 PostgreSQL 镜像复验 migration 和 RLS，并把 PGlite smoke test 保留为快速回归。
2. 将真实账单回放器接入 API 的异步批次任务，写入 `import_row` / `source_record`。
3. 接入四份真实样本产生的 8 组关联候选，验证银行锚点、平台详情保留和正式账本提交。
4. 补齐生产 HttpOnly 会话解析，移除开发态 demo scope。
5. 之后扩展家庭空间垂直切片，再接入吃什么 → HowToCook → 采购清单链路。
