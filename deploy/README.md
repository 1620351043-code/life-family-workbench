# Life 腾讯云轻量服务器发布收口

以下命令必须在目标服务器执行；本地没有数据库、COS 凭据时不能代替执行。

发布前必须阅读：[生产发布与回滚清单](./ROLLBACK.md)。该清单已建立 A-006 的回滚路径，但真实服务器备份恢复和回滚演练仍需在 staging 完成。

## 1. 数据库迁移

使用只用于迁移的管理员连接执行：

```bash
NODE_ENV=production DATABASE_URL='postgres://migration_role:***@127.0.0.1:5432/life' \
  LIFE_DB_MIGRATE_CONFIRM=YES npm run db:migrate
```

应用服务使用单独的 `life_app` 连接，必须是 `NOSUPERUSER NOBYPASSRLS`，不能复用迁移管理员连接。

## 2. 生产 preflight

将 `.env.example` 复制为服务器私有环境配置，填入真实数据库和 COS 值，然后执行：

```bash
set -a
. /etc/life/life.env
set +a
npm run production:preflight
```

该命令会检查应用数据库角色、核心表、`FORCE ROW LEVEL SECURITY`、认证函数，并在 COS 私有桶中执行一次上传、读取、HTTPS 签名 URL 和删除 smoke。`LIFE_COS_LIVE_SMOKE` 必须显式设为 `true`。

## 3. 服务与 worker

开发阶段可用以下入口验证；生产环境必须使用已验证的构建产物和 systemd/supervisor/timer 守护，不得把 `api:dev` 当作生产启动命令：

```bash
npm run api:dev
npm run finance:export-worker
npm run finance:retention-worker
```

当前导出 worker 和保留期 worker 是一次性批处理入口，应由 systemd timer 或等价调度周期性触发，并为导入、导出、保留期清理配置失败告警。API 对外只经 HTTPS 反向代理，不能直接暴露 3100 端口。

## 4. 发布验收

必须实际完成：登录 → `/api/me` → 财务首页 → 新增记账 → 导入账单 → 表头预览 → 关联审核 → 导出下载 → 退出；再验证跨家庭 Cookie、儿童权限、COS 对象路径、备份恢复和回滚。
