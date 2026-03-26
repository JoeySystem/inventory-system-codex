# OvO-Inventory-System

面向制造型企业内部场景的物料与库存管理系统，重点覆盖物料主数据、库存执行、BOM/SOP/工单联动、销售发货、报表治理与供应风险预警。

本仓库用于：

- 日常开发基线
- Windows 部署源
- 版本发布与更新来源

## 项目概述

当前系统不是通用 ERP 替代品，而是一套围绕真实生产与仓储流程收敛出来的内部系统，重点解决：

- 物料命名、分类、供应与替代关系管理
- `收 / 发 / 转 / 盘` 执行与库存单据化
- BOM / SOP / 生产工单闭环
- 发货与库存动作联动
- 数据一致性治理
- 低库存、保供套数、高风险供应三层预警

## 当前已落地能力

### 物料主数据

- 生命周期、分类、物料类型
- 安全库存、最低库存、补货点、目标保供套数
- 供应商、供应商报价、来源平台、采购参考
- 供给方式、替代料、供应风险字段
- 统一搜索选择器、重复治理、引用反查

### 库存执行

- `收 / 发 / 转 / 盘` 独立执行页
- 正式库存单据链：`stock_documents / stock_document_items / stock_movements`
- 草稿、提交、执行、记账、红冲、反记账、撤销执行
- 一致性治理与动作流水查询

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
- 正式报表
- 动作流水独立页面
- 一致性治理工作台
- 高风险供应治理

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
```

### 4. 启动服务

```bash
npm start
```

默认地址：

- 应用：[http://localhost:3000](http://localhost:3000)
- 健康检查：[http://localhost:3000/api/health](http://localhost:3000/api/health)

默认账号：

- 用户名：`admin`
- 密码：`admin123`

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

## 文档导航

首次接手项目，建议按这个顺序阅读：

1. [当前项目技术说明与维护交接指南.md](./docs/当前项目技术说明与维护交接指南.md)
2. [项目实施路线图.md](./docs/项目实施路线图.md)
3. [单据模型与库存流水映射设计.md](./docs/单据模型与库存流水映射设计.md)
4. [物料主数据改造实施文档.md](./docs/物料主数据改造实施文档.md)
5. [另一台电脑首次部署步骤.md](./docs/另一台电脑首次部署步骤.md)
6. [Git标签发布与更新流程规范.md](./docs/Git标签发布与更新流程规范.md)

与专项治理相关的文档，如 BOM 命名、供应风险、价格本管理等，可在 `docs/` 内继续按主题查阅。

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
- 发布与更新规范见：[docs/Git标签发布与更新流程规范.md](./docs/Git标签发布与更新流程规范.md)
- 正式运行机建议按 Git tag 或 GitHub Releases 更新，而不是直接追 `main`

## 仓库说明

这个 README 不是营销介绍，而是项目总入口。  
如果你要继续开发、部署、更新、回滚或交接，请先看本文件，再进入 `docs/` 的对应文档。
