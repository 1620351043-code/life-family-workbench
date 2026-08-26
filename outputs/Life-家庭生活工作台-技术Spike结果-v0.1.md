# Life 家庭生活工作台

## 三个技术 Spike 结果 v0.1

> 执行日期：2026-08-24
>
> 基线文档：[技术路线评审 v0.1](./Life-家庭生活工作台-技术路线评审-v0.1.md)、[数据库与家庭隔离 / AI 网关设计 v0.1](./Life-家庭生活工作台-数据库与家庭隔离-AI网关设计-v0.1.md)、[移动端信息架构与核心流程 v0.1](./Life-家庭生活工作台-移动端信息架构与核心流程-v0.1.md)。

## 1. 总体结论

本轮三个 Spike 的本地结果：

| Spike | 本地结果 | 结论级别 |
|---|---|---|
| A：家庭隔离 | SQL 隔离契约和应用层作用域测试通过；真实 PostgreSQL RLS 未运行 | 条件通过 |
| B：账单导入 | 合成银行/支付宝/微信 CSV 全部通过 | 通过合成样本 |
| C：财务下钻 | 摘要、预算环、趋势线、资产成本和下钻引用全部通过 | 通过 |

重要说明：当前开发环境没有 `docker` 或 `psql`，所以 Spike A 的 PostgreSQL 运行态不能被标记为已验证。已经留下可直接执行的 SQL 和复验说明，不把静态契约测试冒充 RLS 运行结果。

## 2. Spike A：PostgreSQL / RLS 家庭隔离

### 2.1 已验证内容

- 家庭主题、财务交易和财务分录启用 RLS。
- 使用 `FORCE ROW LEVEL SECURITY`，避免表所有者路径绕过策略。
- RLS 使用事务级 `app.household_id`。
- 应用角色设置为 `NOBYPASSRLS`。
- 财务交易和分录使用 `(household_id, id)` 组合外键，阻止跨家庭关联。
- 应用层不能接受客户端提交的其它家庭 ID 覆盖会话推导出的家庭 ID。

### 2.2 本地执行结果

执行：

```bash
cd spikes/spike-a-postgres-rules
python3 contract_test.py
```

结果：

```text
Spike A contract: PASS
SQL guards: RLS enabled/forced, transaction scope, composite FK, NO BYPASSRLS
Application scope: client household cannot override session household
PostgreSQL runtime: NOT RUN (docker/psql unavailable in current environment)
```

### 2.3 真实数据库复验要求

在测试数据库中执行 [`schema.sql`](../spikes/spike-a-postgres-rules/schema.sql)，再补充：

1. 建立家庭 A/B 和各自主题、账单。
2. 使用 `life_app` 角色，在不同事务中设置家庭上下文。
3. 验证 A 对 B 的 SELECT 返回空或统一拒绝。
4. 验证 A 不能 INSERT/UPDATE/DELETE B 的资源。
5. 验证家庭 A 的分录不能引用家庭 B 的交易。
6. 验证连接池复用后不会残留上一个事务的家庭变量。

因此，数据库路线可以继续按 PostgreSQL 设计推进，但正式进入上线前必须完成一次真实 PostgreSQL 运行复验。

## 3. Spike B：多来源账单导入

### 3.1 已验证内容

- 扫描前 100 行，识别第 4 行为表头。
- 银行、支付宝、微信使用不同列名时，映射到统一字段。
- 金额符号、金额正负和“收支类型”可以规范化。
- 同一银行流水号在重复文件中形成一个同源重复组。
- 跨来源匹配前先完成同源去重，避免重复文件放大关联候选。
- 银行账单成为资金锚点，支付宝/微信记录保留为详细来源。
- 跨来源关联先进入 `pending_review`，不会未经确认写入正式账本。

### 3.2 本地执行结果

执行：

```bash
cd spikes/spike-b-finance-import
python3 test_import_spike.py
```

结果：

```text
Spike B import contract: PASS
Header detection: 4th row for bank/Alipay/WeChat fixtures
Same-source idempotency: 1 duplicate group
Cross-source linkage: 2 pending-review links with bank anchor
Detail retention: Alipay/WeChat records preserved as detail sources
```

这次 Spike 还暴露并修复了一个真实规则问题：必须先做同源幂等去重，再做跨来源关联；否则重复导出的银行文件会让同一支付平台账单产生多个候选。

### 3.3 尚未通过的范围

当前只使用合成 CSV，不代表已经兼容真实导出格式。产品实现前需要用脱敏样本补测：

- XLS/XLSX 多工作表和多个数据区域。
- 多行表头、合并单元格和前置统计行。
- PDF 表格、OCR 低置信度和扫描件。
- ZIP 内多个账单文件。
- GBK、GB18030、UTF-16 和 CSV 分隔符变化。
- 退款、冲正、转账、手续费、拆分和同日同额交易。

## 4. Spike C：财务统计与统一下钻

### 4.1 已验证内容

- 收入、支出和净现金流由确定性交易计算。
- 预算分类环返回额度、已用、进度、颜色语义和 `drilldown_ref`。
- 预算环心、图例和趋势容器都具备下钻引用。
- 每个收入/支出趋势点进入对应日期账单。
- 实物资产趋势区分购买成本、维护成本、回收金额、毛成本和净现金成本。
- 每个资产成本点进入对应资产事件。
- 前端不根据展示标签、颜色或金额重建财务查询条件。

### 4.2 本地执行结果

执行：

```bash
cd spikes/spike-c-finance-drilldown
python3 test_drilldown_spike.py
```

结果：

```text
Spike C drilldown contract: PASS
Summary values: income 10200.00, expense 376.00, net cash flow 9824.00
Budget ring: food category drilldown returns 2 ledger rows
Trend point: 2026-08-03 drilldown returns 1 ledger row
Asset cost: gross 3200.00, net cash cost 2700.00
Drilldown refs: summary, ring, chart point and container all carry stable refs
```

### 4.3 对产品和前端的直接结论

- 财务 API 必须返回“展示值 + 周期 + 来源数量 + `drilldown_ref`”。
- `drilldown_ref` 应该是服务端生成的稳定过滤定义或短期 ID。
- 财务首页可以采用任意视觉形式，但不能保留不可点击的装饰图表。
- 资产趋势需要明确显示“毛成本”和“净现金成本”，避免用户把出售回收额误解为成本减少后重写历史。

## 5. 本轮文件清单

- [`spikes/README.md`](../spikes/README.md)
- [`spike-a-postgres-rules/schema.sql`](../spikes/spike-a-postgres-rules/schema.sql)
- [`spike-a-postgres-rules/contract_test.py`](../spikes/spike-a-postgres-rules/contract_test.py)
- [`spike-b-finance-import/import_spike.py`](../spikes/spike-b-finance-import/import_spike.py)
- [`spike-b-finance-import/test_import_spike.py`](../spikes/spike-b-finance-import/test_import_spike.py)
- [`spike-b-finance-import/fixtures/`](../spikes/spike-b-finance-import/fixtures/)
- [`spike-c-finance-drilldown/drilldown_spike.py`](../spikes/spike-c-finance-drilldown/drilldown_spike.py)
- [`spike-c-finance-drilldown/test_drilldown_spike.py`](../spikes/spike-c-finance-drilldown/test_drilldown_spike.py)

## 6. 下一阶段闸门

### 必须先完成

1. 在隔离测试 PostgreSQL 中完成 Spike A 运行态复验。
2. 收集并脱敏至少一组真实银行、支付宝、微信或其它记账 App 导出文件，补充 Spike B。
3. 根据 Spike C 的 `drilldown_ref` 契约建立 OpenAPI 草案和移动端低保真交互原型。

### 然后进入

```text
技术 Spike 闸门
  → OpenAPI / 数据库 migration
  → 移动端低保真 UI
  → 财务导入和下钻高保真原型
  → 家庭空间 / 吃什么 / 财务垂直切片开发
```

本轮不直接开始全量业务编码，避免在真实 PostgreSQL 隔离和真实账单格式未复验前固化错误数据边界。

