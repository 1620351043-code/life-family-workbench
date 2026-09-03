# I-014 Staging 异常场景演练最终证据（2026-09-03）

> 结论：staging 公开 HTTPS API + 服务器本地 PostgreSQL 的隔离、超大账单、导出队列 worker、AI 降级、慢查询五项真实演练全部通过，I-014 收口。

## 运行范围

- 环境：staging `https://life.wbutterfly.cn` + 服务器本地 PostgreSQL 16.15
- 数据：仅使用合成测试家庭与合成账单，不包含用户真实账单、密码、令牌或 API 密钥。
- 报告：服务器 `/tmp/life-anomaly-db-final2-1788418616/report.json`
- 运行时间：2026-09-03 06:56:56 ~ 06:58:55 UTC

## 场景结果

### isolation
- 家庭数：3；并发请求：3；跨家庭事务读取隔离检查：6 次均返回 404
- 每家账户、分类、流水与汇总均可见，未发现跨家庭泄露

### large_import
- 超大账单大小：12,583,217 字节（约 12 MB）；解析状态：`succeeded`；解析行数：37,294
- 超过 50MB 拒绝：HTTP 400，未创建对象；原始账单删除接口正常返回

### queue
- 创建导出任务：10（API 探测）；直接数据库种子：60 条导出任务；worker batch limit：50
- worker 处理：扫描 50、处理 50；抽样任务第 1、30、60 条均为 `ready`，返回 job id 正常

### ai
- 配置 Endpoint：`127.0.0.1:9`；连接测试：503；AI 汇总失败状态：503
- 核心 `/healthz`：`ok`；核心财务总览：正常返回；禁用 AI 后确定性 AI 汇总可用

### slow
- 账本种子：30,000 行；种子耗时：1,890 ms；`EXPLAIN (ANALYZE, BUFFERS)` 耗时：32 ms
- API 总览耗时：1,672 ms；`ledger_transaction` 30,002；`ledger_entry` 30,002

## 脚本修复

- `staging_anomaly_drill.mjs`：
  - `main()` 家庭数组改为 `let`，修复“Assignment to constant variable”
  - 未知下钻过滤条件改用随机 UUID，避免非法 UUID 触发 500
  - 补充 `const execFileAsync = promisify(execFile);`，修复队列 worker 阶段 `execFileAsync is not defined`
- 服务器已安装本机 SSH 公钥，后续连接不再需要微信扫码；`/etc/hosts` 已补充公网域名到公网 IP 的映射，保证服务器本机调用 staging HTTPS API。
