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
- 真实 staging journald 检索、`LIFE_LOG_SALT` 稳定性和服务重启验收尚未执行。
- 日志聚合告警仍归 I-011，当前 I-010 只记录为 `PARTIAL / REPO_READY`。
