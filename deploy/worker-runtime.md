# Life 财务 worker 运行时依赖与存储权限

本文档由 staging 真实调度验收补充，防止部署后 worker 因环境问题静默失败。

## 1. Python 依赖

导入解析 worker 在 `life` 用户下调用 `python3`，需要以下 Debian/Ubuntu 包：

```bash
sudo apt-get install -y python3-pandas python3-openpyxl
```

缺少依赖时，导入任务会失败并在 `finance_import_job.error_message` 中记录
`ModuleNotFoundError: No module named 'pandas'`。

## 2. 本地对象存储权限

非生产环境的 `LIFE_IMPORT_STORAGE_ROOT` 默认是 `/var/lib/life/staging-imports`，
必须由 worker 服务用户持有并可写；否则导出 worker 无法创建目录，任务会在
`finance_export_job.error_message` 中记录 `EACCES`。

```bash
sudo install -d -o life -g life -m 0750 /var/lib/life/staging-imports
sudo chown -R life:life /var/lib/life/staging-imports
```

## 3. 正式 `.xls` 边界

当前 Python worker 在 Linux 上对 `.xls` 仍依赖 `soffice` 转换路径，
该路径尚未纳入生产环境部署；本轮 worker 调度验证使用的是 CSV。
`.xls` 账单的服务器路径由 I-004/I-016 单独验收。
