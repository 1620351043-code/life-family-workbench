# Life 协作与提交规范

本文是仓库级开发协作规则。它与生产发布总控清单配套使用：总控清单定义“做什么和是否达标”，本文定义“如何进入主分支”。

## 1. 分支模型

`main` 是唯一集成分支，代表当前可审查的产品基线。任何功能、修复、文档或配置变更都从 `main` 创建短生命周期分支，通过 Pull Request 合并，不直接向 `main` 推送。

分支命名统一使用以下格式：

```text
codex/<scope>-<short-slug>
```

其中 `<scope>` 使用模块名，例如 `finance`、`auth`、`food`、`family`、`ui`、`infra`；`<short-slug>` 使用小写英文、数字和连字符。示例：

```text
codex/finance-import-review
codex/auth-mobile-session
codex/ui-family-space
codex/infra-ci
```

本地开始工作前先确认基线干净：

```bash
git status --short --branch
git switch main
git pull --ff-only
git switch -c codex/<scope>-<short-slug>
```

不要在已有未提交改动时切换或创建分支，除非已经明确知道这些改动属于当前任务。

## 2. 提交信息

提交使用 Conventional Commits 形式：

```text
<type>(<scope>): <summary>
```

允许的 `type`：

| type | 用途 |
|---|---|
| `feat` | 新增用户可见能力 |
| `fix` | 修复缺陷 |
| `refactor` | 不改变行为的重构 |
| `docs` | 文档、PRD、验收记录 |
| `test` | 测试或测试夹具 |
| `chore` | 工程维护、依赖和仓库配置 |
| `ci` | CI/CD 配置 |
| `build` | 构建系统或打包配置 |
| `perf` | 性能优化 |
| `revert` | 回滚已有提交 |

提交规则：

1. 一个提交只表达一个逻辑变化。
2. 提交正文说明动机、影响范围和验证命令；纯文档修改可简化。
3. 不提交 `.env`、真实账单、数据库转储、COS 临时文件、截图产物或密钥。
4. 与功能一起提交对应测试；如果暂时无法测试，必须在 Pull Request 中写明原因和后续任务。
5. 不改写已经进入共享分支的提交历史，不使用 `git push --force` 改写 `main`。

推荐示例：

```text
feat(finance): add manual expense entry
fix(import): preserve detailed payment-platform source record
test(finance): cover cross-provider duplicate candidates
docs: record A-003 branch and review policy
```

## 3. Pull Request 与审查

每个 Pull Request 必须：

- 关联一个总控清单、垂直切片卡或明确的问题编号；
- 说明变更目标、非目标、影响模块和数据迁移；
- 提供实际验证命令及结果；
- 涉及移动端 UI/UX 时附 430×932 截图，并说明交互状态、空态、错误态和长内容表现；
- 涉及 API、数据库、导入、权限或 AI 时说明租户隔离、权限边界、审计和回滚影响；
- 所有审查意见关闭后再合并。

审查至少覆盖以下维度：

1. 正确性：主流程、空态、错误态、重复提交和并发边界。
2. 数据安全：家庭隔离、权限校验、敏感数据、原始账单保留期限。
3. UX：即时反馈、异步刷新是否必要、可点击容器的下钻关系、44pt 触控目标和可读性。
4. 可运维性：日志、失败重试、迁移顺序、回滚路径和部署影响。
5. 测试：新增行为是否有自动化测试，既有测试是否仍通过。

默认采用 Squash merge，把一个完成的 Pull Request 合并为一个可追踪提交；合并后删除短生命周期分支。紧急修复也必须补齐 Pull Request 和复盘记录。

## 4. 合并前检查

在提交 Pull Request 前至少运行：

```bash
npm run api:typecheck
npm run web:typecheck
npm run api:test
npm run openapi:validate
node db/migration_smoke_test.mjs
npm run web:build
```

金融、导入或移动端切片变更还应运行对应的真实回放、移动端 smoke 或视觉回归命令，并把结果写入 Pull Request。

## 5. 数据库和迁移

- 已合并的迁移文件视为不可变，不在原文件上修改历史语义。
- 新迁移必须说明前向变更、兼容窗口、数据回填、锁风险和回滚策略。
- 涉及家庭数据的查询必须带家庭作用域，并有越权测试。
- 迁移通过后才能合并调用新字段或新接口的应用代码；若需要分阶段发布，先兼容后切换再清理。

## 6. 完成定义

一个变更只有同时满足以下条件才算完成：

- 需求范围和验收标准已对应到文档或任务；
- 代码、测试、迁移和 UI 状态实现一致；
- 本文规定的审查和合并流程完成；
- 总控清单更新状态、证据、复核日期和下一步；
- 没有把本地演示数据、敏感文件或生成物带入提交。
