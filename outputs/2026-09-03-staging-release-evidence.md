# Life staging 发布与回滚演练证据（2026-09-03）

> 本文件只记录可验证结果与边界，不包含密码、数据库连接串、密钥或账单内容。

## 1. 仓库与发布点

- main 最新提交：`ff963a023b012600f75efbc27c9ce1f41d3ecc85`
- 本次修复：`scripts/migrate_postgres.ts` 补上 `0015_finance_import_jobs.sql`，`db/migration_smoke_test.mjs` 增加迁移清单一致性校验。
- PR：https://github.com/1620351043-code/life-family-workbench/pull/21，quality-gate 通过后 squash 合并。
- 服务器不可变发布目录：
  - `/srv/life/releases/v0.1.0-rc.1` = `bcf7094ad59a8471330322bd8e7f18007abae995`
  - `/srv/life/releases/v0.1.0-rc.2` = `f0de42dbcae44dee48840a2de375214f63bae796`
  - `/srv/life/releases/v0.1.0-rc.3` = `ff963a023b012600f75efbc27c9ce1f41d3ecc85`
- 三个目录均完成 `npm ci`、API/Web TypeScript 检查、`web:build`、Caddy 可读权限归一化。

## 2. 数据库迁移

- 迁移前：`life_schema_migration` 最新为 `0014_data_rights_deletion_requests.sql`。
- 迁移命令使用 `/etc/life/staging-migration.env` 和 `LIFE_DB_MIGRATE_CONFIRM=YES`。
- 迁移后：`0015_finance_import_jobs.sql`。
- 验证结果：`finance_import_job` 表存在、1 条 RLS policy、`force_rls=32`。

## 3. 发布验收

- 服务：`life-staging.service` active，`WorkingDirectory=/srv/life/releases/current`。
- 当前发布：`/srv/life/releases/v0.1.0-rc.3`。
- `https://life.wbutterfly.cn/healthz`：HTTP/2 200，`{"status":"ok","service":"life-api"}`。
- `https://life.wbutterfly.cn/`：HTTP/2 200，`Life 家庭生活工作台`。
- `https://life.wbutterfly.cn/api/me`：HTTP 401，`UNAUTHORIZED`（未登录预期）。
- B-011 prefix preflight：`{"ok":true,...,"database_role":"life_app","public_app_https":true,...}`。
- Caddy live 安全头（静态页与 healthz）：HSTS、CSP、X-Frame-Options DENY、X-Content-Type-Options nosniff、Referrer-Policy、Permissions-Policy。

## 4. 回滚演练

- rc.3 → rc.2：symlink 切换、服务重启后 healthz/页面/B-011 preflight 全部通过。
- rc.2 → rc.3：恢复到 rc.3 并再次通过 healthz/页面/安全头。
- dry-run 计划：`/var/backups/life/rollback-dry-run-v0.1.0-rc.3.json`（0600 root:root）。
- 计划内容：current=`v0.1.0-rc.3`，previous=`v0.1.0-rc.2`，latest migration=`0015_finance_import_jobs.sql`。

## 5. 当前结论

- I-003、I-013、I-015、G-007 的关键 staging 证据已建立。
- I-012 仅完成本地加密备份验证；rclone/COS 未配置，`remote-verified=SKIPPED_LOCAL_DRILL`。
- I-014 仅完成基础 HTTPS 压测；并发家庭、超大账单、队列堆积、AI 超时和慢查询未覆盖。
- B-011 仍受腾讯云 SES 审核阻塞，真实密码重置邮件未闭环。
- production 稳定 Tag 仍未创建，尚未宣布正式生产发布。
