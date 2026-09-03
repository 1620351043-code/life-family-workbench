# I-011 健康检查与告警 staging live 证据（2026-09-03）

> 本文件只记录可复现命令、聚合状态与边界，不包含数据库连接串、密钥、令牌、账单内容或家庭标识。

## 1. 仓库与发布点

- PR #32：`feat(i-011): add staging health check and alert contract`，提交 `18f5ad74299f0662c405c4a0cdd2e8e16e887dd3`
- PR #33：`fix(i-011): staging health check hardening`，提交 `50c503c95c42826a1ea2a77f6c3a36942aa75de2`
- staging Tag：`v0.1.0-rc.8`、`v0.1.0-rc.9`
- 服务器不可变发布目录：
  - `/srv/life/releases/v0.1.0-rc.8` = `18f5ad74299f0662c405c4a0cdd2e8e16e887dd3`
  - `/srv/life/releases/v0.1.0-rc.9` = `50c503c95c42826a1ea2a77f6c3a36942aa75de2`
- 当前 symlink：`/srv/life/releases/current -> /srv/life/releases/v0.1.0-rc.9`

## 2. 自动化验证

- `npm run api:typecheck`：PASS
- `npm run api:test`：PASS，46/46
- `npm run openapi:validate`：PASS，68 paths / 91 schemas
- `npm run migration:smoke`：PASS，241 statements / 31 protected tables / 32 policies
- `npm run health:contract`：PASS，30 checks
- `npm run web:typecheck`：PASS
- `npm run web:build`：PASS
- `git diff --check`：PASS
- CI `quality-gate`：PR #32/#33 均 PASS

## 3. staging 运行

- `life-staging.service`：active / enabled，指向 `v0.1.0-rc.9`
- `life-staging-health.timer`：active / enabled，`OnCalendar=*-*-* *:00/5:00`
- `life-staging-health.service`：one-shot，退出码 0
- 健康检查报告摘要：

```text
state=ok ok=true
api           ok
database      ok
queue         ok
ai            ok
object_storage ok
disk          ok
certificate   ok
```

- PostgreSQL 实测：`life_migrator` 无 `pg_read_all_settings`，`SHOW data_directory` 返回 permission denied；健康检查已通过 `LIFE_HEALTH_PG_DATA_DIR=/var/lib/postgresql/16/main` 完成磁盘巡检，不再误判数据库 critical。
- 对象存储：staging 本地目录 `access(R_OK|W_OK)` 通过；systemd 使用 `ReadWritePaths=/var/lib/life/staging-imports`，与导入/导出 worker 权限一致。
- 证书：`life.wbutterfly.cn` TLS 有效至 2026-11-27，剩余 84 天。

## 4. 实际发现并修复的问题

- 健康检查首次运行发现 20 个 `finance_export_job.status=failed`，全部为 `EXPORT_WORKER_FAILED`，错误为 `EACCES: permission denied, mkdir /var/lib/life/staging-imports/households/.../finance-exports/...`。
- 根因：目标家庭 `finance-exports` 目录被 `root` 持有，`life` worker 无法创建导出子目录。
- 处置：修正 `/var/lib/life/staging-imports` 下 root 归属为 `life:life`；对 20 个 EACCES 失败任务写入 `finance_export_retried` 审计后重排队；运行 export worker 后 `failed=0`，`ready` 从 130 增至 150。
- 配置缺口：监控角色缺少 `pg_read_all_settings`，原 `SHOW data_directory` 会让数据库检查整体 critical；已改为可选 `LIFE_HEALTH_PG_DATA_DIR`，未配置时只跳过该磁盘项。
- 配置缺口：健康检查 service 原为 `ReadOnlyPaths`，与“可读可写”语义冲突；已改 `ReadWritePaths`。

## 5. Timer 自动触发

- 首次观察：timer LAST `2026-09-03 16:20:18 CST`，NEXT `2026-09-03 16:25:22 CST`，此时健康报告仍为 critical，属于预期报警行为。
- 16:22:09（CST）手动启动 `life-staging-health.service` 一次：`Result=success`、`ExecMainStatus=0`，报告 `state=ok ok=true`。
- 16:25:22（CST）由 timer 自动触发同一 unit；journald 明确记录 `Starting life-staging-health.service` 与 `Finished ... Deactivated successfully`，退出码 0。
- 该次自动运行报告 `state=ok ok=true`，七项检查全部 `ok`；其中 PostgreSQL 15 migrations、对象存储可读可写、磁盘最差使用率 41.9%、证书剩余 84 天。
- 复核时 `systemctl list-timers`：LAST `Thu 2026-09-03 16:25:22 CST`，NEXT `Thu 2026-09-03 16:30:15 CST`。

## 6. 当前边界

- 告警 Webhook 未配置：systemd/journald 保留失败记录，当前仅做本地健康检查聚合。
- 生产 COS smoke、生产通知渠道和完整 staging 发布回滚全流程仍归 I-004 / I-016。
- I-011 只标记 `DONE / STAGING_LIVE`，不代表生产环境自动告警已闭环。
