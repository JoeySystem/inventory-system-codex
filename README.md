# OvO-Inventory-System

面向生产型企业的物料管理系统，覆盖：

- 物料主数据
- `收 / 发 / 转 / 盘`
- BOM / SOP / 生产工单
- 销售发货
- 报表与一致性治理
- 高风险供应预警

本仓库是当前项目的代码主仓库，适合作为：

- 日常开发基线
- Windows 部署源
- 后续版本发布与更新来源

## 项目定位

当前系统主要用于内部生产管理场景，强调：

- 物料主数据结构化
- BOM / SOP / 工单闭环
- 库存单据化与可追溯
- 生产异常与替代料处理
- 低库存、保供套数、高风险供应三层预警

## 当前能力概览

- 物料主数据
  - 生命周期
  - 供应商信息
  - 供给方式
  - 替代料
  - 风险字段
- 库存执行
  - `收 / 发 / 转 / 盘`
  - 正式单据链
  - 红冲 / 反记账 / 撤销执行
- 生产域
  - BOM
  - SOP
  - 生产工单
  - 工单快照
  - 异常单
- 发货
  - 销售发货与库存单据联动
- 报表与治理
  - 正式报表
  - 动作流水
  - 一致性治理
  - 高风险供应治理

## 技术栈

- Node.js
- Express
- SQLite
- Vue 3（CDN 方式）
- Tailwind 风格静态页面实现

## 目录结构

```text
inventory-system-codex/
├── public/          # 前端单页应用
├── server/          # 后端服务、路由、数据库初始化、业务服务
├── deploy/          # Windows 部署、更新、回滚脚本
├── docs/            # 项目方案、路线图、交接和实施文档
├── data/            # 本地数据库（不应提交真实业务库）
├── dist/            # 打包产物
├── package.json
└── .env.example
```

## 本地启动

### 1. 安装依赖

```bash
npm install
```

### 2. 准备环境文件

```bash
cp .env.example .env
```

再根据本机环境修改 `.env`。

### 3. 启动服务

```bash
npm start
```

默认访问地址：

- [http://localhost:3000](http://localhost:3000)

健康检查：

- [http://localhost:3000/api/health](http://localhost:3000/api/health)

## 环境变量

当前主要环境变量如下：

- `PORT`
- `SESSION_SECRET`
- `NODE_ENV`
- `COOKIE_SECURE`
- `TRUST_PROXY`
- `DB_PATH`
- `SESSION_DB_DIR`
- 可选：`SESSION_DB_NAME`

参考模板见：

- [.env.example](/Users/Joey/CodexProjects/inventory-system-codex/.env.example)

推荐配置：

- `NODE_ENV=production`
- `COOKIE_SECURE=auto`
- `TRUST_PROXY=0`

在 `http://localhost` 首次部署时，不要通过把 `NODE_ENV` 改成 `development` 来维持登录态。

## 数据与代码分离原则

本项目后续会用于 GitHub 同步与 Windows 自更新，因此必须遵守：

- 真实数据库不提交到 Git
- `.env` 不提交到 Git
- 代码更新不直接覆盖业务数据库

当前仓库已经通过 `.gitignore` 排除了：

- `data/*.db`
- `.env`
- 日志与备份文件

## Windows 部署与更新

当前仓库已包含 Windows 部署与更新脚本：

- [deploy/install.bat](/Users/Joey/CodexProjects/inventory-system-codex/deploy/install.bat)
- [deploy/start.bat](/Users/Joey/CodexProjects/inventory-system-codex/deploy/start.bat)
- [deploy/stop.bat](/Users/Joey/CodexProjects/inventory-system-codex/deploy/stop.bat)
- [deploy/update.bat](/Users/Joey/CodexProjects/inventory-system-codex/deploy/update.bat)
- [deploy/update-and-restart.bat](/Users/Joey/CodexProjects/inventory-system-codex/deploy/update-and-restart.bat)
- [deploy/rollback.bat](/Users/Joey/CodexProjects/inventory-system-codex/deploy/rollback.bat)

推荐原则：

- 开发在本地完成并推送 GitHub
- 正式机优先更新明确 tag
- 更新前自动备份数据库
- 出问题可通过 `rollback.bat` 回滚

## 环境兼容性

当前推荐环境：

- Node.js `20.x LTS` 或 `22.x LTS`
- npm `10.x` 或 `11.x`
- 不建议直接使用 `Node 24.x`

原因：

- 项目依赖 `better-sqlite3`
- 已有 Windows 实机反馈表明 `Node 24.x` 存在兼容风险

可执行环境检查：

```bash
npm run check-env
```

## 关键文档导航

如果你是第一次接手项目，优先阅读以下文档：

- [当前项目技术说明与维护交接指南.md](/Users/Joey/CodexProjects/inventory-system-codex/docs/当前项目技术说明与维护交接指南.md)
- [项目实施路线图.md](/Users/Joey/CodexProjects/inventory-system-codex/docs/项目实施路线图.md)
- [单据模型与库存流水映射设计.md](/Users/Joey/CodexProjects/inventory-system-codex/docs/单据模型与库存流水映射设计.md)
- [物料主数据改造实施文档.md](/Users/Joey/CodexProjects/inventory-system-codex/docs/物料主数据改造实施文档.md)
- [另一台电脑首次部署步骤.md](/Users/Joey/CodexProjects/inventory-system-codex/docs/另一台电脑首次部署步骤.md)
- [Git标签发布与更新流程规范.md](/Users/Joey/CodexProjects/inventory-system-codex/docs/Git标签发布与更新流程规范.md)

## Git 使用建议

推荐流程：

1. 在本地完成开发和验证
2. 提交到 `main`
3. 稳定版本打 `tag`
4. Windows 运行机按 `tag` 更新

示例：

```bash
git add .
git commit -m "Describe changes"
git push origin main

git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

## 不要提交的内容

不要把以下内容提交到仓库：

- 真实 `.env`
- 真实数据库
- session 数据库
- 本地备份
- 本地日志

## 注意事项

- 正式机不要直接追未验证提交
- 更新前先备份数据库
- 如果修改数据库结构，必须通过迁移脚本进入仓库
- 生产数据治理与功能开发应分开执行

## 当前仓库用途总结

这个 README 的用途不是营销介绍，而是项目总入口。  
后续任何同事接手项目，建议先看本文件，再顺着“关键文档导航”进入细节文档。
