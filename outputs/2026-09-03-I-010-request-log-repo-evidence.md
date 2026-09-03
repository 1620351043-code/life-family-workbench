# I-010 结构化请求日志与检索仓库侧证据（2026-09-03）

> 本文件只记录可复现命令与结果，不包含密码、令牌、Cookie、账单内容或真实用户邮箱。

## 1. 实现内容

- 每个响应新增 `x-request-id`，与错误响应正文的 `trace_id` 一致，由 Fastify `genReqId` 生成 UUID。
- `onResponse` 输出结构化 JSON：时间、trace id、方法、路由、状态码、耗时、IP/用户/家庭/邮箱的 SHA-256 摘要、截断后的 User-Agent。
- 关闭 Fastify 默认请求日志，避免原始 IP、完整查询串和请求对象进入日志正文。
- 错误处理输出 `error_code`，保留 `DomainError`、`ImportSecurityError`、Zod 和未知错误的稳定码。
- 新增 `scripts/request_log_query.mjs`，在目标服务器通过 journald 按 trace id 检索白名单字段。
- `LIFE_LOG_SALT` 仅用于日志摘要，写入服务器私有环境，不进入 Git。

## 2. 自动化证据

```bash
npm run api:typecheck
# PASS

npm run api:test
# PASS: 44 tests

npm run migration:smoke
# PASS: 241 statements, 31 protected tables, 32 policies

npm run openapi:validate
# PASS: 3.1.0, 68 paths, 91 schemas

npm run web:build
# PASS: mobile dist built

node --check scripts/request_log_query.mjs
# PASS

git diff --check
# PASS
```

## 3. 隐私断言

`src/api/request-log.test.ts` 验证：

- 日志不包含提交的密码或邮箱原文。
- `x-request-id` 与结构化日志 `trace_id` 一致。
- 路由记录不包含查询参数。
- IP 只以 16 位十六进制摘要记录。

## 4. 当前边界

- 仓库侧已具备结构化日志、错误码和检索入口。
- 已通过 PR #30 修复 journald `MESSAGE` 内嵌 JSON 的检索问题。
- 已部署 `v0.1.0-rc.7` 到 staging，服务重启后 journald 检索复验通过。
- 日志聚合告警仍归 I-011，当前 I-010 只记录为 `PARTIAL / REPO_READY`。

## 5. staging live 复验（2026-09-03）

- 发布点：`v0.1.0-rc.7`，提交 `fa2601952e299c09d84e1786a003929fa99b5c3c`。
- 服务：`life-staging.service` active，运行目录 `/srv/life/releases/v0.1.0-rc.7`。
- `https://life.wbutterfly.cn/healthz`：HTTP/2 200，响应含 `x-request-id`。
- `staging:auth-preflight`：`ok=true`，PostgreSQL 16.15，HTTPS/Secure Cookie 均通过。
- 真实 journald 检索：按 `x-request-id` 查询返回 `api request completed`，字段包含 trace id、method、route、status code、duration、脱敏 IP hash 和 msg。
- `LIFE_LOG_SALT` 已写入服务器私有环境，未进入 Git。
