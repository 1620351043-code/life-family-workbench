# I-012 远端备份基础设施准备证据（2026-09-03）

> 本文件记录已完成的服务器基础设施准备与真实阻塞边界；不包含数据库连接串、GPG 口令、COS 密钥或令牌。

## 1. 现状

- 已在腾讯云 staging 服务器完成一次本地加密 PostgreSQL 备份：
  - `/var/backups/life/staging/postgres/staging-postgres-20260903T020356Z-VM-0-12-ubuntu`
  - 原清单记录：本地加密、SHA-256、AES-256 GPG 解密、解包白名单与 `pg_restore --list` 均通过。
- 当前仍未配置任何 rclone 远端，服务器上没有 COS 凭据或 bucket/remote 配置，因此 `remote-verified.txt` 不存在。
- 本轮不把“本地成功”冒充“异地备份成功”，I-012 保持 `LOCAL_DONE / REMOTE_BLOCKED`。

## 2. 本轮服务器准备

- 安装 rclone：`rclone v1.60.1-DEV`（Ubuntu 24.04 仓库版本）。
- 安装 systemd unit：
  - `/etc/systemd/system/life-staging-postgres-backup.service`
  - `/etc/systemd/system/life-staging-postgres-backup.timer`
- 复制私有环境模板：
  - `/etc/life/staging-backup.env`，权限 `0600 root:root`
  - 明确使用 `LIFE_BACKUP_RCLONE_REMOTE=life-cos:life-backups/staging/postgres`，目标必须是专用 bucket/prefix。
- 确认备份口令文件：
  - `/etc/life/staging-backup.gpg-passphrase`，权限 `0600`
  - 只用于 GPG 对称加密，未写入 Git、日志或归档。
- 创建 GPG 目录：
  - `/var/lib/life/staging-backup-gnupg`，`root:root 0700`
- `systemctl daemon-reload` 完成；`life-staging-postgres-backup.timer` 当前保持 `disabled`。
- 原因：远端未配置前启用 timer 会每天定时失败并污染告警，必须等 COS/rclone 真实可用后再启用。

## 3. 阻塞与下一步

- 需要真实腾讯云 COS 信息：
  - 专用 bucket 名称与 region；
  - 最小权限的 SecretId / SecretKey（或等价 CAM 临时凭据）；
  - 确认 bucket 为私有 ACL，并只允许 `life-backups/staging/postgres/` 前缀。
- 拿到凭据后执行：
  1. 在服务器 root 私有配置中创建 `life-cos` rclone remote（不进入 Git）；
  2. 先对空专用前缀执行一次 `rclone lsd/ls` 确认路径隔离；
  3. 手动运行 `life-staging-postgres-backup.service`；
  4. 校验加密归档、`.sha256` 与 `remote-verified.txt`；
  5. 再启用 timer，并复查下一次自动运行。
- 未获得上述凭据前，禁止使用本地目录、临时测试桶或假远端代替验收。
