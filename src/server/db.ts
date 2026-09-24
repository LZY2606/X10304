import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 2;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function metaGet(db: DatabaseSync, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  } catch {
    return null;
  }
}

/** Forward-only migrations. Old databases are upgraded in place, data preserved. */
export function migrate(db: DatabaseSync): void {
  let version = Number(metaGet(db, 'schema_version') ?? '0');
  if (version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
        content TEXT NOT NULL, hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cases (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL, created_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY, case_id TEXT NOT NULL, seq INTEGER NOT NULL,
        parent_id TEXT, note TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, case_id TEXT NOT NULL, seq INTEGER NOT NULL,
        version_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS case_pointer (case_id TEXT PRIMARY KEY, version_id TEXT NOT NULL);
    `);
    version = 1;
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1');
  }
  if (version < 2) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS derivations (
        id TEXT PRIMARY KEY, case_id TEXT NOT NULL, version_id TEXT NOT NULL, version_seq INTEGER NOT NULL,
        dkey TEXT NOT NULL, inputs TEXT NOT NULL, status TEXT NOT NULL,
        result TEXT NOT NULL, explanation TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conflicts (
        id TEXT PRIMARY KEY, case_id TEXT NOT NULL, base_version_id TEXT NOT NULL,
        candidates TEXT NOT NULL, status TEXT NOT NULL, resolution TEXT
      );
    `);
    const cols = db.prepare("SELECT name FROM pragma_table_info('events')").all() as { name: string }[];
    if (!cols.some((c) => c.name === 'payload_hash')) {
      db.exec("ALTER TABLE events ADD COLUMN payload_hash TEXT NOT NULL DEFAULT ''");
    }
    version = 2;
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', '2');
  }
}
