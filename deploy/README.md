# Life 腾讯云轻量服务器发布收口

以下命令必须在目标服务器执行；本地没有数据库、COS 凭据时不能代替执行。

发布前必须阅读：[生产发布与回滚清单](./ROLLBACK.md)。该清单已建立 A-006 的回滚路径，但真实服务器备份恢复和回滚演练仍需在 staging 完成。

## 1. 数据库迁移

使用只用于迁移的管理员连接执行：

```bash
NODE_ENV=production DATABASE_URL='postgres://migration_role:***@127.0.0.1:5432/life' \
  LIFE_DB_MIGRATE_CONFIRM=YES npm run db:migrate
```

应用服务使用单独的 `life_app` 连接，必须是 `NOSUPERUSER NOBYPASSRLS`，不能复用迁移管理员连接。

## 2. 生产 preflight

将 `.env.example` 复制为服务器私有环境配置，填入真实数据库和 COS 值，然后执行：

```bash
set -a
. /etc/life/life.env
set +a
npm run production:preflight
```

该命令会检查应用数据库角色、核心表、`FORCE ROW LEVEL SECURITY`、认证与密码重置函数、公开 App URL 和密码重置交付 Endpoint 配置，并在 COS 私有桶中执行一次上传、读取、HTTPS 签名 URL 和删除 smoke。`LIFE_COS_LIVE_SMOKE` 必须显式设为 `true`。真实邮件送达仍须另做一次目标环境验收。

## 3. 服务与 worker

开发阶段可用以下入口验证；生产环境必须使用已验证的构建产物和 systemd/supervisor/timer 守护，不得把 `api:dev` 当作生产启动命令：

```bash
npm run api:dev
npm run finance:export-worker
npm run finance:import-worker
npm run finance:retention-worker
```

当前导入解析、导出和保留期 worker 是一次性批处理入口，应由 systemd timer 或等价调度周期性触发，并为导入、导出、保留期清理配置失败告警。API 对外只经 HTTPS 反向代理，不能直接暴露 3100 端口。

## 4. 发布验收
## 3.1 安全响应头与 CSRF

API 服务在 `onSend` 中统一设置 `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy` 和 `Content-Security-Policy`，staging/production 另加 HSTS；`deploy/life-staging.Caddyfile.example` 保持相同头规则，部署时必须使用该模板且不删除其中的安全头。

所有 `/api/*` 的 POST/PUT/PATCH/DELETE 请求都会校验 `Origin` 或 `Referer`：请求主机或 `LIFE_PUBLIC_APP_URL` 与来源同域才放行；无 Origin/Referer 的非浏览器客户端仍可正常调用，跨域请求返回 403 `CSRF_ORIGIN_DENIED`。受支持的来源必须与外部域名保持一致，不能把 API 直接暴露在未经 Caddy HTTPS 保护的端口。

必须实际完成：注册 → 登录 → `/api/me` → 申请密码重置 → 邮件链接 → 更新密码 → 旧会话失效 → 新密码登录 → 财务首页 → 新增记账 → 导入账单 → 表头预览 → 关联审核 → 导出下载 → 退出；再验证跨家庭 Cookie、儿童权限、COS 对象路径、备份恢复和回滚。

## 5. B-011 正式身份 staging 验收

本节只验收原生 PostgreSQL、HTTPS、Secure/HttpOnly Cookie 和真实密码重置交付。腾讯云 COS 私有桶仍按既定决策留在 `E-119/I-004`，不能因为 B-011 通过而标记 COS 或生产发布闸门完成。

### 5.1 先确认服务器身份

如果 SSH 报告主机指纹变化，立即停止。必须从腾讯云控制台登录该实例，在实例终端执行：

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

只有控制台显示的 SHA256 指纹与本地 SSH 返回的指纹完全一致，才可以更新本机 `known_hosts`。不能使用 `StrictHostKeyChecking=no`，也不能仅凭 IP 相同假定服务器身份未变。

### 5.2 staging 配置

1. 为 staging 域名设置 DNS，并让 Caddy 自动取得可信证书；参考 `deploy/life-staging.Caddyfile.example`。
2. 创建独立的 `life_staging` 数据库、迁移角色和 `life_app` 应用角色；应用角色必须是 `NOSUPERUSER NOBYPASSRLS`。迁移角色拥有数据库结构，本项目的认证 `SECURITY DEFINER` 函数也由它持有，因此必须显式具备 `BYPASSRLS`，否则真实 PostgreSQL 会在 `FORCE RLS` 表上拒绝注册；该高权限连接只允许 root 在迁移和 preflight 时读取，严禁注入应用服务。
3. 使用迁移角色运行全部迁移，再将 `deploy/staging.env.example` 复制到 `/etc/life/staging.env`，替换占位符并设置权限 `0600`。
4. 使用 `deploy/life-staging.service.example` 启动 API。API 仅监听 `127.0.0.1:3100`，外部流量全部经过 Caddy HTTPS。
5. 密码重置交付接口必须为 HTTPS，并把邮件真正投递到专用 staging 测试邮箱；不能暴露数据库令牌或增加 `/__e2e` 取令牌接口。

服务器构建通常运行在严格 `umask 077` 下。`npm run web:build` 后必须只把静态发布目录归一化为 Caddy 可读，不能放宽私有环境文件或整个 release：

```bash
chmod 0755 /srv/life/releases/<commit>/dist
find /srv/life/releases/<commit>/dist/mobile -type d -exec chmod 0755 {} +
find /srv/life/releases/<commit>/dist/mobile -type f -exec chmod 0644 {} +
sudo -u caddy test -r /srv/life/releases/<commit>/dist/mobile/index.html
```

在服务器私有环境中运行：

```bash
set -a
. /etc/life/staging.env
set +a
npm run staging:auth-preflight
```

### 5.3 黑盒移动端 E2E

验收机只读取专用测试邮箱。邮箱读取接口必须使用 HTTPS 和 Bearer 鉴权，接收 `recipient`、`after` 查询参数，并返回以下最小结构：

```json
{
  "messages": [
    {
      "recipient": "life-e2e+unique@example.com",
      "reset_url": "https://staging-life.example.com/?reset_token=REDACTED",
      "received_at": "2026-08-28T12:00:00Z",
      "message_id": "optional-id"
    }
  ]
}
```

运行前在本地私有 shell 注入环境变量，不要写进仓库：

```bash
export LIFE_E2E_CONFIRM=I_UNDERSTAND_THIS_CREATES_STAGING_DATA
export LIFE_E2E_BASE_URL=https://staging-life.example.com/
export LIFE_E2E_EMAIL_TEMPLATE='life-e2e+{nonce}@example.com'
export LIFE_E2E_MAILBOX_ENDPOINT=https://mailbox.example.com/messages/latest
export LIFE_E2E_MAILBOX_BEARER_TOKEN=REPLACE_ME
npm run staging:auth-e2e
```

脚本将真实创建一个带 `B011-` 标记的 staging 家庭，验证 HTTP→HTTPS、HSTS、注册、第二会话、`/api/me`、Secure/HttpOnly/SameSite Cookie、真实重置邮件、旧会话撤销、旧密码失效、新密码登录、财务会话和退出。报告不会写入密码或重置链接；测试数据不允许指向 production。

### 5.4 I-010 结构化请求日志与检索

API 对每个请求回报 `x-request-id`，错误响应同时返回相同 `trace_id`。日志只输出结构化 JSON，不记录请求体、Cookie、令牌、查询参数或账单内容；IP、用户、家庭和邮箱只保留带 `LIFE_LOG_SALT` 的 SHA-256 摘要，User-Agent 截断到 200 字符。生产/ staging 使用 journald 收集 API 日志，默认关闭 Fastify 自带的原始请求行，避免重复记录原始 IP 和查询串。

在目标服务器按 trace id 检索：

```bash
export LIFE_LOG_SERVICE=life-staging.service
export LIFE_LOG_SINCE='30 minutes ago'
npm run ops:request-log -- <trace-id>
```

`LIFE_LOG_SALT` 必须在 `/etc/life/staging.env`（及 production 环境）保持稳定，不得写入 Git。仓库侧只验证结构、哈希和响应头；真实 journald 检索必须由目标服务器验收。

## 6. I-012 加密 PostgreSQL 备份

仓库已提供 `scripts/postgres_backup.sh`、`deploy/life-staging-postgres-backup.service.example`、`deploy/life-staging-postgres-backup.timer.example` 和 `deploy/staging-backup.env.example`，并已在 staging 服务器完成真实验收与远端备份；生产环境仍需按相同步骤独立部署和验证，不能以 staging 结果替代。

本地可执行 `npm run postgres:backup-contract` 验证脚本语法、加密/校验/保留期/远端校验契约（20 项检查），该检查不连接真实数据库或 COS；staging 真实验收证据见 `outputs/2026-09-03-I-012-backup-prep-evidence.md`。

备份服务的安全边界：

- 仅从 root 私有的 `/etc/life/staging-migration.env` 读取现有迁移数据库连接；不会将连接串写入日志、归档或 Git。
- 每次先生成 PostgreSQL custom-format dump，并用 `pg_restore --list` 校验；再把 dump、核心账本计数和 manifest 打包为 AES-256 GPG 对称加密归档。
- 只有加密归档和 SHA-256 校验和会落入 `/var/backups/life/staging/postgres`；明文临时文件处于 `0700` 的短生命周期工作目录，完成后删除。
- 归档必须同时通过 `rclone copy --checksum` 与 `rclone check --checksum` 复制到专用异地 bucket/prefix，才会写入 `remote-verified.txt`，并开始本地/远端保留期清理。远端不可用时本次失败且不清理旧恢复点。
- 默认保留 7 个本地日备份和 35 个异地日备份；远端必须是专用前缀，例如 `life-cos:life-backups/staging/postgres`，禁止指向 bucket 根或共享目录。

首次部署前，在服务器上由 root 创建一个只用于备份的随机 GPG 口令文件、配置 root 私有 rclone 远端，并按以下方式安装 unit：

```bash
sudo install -o root -g root -m 0600 /root/.config/rclone/rclone.conf /etc/life/rclone.conf
sudo install -o root -g root -m 0600 deploy/staging-backup.env.example /etc/life/staging-backup.env
sudo install -o root -g root -m 0644 deploy/life-staging-postgres-backup.service.example /etc/systemd/system/life-staging-postgres-backup.service
sudo install -o root -g root -m 0644 deploy/life-staging-postgres-backup.timer.example /etc/systemd/system/life-staging-postgres-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now life-staging-postgres-backup.timer
```

首次手动运行前必须确认：备份口令文件为 `0600 root:root`、rclone 目标为空的专用前缀、`DATABASE_URL` 指向 staging 而非 production。执行一次 `sudo systemctl start life-staging-postgres-backup.service` 后，检查 `systemctl status`、journal、加密归档、SHA-256 文件和 `remote-verified.txt`；实际恢复到隔离库的演练归 I-013，不能用“备份成功”替代恢复验证。

## 7. I-013 隔离恢复演练

仓库提供 `scripts/postgres_restore.sh` 和 `npm run postgres:restore-contract`（18 项静态契约检查）。脚本只允许恢复的 `LIFE_RESTORE_TARGET_DB` 以 `life_restore` 开头，并要求 `LIFE_RESTORE_CONFIRM=I_UNDERSTAND_THIS_RESTORES_ENCRYPTED_POSTGRES_BACKUP`；执行前先校验加密归档 SHA-256、解密、解包白名单、`pg_restore --list` 和目标库身份，目标库已有表时默认拒绝，只有显式设置 `LIFE_RESTORE_ALLOW_REPLACE=YES` 才允许覆盖。恢复完成后会按 `integrity.tsv` 比对核心表计数。

首次真实演练必须由手动操作完成：从 `/var/backups/life/staging/postgres/<backup_id>` 选择加密归档，配置私有口令文件与独立 `life_restore_*` 数据库，执行恢复后再核对家庭数量、账本金额、来源关系、权限和审计。仓库侧契约通过不代表真实恢复已完成。

## 8. I-014 staging 容量与压力测试

仓库提供 `scripts/staging_load_test.mjs` 和 `npm run staging:load-contract`（10 项静态契约检查）。真实压力测试必须显式设置 `LIFE_LOAD_CONFIRM=I_UNDERSTAND_THIS_RUNS_LOAD_TEST`、HTTPS 地址、时长、并发数和 P95 阈值；默认禁止压测 `life.wbutterfly.cn`，需要设置 `LIFE_LOAD_ALLOW_PRODUCTION=YES` 才会放行。脚本不会打印密码、Cookie 或令牌，并会在 5xx 比例、网络错误或 P95 超阈值时以非零退出。

仓库侧契约通过仅表示测试驱动可用，不表示 staging 已达到容量目标；真实并发家庭、超大账单、队列堆积、AI 超时和慢查询仍须在服务器上留档。

## 9. I-015 发布与回滚演练

仓库提供 `scripts/release_rollback_drill.sh` 和 `npm run release:rollback-contract`（13 项静态契约检查）。当前脚本只做 fail-closed dry-run：校验当前/上一 Tag、祖先关系、不可变发布目录和 migration 记录，并生成 `0600` 的计划 JSON；默认不切换目录、不重启服务、不删除文件。真实切换与回滚仍必须由人工在 staging 按 `deploy/ROLLBACK.md` 执行并留档。

## 10. I-011 健康检查与告警

仓库已提供 `scripts/life_health_check.ts`、`deploy/life-staging-health.service.example`、`deploy/life-staging-health.timer.example` 和 `deploy/staging-health.env.example`。本地可先执行 `npm run health:contract` 验证静态契约；真实服务器必须在 `/etc/life/staging-health.env` 配置完成后执行一次并启用 timer。

健康检查覆盖：

- API：`/healthz` 状态与响应延迟；
- PostgreSQL：连接、迁移数量、FORCE RLS 数量和关键表；
- 队列：导入/导出待处理、租约超时、失败任务和原始账单清理积压；
- 对象存储：生产 COS 配置（可选 live upload/read/delete smoke）或 staging 本地目录可读写；
- AI：家庭 AI 连接 active/disabled/error 与密钥引用状态；
- 磁盘：`/srv/life`、对象存储目录与 PostgreSQL 数据目录；
- 证书：目标 HTTPS 证书有效期。

监控边界：

- 应用角色受 FORCE RLS 限制，不能查看全局队列，因此健康检查使用独立的 `LIFE_HEALTH_DATABASE_URL` 数据库连接，通常复用 root 私有的 migration/admin 连接；该连接不得进入应用服务或仓库。
- 健康检查只输出聚合状态和检查项，不打印数据库连接串、COS 密钥、AI 密钥、账单内容、家庭标识或原始错误信息。
- 非生产 staging 使用本地对象存储，不要求 COS 配置；生产环境缺少 COS 配置会直接判为 critical。
- 监控数据库角色通常没有 `pg_read_all_settings`，因此健康检查允许通过 `LIFE_HEALTH_PG_DATA_DIR` 显式配置 PostgreSQL 数据目录；未配置时仅跳过该磁盘项，不会误判数据库结构失败。
- staging systemd 服务对对象存储目录使用 `ReadWritePaths`，而不是只读挂载，确保“可读可写”检查与导出/导入 worker 的真实权限一致。
- 未配置告警 Webhook 时，systemd 和 journald 保存失败记录；配置 Webhook 后，仅在健康状态非 ok 且 Webhook 为 HTTPS 时发送一次性聚合告警，默认不按每个失败项反复发送。

服务器安装（`staging-health.env` 复制后必须把 `LIFE_HEALTH_DATABASE_URL` 替换为实际 monitoring/admin 连接）：

```bash
sudo install -o root -g root -m 0600 deploy/staging-health.env.example /etc/life/staging-health.env
sudo install -o root -g root -m 0644 deploy/life-staging-health.service.example /etc/systemd/system/life-staging-health.service
sudo install -o root -g root -m 0644 deploy/life-staging-health.timer.example /etc/systemd/system/life-staging-health.timer
sudo systemctl daemon-reload
sudo systemctl enable --now life-staging-health.timer
sudo systemctl start life-staging-health.service
systemctl status life-staging-health.service
journalctl -u life-staging-health.service -n 30 --no-pager
```

首次执行必须确认输出全部检查项为 `ok` 或按预期区分 staging 本地对象存储；随后至少再观察一次 timer 触发记录，确认不是仅人工运行一次。
