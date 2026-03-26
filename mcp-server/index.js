/**
 * OvO System MCP Server
 * 让 AI (OpenClaw/Claude) 通过 MCP 协议安全操作物料管理系统
 *
 * 安全防护：
 * - 第1层：专用 AI 账号，editor 权限（不能删除）
 * - 第2层：高风险操作需确认（preview → confirm 两步）
 * - 第3层：操作日志全程记录
 * - 第4层：频率限制防失控
 * - 第5层：数量异常检测
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const http = require('http');

// ============================================================
// 配置
// ============================================================

const CONFIG = {
  apiBase: process.env.IMS_API_URL || 'http://localhost:3000',
  username: process.env.IMS_USERNAME || 'ai-operator',
  password: process.env.IMS_PASSWORD || 'ai123456',
  // 安全限制
  maxWriteOpsPerMinute: 10,
  maxQtyPerOperation: 5000,
  abnormalQtyRatio: 0.8,  // 出库超过库存80%时警告
};

// ============================================================
// HTTP 客户端（不依赖 fetch/axios，纯 Node.js http）
// ============================================================

let sessionCookie = null;

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, CONFIG.apiBase);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };
    if (sessionCookie) {
      options.headers['Cookie'] = sessionCookie;
    }

    const req = http.request(options, (res) => {
      // 捕获 Set-Cookie 头以维持 session
      const setCookies = res.headers['set-cookie'];
      if (setCookies) {
        // 提取 connect.sid cookie
        for (const c of setCookies) {
          const match = c.match(/(?:connect|maverick)\.sid=[^;]+/);
          if (match) sessionCookie = match[0];
        }
      }

      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            resolve({ error: true, status: res.statusCode, message: json.error || json.message || data });
          } else {
            resolve(json);
          }
        } catch {
          if (res.statusCode >= 400) {
            resolve({ error: true, status: res.statusCode, message: data });
          } else {
            resolve({ raw: data });
          }
        }
      });
    });

    req.on('error', (err) => reject(err));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function ensureAuth() {
  if (sessionCookie) {
    const me = await request('GET', '/api/auth/me');
    if (!me.error) return;
    sessionCookie = null; // session 过期，重新登录
  }
  const res = await request('POST', '/api/auth/login', {
    username: CONFIG.username,
    password: CONFIG.password,
  });
  if (res.error) {
    throw new Error(`登录失败: ${res.message}. 请确认 ai-operator 账号已创建。`);
  }
  if (!sessionCookie) {
    throw new Error('登录成功但未获取到 session cookie，请检查服务器配置。');
  }
}

async function api(method, path, body = null) {
  await ensureAuth();
  const res = await request(method, path, body);
  // API 统一返回 { success: true, data: { ... } }，自动解包
  if (res && res.success && res.data !== undefined) {
    return res.data;
  }
  return res;
}

// ============================================================
// 安全防护：频率限制
// ============================================================

const writeOpsLog = [];

function checkRateLimit() {
  const now = Date.now();
  const oneMinAgo = now - 60000;
  // 清理过期记录
  while (writeOpsLog.length > 0 && writeOpsLog[0] < oneMinAgo) {
    writeOpsLog.shift();
  }
  if (writeOpsLog.length >= CONFIG.maxWriteOpsPerMinute) {
    return `频率限制：最近1分钟已执行 ${writeOpsLog.length} 次写操作，超过上限 ${CONFIG.maxWriteOpsPerMinute}。请稍后再试。`;
  }
  writeOpsLog.push(now);
  return null;
}

// ============================================================
// 安全防护：待确认操作暂存
// ============================================================

const pendingOps = new Map();
let opCounter = 0;

function createPendingOp(type, description, executeData) {
  const id = `op_${++opCounter}`;
  pendingOps.set(id, {
    id,
    type,
    description,
    executeData,
    createdAt: new Date().toISOString(),
  });
  // 5分钟后自动过期
  setTimeout(() => pendingOps.delete(id), 5 * 60 * 1000);
  return id;
}

// ============================================================
// MCP Server 定义
// ============================================================

const server = new McpServer({
  name: 'OvO System',
  version: '1.0.0',
});

// ----------------------------------------------------------
// 🔍 查询类工具（只读，安全）
// ----------------------------------------------------------

server.tool(
  'search_materials',
  '搜索物料。支持拼音、名称、编号搜索。返回物料列表及库存信息。',
  {
    keyword: z.string().describe('搜索关键词（名称/拼音/编号）'),
    category: z.string().optional().describe('按分类筛选'),
    page: z.number().optional().default(1).describe('页码'),
    limit: z.number().optional().default(20).describe('每页条数，最大50'),
  },
  async ({ keyword, category, page, limit }) => {
    const params = new URLSearchParams({ q: keyword, page, limit: Math.min(limit, 50) });
    if (category) params.set('category', category);
    const res = await api('GET', `/api/materials?${params}`);
    if (res.error) return { content: [{ type: 'text', text: `查询失败: ${res.message}` }] };
    const items = (res.materials || []).map(m =>
      `[${m.code}] ${m.name} (ID:${m.id}) | 分类:${m.category_name || '无'} | 规格:${m.spec || '无'} | 总库存:${m.total_stock || 0} ${m.unit} | 成本:${m.cost_price || '未设'}元`
    );
    return {
      content: [{
        type: 'text',
        text: `找到 ${res.pagination?.total || items.length} 条物料（第${page}页）:\n\n${items.join('\n') || '无匹配结果'}`,
      }],
    };
  }
);

server.tool(
  'get_material_detail',
  '获取单个物料的完整信息，包括各仓库库存明细和最近出入库记录。',
  {
    material_id: z.number().describe('物料ID'),
  },
  async ({ material_id }) => {
    const res = await api('GET', `/api/materials/${material_id}`);
    if (res.error) return { content: [{ type: 'text', text: `查询失败: ${res.message}` }] };
    const m = res.material || res;
    let text = `物料详情:\n`;
    text += `  ID: ${m.id}\n  编号: ${m.code}\n  名称: ${m.name}\n  分类: ${m.category_name || '无'}\n`;
    text += `  规格: ${m.spec || '无'}\n  单位: ${m.unit}\n  品牌: ${m.brand || '无'}\n`;
    text += `  成本价: ${m.cost_price || '未设'}元\n  售价: ${m.sale_price || '未设'}元\n`;
    text += `  安全库存: ${m.min_stock || 0} ~ ${m.max_stock || '不限'}\n`;
    const inv = res.inventory || [];
    if (inv.length > 0) {
      text += `\n各仓库库存:\n`;
      inv.forEach(i => {
        text += `  ${i.warehouse_name}: ${i.quantity} ${m.unit}\n`;
      });
    }
    const movements = res.recentMovements || [];
    if (movements.length > 0) {
      text += `\n最近出入库:\n`;
      movements.slice(0, 5).forEach(mv => {
        text += `  ${mv.created_at} | ${mv.type === 'in' ? '入库' : '出库'} ${mv.quantity} | ${mv.warehouse_name} | ${mv.notes || ''}\n`;
      });
    }
    return { content: [{ type: 'text', text }] };
  }
);

server.tool(
  'query_inventory',
  '查询指定仓库的库存列表。可搜索特定物料。',
  {
    warehouse_id: z.number().describe('仓库ID'),
    keyword: z.string().optional().describe('搜索物料名称'),
    page: z.number().optional().default(1),
    limit: z.number().optional().default(30),
  },
  async ({ warehouse_id, keyword, page, limit }) => {
    const params = new URLSearchParams({ page, limit: Math.min(limit, 50) });
    if (keyword) params.set('q', keyword);
    const res = await api('GET', `/api/warehouses/${warehouse_id}/inventory?${params}`);
    if (res.error) return { content: [{ type: 'text', text: `查询失败: ${res.message}` }] };
    const invItems = res.items || res.inventory || [];
    const items = invItems.map(i =>
      `[${i.material_code || ''}] ${i.material_name} (ID:${i.material_id}) | 数量:${i.quantity} ${i.unit || ''} | 均价:${i.avg_price || '未知'}元`
    );
    return {
      content: [{
        type: 'text',
        text: `仓库库存（第${page}页，共${res.pagination?.total || items.length}条）:\n\n${items.join('\n') || '该仓库暂无库存'}`,
      }],
    };
  }
);

server.tool(
  'list_warehouses',
  '列出所有仓库及其库存汇总。',
  {},
  async () => {
    const res = await api('GET', '/api/warehouses');
    if (res.error) return { content: [{ type: 'text', text: `查询失败: ${res.message}` }] };
    const items = (res.warehouses || []).map(w =>
      `[ID:${w.id}] ${w.name} | 物料种类:${w.material_types || 0} | 总数量:${w.total_quantity || 0} | 地址:${w.address || '无'}`
    );
    return { content: [{ type: 'text', text: `仓库列表:\n\n${items.join('\n') || '暂无仓库'}` }] };
  }
);

server.tool(
  'get_dashboard',
  '获取系统仪表盘数据：物料总数、库存总量、低库存预警、今日出入库等。',
  {},
  async () => {
    const res = await api('GET', '/api/statistics/dashboard');
    if (res.error) return { content: [{ type: 'text', text: `查询失败: ${res.message}` }] };
    let text = `系统概览:\n`;
    text += `  物料总数: ${res.materialCount || 0}\n`;
    text += `  库存总量: ${res.totalStock || 0}\n`;
    text += `  低库存预警: ${res.lowStockCount || 0} 种\n`;
    text += `  今日入库: ${res.todayIn || 0} 次\n`;
    text += `  今日出库: ${res.todayOut || 0} 次\n`;
    text += `  仓库数: ${res.warehouseCount || 0}\n`;
    return { content: [{ type: 'text', text }] };
  }
);

server.tool(
  'get_low_stock_alerts',
  '获取低库存预警清单：库存低于安全库存的物料列表。',
  {},
  async () => {
    const res = await api('GET', '/api/statistics/low-stock');
    if (res.error) return { content: [{ type: 'text', text: `查询失败: ${res.message}` }] };
    const items = (res.items || []).map(m =>
      `⚠ [${m.code}] ${m.name} | 当前:${m.total_stock} | 最低:${m.min_stock} | 缺口:${m.min_stock - m.total_stock} ${m.unit}`
    );
    return {
      content: [{
        type: 'text',
        text: items.length > 0
          ? `低库存预警（${items.length}种物料）:\n\n${items.join('\n')}`
          : '当前没有低库存预警，所有物料库存充足。',
      }],
    };
  }
);

server.tool(
  'get_stock_trends',
  '查询出入库趋势数据（按天统计）。',
  {
    range: z.enum(['7d', '30d', '90d']).optional().default('30d').describe('时间范围'),
  },
  async ({ range }) => {
    const res = await api('GET', `/api/statistics/trends?range=${range}`);
    if (res.error) return { content: [{ type: 'text', text: `查询失败: ${res.message}` }] };
    let text = `出入库趋势（${range}）:\n\n`;
    if (res.summary) {
      text += `汇总: 入库${res.summary.totalIn || 0}次 共${res.summary.totalInQty || 0}件 | 出库${res.summary.totalOut || 0}次 共${res.summary.totalOutQty || 0}件\n\n`;
    }
    const labels = res.labels || [];
    const datasets = res.datasets || {};
    if (labels.length === 0) {
      text += '该时间段内无出入库记录。';
    } else {
      text += '日期 | 入库数量 | 出库数量\n';
      text += '---|---|---\n';
      labels.forEach((label, i) => {
        text += `${label} | ${(datasets.stockIn || [])[i] || 0} | ${(datasets.stockOut || [])[i] || 0}\n`;
      });
    }
    return { content: [{ type: 'text', text }] };
  }
);

server.tool(
  'get_bom_detail',
  '查看BOM详情：物料清单树形结构、成本分析、版本信息。',
  {
    bom_id: z.number().describe('BOM ID'),
  },
  async ({ bom_id }) => {
    const [detail, cost] = await Promise.all([
      api('GET', `/api/boms/${bom_id}`),
      api('GET', `/api/boms/${bom_id}/cost`),
    ]);
    if (detail.error) return { content: [{ type: 'text', text: `查询失败: ${detail.message}` }] };
    const bom = detail.bom || detail;
    let text = `BOM详情:\n`;
    text += `  名称: ${bom.name}\n  编号: ${bom.code}\n  版本: ${bom.version}\n`;
    text += `  状态: ${bom.status}\n  产出: ${bom.output_material_name || '未指定'} × ${bom.output_quantity || 1}\n\n`;

    const tree = detail.tree || bom.tree || [];
    if (tree.length > 0) {
      text += `物料清单:\n`;
      const printTree = (items, indent = '') => {
        items.forEach(item => {
          text += `${indent}${item.material_name || item.sub_bom_name || '?'} × ${item.quantity}`;
          if (item.loss_rate) text += ` (损耗${item.loss_rate}%)`;
          if (item.cost_price) text += ` | 单价${item.cost_price}元`;
          text += '\n';
          if (item.children && item.children.length > 0) {
            printTree(item.children, indent + '  ');
          }
        });
      };
      printTree(tree);
    }

    if (cost && !cost.error && cost.totalCost !== undefined) {
      text += `\n成本分析:\n  总成本: ${cost.totalCost}元\n`;
      if (cost.categories) {
        cost.categories.forEach(c => {
          text += `  ${c.category}: ${c.cost}元 (${c.percentage}%)\n`;
        });
      }
    }
    return { content: [{ type: 'text', text }] };
  }
);

server.tool(
  'search_boms',
  '搜索BOM清单。',
  {
    keyword: z.string().optional().default('').describe('搜索关键词'),
    status: z.enum(['active', 'draft', 'archived']).optional().describe('状态筛选'),
  },
  async ({ keyword, status }) => {
    const params = new URLSearchParams();
    if (keyword) params.set('q', keyword);
    if (status) params.set('status', status);
    const res = await api('GET', `/api/boms?${params}`);
    if (res.error) return { content: [{ type: 'text', text: `查询失败: ${res.message}` }] };
    const items = (res.boms || []).map(b =>
      `[ID:${b.id}] ${b.name} | 编号:${b.code} | 版本:${b.version} | 状态:${b.status} | 产出:${b.output_material_name || '未指定'}`
    );
    return {
      content: [{
        type: 'text',
        text: `BOM列表（共${res.pagination?.total || items.length}条）:\n\n${items.join('\n') || '无匹配结果'}`,
      }],
    };
  }
);

server.tool(
  'where_used',
  '反查某个物料被哪些BOM使用（直接引用和间接引用）。',
  {
    material_id: z.number().describe('物料ID'),
  },
  async ({ material_id }) => {
    const res = await api('GET', `/api/boms/where-used/${material_id}`);
    if (res.error) return { content: [{ type: 'text', text: `查询失败: ${res.message}` }] };
    const direct = (res.direct || []).map(b => `  [直接] ${b.bom_name} (${b.bom_code}) × ${b.quantity}`);
    const indirect = (res.indirect || []).map(b => `  [间接] ${b.bom_name} (${b.bom_code})`);
    const all = [...direct, ...indirect];
    return {
      content: [{
        type: 'text',
        text: all.length > 0
          ? `物料(ID:${material_id})被以下BOM使用:\n\n${all.join('\n')}`
          : '该物料未被任何BOM引用。',
      }],
    };
  }
);

server.tool(
  'list_shipments',
  '查看发货单列表。',
  {
    status: z.enum(['pending', 'confirmed', 'shipped', 'delivered', 'cancelled']).optional().describe('状态筛选'),
    page: z.number().optional().default(1),
  },
  async ({ status, page }) => {
    const params = new URLSearchParams({ page });
    if (status) params.set('status', status);
    const res = await api('GET', `/api/shipments?${params}`);
    if (res.error) return { content: [{ type: 'text', text: `查询失败: ${res.message}` }] };
    const statusMap = { pending: '待确认', confirmed: '已确认', shipped: '已发货', delivered: '已送达', cancelled: '已取消' };
    const items = (res.shipments || []).map(s =>
      `[${s.shipment_no}] ${s.customer_name || '未知客户'} | 状态:${statusMap[s.status] || s.status} | ${s.item_count || 0}种物料 | ${s.created_at}`
    );
    return {
      content: [{
        type: 'text',
        text: `发货单列表（共${res.pagination?.total || items.length}条）:\n\n${items.join('\n') || '暂无发货单'}`,
      }],
    };
  }
);

server.tool(
  'list_production_orders',
  '查看生产工单列表。',
  {
    status: z.enum(['planned', 'in_progress', 'completed', 'cancelled']).optional().describe('状态筛选'),
    page: z.number().optional().default(1),
  },
  async ({ status, page }) => {
    const params = new URLSearchParams({ page });
    if (status) params.set('status', status);
    const res = await api('GET', `/api/production?${params}`);
    if (res.error) return { content: [{ type: 'text', text: `查询失败: ${res.message}` }] };
    const statusMap = { planned: '计划中', in_progress: '进行中', completed: '已完成', cancelled: '已取消' };
    const items = (res.orders || []).map(p =>
      `[${p.order_no}] ${p.sop_title || '未知'} | 状态:${statusMap[p.status] || p.status} | 计划:${p.planned_quantity} | 完成:${p.completed_quantity || 0} | ${p.created_at}`
    );
    return {
      content: [{
        type: 'text',
        text: `生产工单列表（共${res.pagination?.total || items.length}条）:\n\n${items.join('\n') || '暂无工单'}`,
      }],
    };
  }
);

server.tool(
  'check_production_materials',
  '检查生产工单的物料齐套情况（哪些物料不足）。',
  {
    order_id: z.number().describe('工单ID'),
  },
  async ({ order_id }) => {
    const res = await api('GET', `/api/production/${order_id}/check`);
    if (res.error) return { content: [{ type: 'text', text: `查询失败: ${res.message}` }] };
    const items = (res.data || res.shortages || []).map(s =>
      `❌ ${s.material_name} | 需要:${s.required} | 库存:${s.available} | 缺口:${s.shortage} ${s.unit || ''}`
    );
    return {
      content: [{
        type: 'text',
        text: items.length > 0
          ? `工单(ID:${order_id})物料不足:\n\n${items.join('\n')}`
          : '所有物料充足，可以开始生产。',
      }],
    };
  }
);

server.tool(
  'get_categories',
  '获取所有物料分类及各分类的物料数量。',
  {},
  async () => {
    const res = await api('GET', '/api/materials/meta/categories');
    if (res.error) return { content: [{ type: 'text', text: `查询失败: ${res.message}` }] };
    const items = (res.categories || []).map(c =>
      `[ID:${c.id}] ${c.name} (${c.material_count || 0}种物料)`
    );
    return { content: [{ type: 'text', text: `物料分类:\n\n${items.join('\n')}` }] };
  }
);

server.tool(
  'get_inventory_report',
  '生成库存报表：各物料在各仓库的详细库存。',
  {
    warehouse_id: z.number().optional().describe('限定仓库ID'),
    category_id: z.number().optional().describe('限定分类ID'),
    keyword: z.string().optional().describe('搜索关键词'),
  },
  async ({ warehouse_id, category_id, keyword }) => {
    const params = new URLSearchParams();
    if (warehouse_id) params.set('warehouseId', warehouse_id);
    if (category_id) params.set('categoryId', category_id);
    if (keyword) params.set('search', keyword);
    const res = await api('GET', `/api/statistics/inventory-report?${params}`);
    if (res.error) return { content: [{ type: 'text', text: `查询失败: ${res.message}` }] };
    const items = (res.items || []).map(r =>
      `${r.material_name} | ${r.warehouse_name} | 数量:${r.quantity} ${r.unit || ''} | 均价:${r.avg_price || 0}元 | 金额:${(r.quantity * (r.avg_price || 0)).toFixed(2)}元`
    );
    return {
      content: [{
        type: 'text',
        text: `库存报表（${items.length}条）:\n\n${items.slice(0, 100).join('\n')}${items.length > 100 ? '\n... 更多结果请缩小查询范围' : ''}`,
      }],
    };
  }
);

server.tool(
  'get_movement_report',
  '查询出入库流水记录。',
  {
    range: z.enum(['7d', '30d', '90d']).optional().default('7d').describe('时间范围'),
    type: z.enum(['in', 'out']).optional().describe('只看入库或出库'),
    warehouse_id: z.number().optional().describe('限定仓库ID'),
    page: z.number().optional().default(1),
  },
  async ({ range, type, warehouse_id, page }) => {
    const params = new URLSearchParams({ range, page, limit: 30 });
    if (type) params.set('type', type);
    if (warehouse_id) params.set('warehouseId', warehouse_id);
    const res = await api('GET', `/api/statistics/movement-report?${params}`);
    if (res.error) return { content: [{ type: 'text', text: `查询失败: ${res.message}` }] };
    const items = (res.items || []).map(m =>
      `${m.created_at} | ${m.type === 'in' ? '入库' : '出库'} | ${m.material_name} × ${m.quantity} | ${m.warehouse_name} | ${m.counterparty || ''} | ${m.notes || ''}`
    );
    return {
      content: [{
        type: 'text',
        text: `出入库流水（共${res.pagination?.total || items.length}条，第${page}页）:\n\n${items.join('\n') || '无记录'}`,
      }],
    };
  }
);

// ----------------------------------------------------------
// ✏️ 写操作工具（需安全防护）
// ----------------------------------------------------------

server.tool(
  'preview_stock_in',
  '【预览】入库操作。生成入库预览信息，需调用 confirm_operation 确认后才会真正执行。',
  {
    warehouse_id: z.number().describe('仓库ID'),
    material_id: z.number().describe('物料ID'),
    quantity: z.number().positive().describe('入库数量'),
    unit_price: z.number().optional().describe('单价（元）'),
    counterparty: z.string().optional().describe('供应商/来源'),
    reference_no: z.string().optional().describe('单据号'),
    notes: z.string().optional().describe('备注'),
  },
  async ({ warehouse_id, material_id, quantity, unit_price, counterparty, reference_no, notes }) => {
    // 数量上限检查
    if (quantity > CONFIG.maxQtyPerOperation) {
      return { content: [{ type: 'text', text: `安全拦截：单次入库数量 ${quantity} 超过上限 ${CONFIG.maxQtyPerOperation}，请分批操作。` }] };
    }
    // 获取物料和仓库信息用于展示
    const [mat, wh] = await Promise.all([
      api('GET', `/api/materials/${material_id}`),
      api('GET', `/api/warehouses/${warehouse_id}`),
    ]);
    const matInfo = mat.material || mat;
    const whInfo = wh.warehouse || wh;
    if (mat.error) return { content: [{ type: 'text', text: `物料不存在: ${mat.message}` }] };
    if (wh.error) return { content: [{ type: 'text', text: `仓库不存在: ${wh.message}` }] };

    const desc = `入库操作：将 ${matInfo.name}(${matInfo.code}) × ${quantity} ${matInfo.unit} 入库到 ${whInfo.name}` +
      (unit_price ? `，单价 ${unit_price} 元` : '') +
      (counterparty ? `，来源: ${counterparty}` : '') +
      (notes ? `，备注: ${notes}` : '');

    const opId = createPendingOp('stock_in', desc, {
      warehouse_id, material_id, quantity, unit_price, counterparty, reference_no, notes,
    });

    return {
      content: [{
        type: 'text',
        text: `📋 入库预览:\n\n${desc}\n\n操作编号: ${opId}\n\n⚠️ 请确认无误后调用 confirm_operation(operation_id="${opId}") 执行。`,
      }],
    };
  }
);

server.tool(
  'preview_stock_out',
  '【预览】出库操作。生成出库预览信息，需调用 confirm_operation 确认后才会真正执行。',
  {
    warehouse_id: z.number().describe('仓库ID'),
    material_id: z.number().describe('物料ID'),
    quantity: z.number().positive().describe('出库数量'),
    unit_price: z.number().optional().describe('单价（元）'),
    counterparty: z.string().optional().describe('客户/去向'),
    reference_no: z.string().optional().describe('单据号'),
    notes: z.string().optional().describe('备注'),
  },
  async ({ warehouse_id, material_id, quantity, unit_price, counterparty, reference_no, notes }) => {
    if (quantity > CONFIG.maxQtyPerOperation) {
      return { content: [{ type: 'text', text: `安全拦截：单次出库数量 ${quantity} 超过上限 ${CONFIG.maxQtyPerOperation}，请分批操作。` }] };
    }
    const [mat, wh] = await Promise.all([
      api('GET', `/api/materials/${material_id}`),
      api('GET', `/api/warehouses/${warehouse_id}`),
    ]);
    const matInfo = mat.material || mat;
    const whInfo = wh.warehouse || wh;
    if (mat.error) return { content: [{ type: 'text', text: `物料不存在: ${mat.message}` }] };
    if (wh.error) return { content: [{ type: 'text', text: `仓库不存在: ${wh.message}` }] };

    // 检查当前库存
    const invRes = await api('GET', `/api/warehouses/${warehouse_id}/inventory?q=${encodeURIComponent(matInfo.name)}`);
    const invItems = invRes.items || invRes.inventory || [];
    const invItem = invItems.find(i => i.material_id === material_id);
    const currentStock = invItem ? invItem.quantity : 0;

    let warning = '';
    if (quantity > currentStock) {
      warning = `\n\n🚫 库存不足！当前库存 ${currentStock} ${matInfo.unit}，请求出库 ${quantity}。此操作将被拒绝。`;
      return { content: [{ type: 'text', text: `出库预览失败:${warning}` }] };
    }
    if (quantity > currentStock * CONFIG.abnormalQtyRatio) {
      warning = `\n\n⚠️ 异常提醒：出库数量(${quantity})超过当前库存(${currentStock})的${CONFIG.abnormalQtyRatio * 100}%，请确认是否正确。`;
    }

    const desc = `出库操作：从 ${whInfo.name} 出库 ${matInfo.name}(${matInfo.code}) × ${quantity} ${matInfo.unit}（当前库存: ${currentStock}）` +
      (counterparty ? `，去向: ${counterparty}` : '') +
      (notes ? `，备注: ${notes}` : '');

    const opId = createPendingOp('stock_out', desc, {
      warehouse_id, material_id, quantity, unit_price, counterparty, reference_no, notes,
    });

    return {
      content: [{
        type: 'text',
        text: `📋 出库预览:\n\n${desc}${warning}\n\n操作编号: ${opId}\n\n⚠️ 请确认无误后调用 confirm_operation(operation_id="${opId}") 执行。`,
      }],
    };
  }
);

server.tool(
  'preview_transfer',
  '【预览】仓库间调拨。生成调拨预览信息，需确认后执行。',
  {
    material_id: z.number().describe('物料ID'),
    from_warehouse_id: z.number().describe('源仓库ID'),
    to_warehouse_id: z.number().describe('目标仓库ID'),
    quantity: z.number().positive().describe('调拨数量'),
    notes: z.string().optional().describe('备注'),
  },
  async ({ material_id, from_warehouse_id, to_warehouse_id, quantity, notes }) => {
    if (quantity > CONFIG.maxQtyPerOperation) {
      return { content: [{ type: 'text', text: `安全拦截：单次调拨数量 ${quantity} 超过上限 ${CONFIG.maxQtyPerOperation}。` }] };
    }
    const [mat, fromWh, toWh] = await Promise.all([
      api('GET', `/api/materials/${material_id}`),
      api('GET', `/api/warehouses/${from_warehouse_id}`),
      api('GET', `/api/warehouses/${to_warehouse_id}`),
    ]);
    const matInfo = mat.material || mat;
    const fromWhInfo = fromWh.warehouse || fromWh;
    const toWhInfo = toWh.warehouse || toWh;
    if (mat.error || fromWh.error || toWh.error) {
      return { content: [{ type: 'text', text: `参数错误: 物料或仓库不存在` }] };
    }

    const desc = `仓库调拨：${matInfo.name}(${matInfo.code}) × ${quantity} ${matInfo.unit}\n  从: ${fromWhInfo.name}\n  到: ${toWhInfo.name}` +
      (notes ? `\n  备注: ${notes}` : '');

    const opId = createPendingOp('transfer', desc, {
      materialId: material_id, fromWarehouseId: from_warehouse_id, toWarehouseId: to_warehouse_id, quantity, notes,
    });

    return {
      content: [{
        type: 'text',
        text: `📋 调拨预览:\n\n${desc}\n\n操作编号: ${opId}\n\n⚠️ 请确认无误后调用 confirm_operation(operation_id="${opId}") 执行。`,
      }],
    };
  }
);

server.tool(
  'preview_shipment',
  '【预览】创建发货单。生成预览信息，需确认后执行。',
  {
    warehouse_id: z.number().describe('出库仓库ID'),
    customer_name: z.string().describe('客户名称'),
    items: z.array(z.object({
      material_id: z.number().describe('物料ID'),
      quantity: z.number().positive().describe('数量'),
    })).min(1).describe('发货明细'),
    customer_contact: z.string().optional().describe('联系方式'),
    shipping_address: z.string().optional().describe('收货地址'),
    notes: z.string().optional().describe('备注'),
  },
  async ({ warehouse_id, customer_name, items, customer_contact, shipping_address, notes }) => {
    // 先检查库存
    const checkRes = await api('POST', '/api/shipments/check-stock', {
      warehouseId: warehouse_id,
      items: items.map(i => ({ materialId: i.material_id, quantity: i.quantity })),
    });

    let stockInfo = '';
    if (checkRes.shortages && checkRes.shortages.length > 0) {
      stockInfo = '\n\n🚫 库存不足，以下物料无法满足:\n' +
        checkRes.shortages.map(s => `  ${s.material_name}: 需要${s.required} 库存${s.available} 缺${s.shortage}`).join('\n');
      return { content: [{ type: 'text', text: `发货单预览失败:${stockInfo}` }] };
    }

    // 获取物料名称
    const matNames = {};
    for (const item of items) {
      const m = await api('GET', `/api/materials/${item.material_id}`);
      const mi = m.material || m;
      matNames[item.material_id] = m.error ? `ID:${item.material_id}` : `${mi.name}(${mi.code})`;
    }

    const wh = await api('GET', `/api/warehouses/${warehouse_id}`);
    const whInfo = wh.warehouse || wh;
    const desc = `创建发货单:\n  客户: ${customer_name}\n  出库仓: ${whInfo.name || warehouse_id}\n` +
      items.map(i => `  - ${matNames[i.material_id]} × ${i.quantity}`).join('\n') +
      (shipping_address ? `\n  地址: ${shipping_address}` : '') +
      (notes ? `\n  备注: ${notes}` : '');

    const opId = createPendingOp('shipment', desc, {
      warehouseId: warehouse_id,
      customerName: customer_name,
      customerContact: customer_contact,
      shippingAddress: shipping_address,
      notes,
      items: items.map(i => ({ materialId: i.material_id, quantity: i.quantity })),
    });

    return {
      content: [{
        type: 'text',
        text: `📋 发货单预览:\n\n${desc}\n\n操作编号: ${opId}\n\n⚠️ 请确认无误后调用 confirm_operation(operation_id="${opId}") 执行。`,
      }],
    };
  }
);

// ----------------------------------------------------------
// ✅ 确认执行
// ----------------------------------------------------------

server.tool(
  'confirm_operation',
  '确认并执行之前预览的操作。需要提供 preview 步骤返回的操作编号。',
  {
    operation_id: z.string().describe('操作编号（如 op_1）'),
  },
  async ({ operation_id }) => {
    // 频率限制
    const rateErr = checkRateLimit();
    if (rateErr) return { content: [{ type: 'text', text: rateErr }] };

    const op = pendingOps.get(operation_id);
    if (!op) {
      return { content: [{ type: 'text', text: `操作编号 ${operation_id} 不存在或已过期（5分钟有效期）。请重新预览。` }] };
    }

    let result;
    const d = op.executeData;

    switch (op.type) {
      case 'stock_in':
        result = await api('POST', `/api/warehouses/${d.warehouse_id}/stock-in`, {
          materialId: d.material_id,
          quantity: d.quantity,
          unitPrice: d.unit_price,
          counterparty: d.counterparty,
          referenceNo: d.reference_no,
          notes: `[AI操作] ${d.notes || ''}`.trim(),
        });
        break;

      case 'stock_out':
        result = await api('POST', `/api/warehouses/${d.warehouse_id}/stock-out`, {
          materialId: d.material_id,
          quantity: d.quantity,
          unitPrice: d.unit_price,
          counterparty: d.counterparty,
          referenceNo: d.reference_no,
          notes: `[AI操作] ${d.notes || ''}`.trim(),
        });
        break;

      case 'transfer':
        result = await api('POST', '/api/warehouses/transfer', {
          materialId: d.materialId,
          fromWarehouseId: d.fromWarehouseId,
          toWarehouseId: d.toWarehouseId,
          quantity: d.quantity,
          notes: `[AI操作] ${d.notes || ''}`.trim(),
        });
        break;

      case 'shipment':
        result = await api('POST', '/api/shipments', {
          warehouseId: d.warehouseId,
          customerName: d.customerName,
          customerContact: d.customerContact,
          shippingAddress: d.shippingAddress,
          notes: `[AI操作] ${d.notes || ''}`.trim(),
          items: d.items,
        });
        break;

      default:
        return { content: [{ type: 'text', text: `未知操作类型: ${op.type}` }] };
    }

    // 删除已执行的操作
    pendingOps.delete(operation_id);

    if (result.error) {
      return { content: [{ type: 'text', text: `❌ 执行失败: ${result.message}` }] };
    }

    return {
      content: [{
        type: 'text',
        text: `✅ 操作成功执行！\n\n${op.description}\n\n${result.shipment_no ? '发货单号: ' + result.shipment_no : ''}`,
      }],
    };
  }
);

server.tool(
  'list_pending_operations',
  '查看当前所有待确认的操作列表。',
  {},
  async () => {
    if (pendingOps.size === 0) {
      return { content: [{ type: 'text', text: '当前没有待确认的操作。' }] };
    }
    const items = [];
    for (const [id, op] of pendingOps) {
      items.push(`[${id}] ${op.type} | ${op.description} | 创建时间: ${op.createdAt}`);
    }
    return { content: [{ type: 'text', text: `待确认操作（${pendingOps.size}个）:\n\n${items.join('\n\n')}` }] };
  }
);

server.tool(
  'cancel_operation',
  '取消一个待确认的操作。',
  {
    operation_id: z.string().describe('操作编号'),
  },
  async ({ operation_id }) => {
    if (pendingOps.delete(operation_id)) {
      return { content: [{ type: 'text', text: `已取消操作 ${operation_id}。` }] };
    }
    return { content: [{ type: 'text', text: `操作 ${operation_id} 不存在或已过期。` }] };
  }
);

// ----------------------------------------------------------
// 🚀 启动
// ----------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('OvO System MCP Server 已启动');
  console.error(`API 地址: ${CONFIG.apiBase}`);
  console.error(`AI 账号: ${CONFIG.username}`);
  console.error(`工具数量: 22 个（15个只读 + 4个预览 + 3个操作管理）`);
}

main().catch(err => {
  console.error('MCP Server 启动失败:', err);
  process.exit(1);
});
