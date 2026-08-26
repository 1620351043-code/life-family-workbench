# Life 财务生产发布闸门复审报告 v0.4

复审时间：2026-08-25

## 1. 本轮结论

本轮已解决代码库内最后一个核心阻塞：正式身份认证和唯一家庭会话链路已闭合。

当前状态：**财务生产候选继续通过，目标基础设施 live 发布仍未放行。**

## 2. 已解决的身份阻塞

- 新增 `user_session` 表，只存会话 token 的 SHA-256 摘要，不存原始 token。
- 新增 HttpOnly、SameSite Cookie，会话默认 30 天；生产环境强制 Secure。
- 新增 `/api/auth/register`：一次性创建用户、家庭和 owner 成员关系。
- 新增 `/api/auth/login`：验证密码后创建会话。
- 新增 `/api/auth/logout`：立即撤销当前会话。
- 新增 `/api/me`：从有效会话返回用户、家庭和成员角色。
- 每次请求重新验证会话有效期、撤销状态、活跃成员状态和家庭归属。
- 数据库使用 `life_auth_lookup_user` / `life_auth_register_user` 受限 `SECURITY DEFINER` 函数完成无租户上下文的登录/注册前置查询。
- `household_member.user_id` 的唯一约束和注册事务共同保证一个用户不能加入多个家庭。
- 生产服务未配置正式 `authStore` 或 scope resolver 时拒绝启动，不再允许开发 scope 进入生产。

## 3. 最新自动化证据

| 验证项 | 结果 |
|---|---|
| API TypeScript | PASS |
| PostgreSQL 兼容垂直测试 | PASS，13/13 |
| 会话登录 → `/api/me` → 财务首页 → 退出撤销 | PASS |
| 注册 → 新家庭 owner → 重复邮箱拒绝 | PASS |
| 迁移烟测 | PASS，168 statements、27 张 RLS 业务表、28 条 RLS policy，另含 `user_session` |
| OpenAPI | PASS，48 paths、68 schemas |
| Web 类型检查/生产构建 | PASS |
| 四份真实账单回放 | PASS，1,339 来源记录、1,331 正式流水、8 个关联候选 |
| 移动端 430px/320px | PASS，无横向溢出、无低于 44px 的按钮 |

## 4. 新增的生产执行工具

- `npm run db:migrate`：使用 `LIFE_DB_MIGRATE_CONFIRM=YES` 执行 0001–0010，并用 `life_schema_migration` 记录已应用迁移，避免重复执行。
- `npm run production:preflight`：检查生产数据库角色不是 superuser/BYPASSRLS、核心表和 FORCE RLS、认证函数，以及 COS 上传/读取/HTTPS 签名/删除闭环。
- `npm run finance:export-worker`：消费导出队列。
- `npm run finance:retention-worker`：清理原始账单、过期导出和 AI 记忆对象。
- `deploy/README.md`：腾讯云轻量服务器迁移、preflight、worker、HTTPS、备份恢复和回滚验收步骤。

## 5. 仍未完成的真实环境验证

这些不是代码缺口，必须在目标腾讯云环境执行后才能关闭：

1. 原生 PostgreSQL：迁移、连接池、RLS、索引、备份恢复和回滚。
2. 腾讯云 COS：真实私有桶上传、读取、签名 URL、跨家庭对象隔离和清理。
3. 服务器部署：HTTPS 反向代理、systemd/守护、导出 worker、清理 worker 和告警。
4. 外部家庭 AI：真实 Endpoint 的成功、超时、4xx/5xx、限流和家庭记忆隔离。

当前环境未提供 `DATABASE_URL`、COS 凭据或目标服务器执行权限，因此本轮不能伪造这些 live 结果。

## 6. 最终判定

| 判定层 | 结果 |
|---|---|
| 财务功能与身份代码实现 | **通过** |
| 隔离测试和移动端闭环 | **通过** |
| 生产迁移/部署工具 | **通过，已具备执行条件** |
| 腾讯云目标环境 live smoke | **待执行** |
| 财务生产发布 | **暂不放行，等待目标环境证据** |

目标环境执行入口：`deploy/README.md`。执行 `npm run production:preflight` 并取得全量通过结果后，才可将本报告升级为“生产可发布”。
