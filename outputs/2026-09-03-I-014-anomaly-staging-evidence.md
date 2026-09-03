# I-014 Staging 异常场景演练证据（2026-09-03）

> 结论：staging 公开 HTTPS API 的隔离、超大账单、导出队列 API 探测、AI 降级场景已通过；数据库直连的队列 worker 与慢查询基线尚未完成。

## 运行范围

- 环境：`https://life.wbutterfly.cn`（staging，正式身份 HTTPS）
- 数据：仅使用合成测试家庭与合成账单，不包含用户真实账单、密码、令牌或 API 密钥。
- 报告：`/tmp/life-anomaly-api-full-1788417456/report.json`
- 运行时间：2026-09-03 06:37:36 ~ 06:38:49 UTC

## 场景结果

### isolation
- 家庭数：3
- 并发请求：3
- 跨家庭事务读取隔离检查：6 次均返回 404
- 每家账户、分类、流水与汇总均可见，未发现跨家庭泄露

### large_import
- 超大账单大小：12,583,217 字节（约 12 MB）
- 解析状态：`succeeded`
- 解析行数：37,294
- 超过 50MB 拒绝：HTTP 400，未创建对象
- 原始账单删除接口正常返回

### queue（API 探测部分）
- 创建导出任务：10
- 3 秒后状态：均为 `queued`
- 由于当前未提供服务器数据库直连，未执行真实 DB 队列堆积与 worker 处理

### ai
- 配置 Endpoint：`127.0.0.1:9`（主动超时/连接失败）
- 连接测试：503
- AI 汇总失败状态：503
- 核心 `/healthz`：`ok`
- 核心财务总览：正常返回
- 禁用 AI 后：确定性 AI 汇总可用（`deterministic_after_disabled=true`）

## 剩余项

- `slow`：30,000 行账本种子 + `EXPLAIN (ANALYZE, BUFFERS)` + API 延迟基线
- `queue` 数据库直连：真实导出任务堆积、批量 worker 与样本状态
- 服务器侧完成上述两项前，I-014 只能标记为 `PARTIAL / STAGING_API_DONE_DB_PENDING`

## 脚本修复

- `staging_anomaly_drill.mjs`：
  - `main()` 中家庭数组改为 `let`，修复“Assignment to constant variable”
  - 未知下钻过滤条件改用随机 UUID，避免非法 UUID 触发 500 而非预期 404
