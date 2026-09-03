# Life staging 财务 worker 真实调度验证证据（2026-09-03）

> 本文只记录可验证结果与边界，不包含密码、数据库连接串、密钥、账单内容或测试对象内容。

## 1. 版本与发布点

- 仓库 main：`888d568fb44b8107215e11f5fd55c3a72965facc`
- 远程 Tag：
  - `v0.1.0-rc.4` -> `20e58e70b1736eea082bfe1dca09ec1f72fd2b15`
  - `v0.1.0-rc.5` -> `888d568fb44b8107215e11f5fd55c3a72965facc`
- 服务器不可变发布目录：`/srv/life/releases/v0.1.0-rc.5`
- 当前 symlink：`/srv/life/releases/current -> /srv/life/releases/v0.1.0-rc.5`
- 服务器 worker 工作树：`/tmp/life-release-current`，`git rev-parse HEAD` 与 main 一致。
- 相关 PR：#23（调度与本地对象存储解耦）、#24（修复 export timer 日历表达式）。

## 2. systemd 运行状态

- `life-finance-import.timer`：active，每分钟触发。
- `life-finance-export.timer`：active，每 5 分钟触发。
- `life-finance-retention.timer`：active，每日 04:30 触发。
- `life-staging.service`、`postgresql.service`：active。
- `systemd-analyze verify`：新增 6 个 worker unit 无 `bad unit file setting`。

## 3. 解析 worker 真实验收

使用隔离测试家庭与确定性 UUID，不包含真实账单。测试对象包含 2 行合成的微信 CSV。

- 启动前：import job 为 queued，batch 为 uploaded。
- 触发：`systemctl start life-finance-import.service`。
- Journal 证据（摘要）：

```text
{"ok":true,"result":[
  {"household_id":"4c7ba085-...","scanned":0,"processed":0,"recovered":0},
  {"household_id":"a1111111-1111-1111-1111-111111111111","scanned":1,"processed":1,"recovered":0}
]}
```

- 完成后状态：
  - `finance_import_job.status = succeeded`，attempts = 1。
  - `import_batch.status = header_detected`，`detected_header_row = 4`，`data_start_row = 5`。
  - `import_row`：2 行 parsed。
  - `source_record`：2 行，方向 expense / income，金额 120.0000 / 200.0000。
  - 原始对象在保留期内仍存在。

## 4. 导出 worker 真实验收

- 触发：`systemctl start life-finance-export.service`。
- Journal 证据（摘要）：

```text
{"ok":true,"result":[
  {"household_id":"4c7ba085-...","scanned":0,"processed":0},
  {"household_id":"a1111111-...","scanned":1,"processed":1}
]}
```

- 完成后状态：`finance_export_job.status = ready`，`row_count = 1`，生成
  `households/.../finance-exports/.../ledger.csv`，下载过期时间 1 小时后。
- 导出文件实际存在，后续 retention 过期后删除。

## 5. 保留期 worker 真实验收

构造已过期测试对象：1 个过期原始账单、1 个过期导出文件、1 个过期 AI 记忆对象；同时保留 1 个未到期原始账单和正式源记录。

- 触发：`systemctl start life-finance-retention.service`。
- Journal 证据（摘要）：

```text
{"ok":true,"result":[
  {"household_id":"4c7ba085-...","scanned":0,"deleted":0,"failed":0,
   "exports_expired":0,"exports_failed":0,"ai_memory_deleted":0,"ai_memory_failed":0},
  {"household_id":"a1111111-...","scanned":1,"deleted":1,"failed":0,
   "exports_expired":1,"exports_failed":0,"ai_memory_deleted":1,"ai_memory_failed":0}
]}
```

- 完成后状态：
  - 过期批次：`raw_delete_status = deleted`，`raw_delete_attempts = 1`，header_preview 清空。
  - 过期导出：`status = expired`，`object_key = NULL`。
  - 过期 AI 记忆：`status = deleted`，记录删除时间。
  - 未到期批次：原始文件保留，`raw_delete_status = pending`。
  - 正式源记录：保留原始对象引用，未因过期清理而丢失。

## 6. 部署缺口修复

验证中实际发现并修复两个 staging 运行时缺口：

1. Python worker 缺少 `pandas` / `openpyxl`：  
   `apt-get install -y python3-pandas python3-openpyxl`，解析 worker 随后成功。
2. 本地对象存储子目录由 root 持有，`life` 服务无法创建导出目录：  
   `chown -R life:life /var/lib/life/staging-imports`，并归一化目录可读写权限，导出 worker 随后成功。

## 7. 边界与结论

- 本轮验证的是非生产（NODE_ENV=staging）本地对象存储闭环；腾讯云 COS 私有桶仍由 I-004 负责。
- 验证数据为 worker-drill 合成数据，完成后仅清理该测试家庭及测试对象，未扩大删除。
- 正式 `.xls` 账单在 Linux worker 上仍依赖 LibreOffice/soffice 或等效解析通路，单独跟踪；本轮 CSV 真实调度已闭环。
- I-007 / I-008 / I-009 至少达到 `DONE / STAGING`；生产正式环境与告警链路仍待 I-011/I-016 收口。
