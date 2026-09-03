# I-002 域名、HTTPS 与证书连接证据（2026-09-03）

> 状态：`I-002 = DONE / STAGING_LIVE`。
> 本文件记录 `life.wbutterfly.cn` 与腾讯云服务器完成连接并进入 staging 初步上线状态的证据；不包含数据库连接串、COS 密钥、SES Bearer Token 或其他私有凭据。

## 1. DNS 与入口

- 域名：`life.wbutterfly.cn`
- A 记录：`139.199.70.242`（腾讯云轻量服务器 `VM-0-12-ubuntu`）
- `http://life.wbutterfly.cn/` 返回 `308 Permanent Redirect`
- `https://life.wbutterfly.cn/` 返回 `HTTP/2 200`
- 响应包含 `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- 响应包含 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy`、`Permissions-Policy` 与 CSP
- 根页面返回正式移动端入口：`Life 家庭生活工作台`

## 2. Caddy 反向代理配置

服务器 `/etc/caddy/Caddyfile` 已通过 `import /etc/caddy/life-staging.Caddyfile` 接入 Life 站点，实际配置：

```text
life.wbutterfly.cn {
  encode zstd gzip
  handle /api/* { reverse_proxy 127.0.0.1:3100 }
  handle /healthz { reverse_proxy 127.0.0.1:3100 }
  handle {
    root * /srv/life/releases/current/dist/mobile
    try_files {path} /index.html
    file_server
    header { ... }
  }
}
```

验证结果：

- `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`：`Valid configuration`
- Caddy 自动 TLS 已启用，管理域名包含 `life.wbutterfly.cn`
- 监听端口：`*:80`、`*:443`；API 仅监听 `127.0.0.1:3100`，未暴露公网直连端口
- 安全头与仓库模板保持一致

## 3. 应用与 API 连通

- `GET https://life.wbutterfly.cn/healthz`
  - 返回 `{"status":"ok","service":"life-api"}`
- `GET https://life.wbutterfly.cn/api/me`
  - 返回 `UNAUTHORIZED`，符合未登录会话预期
- 服务器环境：
  - `LIFE_PUBLIC_APP_URL=https://life.wbutterfly.cn/`
  - `LIFE_SESSION_COOKIE_SECURE=true`
  - `NODE_ENV=staging`
  - `LIFE_DEPLOYMENT_ENV=staging`
- staging API 由 `life-staging.service` 守护，当前 `active`

## 4. HTTPS 证书与自动续期

- Caddy 自动 TLS 证书管理已启用，无需手动续期
- 最近健康检查：
  - 证书状态：`ok`
  - 剩余天数：84 天
  - 有效期至：`Nov 27 00:03:03 2026 GMT`
- 健康检查阈值：
  - 警告阈值：14 天
  - 严重阈值：7 天
- `life-staging-health.timer` 已启用，每 5 分钟执行；最近一次 service 运行成功，各级检查项均为 `ok`

## 5. 当前边界

- 当前域名指向 staging 环境，已具备正式公开访问、HTTPS 和安全响应头的初步上线状态。
- 该状态不代表生产发布完成：业务 COS 私有桶（I-004）、真实密码重置邮件（B-011）、生产监控告警和生产环境全路径演练仍未关闭。
- 生产发布必须使用新的稳定 Tag 和独立 production 配置，不能直接复用 staging 的发布记录。
