# `main` 主分支保护配置

## 目标策略

远端仓库绑定后，对 `main` 配置以下保护规则：

1. 禁止直接 push，只允许通过 Pull Request 合并。
2. 禁止 force push 和删除分支。
3. Pull Request 至少需要 1 名独立审查者批准；作者不能用自己的批准替代审查。
4. 必须通过所有 required status checks 后才能合并。
5. 必须解决全部审查对话；禁止绕过检查直接合并。
6. 使用 Squash merge；合并后删除短生命周期工作分支。
7. 对数据库迁移、权限、导入、AI 和身份认证变更启用 code-owner 或指定领域审查。

## Required status checks

A-004 CI 建设完成后，至少将 `quality-gate` 这个 GitHub Actions job 设为 required。它内部必须完整运行以下检查：

```text
quality-gate
```

`quality-gate` 内部的检查命令为：

```text
npm run api:typecheck
npm run web:typecheck
npm run api:test
npm run openapi:validate
npm run migration:smoke
npm run web:build
```

专项变更按 Pull Request 增加对应检查，例如财务真实账单回放、移动端 smoke、视觉回归和安全扫描。

## 当前状态

当前仓库已绑定 remote 并推送 `main`：

```bash
origin https://github.com/1620351043-code/life-family-workbench.git
```

仓库合并策略已配置为：仅允许 Squash merge，关闭普通 Merge/Rebase，合并后自动删除短生命周期分支。GitHub Actions `quality-gate` 已在提交 `f8085ed` 对应的远端运行中全部通过。

传统 Branch Protection 和 Rulesets API 均返回 HTTP 403：当前账号的 GitHub 个人私有仓库计划不支持该能力。因此“远端 `main` 已受保护”仍不能确认。保留私有仓库需要升级 GitHub Pro；如果不升级，另一种方案是将仓库改为公开，但不得在没有明确授权的情况下改变可见性。

## 远端配置完成后的验证

至少验证以下行为：

- 未经 Pull Request 向 `main` push 被拒绝；
- required checks 未通过时无法合并；
- 未解决审查对话时无法合并；
- force push 和删除 `main` 被拒绝；
- 合并后的 commit 可追溯到 Pull Request、审查者和发布清单。
