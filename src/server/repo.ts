import { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.js';
import { stableId } from '../core/ids.js';
import { AppEvent, Derivation, DerivationInput, EventKind, makeEvent } from '../core/events.js';

export interface DocumentRow { id: string; kind: string; name: string; content: string; hash: string }
export interface VersionRow { id: string; case_id: string; seq: number; parent_id: string | null; note: string; created_at: string }
export interface ConflictRow { id: string; case_id: string; base_version_id: string; candidates: string; status: string; resolution: string | null }

export interface CommitSpec {
  caseId: string;
  baseVersionId: string | null;
  note: string;
  events: { kind: EventKind; payload: unknown }[];
  derivations: { dkey: string; inputs: DerivationInput[]; result: unknown; explanation: string }[];
  author?: string;
  failpoint?: 'crash_before_pointer';
}
export type CommitOutcome =
  | { outcome: 'committed'; versionId: string; eventIds: string[] }
  | { outcome: 'conflict'; conflictId: string };

export class Repo {
  constructor(public db: DatabaseSync) {}

  static open(path: string): Repo { return new Repo(openDb(path)); }

  addDocument(kind: string, name: string, content: string): DocumentRow {
    const id = stableId('doc', { kind, content });
    const hash = stableId('sha', content);
    this.db.prepare('INSERT OR IGNORE INTO documents (id, kind, name, content, hash) VALUES (?, ?, ?, ?, ?)').run(id, kind, name, content, hash);
    return this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as unknown as DocumentRow;
  }
  getDocument(id: string): DocumentRow | null {
    return (this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as unknown as DocumentRow) ?? null;
  }

  createCase(name: string, title: string): string {
    const id = stableId('case', { name });
    const seq = (this.db.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number }).n + 1;
    this.db.prepare('INSERT OR IGNORE INTO cases (id, name, title, created_seq) VALUES (?, ?, ?, ?)').run(id, name, title, seq);
    return id;
  }
  listCases(): { id: string; name: string; title: string }[] {
    return this.db.prepare('SELECT id, name, title FROM cases ORDER BY created_seq').all() as unknown as { id: string; name: string; title: string }[];
  }

  currentVersion(caseId: string): VersionRow | null {
    const p = this.db.prepare('SELECT version_id FROM case_pointer WHERE case_id = ?').get(caseId) as { version_id: string } | undefined;
    if (!p) return null;
    return this.db.prepare('SELECT * FROM versions WHERE id = ?').get(p.version_id) as unknown as VersionRow;
  }

  private nextEventSeq(caseId: string): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE case_id = ?').get(caseId) as { m: number };
    return r.m + 1;
  }

  /**
   * Atomic commit: version row + events + derivations + pointer switch happen in
   * one transaction. A crash (failpoint) rolls everything back: readers see either
   * the complete old version or the complete new one, never a partial write.
   */
  commit(spec: CommitSpec): CommitOutcome {
    const current = this.currentVersion(spec.caseId);
    const currentId = current ? current.id : null;
    if (spec.baseVersionId !== currentId) {
      const conflictId = stableId('cfl', { caseId: spec.caseId, base: spec.baseVersionId, note: spec.note, events: spec.events });
      const candidate = { note: spec.note, author: spec.author ?? 'unknown', events: spec.events, derivations: spec.derivations };
      const existing = this.db.prepare('SELECT * FROM conflicts WHERE id = ?').get(conflictId) as unknown as ConflictRow | undefined;
      if (existing) {
        const candidates = JSON.parse(existing.candidates) as unknown[];
        candidates.push(candidate);
        this.db.prepare('UPDATE conflicts SET candidates = ? WHERE id = ?').run(JSON.stringify(candidates), conflictId);
      } else {
        this.db.prepare('INSERT INTO conflicts (id, case_id, base_version_id, candidates, status, resolution) VALUES (?, ?, ?, ?, ?, NULL)')
          .run(conflictId, spec.caseId, spec.baseVersionId ?? '<none>', JSON.stringify([candidate]), 'open');
      }
      return { outcome: 'conflict', conflictId };
    }

    const parentSeq = current ? current.seq : 0;
    const versionSeq = parentSeq + 1;
    const createdAt = new Date().toISOString();
    let seq = this.nextEventSeq(spec.caseId);
    const events: AppEvent[] = spec.events.map((e) => makeEvent(spec.caseId, seq++, null, e.kind, e.payload, createdAt));
    const versionId = stableId('ver', { caseId: spec.caseId, seq: versionSeq, parent: currentId, note: spec.note, events: events.map((e) => e.id) });
    const withVersion = events.map((e) => ({ ...e, versionId }));

    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO versions (id, case_id, seq, parent_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(versionId, spec.caseId, versionSeq, currentId, spec.note, createdAt);
      const evtStmt = this.db.prepare('INSERT INTO events (id, case_id, seq, version_id, kind, payload, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const e of withVersion) {
        evtStmt.run(e.id, e.caseId, e.seq, versionId, e.kind, JSON.stringify(e.payload), stableId('sha', e.payload), e.createdAt);
      }
      const drvStmt = this.db.prepare('INSERT INTO derivations (id, case_id, version_id, version_seq, dkey, inputs, status, result, explanation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const d of spec.derivations) {
        const id = stableId('drv', { caseId: spec.caseId, dkey: d.dkey, inputs: d.inputs, result: d.result });
        drvStmt.run(id, spec.caseId, versionId, versionSeq, d.dkey, JSON.stringify(d.inputs), 'valid', JSON.stringify(d.result), d.explanation);
      }
      if (spec.failpoint === 'crash_before_pointer') {
        throw new Error('simulated crash before pointer switch');
      }
      this.db.prepare('INSERT OR REPLACE INTO case_pointer (case_id, version_id) VALUES (?, ?)').run(spec.caseId, versionId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { outcome: 'committed', versionId, eventIds: events.map((e) => e.id) };
  }

  /**
   * Resolve a conflict. winnerIndex === -1 keeps the current branch (all stored
   * candidates rejected); winnerIndex >= 0 commits that candidate on top.
   * Unchosen candidates are kept in the resolution record, never overwritten.
   */
  resolveConflict(conflictId: string, winnerIndex: number, author = 'reviewer'): CommitOutcome {
    const c = this.db.prepare('SELECT * FROM conflicts WHERE id = ?').get(conflictId) as unknown as ConflictRow | undefined;
    if (!c) throw new Error(`conflict ${conflictId} not found`);
    if (c.status !== 'open') throw new Error(`conflict ${conflictId} already resolved`);
    const candidates = JSON.parse(c.candidates) as { note: string; author: string; events: { kind: EventKind; payload: unknown }[]; derivations: { dkey: string; inputs: DerivationInput[]; result: unknown; explanation: string }[] }[];
    const winner = winnerIndex >= 0 ? candidates[winnerIndex] : null;
    if (winnerIndex >= 0 && !winner) throw new Error(`candidate ${winnerIndex} out of range`);
    const keptCandidates = [
      { index: -1, author: 'current-branch', note: 'keep current branch', chosen: winnerIndex === -1 },
      ...candidates.map((cd, i) => ({ index: i, author: cd.author, note: cd.note, chosen: i === winnerIndex })),
    ];
    const outcome = this.commit({
      caseId: c.case_id, baseVersionId: this.currentVersion(c.case_id)?.id ?? null,
      note: `resolve ${conflictId}: ${winner ? winner.note : 'keep current branch'}`,
      events: [...(winner ? winner.events : []), {
        kind: 'conflict_resolved' as const,
        payload: { conflictId, winnerIndex, winnerAuthor: winner ? winner.author : 'current-branch', keptCandidates },
      }],
      derivations: winner ? winner.derivations : [],
      author,
    });
    if (outcome.outcome === 'committed') {
      this.db.prepare('UPDATE conflicts SET status = ?, resolution = ? WHERE id = ?')
        .run('resolved', JSON.stringify({ winnerIndex, resolvedAtVersion: outcome.versionId, allCandidatesKept: true }), conflictId);
    }
    return outcome;
  }

  eventsFor(caseId: string, upToSeq?: number): AppEvent[] {
    const rows = (upToSeq === undefined
      ? this.db.prepare('SELECT * FROM events WHERE case_id = ? ORDER BY seq').all(caseId)
      : this.db.prepare('SELECT * FROM events WHERE case_id = ? AND seq <= ? ORDER BY seq').all(caseId, upToSeq)) as unknown as any[];
    return rows.map((r) => ({ id: r.id, caseId: r.case_id, seq: r.seq, versionId: r.version_id, kind: r.kind, payload: JSON.parse(r.payload), createdAt: r.created_at }));
  }

  versionsFor(caseId: string): VersionRow[] {
    return this.db.prepare('SELECT * FROM versions WHERE case_id = ? ORDER BY seq').all(caseId) as unknown as VersionRow[];
  }

  derivationsAt(caseId: string, versionSeq: number): Derivation[] {
    const rows = this.db.prepare(
      `SELECT d.* FROM derivations d
       JOIN (SELECT dkey, MAX(version_seq) AS ms FROM derivations WHERE case_id = ? AND version_seq <= ? GROUP BY dkey) latest
         ON d.dkey = latest.dkey AND d.version_seq = latest.ms
       WHERE d.case_id = ?`,
    ).all(caseId, versionSeq, caseId) as unknown as any[];
    return rows.map((r) => ({ id: r.id, caseId: r.case_id, versionId: r.version_id, dkey: r.dkey, inputs: JSON.parse(r.inputs), status: r.status, result: JSON.parse(r.result), explanation: r.explanation }));
  }

  conflictsFor(caseId: string): ConflictRow[] {
    return this.db.prepare('SELECT * FROM conflicts WHERE case_id = ? ORDER BY rowid').all(caseId) as unknown as ConflictRow[];
  }

  caseState(caseId: string, atVersionId?: string) {
    const versions = this.versionsFor(caseId);
    const current = this.currentVersion(caseId);
    const viewVersion = atVersionId ? versions.find((v) => v.id === atVersionId) ?? null : current;
    const events = viewVersion ? this.eventsFor(caseId, undefined).filter((e) => {
      const v = versions.find((vv) => vv.id === e.versionId);
      return !v || !viewVersion || v.seq <= viewVersion.seq;
    }) : [];
    const derivations = viewVersion ? this.derivationsAt(caseId, viewVersion.seq) : [];
    return { versions, current, viewVersion, events, derivations, conflicts: this.conflictsFor(caseId) };
  }

  exportCase(caseId: string) {
    const caseRow = this.db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId) as unknown as { id: string; name: string; title: string; created_seq: number } | undefined;
    if (!caseRow) throw new Error(`case ${caseId} not found`);
    return {
      formatVersion: 1,
      case: caseRow,
      pointerVersionId: this.currentVersion(caseId)?.id ?? null,
      documents: this.db.prepare('SELECT * FROM documents ORDER BY id').all(),
      versions: this.versionsFor(caseId),
      events: this.db.prepare('SELECT * FROM events WHERE case_id = ? ORDER BY seq').all(caseId),
      derivations: this.db.prepare('SELECT * FROM derivations WHERE case_id = ? ORDER BY version_seq').all(caseId),
      conflicts: this.conflictsFor(caseId),
    };
  }

  /** Import preserves ids, order (seq) and provenance links exactly. */
  importCase(data: ReturnType<Repo['exportCase']>): void {
    if (data.formatVersion !== 1) throw new Error(`unsupported archive format ${data.formatVersion}`);
    const existing = this.db.prepare('SELECT id FROM cases WHERE id = ?').get(data.case.id);
    if (existing) throw new Error(`case ${data.case.id} already exists`);
    this.db.exec('BEGIN');
    try {
      const docStmt = this.db.prepare('INSERT OR IGNORE INTO documents (id, kind, name, content, hash) VALUES (?, ?, ?, ?, ?)');
      for (const d of data.documents as any[]) docStmt.run(d.id, d.kind, d.name, d.content, d.hash);
      this.db.prepare('INSERT INTO cases (id, name, title, created_seq) VALUES (?, ?, ?, ?)').run(data.case.id, data.case.name, data.case.title, data.case.created_seq);
      const vStmt = this.db.prepare('INSERT INTO versions (id, case_id, seq, parent_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const v of data.versions as any[]) vStmt.run(v.id, v.case_id, v.seq, v.parent_id, v.note, v.created_at);
      const eStmt = this.db.prepare('INSERT INTO events (id, case_id, seq, version_id, kind, payload, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const e of data.events as any[]) eStmt.run(e.id, e.case_id, e.seq, e.version_id, e.kind, e.payload, e.payload_hash ?? '', e.created_at);
      const dStmt = this.db.prepare('INSERT INTO derivations (id, case_id, version_id, version_seq, dkey, inputs, status, result, explanation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const d of data.derivations as any[]) dStmt.run(d.id, d.case_id, d.version_id, d.version_seq, d.dkey, d.inputs, d.status, d.result, d.explanation);
      const cStmt = this.db.prepare('INSERT INTO conflicts (id, case_id, base_version_id, candidates, status, resolution) VALUES (?, ?, ?, ?, ?, ?)');
      for (const c of data.conflicts as any[]) cStmt.run(c.id, c.case_id, c.base_version_id, c.candidates, c.status, c.resolution);
      if (data.pointerVersionId) {
        this.db.prepare('INSERT OR REPLACE INTO case_pointer (case_id, version_id) VALUES (?, ?)').run(data.case.id, data.pointerVersionId);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
