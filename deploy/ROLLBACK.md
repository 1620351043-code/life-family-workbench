# Life A-006：生产发布与回滚清单

版本：v0.1  
适用范围：移动端 PWA 静态资源、API、PostgreSQL 迁移、账单解析/导出/保留期 worker、Nginx/systemd、腾讯云 COS  发行状态：清单已建立；真实服务器回滚演练仍未完成

本文件是发布操作的控制清单，不等于已经完成腾讯云生产演练。任何带有 `<...>` 的值必须在发布单中替换为真实值；不要把密码、数据库连接串、COS SecretId/SecretKey 写入 Git。

## 1. 回滚原则

1. 回滚的目标是停止错误版本继续产生影响，并恢复到最近一个可验证版本；不是删除已经发生的财务事实。
2. 稳定 Tag 和发布产物不可移动、复用或删除。回滚必须指向已有的上一稳定 Tag/commit。
3. 数据库迁移按前向兼容处理。已执行的迁移文件不可修改，不能用 `git revert` 当作数据库回滚。
4. 任何财务数据、导入关联、审计记录和 AI 操作都保留；禁止为“回滚界面”直接删除账单或账本数据。
5. 发现跨家庭读取、权限绕过、账务重复入账、原始文件误删或迁移破坏数据时，立即冻结导入、导出和清理 worker，优先保护数据。
6. 回滚完成前，不能重新开放写入流量；回滚后必须执行健康检查、租户隔离检查和最小财务 smoke。

## 2. 发布单与回滚点

每次 staging/production 发布必须先记录以下信息，并将发布单与 Tag、PR、CI 运行和备份建立关联：

| 字段 | 必填内容 |
|---|---|
| 发布环境 | `staging` / `production` |
| 当前版本 | Tag、commit SHA、PR、quality-gate run |
| 上一可回滚版本 | 上一稳定 Tag、commit SHA、构建产物位置 |
| 数据库状态 | 已执行 migration 文件、`life_schema_migration` 最新记录、备份 ID/时间 |
| 对象存储状态 | COS bucket、原始账单保留状态、导出对象状态 |
| worker 状态 | 解析、导出、保留期任务是否暂停/排空、待处理数量、失败数量 |
| 操作人和时间 | 发布人、复核人、开始/结束时间、变更原因 |
| 回滚决定 | 触发指标、批准人、回滚或继续观察的结论 |

最低回滚点要求：

- 当前 Tag 和上一稳定 Tag 都能通过 `git rev-list -n 1 <tag>` 找到；
- 上一版本的前端构建产物、API 运行包和 worker 运行包已保存为不可变目录；
- 回滚前已取得并确认可读的 PostgreSQL 备份；
- 回滚前没有正在执行的生产迁移；
- 原始账单对象、来源记录、统一账本和审计日志均不能依靠“回滚代码”恢复，必须有数据库/COS 备份路径；
- 发布单中记录当前队列和数据库 migration 状态。

## 3. 何时触发回滚

满足任一条件即可进入回滚评估；P0 安全或数据问题直接冻结写入并回滚：

- `/healthz` 连续失败、API 5xx 或登录失败超过发布阈值；
- 发现跨家庭数据、AI 连接/记忆、Cookie 或权限越权；
- 新版本导致同一导入批次重复入账、父子结算关系错误或账单金额变化；
- 数据库迁移失败、锁等待异常、关键查询持续超时或 RLS 验证失败；
- 解析、导出或保留期任务连续失败并堆积，且无法在观察窗口内恢复；
- 原始账单、导出文件或 AI 记忆出现非预期删除；
- 关键 P0 验收路径无法完成：登录 → 财务首页 → 新增记账 → 导入/关联审核 → 导出。

## 4. 发布组件回滚矩阵

| 组件 | 首要动作 | 回滚动作 | 数据注意事项 | 放行条件 |
|---|---|---|---|---|
| PWA 静态资源 | 停止发布、保留当前目录 | 将静态资源软链接切回上一版本不可变目录；按实际 CDN 策略刷新缓存 | 不清理旧资源；确认 HTML、JS、CSS 和 manifest 同版本 | `/healthz`、页面加载、登录入口和财务首页通过 |
| API | 停止新版本写流量并优雅排空 | 启动上一版本 API；仅当数据库 schema 对上一版本向后兼容时恢复写入 | 不能把应用回滚误当账务回滚；保留新版本产生的审计和账本数据 | 正式 Cookie、`/api/me`、权限和最小财务 smoke 通过 |
| PostgreSQL 迁移 | 停止 API/worker 发布动作，记录错误 | 优先使用兼容旧代码运行；不能直接删除已应用 migration。破坏性变更只能走经过演练的新前向迁移或隔离环境恢复 | 不在生产执行未经演练的 `DROP/TRUNCATE`；备份恢复必须先到隔离库校验 | migration 记录、RLS、家庭隔离和账本计数一致 |
| 解析 worker | 暂停调度，保留原始对象和批次 | 使用与当前 schema 兼容的上一版本 worker；对可重试批次按幂等键重跑 | 不手工改导入状态绕过审计；保留 `import_row/source_record` 和关联候选 | 无重复入账、失败可重试、批次状态可解释 |
| 导出 worker | 停止新任务领取，保留已生成对象 | 恢复上一版本 worker 或保持队列暂停；对失败任务按幂等策略重试 | 不删除已生成导出对象；过期清理由保留期 worker 处理 | 下载链接、家庭边界、过期时间和审计通过 |
| 保留期 worker | 立即停用 timer/调度 | 先恢复调度但不追补删除；确认删除范围后再恢复 | 原始账单和 AI 记忆删除是不可逆业务动作；只能从备份/COS 版本恢复 | 删除状态、审计、保留期和告警一致 |
| Nginx/systemd | 保留当前配置副本 | 切换上一版本静态目录和服务环境；reload 前检查配置 | 不直接覆盖唯一配置；保留发布前后配置哈希 | HTTPS、Cookie Secure、上传限制和代理超时通过 |
| COS | 停止清理与上传变更 | 恢复应用指针/对象版本；不要用删除对象来“回滚” | 私有桶、对象路径和签名下载必须保持家庭隔离 | 上传、读取、签名、删除策略和生命周期符合发布单 |

## 5. 标准回滚顺序

### 5.1 应用兼容回滚（没有数据库破坏性变更）

1. 记录事件、当前版本、上一版本、队列和数据库状态。
2. 关闭新版本 API 的写入入口；冻结导入、导出和保留期调度。
3. 保留当前日志、构建产物、配置哈希和失败请求样本。
4. 切换 API 到上一稳定版本；切换 PWA 静态目录到同一版本。
5. 先启动 API，执行 `/healthz`、登录、`/api/me` 和家庭隔离检查。
6. 确认 schema 向后兼容后，再恢复解析/导出 worker；保留期 worker 最后恢复。
7. 完成财务最小 smoke：新增记账、趋势下钻、导入批次状态、关联候选、导出任务和退出。
8. 观察错误率、队列积压、重复入账、COS 操作和审计日志至少一个业务观察窗口。
9. 发布单记录结果；若仍异常，停止自动重试并升级到数据库/安全负责人。

### 5.2 迁移失败

当前 `scripts/migrate_postgres.ts` 对每个 migration 使用事务，并通过 `life:migrations` advisory lock 串行执行。失败时必须：

1. 保留完整错误日志，不重复盲目执行。
2. 确认当前事务已回滚；确认失败文件没有写入 `life_schema_migration`。
3. 确认 advisory lock 随迁移连接释放；不要直接删 migration 记录。
4. 保持旧 API/worker 停止，评估是否需要修复后重新发布。
5. 若 migration 已成功提交但应用不兼容，优先恢复兼容代码；只有经 DBA 审批、备份和隔离演练后，才可执行数据恢复或新的前向修复迁移。

严禁：修改已经进入生产的历史 SQL、直接 `DELETE FROM life_schema_migration`、在生产执行未经演练的 down migration、用旧代码强行写入不兼容 schema。

### 5.3 worker 异常或队列堆积

1. 停止对应调度器；解析、导出、保留期 worker 分开处理，不能全部一起重启。
2. 记录任务状态、失败原因、attempt、批次 ID、家庭 ID 脱敏摘要和对象 key 摘要。
3. 解析任务先检查批次状态、版本和唯一约束，再决定重跑；不重复产生正式账本。
4. 导出任务可在数据不变时重试；不删除已有导出对象。
5. 保留期任务默认暂停；任何已删除原始对象或 AI 记忆只能通过备份/COS 版本恢复，不能依靠重新运行 worker 撤销。
6. 恢复调度后分批放量，观察失败率和租户边界，再恢复正常批量。

## 6. 服务器操作命令模板

以下是发布单中的命令模板，不代表当前腾讯云服务器已经配置了这些 unit 名称。首次部署前必须把 unit、目录和域名替换为实测值。

```bash
# 载入服务器私有配置；不要提交或打印该文件
set -a
. /etc/life/life.env
set +a

# 发布前确认版本和健康状态
git rev-list -n 1 <CURRENT_TAG>
git rev-list -n 1 <PREVIOUS_TAG>
curl -fsS https://<DOMAIN>/healthz

# 先停止调度和写入相关进程；实际 unit 名称以服务器清单为准
sudo systemctl stop life-finance-retention.timer
sudo systemctl stop life-finance-export.timer
sudo systemctl stop life-finance-import.service
sudo systemctl stop life-api.service

# 切回上一版本不可变目录（示例）
sudo ln -sfn /opt/life/releases/<PREVIOUS_TAG> /opt/life/current
sudo systemctl daemon-reload
sudo systemctl start life-api.service
sudo systemctl reload nginx

# API 和隔离 smoke
curl -fsS https://<DOMAIN>/healthz
npm run production:preflight

# 确认 migration 记录；DATABASE_URL 只从私有环境加载
psql "$DATABASE_URL" -c \
  "SELECT filename, applied_at FROM life_schema_migration ORDER BY applied_at, filename;"

# API 验收通过后再恢复 worker；保留期最后恢复
sudo systemctl start life-finance-import.service
sudo systemctl start life-finance-export.timer
sudo systemctl start life-finance-retention.timer
```

若实际采用 systemd service 而非 timer，必须在发布单中记录“服务会运行一次后退出”还是“常驻循环”，并验证下一次调度确实发生。当前仓库的 `finance_export_worker.ts` 和 `finance_retention_worker.ts` 是一次性批处理入口，不能仅执行一次命令就视为生产调度已建立。

## 7. 回滚后验收清单

- [ ] 当前 API、PWA、worker 均指向同一回滚 Tag/commit。
- [ ] `/healthz`、HTTPS、Cookie、安全头和反向代理正常。
- [ ] 正式身份登录、`/api/me`、退出和会话撤销正常。
- [ ] 家庭 A 无法读取家庭 B 的账本、来源、导入对象、导出对象、AI 连接和记忆。
- [ ] 账户余额、总收入、总支出、预算环、趋势线和实物资产成本趋势没有异常变化。
- [ ] 手动记账、撤销、导入批次、表头预览、字段映射、关联审核和导出均可解释。
- [ ] 没有重复入账；父子结算、平台详情保留和来源关联仍存在。
- [ ] `finance_export_job`、导入批次、worker 失败状态和审计日志可检索。
- [ ] 原始账单保留一年规则未被回滚破坏；未误删未到期对象。
- [ ] 数据库备份、COS 对象、配置和日志已保留，且发布单已补齐。
- [ ] 观察窗口内 5xx、登录失败、队列积压、COS 错误和磁盘告警恢复正常。

## 8. 不可直接回滚的事项

以下动作不能由应用发布回滚自动完成，必须单独走备份恢复或数据修复审批：

- 已删除的原始账单对象、导出对象或 AI 记忆对象；
- 已发送给用户或外部平台的通知、下载链接或人工操作；
- 已经确认的手动记账、导入入账、撤销和关联审核结果；
- 已执行且改变约束/字段语义的 PostgreSQL migration；
- 已被外部数据库、银行或支付平台产生的新数据覆盖的内容。

## 9. 当前差距与出口标准

A-006 建设完成只表示回滚路径、责任边界、命令模板和验收清单已入库。以下事项仍不计入 A-006 完成证据，必须由 I-012～I-016 关闭：

- 腾讯云目标服务器上的实际 systemd/Nginx unit 尚未确认；
- 原生 PostgreSQL 备份、隔离恢复和家庭边界恢复演练尚未完成；
- COS 私有桶版本/恢复能力尚未 live 验证；
- 前端/API/worker 的真实 staging 发布和回滚尚未演练；
- 解析 worker 独立队列、重试、暂停、恢复和失败告警尚未达到生产标准。

生产发布闸门只有在真实 staging 连续完成“发布 → 验收 → 故障注入 → 回滚 → 再验收”并保留证据后，才可将 G0、G8、G10 或 I-015 标记为完成。
