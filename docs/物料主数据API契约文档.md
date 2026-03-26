# 物料主数据 API 契约文档

## 1. 文档目的

本文档定义“物料主数据改造”后的后端 API 契约，用于指导：

- 后端接口实现
- 前端页面联调
- 导入导出适配
- 测试用例编写

文档以当前项目现有 API 风格为基础，保持以下约定：

- 统一返回 JSON
- 成功返回 `success: true`
- 参数错误返回 4xx
- 使用 session 认证

## 2. 通用约定

### 2.1 鉴权

所有接口均要求登录。

权限建议：

- 查看：`materials.view`
- 新增：`materials.add`
- 编辑：`materials.edit`
- 生命周期变更、合并、导入提交：建议新增 `materials.manage`

### 2.2 通用返回结构

成功：

```json
{
  "success": true,
  "data": {}
}
```

失败：

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "字段校验失败",
    "field": "materialType"
  }
}
```

### 2.3 幂等性要求

以下写接口建议支持幂等：

- 创建物料
- 导入 preview 提交
- 生命周期变更
- 物料合并

请求头：

- `Idempotency-Key: <uuid>`

服务端策略：

- 同 key 同请求体重复提交返回第一次结果
- 同 key 不同请求体返回冲突错误

## 3. 数据对象定义

### 3.1 Material

```json
{
  "id": 1001,
  "code": "RM-CAP-0402-000123",
  "internalCode": "RM-CAP-0402-000123",
  "name": "贴片电容 20PF",
  "materialType": "raw",
  "categoryId": 8,
  "categoryName": "电容",
  "model": "C0402-20PF",
  "spec": "20PF/0402",
  "brand": "Murata",
  "unit": "pcs",
  "lifecycleStatus": "active",
  "isPurchasable": true,
  "isProducible": false,
  "isSellable": false,
  "defaultWarehouseId": 1,
  "safetyStock": 200,
  "reorderPoint": 200,
  "maxStock": 5000,
  "allowNegativeStock": false,
  "isBatchTracked": false,
  "isSerialTracked": false,
  "isExpiryTracked": false,
  "standardCost": 0.02,
  "avgCost": 0.02,
  "salePrice": 0,
  "defaultBomId": null,
  "defaultSopId": null,
  "dataQualityStatus": "normal",
  "versionNo": 3,
  "createdAt": "2026-03-20 10:00:00",
  "updatedAt": "2026-03-20 10:00:00"
}
```

### 3.2 Material UOM

```json
{
  "id": 1,
  "uomType": "base",
  "unitName": "pcs",
  "ratioToBase": 1,
  "isDefault": true
}
```

### 3.3 Material Supplier

```json
{
  "id": 1,
  "supplierName": "深圳某电子",
  "supplierMaterialCode": "SUP-20PF-0402",
  "isDefault": true,
  "leadTimeDays": 7,
  "minOrderQty": 5000,
  "lotSize": 5000,
  "lastPurchasePrice": 0.018
}
```

### 3.4 Material Substitution

```json
{
  "id": 9,
  "materialId": 1001,
  "substituteMaterialId": 1033,
  "substituteMaterialCode": "RM-CAP-0402-000888",
  "substituteMaterialName": "贴片电容 22PF",
  "priority": 1,
  "substitutionType": "temporary",
  "reason": "原料短缺临时替代",
  "isActive": true
}
```

## 4. 接口清单

### 4.1 物料列表

#### `GET /api/materials`

用途：

- 获取物料列表

查询参数：

- `page`
- `limit`
- `q`
- `categoryId`
- `materialType`
- `lifecycleStatus`
- `isPurchasable`
- `isProducible`
- `isSellable`
- `lowStockOnly`
- `negativeStockOnly`
- `dirtyOnly`

响应示例：

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": 1001,
        "code": "RM-CAP-0402-000123",
        "name": "贴片电容 20PF",
        "materialType": "raw",
        "categoryName": "电容",
        "unit": "pcs",
        "lifecycleStatus": "active",
        "currentStock": 1200,
        "safetyStock": 200,
        "isLowStock": false,
        "isNegativeStock": false,
        "dataQualityStatus": "normal"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 991,
      "totalPages": 50
    }
  }
}
```

### 4.2 物料详情

#### `GET /api/materials/:id`

用途：

- 获取物料详情

响应结构：

- `material`
- `uoms`
- `suppliers`
- `substitutions`
- `inventorySummary`
- `usageSummary`
- `recentMovements`

### 4.3 新建物料

#### `POST /api/materials`

请求体：

```json
{
  "code": "RM-CAP-0402-000123",
  "name": "贴片电容 20PF",
  "materialType": "raw",
  "categoryId": 8,
  "model": "C0402-20PF",
  "spec": "20PF/0402",
  "brand": "Murata",
  "baseUnit": "pcs",
  "lifecycleStatus": "active",
  "isPurchasable": true,
  "isProducible": false,
  "isSellable": false,
  "defaultWarehouseId": 1,
  "stockPolicy": {
    "safetyStock": 200,
    "reorderPoint": 200,
    "maxStock": 5000,
    "allowNegativeStock": false,
    "isBatchTracked": false,
    "isSerialTracked": false,
    "isExpiryTracked": false
  },
  "costPolicy": {
    "standardCost": 0.02,
    "salePrice": 0,
    "costSource": "manual"
  },
  "uoms": [
    {
      "uomType": "base",
      "unitName": "pcs",
      "ratioToBase": 1,
      "isDefault": true
    }
  ],
  "suppliers": [],
  "substitutions": [],
  "notes": "默认物料"
}
```

校验规则：

- `name` 必填
- `materialType` 必填
- `categoryId` 必填
- `uoms` 至少存在一个 `base`
- `code` 唯一
- `lifecycleStatus=active` 时必须具备完整基础信息

成功响应：

```json
{
  "success": true,
  "data": {
    "id": 1001,
    "code": "RM-CAP-0402-000123"
  }
}
```

### 4.4 修改物料

#### `PUT /api/materials/:id`

请求体：

```json
{
  "name": "贴片电容 20PF",
  "materialType": "raw",
  "categoryId": 8,
  "model": "C0402-20PF",
  "spec": "20PF/0402",
  "brand": "Murata",
  "versionNo": 3,
  "isPurchasable": true,
  "stockPolicy": {
    "safetyStock": 300,
    "reorderPoint": 300,
    "maxStock": 6000,
    "allowNegativeStock": false
  }
}
```

规则：

- `versionNo` 必填，用于乐观锁
- 若数据库版本不一致，返回 `409`
- 关键字段变更时写入快照和审计日志

冲突响应：

```json
{
  "success": false,
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "物料已被其他用户修改，请刷新后重试"
  }
}
```

### 4.5 生命周期变更

#### `PUT /api/materials/:id/lifecycle`

请求体：

```json
{
  "toStatus": "frozen",
  "reason": "规格待确认"
}
```

规则：

- 仅允许合法状态机流转
- 若物料被 BOM / 工单 / 发货引用，需按规则判断是否允许
- 变更写入 `material_lifecycle_logs`

成功响应：

```json
{
  "success": true,
  "data": {
    "id": 1001,
    "fromStatus": "active",
    "toStatus": "frozen"
  }
}
```

### 4.6 单位换算维护

#### `PUT /api/materials/:id/uoms`

请求体：

```json
{
  "uoms": [
    {
      "uomType": "base",
      "unitName": "pcs",
      "ratioToBase": 1,
      "isDefault": true
    },
    {
      "uomType": "purchase",
      "unitName": "盘",
      "ratioToBase": 5000,
      "isDefault": true
    }
  ]
}
```

规则：

- 必须保留一个 `base`
- `ratioToBase > 0`
- 同类型只能一个默认值

### 4.7 替代料列表

#### `GET /api/materials/:id/substitutions`

响应：

```json
{
  "success": true,
  "data": {
    "items": []
  }
}
```

### 4.8 新增替代料

#### `POST /api/materials/:id/substitutions`

请求体：

```json
{
  "substituteMaterialId": 1033,
  "priority": 1,
  "substitutionType": "temporary",
  "reason": "短缺替代"
}
```

规则：

- 不可替代自身
- 不可重复建立相同替代关系
- 替代料必须是 `active`

### 4.9 删除替代料

#### `DELETE /api/materials/:id/substitutions/:subId`

响应：

```json
{
  "success": true,
  "message": "替代料关系已删除"
}
```

### 4.10 使用关系查询

#### `GET /api/materials/:id/usages`

用途：

- 查询物料被哪些业务对象引用

响应示例：

```json
{
  "success": true,
  "data": {
    "boms": [
      {
        "id": 20,
        "code": "BOM-00020",
        "name": "主板BOM"
      }
    ],
    "sops": [],
    "productionOrders": [],
    "shipments": [],
    "inventoryRows": 1
  }
}
```

### 4.11 重复物料检测

#### `GET /api/materials/duplicates`

查询参数：

- `status`
- `page`
- `limit`

响应示例：

```json
{
  "success": true,
  "data": {
    "groups": [
      {
        "rule": "same_spec_key",
        "items": [
          {
            "id": 1001,
            "code": "RM-CAP-0402-000123",
            "name": "贴片电容 20PF"
          },
          {
            "id": 1002,
            "code": "RM-CAP-0402-000999",
            "name": "贴片电容 20PF"
          }
        ]
      }
    ]
  }
}
```

### 4.12 物料合并

#### `POST /api/materials/:id/merge`

请求体：

```json
{
  "targetMaterialId": 1001,
  "reason": "重复建档，保留主编码"
}
```

规则：

- 源物料和目标物料不能相同
- 若存在不允许自动迁移的引用，返回阻断错误
- 合并后源物料置为 `obsolete`
- 写入 `material_merge_logs`

成功响应：

```json
{
  "success": true,
  "data": {
    "sourceMaterialId": 1002,
    "targetMaterialId": 1001
  }
}
```

### 4.13 导入预览

#### `POST /api/materials/import/preview`

请求类型：

- `multipart/form-data`

字段：

- `file`

用途：

- 校验文件
- 生成导入预览
- 不落库

响应示例：

```json
{
  "success": true,
  "data": {
    "previewToken": "imp_20260320_xxx",
    "summary": {
      "total": 100,
      "creatable": 80,
      "updatable": 10,
      "duplicated": 5,
      "invalid": 5
    },
    "items": [
      {
        "row": 2,
        "action": "create",
        "code": "RM-CAP-0402-000123",
        "name": "贴片电容 20PF",
        "warnings": [],
        "errors": []
      }
    ]
  }
}
```

### 4.14 导入提交

#### `POST /api/materials/import/commit`

请求体：

```json
{
  "previewToken": "imp_20260320_xxx",
  "mode": "all_or_nothing"
}
```

规则：

- 只能提交有效 preview
- 默认整批成功或整批失败
- 必须支持幂等

成功响应：

```json
{
  "success": true,
  "data": {
    "total": 100,
    "imported": 90,
    "updated": 10,
    "failed": 0
  }
}
```

### 4.15 导出物料主档

#### `GET /api/materials/export`

查询参数：

- `format=csv|xlsx|json`
- `categoryId`
- `materialType`
- `lifecycleStatus`

规则：

- 非法格式返回 `400`
- 导出成功后再记审计日志

## 5. 错误码约定

建议新增错误码：

- `VALIDATION_ERROR`
- `NOT_FOUND`
- `PERMISSION_DENIED`
- `VERSION_CONFLICT`
- `IDEMPOTENCY_CONFLICT`
- `LIFECYCLE_TRANSITION_INVALID`
- `MATERIAL_IN_USE`
- `DUPLICATE_MATERIAL`
- `IMPORT_PREVIEW_EXPIRED`
- `IMPORT_FILE_INVALID`

## 6. 生命周期状态机

状态流转如下：

- `draft -> pending_review`
- `pending_review -> active`
- `pending_review -> draft`
- `active -> frozen`
- `frozen -> active`
- `active -> inactive`
- `frozen -> inactive`
- `inactive -> obsolete`

非法流转示例：

- `draft -> active`
- `obsolete -> active`
- `inactive -> draft`

## 7. 业务校验规则

### 7.1 物料创建校验

- 原材料必须 `isPurchasable = true` 或由管理员明确例外
- 成品必须 `isSellable = true` 或 `isProducible = true`
- 半成品必须 `isProducible = true`
- 虚拟件不得参与实际库存

### 7.2 引用校验

- `inactive` 和 `obsolete` 物料不能被新 BOM 引用
- `frozen` 物料不能被新工单引用
- `draft` 物料不能被发货引用

### 7.3 删除策略

物料不提供物理删除，只允许：

- 冻结
- 停用
- 淘汰

## 8. 审计要求

以下动作必须写审计日志：

- 创建物料
- 修改关键字段
- 生命周期变更
- 替代料新增/删除
- 单位换算修改
- 导入提交
- 物料合并

建议审计内容包含：

- 操作前快照摘要
- 操作后快照摘要
- 影响对象数量
- 操作人
- 操作来源 IP

## 9. 前后端联调注意事项

- 前端保存时必须带 `versionNo`
- 详情页需要并行请求：
  - 基础详情
  - 使用关系
  - 替代料
  - 库存摘要
- 导入必须走 preview -> commit 两阶段
- 合并前必须展示影响范围

## 10. 验收用例建议

### 10.1 创建物料

- 正常创建原材料
- 缺少 `materialType` 创建失败
- 缺少基础单位创建失败

### 10.2 生命周期

- `draft -> pending_review` 成功
- `draft -> active` 失败
- `active -> frozen` 成功

### 10.3 查重与合并

- 疑似重复物料能被查询
- 合并成功后源物料变 `obsolete`
- 合并后引用关系仍可追溯

### 10.4 导入

- 非法文件格式失败
- preview 返回冲突明细
- commit 幂等生效

## 11. 与现有接口兼容建议

为了降低切换风险，建议分两步：

1. 兼容阶段
- 保留旧 `/api/materials` 字段
- 新字段追加返回
- 老前端继续可用

2. 切换阶段
- 前端全面切到新契约
- 老接口字段标记废弃

## 12. 建议后续输出物

基于本文档，下一步应继续产出：

1. OpenAPI 3.0 规范文件
2. 后端 DTO / 校验 schema
3. 前端字段映射与表单 schema
4. 联调测试清单
