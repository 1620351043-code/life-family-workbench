# I-012 加密 PostgreSQL 备份与 COS 异地备份收口证据（2026-09-03）

> 本文件记录 I-012 从基础设施准备到 staging 真实异地备份收口的全部证据；不包含数据库连接串、GPG 口令、COS SecretKey 或令牌。
> 最终状态：`I-012 = DONE / STAGING_VERIFIED`。

## 1. 腾讯云 CAM 权限收口

- 策略名：`LifeCOSBackupOnly`
- 策略 ID：`285059614`
- 当前版本：版本 2（`2026-09-03 20:19:32`）
- 资源范围：`qcs::cos:ap-guangzhou:uid/1413659045:butterfly-1413659045/life-backups/*`
- 已关联子账号：`life-butterfly`（UIN `100052527194`），关联时间 `2026-09-03 22:13:55`
- 子账号同时保留腾讯云预设的 `QcloudCollApiKeyManageAccess`。
- 权限原则：仅允许写入专用备份前缀，不开放 bucket 根、其他前缀、读取私有业务对象或对象删除。

## 2. 服务器与 COS 真实连通

- 服务器：`VM-0-12-ubuntu`（`139.199.70.242`）
- COS 桶：`butterfly-1413659045`
- 区域：`ap-guangzhou`
- rclone remote：`life-cos`
- 目标前缀：`life-cos:butterfly-1413659045/life-backups/staging/postgres`
- `rclone lsf` 对空前缀通过，无 403；证明最小权限 CAM 已真实生效。

## 3. staging 真实加密备份与远端校验

备份 ID：`staging-postgres-20260903T142025Z-VM-0-12-ubuntu`

- 本地归档目录：`/var/backups/life/staging/postgres/staging-postgres-20260903T142025Z-VM-0-12-ubuntu`
- 加密归档大小：`20,956,168` bytes
- 本地 `.gpg` 与 `.sha256`：通过 SHA-256 校验
- 远端 `.gpg` 与 `.sha256`：均存在
- `rclone copy --checksum`：通过
- `rclone check --checksum`：通过（2 个对象匹配，0 differences）
- `remote-verified.txt`：存在，`remote_verified_at=2026-09-03T14:20:28Z`

该文件由备份脚本在 `rclone check` 成功后生成，不属于上传对象；后续远端一致性复核应使用 `--include "*.gpg" --include "*.sha256"`。

## 4. 自动备份定时器

- `life-staging-postgres-backup.service`：最近手动运行 `success`
- `life-staging-postgres-backup.timer`：`enabled / active`
- 下一次自动运行：`Fri 2026-09-04 03:23:37 CST`
- 定时规则：每日 `03:20` 触发，`Persistent=true`，错过触发后补跑。

## 5. 真实验收中修复的部署缺口

本轮真实运行发现并修复以下问题，避免“本地契约通过但服务器无法运行”的假象：

1. 服务单元 `ExecStart` 从错误的 `/srv/life/current/...` 修正为 `/srv/life/releases/current/scripts/postgres_backup.sh`。
2. `ProtectHome=true` 会阻止 rclone 读取 `/root/.config/rclone/rclone.conf`；已将配置保存到 `/etc/life/rclone.conf`，并在服务单元中设置 `Environment=RCLONE_CONFIG=/etc/life/rclone.conf`。
3. `/etc/life/rclone.conf` 与 `/root/.config/rclone/rclone.conf` 均为 `0600 root:root`。

仓库侧已同步修正：

- `deploy/life-staging-postgres-backup.service.example`
- `deploy/staging-backup.env.example`
- `deploy/README.md`
- `scripts/postgres_backup_contract_test.mjs`（契约检查从 17 项扩展到 20 项，新增发布目录、rclone 配置路径和服务环境断言）

本地契约测试结果：

```text
npm run postgres:backup-contract
{"ok":true,"checks":20,"contract":"I-012 encrypted PostgreSQL backup"}
```

## 6. 密钥轮换

- 旧子账号密钥 `AKID7IH4...` 已在腾讯云控制台禁用并永久删除，无法恢复。
- 当前服务器 rclone 配置使用新子账号密钥，且新密钥是当前唯一启用凭证。
- 新密钥已用于真实 COS 访问验证；未写入 Git、证据文档或日志。

## 7. 复现清单（已完成）

1. `LifeCOSBackupOnly` 版本 2 设为当前版本；
2. 策略关联 `life-butterfly`；
3. `rclone lsf` 对空前缀无 403；
4. `systemctl start life-staging-postgres-backup.service` 成功；
5. 本地 `.gpg`、`.sha256`、COS 对象和 `remote-verified.txt` 全部存在；
6. `systemctl enable --now life-staging-postgres-backup.timer` 成功并复查下一次运行；
7. 子账号密钥轮换：新密钥写入服务器并验证 COS 后，删除公开旧密钥。

## 8. 剩余边界

- I-012 本身已闭环；首次 timer 自动触发将在次日 `03:23`，当前以手动服务成功 + timer 注册作为验收，后续自动运行结果应纳入日常巡检。
- I-013 真实恢复演练已完成。
- 监控告警、生产环境自动告警仍归 I-008/I-011/I-016 闸门，不因 I-012 完成而关闭。
- 腾讯云 COS 私有桶适配（业务对象存储）仍由 I-004 管理，与本次备份专用桶是不同工作项。
