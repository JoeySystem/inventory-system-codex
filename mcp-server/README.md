# OvO System MCP Server

让 AI（OpenClaw / Claude）通过 MCP 协议安全操作物料管理系统。

## 安装

```bash
cd mcp-server
npm install
```

## 配置 OpenClaw

将以下内容添加到 OpenClaw 的 MCP 配置文件中：

**Windows** — 文件路径 `%APPDATA%\Claude\claude_desktop_config.json`（Claude Desktop）
或 OpenClaw 对应的 MCP 配置位置：

```json
{
  "mcpServers": {
    "OvO System": {
      "command": "node",
      "args": ["C:\\OvO System\\mcp-server\\index.js"],
      "env": {
        "IMS_API_URL": "http://localhost:3000",
        "IMS_USERNAME": "ai-operator",
        "IMS_PASSWORD": "ai123456"
      }
    }
  }
}
```

> 把 `C:\\OvO System` 改成实际安装路径。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| IMS_API_URL | http://localhost:3000 | 物料系统API地址 |
| IMS_USERNAME | ai-operator | AI专用账号 |
| IMS_PASSWORD | ai123456 | AI账号密码 |

## 可用工具（22个）

### 只读查询（15个，安全无风险）

| 工具名 | 功能 |
|--------|------|
| search_materials | 搜索物料（支持拼音） |
| get_material_detail | 物料详情（含库存、出入库记录） |
| query_inventory | 查询仓库库存 |
| list_warehouses | 仓库列表 |
| get_dashboard | 仪表盘概览 |
| get_low_stock_alerts | 低库存预警 |
| get_stock_trends | 出入库趋势 |
| get_bom_detail | BOM详情（树形+成本） |
| search_boms | 搜索BOM |
| where_used | 物料反查（被哪些BOM使用） |
| list_shipments | 发货单列表 |
| list_production_orders | 生产工单列表 |
| check_production_materials | 工单物料齐套检查 |
| get_categories | 物料分类列表 |
| get_inventory_report | 库存报表 |
| get_movement_report | 出入库流水 |

### 写操作（4个预览 + 3个管理，需两步确认）

| 工具名 | 功能 |
|--------|------|
| preview_stock_in | 预览入库操作 |
| preview_stock_out | 预览出库操作 |
| preview_transfer | 预览仓库调拨 |
| preview_shipment | 预览创建发货单 |
| confirm_operation | 确认执行预览的操作 |
| list_pending_operations | 查看待确认操作 |
| cancel_operation | 取消待确认操作 |

### 写操作流程

所有写操作采用"预览→确认"两步机制：

```
用户: "把100个贴片电阻从A仓出库"
  ↓
AI 调用: preview_stock_out(...)
  ↓ 返回预览信息和操作编号 op_1
AI 展示: "即将从A仓出库 贴片电阻 ×100，确认吗？"
  ↓ 用户确认
AI 调用: confirm_operation(operation_id="op_1")
  ↓
完成！
```

## 安全防护

1. **权限隔离** — AI 用 editor 角色，不能删除任何数据
2. **两步确认** — 写操作必须 preview→confirm
3. **频率限制** — 每分钟最多10次写操作
4. **数量上限** — 单次操作最多5000件
5. **异常检测** — 出库超过库存80%时自动警告
6. **操作标记** — 所有AI操作备注带 [AI操作] 前缀
7. **自动过期** — 未确认操作5分钟后自动失效
