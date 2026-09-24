// 存储层：每次推导产生独立版本，只有完整成功后才切换当前指针；
// 写入中断后重启要么看到旧版本、要么看到完整新版本；
// 两位使用者从同一版本编辑时出现可解决的冲突。
import { DatabaseSync } from 'node:sqlite';
import { stableId } from '../core/id';

export interface VersionRow {
  id: string; parent: string | null; kind: string; label: string;
  params: string; conclusions: string | null; status: string; seq: number; created: string;
}
export interface EventRow { id: string; version: string; seq: number; kind: string; status: string; payload: string }
export interface DecisionRow { id: string; version: string; branch: string; selected: number; payload: string; seq: number }
export interface MaterialRow { id: string; kind: string; name: string; raw: string; hash: string; seq: number }

export const MIGRATIONS: string[] = [
  // v1：材料、版本、事件、当前指针、元信息
  `CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
   CREATE TABLE materials(id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, raw TEXT NOT NULL, hash TEXT NOT NULL, seq INTEGER NOT NULL);
   CREATE TABLE versions(id TEXT PRIMARY KEY, parent TEXT, kind TEXT NOT NULL, label TEXT NOT NULL, params TEXT NOT NULL, status TEXT NOT NULL, seq INTEGER NOT NULL, created TEXT NOT NULL);
   CREATE TABLE events(id TEXT PRIMARY KEY, version TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
   CREATE TABLE pointer(id INTEGER PRIMARY KEY CHECK(id = 1), version TEXT);`,
  // v2：人工决定（含互相冲突、未采纳候选保留）
  `CREATE TABLE decisions(id TEXT PRIMARY KEY, version TEXT NOT NULL, branch TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL, seq INTEGER NOT NULL);`,
  // v3：版本结论快照（回到旧事件时恢复当时可见结论，而不是最新计算）
  `ALTER TABLE versions ADD COLUMN conclusions TEXT;
   CREATE INDEX idx_events_version ON events(version, seq);`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  recover(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let v = row.user_version;
  while (v < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    v++;
  }
}

// 崩溃恢复：丢弃未完成的版本，指针只可能指向完整版本。
function recover(db: DatabaseSync): void {
  db.exec(`DELETE FROM events WHERE version IN (SELECT id FROM versions WHERE status = 'building')`);
  db.exec(`DELETE FROM decisions WHERE version IN (SELECT id FROM versions WHERE status = 'building')`);
  db.exec(`DELETE FROM versions WHERE status = 'building'`);
}

function nextSeq(db: DatabaseSync, table: string): number {
  const r = db.prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS s FROM ${table}`).get() as { s: number };
  return r.s;
}

export function putMaterial(db: DatabaseSync, m: { kind: string; name: string; raw: string }): string {
  const id = stableId('material', m.kind, m.name, m.raw);
  const existing = db.prepare('SELECT id FROM materials WHERE id = ?').get(id);
  if (!existing) {
    db.prepare('INSERT INTO materials(id, kind, name, raw, hash, seq) VALUES (?,?,?,?,?,?)')
      .run(id, m.kind, m.name, m.raw, stableId(m.raw), nextSeq(db, 'materials'));
  }
  return id;
}

export function beginVersion(db: DatabaseSync, v: { parent: string | null; kind: string; label: string; params: unknown }): string {
  const id = stableId('version', v.parent ?? 'root', v.kind, v.label, JSON.stringify(v.params), Date.now(), Math.random());
  db.prepare('INSERT INTO versions(id, parent, kind, label, params, status, seq, created) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, v.parent, v.kind, v.label, JSON.stringify(v.params), 'building', nextSeq(db, 'versions'), new Date().toISOString());
  return id;
}

export function appendEvent(db: DatabaseSync, versionId: string, e: { id?: string; kind: string; status: string; payload: unknown }): string {
  const id = e.id ?? stableId('event', versionId, e.kind, JSON.stringify(e.payload));
  db.prepare('INSERT OR IGNORE INTO events(id, version, seq, kind, status, payload) VALUES (?,?,?,?,?,?)')
    .run(id, versionId, nextSeq(db, 'events'), e.kind, e.status, JSON.stringify(e.payload));
  return id;
}

// 原子提交：版本状态与指针切换在同一事务内，中断只会留下旧指针或完整新版本。
export function completeVersion(db: DatabaseSync, versionId: string, conclusions: unknown): void {
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE versions SET status = 'complete', conclusions = ? WHERE id = ?`)
      .run(JSON.stringify(conclusions), versionId);
    db.prepare('INSERT INTO pointer(id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version')
      .run(versionId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function currentVersion(db: DatabaseSync): string | null {
  const r = db.prepare('SELECT version FROM pointer WHERE id = 1').get() as { version: string } | undefined;
  return r?.version ?? null;
}

export type SaveDecisionResult =
  | { ok: true; id: string }
  | { ok: false; conflict: true; currentVersion: string | null; incoming: unknown };

// 乐观并发：调用方声明自己基于哪个版本编辑；不一致时返回冲突，双方决定都保留可解决。
export function saveDecision(
  db: DatabaseSync,
  d: { baseVersion: string | null; branch: string; payload: unknown; selected?: boolean },
): SaveDecisionResult {
  const cur = currentVersion(db);
  if (d.baseVersion !== cur) {
    return { ok: false, conflict: true, currentVersion: cur, incoming: d.payload };
  }
  const id = stableId('decision', cur ?? 'none', d.branch, JSON.stringify(d.payload));
  db.prepare('INSERT OR IGNORE INTO decisions(id, version, branch, selected, payload, seq) VALUES (?,?,?,?,?,?)')
    .run(id, cur ?? '', d.branch, d.selected ? 1 : 0, JSON.stringify(d.payload), nextSeq(db, 'decisions'));
  return { ok: true, id };
}

// 冲突解决：把未选候选保留，切换 selected 指针到被采纳决定。
export function resolveDecision(db: DatabaseSync, branch: string, selectedId: string): void {
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE decisions SET selected = 0 WHERE branch = ?').run(branch);
    db.prepare('UPDATE decisions SET selected = 1 WHERE id = ? AND branch = ?').run(selectedId, branch);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function getVersion(db: DatabaseSync, id: string): VersionRow | undefined {
  return db.prepare('SELECT * FROM versions WHERE id = ?').get(id) as VersionRow | undefined;
}

export function listVersions(db: DatabaseSync): VersionRow[] {
  return db.prepare(`SELECT * FROM versions WHERE status = 'complete' ORDER BY seq`).all() as VersionRow[];
}

export function listEvents(db: DatabaseSync, versionId: string): EventRow[] {
  return db.prepare('SELECT * FROM events WHERE version = ? ORDER BY seq').all(versionId) as EventRow[];
}

export function listDecisions(db: DatabaseSync, branch?: string): DecisionRow[] {
  if (branch) return db.prepare('SELECT * FROM decisions WHERE branch = ? ORDER BY seq').all(branch) as DecisionRow[];
  return db.prepare('SELECT * FROM decisions ORDER BY seq').all() as DecisionRow[];
}

export function listMaterials(db: DatabaseSync): MaterialRow[] {
  return db.prepare('SELECT * FROM materials ORDER BY seq').all() as MaterialRow[];
}

// 导出 / 导入：身份为内容寻址，删除本地数据库再导入后身份、顺序、来源关系保持。
export function exportArchive(db: DatabaseSync): unknown {
  return {
    format: 'drat-proof-tracer/archive',
    schemaVersion: SCHEMA_VERSION,
    materials: listMaterials(db),
    versions: db.prepare('SELECT * FROM versions ORDER BY seq').all(),
    events: db.prepare('SELECT * FROM events ORDER BY seq').all(),
    decisions: db.prepare('SELECT * FROM decisions ORDER BY seq').all(),
    pointer: currentVersion(db),
  };
}

export function importArchive(db: DatabaseSync, data: any): void {
  db.exec('BEGIN');
  try {
    for (const m of data.materials ?? []) {
      db.prepare('INSERT OR IGNORE INTO materials(id, kind, name, raw, hash, seq) VALUES (?,?,?,?,?,?)')
        .run(m.id, m.kind, m.name, m.raw, m.hash, m.seq);
    }
    for (const v of data.versions ?? []) {
      db.prepare('INSERT OR IGNORE INTO versions(id, parent, kind, label, params, status, seq, created, conclusions) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(v.id, v.parent, v.kind, v.label, v.params, v.status, v.seq, v.created, v.conclusions ?? null);
    }
    for (const e of data.events ?? []) {
      db.prepare('INSERT OR IGNORE INTO events(id, version, seq, kind, status, payload) VALUES (?,?,?,?,?,?)')
        .run(e.id, e.version, e.seq, e.kind, e.status, e.payload);
    }
    for (const d of data.decisions ?? []) {
      db.prepare('INSERT OR IGNORE INTO decisions(id, version, branch, selected, payload, seq) VALUES (?,?,?,?,?,?)')
        .run(d.id, d.version, d.branch, d.selected, d.payload, d.seq);
    }
    if (data.pointer) {
      db.prepare('INSERT INTO pointer(id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version')
        .run(data.pointer);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
