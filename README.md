# OvO-Inventory-System

面向制造型企业内部场景的物料与库存管理系统，重点覆盖物料主数据、库存执行、BOM/SOP/工单联动、销售发货、报表治理与供应风险预警。

本仓库用于：

- 日常开发基线
- Windows 部署源
- 版本发布与更新来源

## 项目概述

当前系统不是通用 ERP 替代品，而是一套围绕真实生产与仓储流程收敛出来的内部系统，重点解决：

- 物料命名、分类、供应与替代关系管理
- `入库 / 出库 / 调拨 / 盘点` 执行与库存单据化
- BOM / SOP / 生产工单闭环
- 发货与库存动作联动
- 数据治理
- 低库存、保供套数、高风险供应三层预警

## 当前已落地能力

### 物料主数据

- 生命周期、分类、物料类型
- 安全库存、最低库存、补货点、目标保供套数
- 供应商、供应商报价、来源平台、采购参考
- 供给方式、替代料、供应风险字段
- 统一搜索选择器、重复治理、引用反查

### 库存执行

- `入库 / 出库 / 调拨 / 盘点` 独立入口
- 正式库存单据链：`stock_documents / stock_document_items / stock_movements`
- 草稿、提交、执行、记账、红冲、反记账、撤销执行
- 数据治理与动作流水查询

### 生产域

- BOM 管理
- SOP 工艺管理
- 生产工单
- 工单快照
- 生产异常、部分完工、部分退料
- 替代料执行与追溯

### 发货与履约

- 销售发货单
- 发货与库存单据联动
- 发货状态流转与取消回冲

### 报表与治理

- 仪表盘
- 业务报表
- 动作流水独立页面
- 数据治理工作台
- 高风险供应治理

### 数据维护

- 系统内创建数据库备份
- 系统内导出数据迁移包
- 迁移包包含数据库、校验信息和迁移说明
- 管理员受控恢复数据库
- 恢复前自动生成当前库备份，降低误操作风险

## 技术栈

- 后端：Node.js + Express
- 数据库：SQLite
- 前端：Vue 3（CDN 单页应用）
- 部署：Windows 脚本化部署 / 更新 / 回滚

## 目录结构

```text
OvO-Inventory-System/
├── public/          # 前端单页应用
├── server/          # 后端服务、路由、数据库、脚本
├── deploy/          # Windows 部署、更新、回滚脚本
├── docs/            # 方案、路线图、交接与实施文档
├── tests/           # 最小冒烟测试
├── package.json
└── .env.example
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 创建环境文件

```bash
cp .env.example .env
```

根据本机环境修改 `.env`。

### 3. 环境检查

```bash
npm run check-env
npm run preflight
```

### 4. 启动服务

```bash
npm start
```

默认地址：

- 应用：[http://localhost:3000](http://localhost:3000)
- 健康检查：[http://localhost:3000/api/health](http://localhost:3000/api/health)

初始化管理员账号请以部署环境实际初始化结果为准。正式使用前必须修改管理员密码，并配置强 `SESSION_SECRET`。

## 环境变量

主要环境变量：

- `PORT`
- `SESSION_SECRET`
- `NODE_ENV`
- `COOKIE_SECURE`
- `TRUST_PROXY`
- `DB_PATH`
- `SESSION_DB_DIR`
- 可选：`SESSION_DB_NAME`

模板见：

- [.env.example](./.env.example)

推荐值：

- `NODE_ENV=production`
- `COOKIE_SECURE=auto`
- `TRUST_PROXY=0`

说明：

- 本地 HTTP 环境不要通过把 `NODE_ENV` 改成 `development` 来规避登录态问题
- 正式行为应通过 `COOKIE_SECURE` 与代理配置控制
- `NODE_ENV=production` 时，如果 `SESSION_SECRET` 仍是占位值、弱值或未配置，服务会拒绝启动

## 运行与兼容性

当前支持：

- Node.js `20.x / 22.x / 24.x`
- npm `10.x / 11.x`

推荐：

- Windows 正式机：`20.x LTS` 或 `22.x LTS`
- 开发机：`20.x / 22.x / 24.x`

说明：

- 项目已完成 Node 24 兼容升级
- 若部署机环境异常，先执行 `npm run check-env`
- 正式部署、更新或回滚前，建议执行 `npm run preflight`

## 数据与代码分离

本仓库只存放代码、安全模板和文档，不应存放真实业务数据。

不要提交：

- 真实 `.env`
- 真实数据库
- session 数据库
- 本地日志
- 备份文件

当前 `.gitignore` 已排除：

- `data/*.db`
- `.env`
- 日志、备份和本地工具目录

## Windows 部署与更新

仓库已包含以下脚本：

- [deploy/install.bat](./deploy/install.bat)
- [deploy/start.bat](./deploy/start.bat)
- [deploy/stop.bat](./deploy/stop.bat)
- [deploy/update.bat](./deploy/update.bat)
- [deploy/update-and-restart.bat](./deploy/update-and-restart.bat)
- [deploy/rollback.bat](./deploy/rollback.bat)

推荐流程：

1. 本地开发并验证
2. 推送到 GitHub
3. 打 tag
4. Windows 运行机按 tag 更新
5. 更新前自动备份数据库
6. 异常时使用回滚脚本恢复

## 数据备份、恢复与迁移

系统内已提供管理员入口：

```text
系统 > 数据维护
```

可执行：

- 创建数据库备份：生成当前 `inventory.db` 的备份文件
- 导出迁移包：生成 zip，包含 `inventory.db`、`manifest.json`、`CHECKSUM.txt` 和迁移说明
- 恢复数据库：上传 `.db / .sqlite / .sqlite3` 文件，并输入“确认恢复”后替换当前数据库

注意：

- 备份、迁移包和恢复上传临时文件默认存放在 `backups/`
- `backups/` 不提交到 GitHub
- 恢复数据库前系统会自动创建一份 `pre-restore` 备份
- 恢复会替换当前运行数据，正式环境建议先停服或安排无人操作窗口执行

## 文档导航

公开仓库保留面向安装和使用的基础文档：

1. [部署安装指南.md](./docs/部署安装指南.md)
2. [用户手册.md](./docs/用户手册.md)
3. [仓库员速查版.md](./docs/仓库员速查版.md)

内部实施方案、迁移草案、API 细节、运维交接和项目管理文档不放在公开仓库中维护。

## Git 使用建议

推荐流程：

```bash
git add .
git commit -m "Describe changes"
git push origin main

git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

原则：

- `main` 用于日常开发合并
- `tag` 用于稳定版本发布
- Windows 运行机优先更新到 tag，而不是直接追最新提交

## 版本追溯

- 当前稳定标签：`v1.0.0`
- 版本变更记录见：[CHANGELOG.md](./CHANGELOG.md)
- 正式运行机建议按 Git tag 或 GitHub Releases 更新，而不是直接追 `main`

## 仓库说明

这个 README 不是营销介绍，而是项目总入口。  
如果你要继续开发、部署、更新、回滚或交接，请先看本文件，再进入 `docs/` 的对应文档。
