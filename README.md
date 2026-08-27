# Life 家庭生活工作台

这是一个移动端优先的家庭生活 PWA。当前实现采用模块化单体后端 + PostgreSQL，前端正在从设计验证用的单页低保真原型迁移到可维护的 TypeScript UI 工程。

## 唯一事实源

- 生产发布差距、推进顺序、逐项状态和验收证据：`outputs/Life-生产发布差距审计与推进总清单-v0.1.md`
- 移动端登录与注册创建家庭垂直切片：`outputs/Life-B004-B005移动端身份入口垂直切片卡-v0.1.md`
- 产品范围、页面树和小兔子 AI 交互：`outputs/Life-家庭生活工作台-PRD与UI页面覆盖规划-v0.1.md`
- 页面垂直切片实施和验收标准：`outputs/Life-页面垂直切片实施与验收流程-v0.1.md`
- 总体 UI 设计系统：`outputs/Life-移动端总体UI设计系统-v0.1.md`
- 产品基线和当前工程状态：`PROJECT_BASELINE.md`
- 分支、提交、审查和合并规范：`CONTRIBUTING.md`
- `main` 主分支保护配置：`.github/BRANCH_PROTECTION.md`
- 版本号、staging/production Tag 和发布追溯规则：`RELEASE.md`
- 生产发布、前端/API/迁移/worker 回滚清单：`deploy/ROLLBACK.md`
- 财务生产发布闸门复审：`outputs/Life-财务生产发布闸门复审报告-v0.4.md`
- API 契约：`api/Life-家庭生活工作台-OpenAPI-v0.1.yaml`
- 数据库迁移：`db/migrations/`
- 后端入口：`src/api/server.ts`
- 当前设计验证原型（不作为业务实现）：`ui/low-fi/index.html`

## 常用检查

```bash
npm run api:typecheck
npm run api:test
npm run openapi:validate
npm run migration:smoke
npm run release:check -- --tag=v0.1.0 --env=production
npm run web:typecheck
npm run web:build
npm run web:auth-e2e
npm run web:visual-regression
```

`web:auth-e2e` 和 `web:visual-regression` 需要先启动 `scripts/mobile_e2e_server.ts` 与 Vite 开发服务；测试会使用真实 `SqlAuthStore`、PGlite 和 HttpOnly Cookie，不使用请求头伪造身份。

生产定时任务：`npm run finance:export-worker`、`npm run finance:retention-worker`。两者都要求 `DATABASE_URL` 和腾讯云 COS 环境变量；缺少生产对象存储配置时必须失败启动，不回退到本地文件。

生产发布前执行 `npm run cos:live-smoke`，在 `NODE_ENV=production`、真实 `DATABASE_URL`、COS 凭据和 `LIFE_COS_LIVE_SMOKE=true` 同时具备时验证私有上传、AES256 加密、读取、HTTPS 签名下载和删除闭环。

目标服务器迁移、生产 preflight 和部署步骤见 `deploy/README.md`；环境变量模板见 `.env.example`。

移动端开发页面使用 `npm run web:dev`，默认端口为 `4173`；API 开发服务仍使用 `npm run api:dev`，默认端口为 `3100`。前端通过 Vite 代理访问 `/api`。

当前默认开发环境不会自动连接数据库；没有有效的家庭会话和 PostgreSQL 配置时，API 应明确返回未授权或未配置，而不是把演示数据伪装成真实数据。
