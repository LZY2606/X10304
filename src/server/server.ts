// API：把数据、派生和裁定连在一起。作为 Vite 中间件挂载，也可独立启动。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import {
  currentVersion, exportArchive, getVersion, importArchive, listDecisions, listEvents,
  listMaterials, listVersions, openDb, resolveDecision, saveDecision,
} from './db';
import { buildArchive, buildCase, applyEdit } from './archive';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const DB_PATH = join(DATA_DIR, 'app.db');

let cached: { db: DatabaseSync } | null = null;

export function getDb(): DatabaseSync {
  if (!cached) {
    mkdirSync(DATA_DIR, { recursive: true });
    const fresh = !existsSync(DB_PATH);
    const db = openDb(DB_PATH);
    if (fresh || listVersions(db).length === 0) buildArchive(db);
    cached = { db };
  }
  return cached.db;
}

function send(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(s);
}

async function body(req: IncomingMessage): Promise<any> {
  let s = '';
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

function versionView(db: DatabaseSync, id: string) {
  const v = getVersion(db, id);
  if (!v) return null;
  return {
    ...v,
    params: JSON.parse(v.params),
    conclusions: v.conclusions ? JSON.parse(v.conclusions) : null,
    events: listEvents(db, id).map(e => ({ ...e, payload: JSON.parse(e.payload) })),
  };
}

export function createApiHandler(db: DatabaseSync) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (!path.startsWith('/api/')) return next();
    try {
      if (path === '/api/archive' && req.method === 'GET') {
        const versions = listVersions(db).map(v => ({
          ...v, params: JSON.parse(v.params),
          conclusions: v.conclusions ? JSON.parse(v.conclusions) : null,
        }));
        return send(res, 200, {
          versions,
          current: currentVersion(db),
          materials: listMaterials(db).map(m => ({ ...m, raw: undefined, rawLength: m.raw.length })),
          decisions: listDecisions(db).map(d => ({ ...d, payload: JSON.parse(d.payload) })),
        });
      }
      if (path === '/api/materials' && req.method === 'GET') {
        return send(res, 200, listMaterials(db));
      }
      const vm = path.match(/^\/api\/versions\/([0-9a-f]+)$/);
      if (vm && req.method === 'GET') {
        const view = versionView(db, vm[1]);
        return view ? send(res, 200, view) : send(res, 404, { error: 'version not found' });
      }
      if (path === '/api/decisions' && req.method === 'POST') {
        const b = await body(req);
        const r = saveDecision(db, { baseVersion: b.baseVersion ?? null, branch: b.branch, payload: b.payload, selected: b.selected });
        return send(res, r.ok ? 200 : 409, r);
      }
      if (path === '/api/decisions/resolve' && req.method === 'POST') {
        const b = await body(req);
        resolveDecision(db, b.branch, b.selectedId);
        return send(res, 200, { ok: true, decisions: listDecisions(db, b.branch) });
      }
      // 参数调整 / 源数据改动 → 新的事件与版本（不覆盖历史）
      if (path === '/api/derive' && req.method === 'POST') {
        const b = await body(req);
        const parent = getVersion(db, b.baseVersion);
        if (!parent) return send(res, 404, { error: 'base version not found' });
        const materials = listMaterials(db);
        const params = JSON.parse(parent.params);
        const cnfMat = materials.find(m => m.id === params.cnfMaterial);
        const proofMat = materials.find(m => m.id === params.proofMaterial);
        if (!cnfMat || !proofMat) return send(res, 500, { error: 'materials missing' });
        const edited = applyEdit(proofMat.raw, { budget: params.budget }, b.edit);
        const c = buildCase(db, {
          parent: parent.id, kind: b.kind ?? 'derived', label: b.label ?? `derived-${Date.now()}`,
          cnfText: cnfMat.raw, proofText: edited.proofText, params: edited.params,
        });
        return send(res, 200, { versionId: c.versionId, verdict: c.result.verdict, recompute: c.recompute ?? null });
      }
      if (path === '/api/export' && req.method === 'GET') {
        return send(res, 200, exportArchive(db));
      }
      if (path === '/api/import' && req.method === 'POST') {
        const b = await body(req);
        importArchive(db, b);
        return send(res, 200, { ok: true, current: currentVersion(db) });
      }
      if (path === '/api/reset' && req.method === 'POST') {
        // 删除本地数据库并重建（演示导出→删除→导入路径用）
        cached = null;
        db.close();
        unlinkSync(DB_PATH);
        const fresh = openDb(DB_PATH);
        buildArchive(fresh);
        cached = { db: fresh };
        return send(res, 200, { ok: true });
      }
      // 九十秒样例路径：来源 → 异常 → 分支 → 重放
      if (path === '/api/sample' && req.method === 'GET') {
        const versions = listVersions(db);
        const byLabel = (l: string) => versions.find(v => v.label === l);
        return send(res, 200, {
          stops: [
            { id: 'source', title: '来源：基线导入保留全部原始表示', versionLabel: 'baseline', focus: 'source' },
            { id: 'anomaly', title: '异常：RAT pivot 首选不成立 / 最短失败前缀', versionLabel: 'rat_pivot', focus: 'anomaly' },
            { id: 'branch', title: '分支：冲突决定与未采纳候选', versionLabel: 'rat_pivot', focus: 'branch' },
            { id: 'replay', title: '重放：预算耗尽不是证明无效', versionLabel: 'budget_exhausted', focus: 'replay' },
          ].map(s => ({ ...s, versionId: byLabel(s.versionLabel)?.id ?? null })),
        });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 500, { error: String(e) });
    }
  };
}

export function apiPlugin() {
  return {
    name: 'drat-proof-tracer-api',
    configureServer(server: any) {
      const handler = createApiHandler(getDb());
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        void handler(req, res, next);
      });
    },
  };
}
