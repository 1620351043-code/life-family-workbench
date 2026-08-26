# Life 财务生产发布闸门复审报告 v0.3

复审时间：2026-08-25

复审对象：财务 V1 垂直切片（账本、账户、分类预算、实物资产、权限审计、账单导入、导出、AI、原始数据保留、移动端）

## 1. 结论先行

当前结果是：**财务功能实现候选通过，生产发布闸门未最终通过。**

代码和隔离测试已经形成完整闭环，但当前环境没有真实 PostgreSQL 服务、腾讯云 COS 凭据、外部家庭 AI 凭据或可执行的生产会话认证配置，因此不能把本地验证结果包装成腾讯云生产已发布。

本轮没有发现财务核心垂直切片的自动化回归失败；剩余问题属于生产环境接入与身份认证发布阻塞项。

## 2. 已通过的功能闭环

### 2.1 财务核心能力

- 新增收入、支出、转账，完整写入统一账本和账户分录。
- 账户编辑、归档；分类稳定引用、归档保护；预算周期、使用进度和下钻。
- 实物资产登记、事件、账单关联、成本/回收/净成本和终止状态保护。
- 家庭所有者逐项授权和撤销儿童/成员的查看、记账、编辑、导入、关联、导出能力。
- 财务写入、关联、撤销、权限变更和 AI 提案均写入审计。
- AI 财务摘要只读解释，带来源引用；提案必须确认/拒绝/撤销，不直接改正式账本。

### 2.2 真实账单回放

使用用户提供的四份账单进行真实解析回放，输出仅保留计数，不输出交易金额、商户或账户隐私：

| 来源 | 解析行数 | `import_row` | `source_record` | 关联候选 | 正式入账 |
|---|---:|---:|---:|---:|---:|
| 银行 | 547 | 547 | 547 | 0 | 547 |
| 微信 | 367 | 367 | 367 | 5 | 362 |
| 支付宝 | 420 | 420 | 420 | 3 | 417 |
| 记账软件 | 5 | 5 | 5 | 0 | 5 |
| 合计 | 1,339 | 1,339 | 1,339 | 8 | 1,331 |

已验证：银行作为正式账本锚点；支付平台保留更详细来源；关联候选经审核后去重，不将同一消费重复计入正式账本。

### 2.3 导入、导出和保留期

- 非首行表头检测、表头行/数据起始行预览、映射确认和批次状态机已通过真实样本回放。
- 导出任务具备幂等键、权限检查、异步队列、CSV 生成、下载有效期和审计。
- API 进程可异步处理新任务；独立 `finance:export-worker` 可在服务重启或多进程部署后继续消费队列。
- 原始账单对象、过期导出对象、过期 AI 记忆对象均有清理 worker；正式账本不会因原始文件清理而删除。
- 清理失败保留可重试状态和审计记录。

## 3. 自动化验证证据

| 验证项 | 结果 | 证据 |
|---|---|---|
| API TypeScript | PASS | `npm run api:typecheck` |
| PostgreSQL 兼容垂直测试 | PASS | `npm run api:test`，12/12 |
| 迁移烟测 | PASS | 158 statements、27 protected tables、28 RLS policies |
| OpenAPI | PASS | OpenAPI 3.1、45 paths、66 schemas |
| Web TypeScript | PASS | `npm run web:typecheck` |
| Web production build | PASS | `npm run web:build` |
| 真实四份账单回放 | PASS | `LIFE_REAL_BILL_DIR=/Users/wrt/Downloads/账单 npx tsx scripts/finance_real_bill_vertical.ts` |
| 移动端 430px | PASS | `clientWidth=430`、`scrollWidth=430`、无低于 44px 按钮 |
| 移动端 320px | PASS | `clientWidth=320`、`scrollWidth=320`、无低于 44px 按钮 |

## 4. 生产发布阻塞项

### P0：生产身份认证尚未闭合

`src/api/server.ts` 的默认 scope resolver 明确是开发桥接：只有 `LIFE_DEV_DEMO_SCOPE=true` 才从环境变量/请求头获得家庭范围；生产必须注入 HttpOnly 会话 resolver。当前 OpenAPI 虽声明 `/api/me` 和 `life_session`，运行时尚未提供正式登录/会话身份链路。

因此当前可证明“租户边界和 RLS 正确”，但不能证明真实用户登录后能稳定进入唯一家庭并完成财务操作。必须在生产部署前接入正式会话 resolver，并补 `/api/me` 运行时回归。

### P0：尚未在原生 PostgreSQL 目标环境执行

本轮测试使用 PGlite 的 PostgreSQL 兼容运行时。当前工作区未发现本机 PostgreSQL、`DATABASE_URL` 或可用容器服务，所以尚未完成原生 PostgreSQL 的迁移、RLS、索引、事务和连接池验证。

### P0：腾讯云 COS 尚未 live smoke

腾讯云 COS 私有桶适配器、私有 ACL、HTTPS 签名 URL、家庭对象前缀和缺少配置时的生产启动拒绝均已写入代码；但当前没有 `LIFE_COS_BUCKET`、`LIFE_COS_REGION`、`LIFE_COS_SECRET_ID`、`LIFE_COS_SECRET_KEY`，尚未完成真实上传、读取、签名下载、过期删除和权限隔离验证。

### P1：家庭级外部 AI 尚未 live smoke

家庭 AI 配置只存 `api_key_ref`，密钥从服务端环境映射读取；没有对应密钥时会 fail closed。当前没有外部 OpenAI-compatible Endpoint 和家庭密钥，尚未验证真实超时、错误响应、限流和模型输出结构。

### P1：部署运维尚未验收

腾讯云轻量服务器部署、HTTPS、备份恢复、定时清理、队列 worker 守护、日志脱敏、告警和回滚演练均未在目标服务器执行。

## 5. 发布判定

| 判定层 | 结果 |
|---|---|
| 财务功能垂直切片实现 | **通过** |
| 代码级隔离、权限、导入、关联、导出、清理闭环 | **通过** |
| 移动端页面与交互回归 | **通过** |
| 原生 PostgreSQL 目标环境 | **未验证** |
| COS/外部 AI 生产依赖 | **未验证** |
| 正式身份认证和 `/api/me` | **阻塞** |
| 腾讯云生产发布 | **不通过，暂不得发布** |

## 6. 进入生产发布前的最短收口路径

1. 在隔离 PostgreSQL 实例执行全部迁移、12 个垂直测试和一次备份恢复；记录 `EXPLAIN`、RLS 和连接池结果。
2. 接入正式 HttpOnly 会话 resolver，补 `/api/me`，验证“一个用户只能属于一个家庭”和跨家庭请求 401/403/404 行为。
3. 配置腾讯云 COS 私有桶，执行上传、解析、签名下载、过期导出清理、原始账单一年清理和跨家庭对象访问测试。
4. 配置至少一个家庭级 AI Endpoint 和密钥引用，验证成功、超时、4xx/5xx、无密钥 fail-closed 和家庭记忆对象隔离。
5. 在腾讯云轻量服务器完成部署、HTTPS、worker 守护、定时任务、监控告警、备份恢复和回滚演练；全部通过后再将结论改为“生产可发布”。

## 7. 本轮变更索引

- `db/migrations/0009_finance_production_hardening.sql`
- `src/api/finance-export-worker.ts`
- `src/api/finance-retention-worker.ts`
- `src/api/import-storage.ts`
- `src/api/ai-gateway.ts`
- `src/api/finance-repository.ts`
- `src/api/server.ts`
- `scripts/finance_real_bill_vertical.ts`
- `scripts/finance_export_worker.ts`
- `scripts/finance_retention_worker.ts`
- `ui/app/src/components/FinancePage.tsx`
- `api/Life-家庭生活工作台-OpenAPI-v0.1.yaml`
