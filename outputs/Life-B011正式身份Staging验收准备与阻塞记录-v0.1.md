# Life B-011 正式身份 Staging 验收准备与阻塞记录 v0.1

日期：2026-08-29

状态：`PARTIAL / DEFERRED_SES_REVIEW`

适用范围：原生 PostgreSQL、HTTPS、正式 Cookie、真实密码重置交付的移动端黑盒 E2E

## 1. 当前结论

B-011 已从“服务器不可进入”推进到“真实 PostgreSQL、HTTPS、注册、登录、正式 Cookie、财务身份态和退出均 live 通过”。2026-08-29 已在腾讯云 SES 提交独立发信子域 `notify.wbutterfly.cn`，控制台状态为“待审核”。用户已明确决定暂时跳过该外部审核，优先推进独立的灾备和发布演练工作包。审核和后续 DNS 身份验证完成前，真实密码重置邮件交付与专用测试邮箱读取接口仍不可配置，因此本项不能标记 `DONE`，也不能创建生产发布 Tag。

腾讯云 COS 私有桶不属于本切片。staging 继续使用 `/var/lib/life/staging-imports` 隔离目录；这不关闭 `E-119/I-004`。

## 2. 目标环境事实

- 主机：腾讯云 Ubuntu 24.04.4 LTS，服务器指纹已在控制台核对为 `SHA256:m6Ze3jDXTijo9E67jlpNt8E+iWgPD0GjhGzAdI2ISbM`。
- Web：Caddy 2.11.4，现有 `wbutterfly.cn` 祭文站保持独立，Life 使用 `https://life.wbutterfly.cn/`。
- TLS：Let's Encrypt 可信证书已签发；HTTP 返回 308 到 HTTPS；HSTS、安全头和 SPA 静态资源已生效。
- API：`life-staging.service` 仅监听 `127.0.0.1:3100`，外部只经 Caddy HTTPS 访问。
- 数据库：PostgreSQL 16.15；`life_staging` 独立数据库；14 个迁移全部应用；31 张表启用 `FORCE RLS`。
- 角色：`life_app` 为 `NOSUPERUSER NOBYPASSRLS`；迁移角色持有认证 `SECURITY DEFINER` 函数并具备 `BYPASSRLS`，其连接只保存在 root `0600` 迁移配置中，不注入应用服务。
- 私有配置：`/etc/life/staging.env` 与 `/etc/life/staging-migration.env` 均为 `0600 root:root`。

## 3. 本轮发现并修复的问题

### 3.1 Caddy SPA fallback 抢占 API

原模板中的 `try_files` 会先把 `/api/*` 与 `/healthz` 改写到 `/index.html`。已改为显式 `handle /api/*`、`handle /healthz` 和最终 SPA `handle`；live 复验结果：

- `/healthz` 返回 `{"status":"ok","service":"life-api"}`；
- 未登录 `/api/me` 返回 JSON `401`；
- 首页继续返回移动端 SPA。

### 3.2 真实 PostgreSQL FORCE RLS 阻断注册

PGlite 未暴露认证 `SECURITY DEFINER` 函数所有者无法穿过 `FORCE RLS` 的差异。首次 live 注册因此被 `app_user` RLS 拒绝。修订后：

- `life_app` 仍然不能绕过 RLS；
- 只让本就拥有结构迁移权限的迁移角色显式 `BYPASSRLS`；
- preflight 新增认证函数必须为 `SECURITY DEFINER` 且所有者能穿过 `FORCE RLS` 的检查；
- 注册 live 重试通过。

### 3.3 严格 umask 导致静态首页 403

服务器 root 会话使用 `umask 077`，Vite 初次构建因此把 `dist/mobile` 生成成仅 owner 可读，API 正常但 Caddy 首页返回 403。已只对静态发布目录归一化为目录 `0755`、文件 `0644`，私有环境文件继续保持 `0600`；部署说明增加 Caddy 实际可读检查。

## 4. 已通过的 live 证据

| 检查 | 结果 |
|---|---|
| PostgreSQL 版本与连接 | `PASS`，16.15 |
| 应用角色 | `PASS`，非超级用户、不可绕过 RLS |
| 迁移与 RLS | `PASS`，14 migrations、31 FORCE RLS |
| HTTPS 与证书 | `PASS`，Let's Encrypt，HTTP 308，HSTS |
| API 边界 | `PASS`，仅 loopback 3100，Caddy 反代 |
| 移动端注册 | `PASS`，真实创建唯一家庭和 owner |
| 正式 Cookie | `PASS`，`Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/` |
| 第二会话登录与 `/api/me` | `PASS`，200 |
| 财务正式身份页 | `PASS`，真实 PostgreSQL 空账本正常展示 |
| 退出与会话失效 | `PASS`，Cookie 清除，`/api/me` 返回 401 |
| 430/390/320 布局 | `PASS`，无根级横向溢出，未发现小于 44pt 的可见控件 |
| 密码重置真实送达 | `DEFERRED / SES_DOMAIN_REVIEW`，`notify.wbutterfly.cn` 已提交，等待腾讯云审核后读取其生成的 DNS 验证记录；真实邮件交付 Endpoint 和测试邮箱读取接口尚未配置 |

浏览器验收使用独立 `B011-LIVE-*` staging 家庭；未读取、上传或提交真实账单。

## 5. 仓库自动化

- `npm run staging:auth-preflight`：检查数据库角色、RLS、认证函数所有者、HTTPS 配置和 Secure Cookie。
- `npm run staging:auth-contract`：10 项，包含邮箱响应、Cookie、HTTPS、跳转和 Caddy API 路由优先级。
- `npm run staging:auth-e2e`：保留完整黑盒流程，不读取数据库令牌，不增加 `/__e2e` 取令牌接口。

## 6. 唯一剩余解除条件

已提交的发信子域与下一步必须严格按以下顺序进行，不能在审核状态下猜测或预写 DNS 记录：

1. `notify.wbutterfly.cn`：已提交至腾讯云 SES，当前为“待审核”；现有网站、`life.wbutterfly.cn` 和根域 DNS 均未改动。
2. 审核通过后，从 SES 域名详情读取该域专属的 MX、SPF、DKIM、DMARC 记录，逐条写入 DNSPod 并等待验证通过。
3. 验证通过后，创建专用发信地址和审核通过的密码重置邮件模板。
4. 最后配置一个真实邮件交付服务，并提供一个只用于 B-011 的专用测试邮箱读取接口：

   - `LIFE_PASSWORD_RESET_DELIVERY_ENDPOINT`：HTTPS，接受项目既定 JSON 契约并真实投递邮件；如需要 Bearer，写入服务器私有环境，不进入仓库。
   - `LIFE_E2E_MAILBOX_ENDPOINT`：HTTPS + Bearer，只允许读取专用测试邮箱，按 `recipient` 和 `after` 查询。
   - `LIFE_E2E_EMAIL_TEMPLATE`：专用测试邮箱模板，不使用个人主邮箱。

完成配置后执行完整 `npm run staging:auth-e2e`，必须验证邮件真实送达、更新密码、旧会话撤销、旧密码失效、新密码登录、财务会话和退出。通过后才能：

1. 把 B-011 标记为 `DONE`；
2. 创建 PR 并等待远端 `quality-gate`；
3. 合并后执行 staging 回滚演练；
4. 继续后续发布闸门。
