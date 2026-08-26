# Life 版本与发布 Tag 规则

## 1. 唯一版本事实源

`package.json` 的 `version` 是应用版本唯一事实源，当前版本为 `0.1.0`。发布提交必须同时更新 `package.json` 和 `package-lock.json`，不允许只改 Tag 名称伪造版本。

版本遵循 SemVer：

- `MAJOR`：不兼容的 API、数据库或用户行为变更；
- `MINOR`：向后兼容的新功能；
- `PATCH`：向后兼容的缺陷修复和安全修复。

建议使用 npm 生成版本变更：

```bash
npm version patch --no-git-tag-version
npm version minor --no-git-tag-version
npm version major --no-git-tag-version
```

执行后必须检查 `package.json`、`package-lock.json`、迁移和发布说明，并在 Pull Request 中说明版本变化。

## 2. Tag 命名和环境映射

Tag 只从已合并到 `main` 的提交创建，使用带注释 Tag，不移动或复用已经发布的 Tag。

| 环境 | Tag 格式 | 示例 | 版本匹配 |
|---|---|---|---|
| staging | `vMAJOR.MINOR.PATCH-rc.N` | `v0.2.0-rc.1` | `package.json.version` 必须为 `0.2.0` |
| production | `vMAJOR.MINOR.PATCH` | `v0.2.0` | `package.json.version` 必须为 `0.2.0` |

RC Tag 只能进入 staging；稳定 Tag 只能进入 production。Tag 的核心版本必须与 `package.json.version` 完全一致，校验由 `npm run release:check` 执行。

## 3. 发布流程

### staging

```bash
git switch main
git pull --ff-only
npm ci
npm run release:check -- --tag=v0.2.0-rc.1 --env=staging
git tag -a v0.2.0-rc.1 -m "chore: prepare v0.2.0-rc.1 staging release"
git push origin v0.2.0-rc.1
```

### production

production 只能从已经通过 staging 验收的同一提交创建稳定 Tag：

```bash
git switch main
git pull --ff-only
npm ci
npm run release:check -- --tag=v0.2.0 --env=production
git tag -a v0.2.0 -m "chore: release v0.2.0"
git push origin v0.2.0
```

发布前必须确认：

- 工作区干净，Tag 指向已合并的 `main` 提交；
- `quality-gate` 已通过；
- 数据库迁移、COS、身份、权限和备份闸门已满足；
- 发布说明记录变更、迁移、已知风险和回滚 Tag；
- 不重用、移动或删除已对外发布的稳定 Tag。

## 4. 可追溯性

每个 staging/production 发布都必须能通过以下链路追溯：

```text
Tag -> commit SHA -> Pull Request -> quality-gate run -> 发布说明 -> 部署记录
```

查询示例：

```bash
git rev-list -n 1 v0.2.0
gh run list --workflow CI --branch main
gh release view v0.2.0
```

当前只建立规则和校验，不创建正式 Tag；正式 Tag 必须在 staging 和生产闸门完成后创建。
