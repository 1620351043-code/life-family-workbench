# Life 财务未达标项修复方案与执行记录 v0.1

**日期：** 2026-08-25  
**目标：** 处理 `Life-财务UIUX差距修订版-v0.2-复核报告.md` 中仍未完成的发布前事项。

## 1. 未达标项与处理策略

| 未达标项 | 本地可执行修复 | 需要外部环境的验收 |
|---|---|---|
| COS 私有桶 live smoke 尚未执行 | 强化 COS 适配器：上传默认 `private` + `AES256`，允许注入客户端进行确定性契约测试；保留生产缺配置即失败 | 配置真实腾讯云凭据后执行 `npm run cos:live-smoke`，验证上传、读取、HTTPS 签名下载和删除 |
| 动态字体 200% / 无障碍专项 | 增加文本尺寸适配声明、减少对比度/强制颜色模式；保留容器自适应、自动换行和 44pt 触控目标 | 原生 iOS VoiceOver、动态字体 200%、键盘避让、系统返回和快速下滑手势需真机确认 |
| 视觉金样与回归截图 | 增加可重复的 430/390/320pt Playwright 回归脚本，输出固定目录截图并校验溢出、控件尺寸和财务首页存在 | 真机色彩、玻璃材质和动态字体最终视觉仍需 iOS 设备校色确认 |
| 生产导入/保留期限/关联回归 | 保留现有 PostgreSQL 垂直测试和清理 worker 验证；生产闸门命令固定化 | 目标腾讯云 PostgreSQL、COS 和真实服务器上执行大文件、365 天清理、备份恢复、重复账单关联和回滚演练 |

## 2. 已执行修改

### 2.1 私有对象存储

- `TencentCosObjectStore` 上传时强制 `ACL: private`；
- 默认使用 COS 服务端 `AES256` 加密；
- 生产密钥只从进程启动环境读取，不进入家庭 API；
- 对象键仍保持家庭/批次隔离；
- 增加 COS 适配器确定性契约测试，验证上传、读取、删除和 HTTPS 签名 URL；
- 增加 `npm run cos:live-smoke`，缺少生产数据库、COS 凭据或 live smoke 开关时 fail-closed。

### 2.2 无障碍与动态文本

- HTML 增加 `text-size-adjust`，允许移动浏览器按系统字号策略调整文本；
- 增加 `prefers-contrast: more` 和 `forced-colors: active` 降级样式；
- 保留容器查询、自适应金额、自动换行、语义标签和 44pt 触控目标；
- 真机专项未被伪装为本地浏览器已通过。

### 2.3 视觉回归

- 新增 `npm run web:visual-regression`；
- 输出 `output/playwright/finance-golden/finance-430x932.png`、`finance-390x844.png`、`finance-320x900.png`；
- 自动检查根节点横向溢出、可见控件尺寸、预算环和财务首页存在。

## 3. 执行结果

本地代码、契约测试、类型检查、构建和视觉回归已在当前工作区闭环执行。`npm run cos:live-smoke` 已实际运行并因缺少 `DATABASE_URL` 按预期安全失败；真实 COS live smoke、原生 iOS 真机验收和腾讯云生产演练因当前环境没有对应凭据/设备，必须在目标环境执行，不能用本地结果替代。

长金额专项截图复核发现并已修复数字中间换行问题：`AdaptiveValue` 现在先保持单行并缩小字号，只有极端内容才按可用宽度计算更小字号；430pt 金样中摘要金额均保持完整单行。

## 4. 发布闸门

```text
npm run cos:live-smoke
npm run api:test
npm run api:typecheck
npm run web:typecheck
npm run web:build
npm run openapi:validate
npm run web:visual-regression
```

只有 COS live smoke、目标 PostgreSQL/RLS、真实会话、原始文件一年清理、备份恢复和 iOS 真机专项全部有证据，才可将财务模块标记为生产发布通过。
