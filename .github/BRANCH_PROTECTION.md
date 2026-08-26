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

A-004 CI 建设完成后，至少将以下任务设为 required：

```text
api:typecheck
web:typecheck
api:test
openapi:validate
migration:smoke
web:build
```

专项变更按 Pull Request 增加对应检查，例如财务真实账单回放、移动端 smoke、视觉回归和安全扫描。

## 当前状态

当前本地仓库没有配置 remote：

```bash
git remote -v
```

因此本文件已经确定保护策略，但“远端 `main` 已受保护”尚不能在当前环境中验证。绑定 GitHub/GitLab 等远端后，由仓库管理员按本文件配置并将设置页面或 API 返回结果作为 A-003 的最终证据。

## 远端配置完成后的验证

至少验证以下行为：

- 未经 Pull Request 向 `main` push 被拒绝；
- required checks 未通过时无法合并；
- 未解决审查对话时无法合并；
- force push 和删除 `main` 被拒绝；
- 合并后的 commit 可追溯到 Pull Request、审查者和发布清单。
