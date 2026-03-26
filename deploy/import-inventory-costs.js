const path = require('path');
const ExcelJS = require('exceljs');
const Database = require('better-sqlite3');
const { getDbPath } = require('../server/config/paths');

const EXCEL_PATH = process.argv[2];
const DB_PATH = process.argv[3] || getDbPath();
const COST_SOURCE = 'inventory_excel_20260319';

if (!EXCEL_PATH) {
  console.error('Usage: node deploy/import-inventory-costs.js <excel-path> [db-path]');
  process.exit(1);
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const normalized = String(value)
    .trim()
    .replace(/,/g, '')
    .replace(/\s*(包|件)$/, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function buildColumnMap(header1, header2) {
  const map = new Map();
  const maxCellCount = Math.max(header1.cellCount || 0, header2.cellCount || 0);
  for (let i = 1; i <= maxCellCount; i += 1) {
    const key1 = normalizeText(header1.getCell(i).value);
    const key2 = normalizeText(header2.getCell(i).value);
    const composite = [key1, key2].filter(Boolean).join('/');
    if (key1) map.set(key1, i);
    if (key2) map.set(key2, i);
    if (composite) map.set(composite, i);
  }
  return map;
}

async function loadWorkbookRows(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  const columnMap = buildColumnMap(worksheet.getRow(5), worksheet.getRow(6));
  const getColumn = (...keys) => {
    for (const key of keys) {
      const index = columnMap.get(key);
      if (index) return index;
    }
    throw new Error(`Missing Excel column: ${keys.join(' | ')}`);
  };

  const codeCol = getColumn('商品编号');
  const nameCol = getColumn('商品名称');
  const avgCostCol = getColumn('成本均价', '财务库存数据/成本均价');
  const inventoryAmountCol = getColumn('库存金额', '财务库存数据/库存金额');
  const bookStockCol = getColumn('财务库存数据/账面库存', '账面库存');
  const retailPriceCol = getColumn('零售价');
  const presetPriceCol = getColumn('预设售价1', '预估收益/预设售价1');

  const rows = [];
  for (let rowNumber = 7; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const code = normalizeText(row.getCell(codeCol).value);
    const name = normalizeText(row.getCell(nameCol).value);
    const avgCost = toNumber(row.getCell(avgCostCol).value);
    const inventoryAmount = toNumber(row.getCell(inventoryAmountCol).value);
    const bookStock = toNumber(row.getCell(bookStockCol).value);
    const retailPrice = toNumber(row.getCell(retailPriceCol).value);
    const presetPrice = toNumber(row.getCell(presetPriceCol).value);

    if (!code && !name) continue;
    if (!avgCost && !inventoryAmount && !retailPrice && !presetPrice) continue;

    let unitCost = avgCost;
    if (!unitCost && inventoryAmount && bookStock) {
      unitCost = inventoryAmount / bookStock;
    }
    if (!unitCost) continue;

    rows.push({
      code,
      name,
      unitCost: Number(unitCost.toFixed(6)),
      inventoryAmount: Number(inventoryAmount.toFixed(2)),
      salePrice: presetPrice > 0 ? presetPrice : retailPrice > 0 ? retailPrice : 0,
    });
  }
  return rows;
}

async function main() {
  const db = new Database(DB_PATH);
  const sourceRows = await loadWorkbookRows(EXCEL_PATH);
  const materials = db.prepare(`
    SELECT id, code, name, cost_price, sale_price
    FROM materials
    WHERE is_active = 1
  `).all();

  const byCode = new Map(materials.filter((m) => m.code).map((m) => [normalizeText(m.code), m]));
  const byName = new Map(materials.filter((m) => m.name).map((m) => [normalizeText(m.name), m]));

  const updateStmt = db.prepare(`
    UPDATE materials
    SET cost_price = @costPrice,
        standard_cost = @costPrice,
        avg_cost = @costPrice,
        sale_price = CASE
          WHEN @salePrice > 0 THEN @salePrice
          ELSE sale_price
        END,
        cost_source = @costSource,
        cost_updated_at = @updatedAt,
        updated_at = @updatedAt
    WHERE id = @id
  `);

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const stats = {
    sourceRows: sourceRows.length,
    matchedByCode: 0,
    matchedByName: 0,
    updated: 0,
    unmatched: 0,
  };
  const unmatched = [];

  const transaction = db.transaction(() => {
    for (const row of sourceRows) {
      let material = byCode.get(row.code);
      if (material) {
        stats.matchedByCode += 1;
      } else {
        material = byName.get(row.name);
        if (material) {
          stats.matchedByName += 1;
        } else {
          stats.unmatched += 1;
          if (unmatched.length < 20) unmatched.push({ code: row.code, name: row.name, cost: row.unitCost });
          continue;
        }
      }

      updateStmt.run({
        id: material.id,
        costPrice: row.unitCost,
        salePrice: row.salePrice,
        costSource: COST_SOURCE,
        updatedAt: now,
      });
      stats.updated += 1;
    }
  });

  transaction();

  const post = db.prepare(`
    SELECT
      COUNT(*) AS totalMaterials,
      SUM(CASE WHEN IFNULL(cost_price, 0) > 0 THEN 1 ELSE 0 END) AS costPriceFilled,
      SUM(CASE WHEN IFNULL(sale_price, 0) > 0 THEN 1 ELSE 0 END) AS salePriceFilled,
      ROUND(SUM(IFNULL(i.quantity, 0) * IFNULL(m.cost_price, 0)), 2) AS inventoryValue
    FROM materials m
    LEFT JOIN inventory i ON i.material_id = m.id
    WHERE m.is_active = 1
  `).get();

  console.log(JSON.stringify({
    excelPath: EXCEL_PATH,
    dbPath: DB_PATH,
    costSource: COST_SOURCE,
    stats,
    post,
    unmatchedSample: unmatched,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
