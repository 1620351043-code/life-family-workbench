# `main` 主分支保护配置

## 目标策略

远端仓库绑定后，对 `main` 配置以下保护规则：

1. 禁止直接 push，只允许通过 Pull Request 合并。
2. 禁止 force push 和删除分支。
3. 当前首期不强制额外审查账号（`required_approving_review_count=0`）；如后续增加协作者，应再提升为独立审查要求。
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

仓库已公开，且已具备 Branch Protection 和 Rulesets 能力。当前仓库合并策略为：仅允许 Squash merge，关闭普通 Merge/Rebase，合并后自动删除短生命周期分支。GitHub Actions `quality-gate` 已在提交 `c5f3a07` 对应的远端运行中全部通过。

`main` 已按本文件配置为：禁止直接 push、force push 和删除；要求 Pull Request、解决全部审查对话、`quality-gate` 通过和线性历史；当前不强制额外审核账号（`required_approving_review_count=0`），管理员也受保护规则约束。

## 远端配置完成后的验证

至少验证以下行为：

- 未经 Pull Request 向 `main` push 被拒绝；
- required checks 未通过时无法合并；
- 未解决审查对话时无法合并；
- force push 和删除 `main` 被拒绝；
- 合并后的 commit 可追溯到 Pull Request、审查者和发布清单。
