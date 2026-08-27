# Life B-006 密码重置垂直切片卡 v0.1

更新时间：2026-08-27

## 1. 目标与边界

本切片把登录页原有的“尚未开放”说明升级为可运行的密码重置闭环：申请链接、邮箱同结果反馈、单次令牌、新密码确认、旧会话撤销和重新登录。

本切片关闭 `B-006` 的仓库级 Definition of Done；目标腾讯云服务器的真实邮件交付、原生 PostgreSQL 与 HTTPS Cookie 仍由 `B-011` 和部署闸门验收。

## 2. 用户流程

| 步骤 | 页面行为 | 安全反馈 |
|---|---|---|
| 忘记密码 | 从登录页进入邮箱申请页 | 原上下文内完成，不打开伪页面 |
| 提交邮箱 | 调用重置申请接口 | 邮箱存在与否均返回相同 202 和同一文案 |
| 等待邮件 | 展示“请检查邮箱” | 不显示账号是否存在，不回传令牌 |
| 打开链接 | 从 `reset_token` 查询参数进入新密码页 | 链接 30 分钟有效且只能使用一次 |
| 输入新密码 | 两次输入、至少 8 位、最多 128 位 | 错误保留在表单，不清空有效输入 |
| 完成重置 | 展示完成页 | 旧密码失效，全部已有会话撤销，当前 Cookie 清除 |
| 重新登录 | 使用新密码进入原唯一家庭 | 不创建新家庭，不改变家庭归属 |

## 3. 数据库与令牌契约

- 新增 `password_reset_token` 表；原始令牌不写入数据库，只保存 SHA-256 摘要。
- 每个用户最多存在一个未使用令牌；重复申请会原子替换摘要，使旧链接立即失效。
- 令牌默认 30 分钟过期。
- 移动端首次读取链接令牌后立即清理地址栏查询参数，减少浏览器历史与 Referer 暴露面。
- 成功消费后设置 `used_at`，同一令牌不能二次使用。
- 密码更新、令牌消费、其余令牌失效和全部 `user_session` 撤销在窄权限数据库函数中原子完成。
- 申请和确认均受基础限流保护；生产多实例共享限流仍属于 `G-004` 未完成部分。

迁移：`db/migrations/0011_password_reset.sql`

## 4. API 契约

### `POST /api/auth/password-reset/request`

- 输入：`email`
- 成功：202
- 对存在和不存在的邮箱返回完全相同的响应。
- 达到频率阈值返回 429 和 `Retry-After`。
- 交付适配器未配置时统一返回 503。

### `POST /api/auth/password-reset/confirm`

- 输入：`token`、`password`
- 成功：200，清除当前 `life_session` Cookie。
- 无效、已使用或过期令牌返回同一 400 文案。
- 成功后所有旧会话与旧密码立即失效。

OpenAPI 已更新为 51 paths、72 schemas。

## 5. 邮件交付边界

`HttpPasswordResetDelivery` 通过服务器私有配置调用外部交付 Endpoint：

- `LIFE_PUBLIC_APP_URL`
- `LIFE_PASSWORD_RESET_DELIVERY_ENDPOINT`
- `LIFE_PASSWORD_RESET_DELIVERY_BEARER_TOKEN`（可选）

Endpoint 接收 `recipient`、`reset_url` 和 `expires_at`。Bearer 凭据只存在服务器环境，不进入移动端和数据库。生产 Endpoint 调用失败会记录结构化服务错误，同时客户端仍收到通用结果，避免通过故障差异枚举账号。

当前自动化验证了 Endpoint 请求体、重置 URL、有效期、Bearer 鉴权和非 2xx 失败；真实邮件送达仍需目标环境 live smoke。

## 6. UI/UX 验收

- 延续淡粉淡紫环境、近白实体内容卡和单一主动作。
- 申请、已发送、设置密码、完成四种状态均有独立标题和即时反馈。
- 430×932、390×844、320×900 三档无横向溢出。
- 三档所有可见按钮和输入控件命中区不小于 44pt。
- 更新完成后保持明确匿名态，不执行多余 `/api/me`，避免表单重挂载和交互抖动。
- 完成重置后旧密码登录失败，新密码可进入原家庭。

截图证据位于：

- `output/playwright/auth-vertical/reset-requested-430x932.png`
- `output/playwright/auth-vertical/reset-layout-430x932.png`
- `output/playwright/auth-vertical/reset-layout-390x844.png`
- `output/playwright/auth-vertical/reset-layout-320x900.png`
- `output/playwright/auth-vertical/reset-complete-430x932.png`

## 7. 自动化证据

- API：3 个测试文件，17/17 通过。
- 密码重置集成：未知邮箱同响应、摘要存储、旧链接失效、弱密码拒绝、单次使用、过期、旧密码失效、全部会话撤销。
- 交付适配器：正确请求与非 2xx 失败测试。
- OpenAPI：51 paths、72 schemas。
- 迁移烟测：177 statements、27 protected tables、28 policies。
- 移动端 E2E：注册家庭 → 退出 → 申请重置 → 链接确认 → 旧密码失败 → 新密码登录 → 原家庭身份 → 退出。
- 财务兼容回归：430/390/320 全部通过。

## 8. 结论

`B-006`：`DONE`。

仍未关闭：

- `B-011` 目标 PostgreSQL + HTTPS + 真实邮件交付 E2E。
- `G-004` 多实例共享限流及其他敏感接口限流。
- `G-005` 泄漏口令库与完整密码策略。
