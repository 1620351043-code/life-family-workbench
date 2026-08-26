# Spike A：PostgreSQL / RLS 家庭隔离

## 本地验证

```bash
python3 contract_test.py
```

本地契约测试检查：

- 家庭业务表启用并强制 RLS。
- RLS 使用事务级 `app.household_id`。
- 应用角色声明为 `NO BYPASSRLS`。
- 财务交易和分录使用同家庭组合外键。
- 客户端传入的家庭 ID 不能覆盖会话推导出的家庭 ID。

如果当前环境已准备 PGlite PostgreSQL WASM 引擎，可以运行：

```bash
node pglite_rls_test.mjs
```

该测试会执行真实 PostgreSQL 引擎的 RLS、`NOBYPASSRLS`、跨家庭读取拒绝、跨家庭写入拒绝和组合外键拒绝。由于 PGlite 不包含 `pgcrypto`，测试会在内存中移除 UUID 默认生成函数并使用显式 UUID；原始 `schema.sql` 不会被修改。

## PostgreSQL 复验命令

在具备 PostgreSQL 的测试环境中执行：

```bash
createdb life_spike_a
psql life_spike_a -f schema.sql
```

真实复验还需要建立家庭 A/B、以 `life_app` 角色设置不同事务上下文，验证 SELECT、INSERT、UPDATE、DELETE 和组合外键。当前工作区没有 `docker` 或 `psql`，因此本轮只完成 SQL 工件和本地契约验证，不能把 RLS 运行结果标记为通过。
