# I-016 Staging 全流程 preflight 证据（2026-09-03）

> 本文件只记录当前 staging 可执行、不依赖邮件交付的 preflight 结果；完整 B-011 黑盒 E2E 仍等待真实邮件通道。

## 1. 执行环境

- 服务器：腾讯云轻量服务器 `root@139.199.70.242`
- 发布点：`/srv/life/releases/v0.1.0-rc.9`
- 配置：`/etc/life/staging.env`
- 命令：`npm run staging:auth-preflight`
- 命令在服务器上以 staging 环境执行，未写入任何密钥、邮箱或家庭数据。

## 2. 结果

```json
{
  "ok": true,
  "contract": "B-011 staging auth preflight",
  "database_role": "life_app",
  "postgres_version": "16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)",
  "tables_checked": 6,
  "functions_checked": 4,
  "security_definer_owners": ["life_migrator"],
  "public_app_https": true,
  "password_reset_delivery_https": true,
  "secure_cookie": true,
  "cos_scope": "explicitly_not_part_of_B-011"
}
```

## 3. 结论与边界

- 前置检查通过：应用角色非 superuser/BYPASSRLS、核心认证表与安全函数、HTTPS 公共地址、HTTPS 邮件端点、Secure Cookie 均符合 staging 契约。
- 真实密码重置邮件送达、测试邮箱读取、旧会话撤销和移动端全流程仍阻塞于 `notify.wbutterfly.cn` SES 审核与专用测试邮箱接口。
- COS 私有桶、异地备份和完整 I-016 发布路径仍未关闭，I-016 保持 `PARTIAL`。
