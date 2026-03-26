/**
 * SOP（标准操作流程）路由
 * GET    /api/sops              - 列表（支持拼音搜索）
 * GET    /api/sops/:id          - 详情（含步骤+物料清单）
 * POST   /api/sops              - 创建
 * PUT    /api/sops/:id          - 更新
 * DELETE /api/sops/:id          - 删除（软删除）
 * POST   /api/sops/:id/duplicate - 复制 SOP
 */

const express = require('express');
const { getDB } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { generatePinyinFields, buildSearchCondition } = require('../utils/pinyin');
const { logOperation } = require('../utils/logger');
const { ValidationError, NotFoundError } = require('../utils/errors');

const router = express.Router();
router.use(requireAuth);

function getSupplyModeMeta(mode) {
    const map = {
        purchase_only: { label: '采购入库后领用', hint: '先采购收货入库，再按单据领用。' },
        direct_issue: { label: '库存现成件直接领用', hint: '库内现成件可直接发料，不需要前置工单。' },
        prebuild_wip: { label: '先做半成品再领用', hint: '应先由前置工单做成半成品，再在当前工艺中领用。' },
        on_site_fabrication: { label: '当前工单现场加工', hint: '仓库发出原材，车间在当前工艺内裁剪、焊接或装配。' }
    };
    return map[mode] || map.direct_issue;
}

function findSopSnapshotReferences(db, sopId) {
    const sql = `
        SELECT id, order_no, status
        FROM production_orders
        WHERE sop_snapshot_json IS NOT NULL
          AND json_valid(sop_snapshot_json)
          AND CAST(json_extract(sop_snapshot_json, '$.sourceSopId') AS INTEGER) = ?
        ORDER BY id DESC
    `;

    try {
        return db.prepare(sql).all(Number(sopId));
    } catch (error) {
        const message = String(error?.message || '');
        if (!/json_extract|json_valid|malformed JSON|no such function/i.test(message)) {
            throw error;
        }

        const rows = db.prepare(`
            SELECT id, order_no, status, sop_snapshot_json
            FROM production_orders
            WHERE sop_snapshot_json IS NOT NULL
        `).all();

        return rows
            .filter(row => {
                try {
                    const snapshot = JSON.parse(row.sop_snapshot_json);
                    return Number(snapshot?.sourceSopId) === Number(sopId);
                } catch {
                    return false;
                }
            })
            .map(({ id, order_no, status }) => ({ id, order_no, status }));
    }
}

/**
 * GET /api/sops
 */
router.get('/', requirePermission('sops', 'view'), (req, res) => {
    const db = getDB();
    const { search, category, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let whereClauses = ['s.is_active = 1'];
    let params = [];

    if (search) {
        const sc = buildSearchCondition(search, {
            nameField: 's.title',
            pinyinField: 's.title_pinyin',
            abbrField: 's.title_pinyin_abbr',
            codeField: null
        });
        whereClauses.push(sc.where);
        params.push(...sc.params);
    }
    if (category) {
        whereClauses.push('s.category = ?');
        params.push(category);
    }

    const whereSQL = whereClauses.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) as cnt FROM sops s WHERE ${whereSQL}`).get(...params).cnt;

    const sops = db.prepare(`
        SELECT s.*, u.display_name as creator_name,
               (SELECT COUNT(*) FROM sop_steps WHERE sop_id = s.id) as step_count,
               (SELECT COUNT(*) FROM sop_materials WHERE sop_id = s.id) as material_count
        FROM sops s
        LEFT JOIN users u ON s.created_by = u.id
        WHERE ${whereSQL}
        ORDER BY s.updated_at DESC
        LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    // 获取所有 SOP 分类
    const categories = db.prepare(
        "SELECT DISTINCT category FROM sops WHERE is_active = 1 AND category IS NOT NULL AND category != '' ORDER BY category"
    ).all().map(r => r.category);

    res.json({
        success: true,
        data: {
            sops,
            categories,
            pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) }
        }
    });
});

/**
 * GET /api/sops/:id
 */
router.get('/:id', requirePermission('sops', 'view'), (req, res) => {
    const db = getDB();
    const sop = db.prepare(`
        SELECT s.*, u.display_name as creator_name
        FROM sops s
        LEFT JOIN users u ON s.created_by = u.id
        WHERE s.id = ? AND s.is_active = 1
    `).get(req.params.id);

    if (!sop) throw new NotFoundError('SOP');

    const steps = db.prepare(
        'SELECT * FROM sop_steps WHERE sop_id = ? ORDER BY step_number'
    ).all(sop.id);

    const materials = db.prepare(`
        SELECT sm.*, m.name as material_name, m.code as material_code, m.unit, m.spec,
               m.material_type, m.supply_mode,
               st.step_number, st.title as step_title
        FROM sop_materials sm
        JOIN materials m ON sm.material_id = m.id
        LEFT JOIN sop_steps st ON sm.step_id = st.id
        WHERE sm.sop_id = ?
        ORDER BY sm.step_id, m.name
    `).all(sop.id);

    // 计算单个成品的总物料需求
    const totalMaterialCost = materials.reduce((sum, m) => {
        const mat = db.prepare('SELECT cost_price FROM materials WHERE id = ?').get(m.material_id);
        return sum + (mat ? mat.cost_price * m.quantity_per_unit : 0);
    }, 0);

    const enrichedMaterials = materials.map(item => ({
        ...item,
        allow_substitution: Boolean(item.allow_substitution),
        substitution_priority: Number(item.substitution_priority || 1),
        supply_mode_label: getSupplyModeMeta(item.supply_mode).label,
        supply_mode_hint: getSupplyModeMeta(item.supply_mode).hint
    }));

    res.json({
        success: true,
        data: { sop, steps, materials: enrichedMaterials, totalMaterialCost }
    });
});

/**
 * POST /api/sops
 */
router.post('/', requirePermission('sops', 'add'), (req, res) => {
    const db = getDB();
    const { title, version, category, description, steps = [], materials = [] } = req.body;

    if (!title?.trim()) throw new ValidationError('SOP标题不能为空');

    const { fullPinyin, abbr } = generatePinyinFields(title);

    const insertSop = db.transaction(() => {
        const result = db.prepare(`
            INSERT INTO sops (title, title_pinyin, title_pinyin_abbr, version, category, description, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(title.trim(), fullPinyin, abbr, version || '1.0', category || null, description || null, req.session.user.id);

        const sopId = result.lastInsertRowid;

        // 插入步骤
        const stmtStep = db.prepare(`
            INSERT INTO sop_steps (sop_id, step_number, title, description, duration_minutes, notes)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        const stepIdMap = {};
        steps.forEach((step, idx) => {
            const stepResult = stmtStep.run(sopId, idx + 1, step.title, step.description || null, step.duration_minutes || null, step.notes || null);
            stepIdMap[idx] = stepResult.lastInsertRowid;
        });

        // 插入物料清单
        const stmtMat = db.prepare(`
            INSERT INTO sop_materials (sop_id, material_id, quantity_per_unit, step_id, allow_substitution, substitution_priority, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        materials.forEach(mat => {
            const stepId = mat.stepIndex !== undefined && mat.stepIndex !== null ? stepIdMap[mat.stepIndex] : null;
            stmtMat.run(sopId, mat.materialId, mat.quantityPerUnit || 1, stepId || null, mat.allowSubstitution ? 1 : 0, mat.substitutionPriority || 1, mat.notes || null);
        });

        return sopId;
    });

    const sopId = insertSop();

    logOperation({
        userId: req.session.user.id,
        action: 'create',
        resource: 'sops',
        resourceId: sopId,
        detail: `创建SOP: ${title}`,
        ip: req.ip
    });

    res.status(201).json({ success: true, data: { id: sopId } });
});

/**
 * PUT /api/sops/:id
 */
router.put('/:id', requirePermission('sops', 'edit'), (req, res) => {
    const db = getDB();
    const sop = db.prepare('SELECT * FROM sops WHERE id = ? AND is_active = 1').get(req.params.id);
    if (!sop) throw new NotFoundError('SOP');

    const { title, version, category, description, steps, materials } = req.body;
    if (!title?.trim()) throw new ValidationError('SOP标题不能为空');

    const { fullPinyin, abbr } = generatePinyinFields(title);

    const updateSop = db.transaction(() => {
        db.prepare(`
            UPDATE sops SET title = ?, title_pinyin = ?, title_pinyin_abbr = ?,
            version = ?, category = ?, description = ?, updated_at = datetime('now', 'localtime')
            WHERE id = ?
        `).run(title.trim(), fullPinyin, abbr, version || sop.version, category || null, description || null, sop.id);

        // 如果提供了步骤，替换全部
        if (steps) {
            db.prepare('DELETE FROM sop_steps WHERE sop_id = ?').run(sop.id);
            const stmtStep = db.prepare(`
                INSERT INTO sop_steps (sop_id, step_number, title, description, duration_minutes, notes)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            const stepIdMap = {};
            steps.forEach((step, idx) => {
                const r = stmtStep.run(sop.id, idx + 1, step.title, step.description || null, step.duration_minutes || null, step.notes || null);
                stepIdMap[idx] = r.lastInsertRowid;
            });

            // 如果同时提供了物料，也替换
            if (materials) {
                db.prepare('DELETE FROM sop_materials WHERE sop_id = ?').run(sop.id);
                const stmtMat = db.prepare(`
                    INSERT INTO sop_materials (sop_id, material_id, quantity_per_unit, step_id, allow_substitution, substitution_priority, notes)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `);
                materials.forEach(mat => {
                    const stepId = mat.stepIndex !== undefined && mat.stepIndex !== null ? stepIdMap[mat.stepIndex] : null;
                    stmtMat.run(sop.id, mat.materialId, mat.quantityPerUnit || 1, stepId || null, mat.allowSubstitution ? 1 : 0, mat.substitutionPriority || 1, mat.notes || null);
                });
            }
        } else if (materials) {
            // 只更新物料
            db.prepare('DELETE FROM sop_materials WHERE sop_id = ?').run(sop.id);
            const stmtMat = db.prepare(`
                INSERT INTO sop_materials (sop_id, material_id, quantity_per_unit, step_id, allow_substitution, substitution_priority, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            materials.forEach(mat => {
                stmtMat.run(sop.id, mat.materialId, mat.quantityPerUnit || 1, mat.stepId || null, mat.allowSubstitution ? 1 : 0, mat.substitutionPriority || 1, mat.notes || null);
            });
        }
    });

    updateSop();

    logOperation({
        userId: req.session.user.id, action: 'update', resource: 'sops',
        resourceId: sop.id, detail: `更新SOP: ${title}`, ip: req.ip
    });

    res.json({ success: true, data: { id: sop.id } });
});

/**
 * DELETE /api/sops/:id (soft)
 */
router.delete('/:id', requirePermission('sops', 'delete'), (req, res) => {
    const db = getDB();
    const sop = db.prepare('SELECT * FROM sops WHERE id = ? AND is_active = 1').get(req.params.id);
    if (!sop) throw new NotFoundError('SOP');

    const snapshotRefs = findSopSnapshotReferences(db, sop.id);
    if (snapshotRefs.length > 0) {
        const sampleOrders = snapshotRefs.slice(0, 5).map(order => order.order_no).join('、');
        throw new ValidationError(`该SOP已被 ${snapshotRefs.length} 张工单快照引用${sampleOrders ? `（${sampleOrders}）` : ''}，无法删除`);
    }

    // 检查是否有关联的进行中生产工单
    const activeOrders = db.prepare(
        "SELECT COUNT(*) as cnt FROM production_orders WHERE sop_id = ? AND status IN ('planned', 'in_progress')"
    ).get(sop.id).cnt;
    if (activeOrders > 0) throw new ValidationError(`该SOP有 ${activeOrders} 个进行中的生产工单，无法删除`);

    db.prepare("UPDATE sops SET is_active = 0, updated_at = datetime('now','localtime') WHERE id = ?").run(sop.id);

    logOperation({
        userId: req.session.user.id, action: 'delete', resource: 'sops',
        resourceId: sop.id, detail: `删除SOP: ${sop.title}`, ip: req.ip
    });

    res.json({ success: true });
});

/**
 * POST /api/sops/:id/duplicate
 */
router.post('/:id/duplicate', requirePermission('sops', 'add'), (req, res) => {
    const db = getDB();
    const sop = db.prepare('SELECT * FROM sops WHERE id = ? AND is_active = 1').get(req.params.id);
    if (!sop) throw new NotFoundError('SOP');

    const newTitle = sop.title + ' (副本)';
    const { fullPinyin, abbr } = generatePinyinFields(newTitle);

    const dupSop = db.transaction(() => {
        const r = db.prepare(`
            INSERT INTO sops (title, title_pinyin, title_pinyin_abbr, version, category, description, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(newTitle, fullPinyin, abbr, sop.version, sop.category, sop.description, req.session.user.id);

        const newId = r.lastInsertRowid;

        // 复制步骤
        const oldSteps = db.prepare('SELECT * FROM sop_steps WHERE sop_id = ? ORDER BY step_number').all(sop.id);
        const stepMap = {};
        const stmtStep = db.prepare('INSERT INTO sop_steps (sop_id, step_number, title, description, duration_minutes, notes) VALUES (?,?,?,?,?,?)');
        oldSteps.forEach(s => {
            const sr = stmtStep.run(newId, s.step_number, s.title, s.description, s.duration_minutes, s.notes);
            stepMap[s.id] = sr.lastInsertRowid;
        });

        // 复制物料
        const oldMats = db.prepare('SELECT * FROM sop_materials WHERE sop_id = ?').all(sop.id);
        const stmtMat = db.prepare('INSERT INTO sop_materials (sop_id, material_id, quantity_per_unit, step_id, allow_substitution, substitution_priority, notes) VALUES (?,?,?,?,?,?,?)');
        oldMats.forEach(m => {
            stmtMat.run(newId, m.material_id, m.quantity_per_unit, m.step_id ? stepMap[m.step_id] : null, m.allow_substitution ? 1 : 0, m.substitution_priority || 1, m.notes);
        });

        return newId;
    });

    const newId = dupSop();

    logOperation({
        userId: req.session.user.id, action: 'create', resource: 'sops',
        resourceId: newId, detail: `复制SOP: ${sop.title} → ${newTitle}`, ip: req.ip
    });

    res.status(201).json({ success: true, data: { id: newId } });
});

module.exports = router;
