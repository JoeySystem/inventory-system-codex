import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

let app;
let stopServer;
let tempDir;
let getDB;

describe('OvO System smoke tests', () => {
    beforeAll(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovo-system-test-'));
        const tempDbPath = path.join(tempDir, 'inventory.db');

        execFileSync(process.execPath, ['server/db/init.js'], {
            cwd: ROOT_DIR,
            env: {
                ...process.env,
                NODE_ENV: 'test',
                DB_PATH: tempDbPath,
                SESSION_DB_DIR: tempDir,
                SESSION_SECRET: 'test-session-secret'
            },
            stdio: 'ignore'
        });

        process.env.NODE_ENV = 'test';
        process.env.SKIP_SERVER_START = 'true';
        process.env.DB_PATH = tempDbPath;
        process.env.SESSION_DB_DIR = tempDir;
        process.env.SESSION_SECRET = 'test-session-secret';
        process.env.COOKIE_SECURE = 'false';

        vi.resetModules();
        ({ app, stopServer } = await import('../server/index.js'));
        ({ getDB } = await import('../server/db/database.js'));
    });

    afterAll(() => {
        if (typeof stopServer === 'function') {
            stopServer();
        }

        delete process.env.SKIP_SERVER_START;
        delete process.env.DB_PATH;
        delete process.env.SESSION_DB_DIR;
        delete process.env.SESSION_SECRET;
        delete process.env.COOKIE_SECURE;

        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('returns healthy status', async () => {
        const response = await request(app).get('/api/health');
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data.status).toBe('healthy');
    });

    it('can login and read protected endpoints', async () => {
        const agent = request.agent(app);

        const login = await agent
            .post('/api/auth/login')
            .send({ username: 'admin', password: 'admin123' });

        expect(login.status).toBe(200);
        expect(login.body.success).toBe(true);

        const me = await agent.get('/api/auth/me');
        expect(me.status).toBe(200);
        expect(me.body.data.user.username).toBe('admin');

        const users = await agent.get('/api/users');
        expect(users.status).toBe(200);
        expect(users.body.success).toBe(true);

        const warehouses = await agent.get('/api/warehouses');
        expect(warehouses.status).toBe(200);
        expect(warehouses.body.success).toBe(true);
    });

    it('returns deployment metadata', async () => {
        const response = await request(app).get('/api/meta');
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data.version).toBeTruthy();
        expect(response.body.data.gitCommit).toBeTruthy();
    });

    it('supports authenticated material export without crashing async routes', async () => {
        const agent = request.agent(app);
        const login = await agent
            .post('/api/auth/login')
            .send({ username: 'admin', password: 'admin123' });
        expect(login.status).toBe(200);

        const response = await agent
            .get('/api/data/export/materials')
            .query({ format: 'json' });

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('application/json');
        expect(Array.isArray(response.body)).toBe(true);
    });

    it('supports BOM naming governance summary', async () => {
        const agent = request.agent(app);
        const login = await agent
            .post('/api/auth/login')
            .send({ username: 'admin', password: 'admin123' });
        expect(login.status).toBe(200);

        const createBom = await agent
            .post('/api/boms')
            .send({
                name: '测试BOM(20260327).BOM',
                bomLevel: '模块',
                displayVersion: 'V01',
                status: 'active',
                items: []
            });

        expect(createBom.status).toBe(201);
        expect(createBom.body.success).toBe(true);
        expect(createBom.body.data.naming.namingStatus).toBe('non_compliant');

        const governance = await agent.get('/api/boms/naming-governance/summary');
        expect(governance.status).toBe(200);
        expect(governance.body.success).toBe(true);
        expect(governance.body.data.summary.total).toBeGreaterThan(0);
        expect(Array.isArray(governance.body.data.items)).toBe(true);
        expect(governance.body.data.items.some(item => item.name === '测试BOM(20260327).BOM')).toBe(true);
    });

    it('supports material naming governance summary', async () => {
        const agent = request.agent(app);
        const login = await agent
            .post('/api/auth/login')
            .send({ username: 'admin', password: 'admin123' });
        expect(login.status).toBe(200);

        const createMaterial = await agent
            .post('/api/materials')
            .send({
                name: '测试物料 最新版 2026-03-27',
                code: 'MAT-NAMING-001',
                baseUnit: '个',
                materialType: 'raw',
                lifecycleStatus: 'active'
            });

        expect(createMaterial.status).toBe(201);
        expect(createMaterial.body.success).toBe(true);

        const governance = await agent.get('/api/materials/naming-governance/summary');
        expect(governance.status).toBe(200);
        expect(governance.body.success).toBe(true);
        expect(governance.body.data.summary.total).toBeGreaterThan(0);
        expect(Array.isArray(governance.body.data.items)).toBe(true);
        const target = governance.body.data.items.find(item => item.code === 'MAT-NAMING-001');
        expect(target).toBeTruthy();
        expect(target.naming_status).not.toBe('compliant');
    });

    it('returns production exceptions list for authenticated users', async () => {
        const agent = request.agent(app);
        const login = await agent
            .post('/api/auth/login')
            .send({ username: 'admin', password: 'admin123' });
        expect(login.status).toBe(200);

        const response = await agent.get('/api/production/exceptions');
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(Array.isArray(response.body.data.items)).toBe(true);
    });

    it('passes preflight checks in the test environment', async () => {
        expect(() => {
            execFileSync(process.execPath, ['server/scripts/preflight.js'], {
                cwd: ROOT_DIR,
                env: {
                    ...process.env,
                    NODE_ENV: 'test',
                    DB_PATH: process.env.DB_PATH,
                    SESSION_DB_DIR: process.env.SESSION_DB_DIR,
                    SESSION_SECRET: process.env.SESSION_SECRET,
                    COOKIE_SECURE: 'false'
                },
                stdio: 'pipe'
            });
        }).not.toThrow();
    });

    it('fails preflight in production when SESSION_SECRET is weak', () => {
        expect(() => {
            execFileSync(process.execPath, ['server/scripts/preflight.js'], {
                cwd: ROOT_DIR,
                env: {
                    ...process.env,
                    NODE_ENV: 'production',
                    DB_PATH: process.env.DB_PATH,
                    SESSION_DB_DIR: process.env.SESSION_DB_DIR,
                    SESSION_SECRET: 'change-me',
                    COOKIE_SECURE: 'auto'
                },
                stdio: 'pipe'
            });
        }).toThrow();
    });

    it('runs receive stock-document lifecycle end to end', async () => {
        const agent = request.agent(app);
        const login = await agent
            .post('/api/auth/login')
            .send({ username: 'admin', password: 'admin123' });
        expect(login.status).toBe(200);

        const createMaterial = await agent
            .post('/api/materials')
            .send({
                name: '业务测试物料-收货流程',
                code: 'MAT-WF-RCV-001',
                baseUnit: 'PCS',
                materialType: 'raw',
                lifecycleStatus: 'active'
            });

        expect(createMaterial.status).toBe(201);
        const materialId = createMaterial.body.data.id;

        const warehouses = await agent.get('/api/warehouses');
        expect(warehouses.status).toBe(200);
        const warehouse = warehouses.body.data.warehouses[0];
        expect(warehouse).toBeTruthy();

        const draft = await agent.post('/api/stock-documents').send({
            docType: 'receive_execution',
            warehouseId: warehouse.id,
            counterparty: '流程测试供应商',
            referenceNo: 'WF-RCV-001',
            notes: '业务链路测试-收货',
            items: [{
                materialId,
                quantity: 5,
                unitPrice: 12.5
            }]
        });

        expect(draft.status).toBe(201);
        const documentId = draft.body.data.document.id;
        expect(draft.body.data.document.documentStatus).toBe('draft');

        const submit = await agent.post(`/api/stock-documents/${documentId}/submit`).send({});
        expect(submit.status).toBe(200);
        const execute = await agent.post(`/api/stock-documents/${documentId}/execute`).send({});
        expect(execute.status).toBe(200);
        const post = await agent.post(`/api/stock-documents/${documentId}/post`).send({});
        expect(post.status).toBe(200);
        expect(post.body.data.document.documentStatus).toBe('posted');

        const list = await agent.get('/api/stock-documents').query({ referenceNo: 'WF-RCV-001' });
        expect(list.status).toBe(200);
        expect(list.body.data.items.some(item => item.id === documentId && item.documentStatus === 'posted')).toBe(true);

        const detail = await agent.get(`/api/stock-documents/${documentId}`);
        expect(detail.status).toBe(200);
        expect(detail.body.data.document.documentStatus).toBe('posted');
        expect(detail.body.data.document.totalAmount).toBeCloseTo(62.5, 5);
        expect(detail.body.data.document.items).toHaveLength(1);
    });

    it('supports production exception governance end to end', async () => {
        const agent = request.agent(app);
        const login = await agent
            .post('/api/auth/login')
            .send({ username: 'admin', password: 'admin123' });
        expect(login.status).toBe(200);

        const outputMaterial = await agent
            .post('/api/materials')
            .send({
                name: '业务测试产出物料',
                code: 'MAT-WF-PEX-OUT',
                baseUnit: 'PCS',
                materialType: 'finished',
                lifecycleStatus: 'active'
            });
        expect(outputMaterial.status).toBe(201);

        const exceptionMaterial = await agent
            .post('/api/materials')
            .send({
                name: '业务测试异常物料',
                code: 'MAT-WF-PEX-MAT',
                baseUnit: 'PCS',
                materialType: 'raw',
                lifecycleStatus: 'active'
            });
        expect(exceptionMaterial.status).toBe(201);

        const warehouses = await agent.get('/api/warehouses');
        const warehouse = warehouses.body.data.warehouses[0];
        const db = getDB();

        const sopId = db.prepare(`
            INSERT INTO sops (title, version, created_by)
            VALUES (?, '1.0', 1)
        `).run('业务链路测试SOP').lastInsertRowid;

        const orderId = db.prepare(`
            INSERT INTO production_orders (
                order_no, sop_id, warehouse_id, output_material_id, planned_quantity, status,
                sop_snapshot_json, workorder_snapshot_json, created_by
            ) VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?, 1)
        `).run(
            'PO-WF-001',
            sopId,
            warehouse.id,
            outputMaterial.body.data.id,
            10,
            JSON.stringify({ title: '业务链路测试SOP', version: '1.0', materials: [] }),
            JSON.stringify({ plannedQuantity: 10, warehouseId: warehouse.id, outputMaterialId: outputMaterial.body.data.id })
        ).lastInsertRowid;

        const createException = await agent.post(`/api/production/${orderId}/exceptions`).send({
            type: 'variance',
            direction: 'in',
            materialId: exceptionMaterial.body.data.id,
            quantity: 2,
            notes: '业务链路测试异常'
        });

        expect(createException.status).toBe(201);
        const exceptionId = createException.body.data.exception.id;
        expect(createException.body.data.exception.document.documentStatus).toBe('posted');

        const governance = await agent.post(`/api/production/exceptions/${exceptionId}/governance`).send({
            status: 'in_progress',
            owner: '仓库主管A',
            notes: '待生成补料采购任务'
        });

        expect(governance.status).toBe(200);
        expect(governance.body.data.item.governanceStatus).toBe('in_progress');

        const list = await agent.get('/api/production/exceptions').query({
            governanceStatus: 'in_progress',
            owner: '仓库主管A'
        });
        expect(list.status).toBe(200);
        expect(Array.isArray(list.body.data.items)).toBe(true);
        expect(list.body.data.items.some(item => item.id === exceptionId && item.governanceOwner === '仓库主管A')).toBe(true);
        expect((list.body.data.governanceSummary || []).some(item => item.status === 'in_progress' && Number(item.count) >= 1)).toBe(true);

        const detail = await agent.get(`/api/production/exceptions/${exceptionId}`);
        expect(detail.status).toBe(200);
        expect(detail.body.data.item.governanceStatus).toBe('in_progress');
        expect(detail.body.data.item.governanceNotes).toContain('补料采购任务');
    });
});
