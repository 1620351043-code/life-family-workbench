# Life B-011 正式身份 Staging 验收准备与阻塞记录 v0.1

日期：2026-08-28

状态：`PARTIAL / LIVE_BLOCKED`

适用范围：原生 PostgreSQL、HTTPS、正式 Cookie、真实密码重置交付的移动端黑盒 E2E

## 1. 当前结论

B-011 的仓库侧验收能力已经补齐，但目标环境实证尚未完成，因此不能标记 `DONE`。当前唯一优先安全阻塞是目标轻量服务器的 SSH 主机指纹与本机历史记录不一致；在腾讯云控制台完成指纹核验前，不允许绕过校验、修改 `known_hosts` 或部署代码。

腾讯云 COS 私有桶不属于本切片。staging 继续使用隔离的本地对象目录，只用于身份链路验收；这不关闭 `E-119/I-004`。

## 2. 已完成的仓库能力

- 新增 `LIFE_DEPLOYMENT_ENV=staging` 安全环境：
  - staging 和 production 都强制 Secure Cookie、正式会话和 HTTPS 密码重置地址；
  - 只信任本机 Caddy 反向代理提供的客户端地址，避免外部伪造转发头；
  - 只有 production 强制腾讯云 COS，避免把此前明确跳过的私有桶适配混入 B-011。
- 新增 `npm run staging:auth-preflight`：
  - 验证真实 PostgreSQL 版本；
  - 验证应用角色为 `NOSUPERUSER NOBYPASSRLS`；
  - 验证认证、会话、密码重置和数据权利表/函数；
  - 验证 HTTPS 公开地址、HTTPS 交付 Endpoint 和 Secure Cookie 配置。
- 新增 `npm run staging:auth-e2e` 黑盒验收：
  - 不读取数据库中的原始令牌；
  - 不使用 `/__e2e` 调试接口；
  - 只通过受 Bearer 保护的 HTTPS 测试邮箱读取接口取得真实送达的重置链接；
  - 验证 HTTP→HTTPS、HSTS、注册、第二会话、`/api/me`、Secure/HttpOnly/SameSite Cookie、重置邮件、旧会话撤销、旧密码失效、新密码登录、财务会话和退出；
  - 报告不落盘密码、Cookie 值或重置链接。
- 新增 Caddy、systemd 和 staging 私有环境模板，API 只监听 `127.0.0.1:3100`。
- CI 新增 `staging:auth-contract`，防止 HTTPS、邮箱响应和 Cookie 契约漂移。

## 3. 本地验证证据

| 检查 | 结果 |
|---|---|
| `npm run staging:auth-contract` | `PASS`，8 项黑盒契约 |
| `npm run api:typecheck` | `PASS` |
| `npm run api:test` | `PASS`，4 文件、22/22 |
| `npm run web:typecheck` | `PASS` |
| `npm run web:build` | `PASS` |
| `git diff --check` | `PASS` |

这些结果只证明仓库准备就绪，不代替目标 PostgreSQL、可信证书和真实邮件送达。

## 4. 目标环境只读检查

- 目标服务器 TCP 22、80、443 当前可达；
- HTTP 由 Caddy 响应，但 IP 直连返回 404，说明需要核对真实站点域名和 Caddy 配置；
- HTTPS 通过 IP 直连因缺少正确 SNI 无法完成握手，不能据此判断证书状态；
- SSH 返回的 ED25519 指纹与本机历史记录不一致；
- 浏览器和桌面控制台自动连接均超时，未取得腾讯云控制台内的可信指纹证据；
- 当前机器没有可用的原生 PostgreSQL 或容器运行时，不能用本地 PGlite 结果替代目标验证。

## 5. 恢复执行的安全闸门

用户需要在腾讯云控制台打开该轻量服务器的实例终端，并执行：

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

把控制台显示的 SHA256 指纹与本轮 SSH 返回的指纹逐字核对。确认一致后，才执行以下后续步骤：

1. 更新本机该 IP 的可信主机记录；
2. 只读检查服务器系统、磁盘、Caddy、DNS、PostgreSQL 和现有目录；
3. 建立独立 staging 数据库与应用角色；
4. 发布构建产物和私有环境文件；
5. 执行 `staging:auth-preflight`；
6. 配置专用测试邮箱读取接口并执行 `staging:auth-e2e`；
7. 全部实证通过后，才把 B-011 标记为 `DONE` 并进入 PR/CI/合并收口。
