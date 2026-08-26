# Life P0-B「账户、分类与预算管理」垂直切片卡 v0.1

状态：已完成，进入 P0-C 资产切片

更新时间：2026-08-25

关联 PRD：`outputs/Life-家庭生活工作台-PRD-v0.10.md` 第 5.3、7.4、8.4、9.1、10.3、12.2、14.3 节

## 1. 切片目标

在 P0-A 统一账本和分录基础上，让家庭所有者/成人成员能够在移动端完成账户生命周期、稳定分类和多预算管理，同时保证历史账单不被分类名称或预算调整重写：

```text
账户管理 → 查看余额 → 编辑/归档
分类管理 → 新增/编辑/归档 → 稳定 category_id
预算管理 → 绑定支出分类 → 设置周期额度 → 查看已用/剩余/进度 → 下钻账单
```

## 2. 数据与业务规则

- `financial_account.status` 控制账户生命周期；归档账户保留历史分录，但不能作为新记账落点。
- 账户编辑只允许修改名称和账户类型，不改写期初余额和历史分录；同一家庭账户名称不能重复。
- `category.id` 是预算、手动账和导入账单的稳定引用；分类名称更新只影响未来展示，不回写历史交易快照。
- 分类归档不删除历史账单；存在生效预算时必须先归档预算，避免预算环出现失效绑定。
- 归档分类不能再用于新手动记账；预算只能绑定当前家庭、处于 active 状态且适用于支出的分类。
- `budget` 保存规则和额度，`budget_period` 保存周期；预算列表返回 `amount / used / remaining / progress`，并保留 `category_id` 与 `color_token`。
- 预算调整只更新指定的当前/未来周期规则；账单仍由统一 `ledger_transaction` 读取，历史账单不被重写。
- 账户、分类、预算的创建、编辑和归档全部执行家庭上下文、财务写权限校验并写入 `audit_log`。

## 3. API 契约

| 方法 | 路径 | 目的 |
|---|---|---|
| `PATCH` | `/api/finance/accounts/{accountId}` | 编辑账户名称和类型 |
| `POST` | `/api/finance/accounts/{accountId}/archive` | 归档账户，保留历史流水 |
| `GET` | `/api/finance/categories?direction&include_archived` | 获取可用/归档分类 |
| `POST` | `/api/finance/categories` | 新增稳定分类 |
| `PATCH` | `/api/finance/categories/{categoryId}` | 编辑分类展示与方向 |
| `POST` | `/api/finance/categories/{categoryId}/archive` | 归档分类 |
| `GET` | `/api/finance/budgets?start&end&include_archived` | 获取周期预算及使用进度 |
| `POST` | `/api/finance/budgets` | 新增分类预算 |
| `PATCH` | `/api/finance/budgets/{budgetId}` | 调整当前/未来预算 |
| `POST` | `/api/finance/budgets/{budgetId}/archive` | 归档预算 |

所有写接口从服务端会话推导 `household_id`；客户端不能覆盖家庭范围。错误保留可追踪错误码和 `trace_id`。

## 4. 移动端 UI/UX 验收标准

- 财务首页“账户与预算”作为二级管理入口，不抢占“新增记账”和“导入账单”的主任务层级。
- 管理页面使用 Bottom Sheet，顶部保留财务上下文；三个 tab 为“账户 / 预算 / 分类”，互斥切换且不离开当前页面。
- 账户 tab 展示余额、账户类型和使用状态；新增账户沿用 P0-A 账户表单，编辑不展示可误改的期初余额。
- 预算 tab 展示周期、分类、已用百分比和剩余额度；新增/编辑表单只提供 active 支出分类，保存前校验额度和周期。
- 分类 tab 展示颜色标识、适用方向和状态；归档动作使用二次确认，服务端拒绝仍有生效预算的分类。
- 行操作和 tab 触控目标不小于 44×44pt；长名称允许换行，列表不因文字撑破容器。
- Sheet 使用淡粉淡紫 Liquid Glass 层，内容层不叠加多层 blur；小屏以内部滚动承载深层表单，不裁切保存按钮。
- 所有请求失败保留当前表单状态，在 Sheet 内显示错误；归档等不可逆语义使用明确确认文案。

## 5. Definition of Done

- [x] 0006 迁移增加分类和预算生命周期字段、索引、应用角色权限。
- [x] 账户编辑、账户归档和审计。
- [x] 分类新增、编辑、归档、稳定引用和 active 状态校验。
- [x] 预算新增、查询、编辑、归档、周期额度和进度计算。
- [x] 首页预算环返回 `category_id`，分类环下钻支持稳定 ID，并兼容旧交易名称快照。
- [x] 更新预算时拒绝收入分类/归档分类；归档有生效预算的分类返回冲突。
- [x] API 类型检查通过。
- [x] Web 类型检查通过。
- [x] OpenAPI 校验通过：30 paths、49 schemas。
- [x] PostgreSQL 垂直测试通过：6 tests；覆盖账户生命周期、分类预算规则、历史不重写、非法绑定和归档冲突。
- [x] 迁移烟测通过：125 statements、23 protected tables、24 policies、app role grants。
- [x] 移动端真实 API 验收通过：430×932、320×900 无横向溢出；管理 Sheet、预算/分类 tab、预算编辑器可打开；所有已测按钮/表单控件达到 44pt 触控目标。

## 6. 未包含范围

- 资产登记、资产事件和实物资产成本趋势的完整写入闭环，进入 P0-C。
- 家庭所有者按成员配置财务查看/记账/编辑/导入/关联/导出权限，进入 P0-D。
- 财务 AI 的家庭级 Provider、记忆、来源解释和确认执行，进入 P0-E。
- COS 私有桶生产适配、异步队列和部署硬化仍按发布闸门执行。
