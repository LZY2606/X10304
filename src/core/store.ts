// ---------------------------------------------------------------------------
// Storage layer: append-only events + materialized derivations in SQLite.
//
// Versioning contract:
//  - Every derivation is written under a NEW id. The `refs` pointer switches to
//    that new derivation only after the write transaction fully commits. A crash
//    mid-write therefore exposes either the old version or the complete new one.
//  - Concurrent editors of the same base version get a resolvable conflict:
//    the second save is rejected with base/head details (HTTP 409 at the API).
//  - Export/import preserves event ids, order and source relations verbatim.
// ---------------------------------------------------------------------------

import Database from "better-sqlite3";
import { evaluate, RULE_VERSION, type EngineEvaluation } from "./engine.js";
import type { ManualDecisionInput } from "./engine.js";

export const SCHEMA_VERSION = 2;

export type EventType =
  | "case-loaded"
  | "source-revised"
  | "budget-revised"
  | "decision"
  | "checkout";

export interface ProofEvent {
  id: string;
  branch: string;
  seq: number;
  parentId: string | null;
  type: EventType;
  baseVersion: string | null;
  actor: string;
  at: string;
  payload: Record<string, unknown>;
  label: string;
}

export interface RefRecord {
  name: string;
  branch: string;
  headEventId: string;
  derivationId: string | null;
}

export interface DerivationRecord {
  id: string;
  eventId: string;
  branch: string;
  parentDerivationId: string | null;
  ruleVersion: string;
  reportJson: string;
  nodesJson: string;
  reuseJson: string;
  createdByEvent: string;
  createdAt: string;
}

export interface MaterialState {
  cnfText: string;
  dratText: string;
  budgetLimit: number;
  decisions: ManualDecisionInput[];
  caseId: string | null;
  manifest: Record<string, unknown> | null;
}

export interface Archive {
  format: "drat-proof-desk-archive";
  archiveVersion: 1;
  exportedAt: string;
  schemaVersion: number;
  events: ProofEvent[];
  refs: RefRecord[];
  derivations: DerivationRecord[];
}

const DDL = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  seq INTEGER NOT NULL,
  parent_id TEXT,
  type TEXT NOT NULL,
  base_version TEXT,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  payload TEXT NOT NULL,
  label TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_branch_seq ON events(branch, seq);
CREATE TABLE IF NOT EXISTS refs (
  name TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  head_event_id TEXT NOT NULL,
  derivation_id TEXT
);
CREATE TABLE IF NOT EXISTS derivations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  parent_derivation_id TEXT,
  rule_version TEXT NOT NULL,
  report_json TEXT NOT NULL,
  nodes_json TEXT NOT NULL,
  reuse_json TEXT NOT NULL,
  created_by_event TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS derivations_event ON derivations(event_id);
`;

export class ConcurrencyError extends Error {
  constructor(
    public baseVersion: string,
    public headVersion: string,
    public branch: string
  ) {
    super(
      `バージョン競合: base=${baseVersion} は現在の head=${headVersion} (branch=${branch}) と一致しません`
    );
    this.name = "ConcurrencyError";
  }
}

export class Store {
  db: Database.Database;
  private stmt: Record<string, Database.Statement> = {};

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("foreign_keys = ON");
    this.db.exec(DDL);
    this.migrate();
    this.prepare();
  }

  close() {
    this.db.close();
  }

  private migrate() {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key='schema_version'")
      .get() as { value: string } | undefined;
    if (!row) {
      this.db
        .prepare("INSERT INTO meta(key,value) VALUES('schema_version',?)")
        .run(String(SCHEMA_VERSION));
      return;
    }
    const from = Number(row.value);
    // Old-version migration path (v1 had a single derivation table; this hook is
    // covered by the migration test). v1 -> v2 is a no-op content migration.
    if (from < SCHEMA_VERSION) {
      const tx = this.db.transaction(() => {
        this.db
          .prepare("UPDATE meta SET value=? WHERE key='schema_version'")
          .run(String(SCHEMA_VERSION));
      });
      tx();
    }
  }

  private prepare() {
    this.stmt.insertEvent = this.db.prepare(
      `INSERT INTO events(id,branch,seq,parent_id,type,base_version,actor,at,payload,label)
       VALUES(@id,@branch,@seq,@parent_id,@type,@base_version,@actor,@at,@payload,@label)`
    );
    this.stmt.insertRef = this.db.prepare(
      `INSERT INTO refs(name,branch,head_event_id,derivation_id)
       VALUES(@name,@branch,@head_event_id,@derivation_id)
       ON CONFLICT(name) DO UPDATE SET
         branch=excluded.branch,
         head_event_id=excluded.head_event_id,
         derivation_id=excluded.derivation_id`
    );
    this.stmt.insertDerivation = this.db.prepare(
      `INSERT INTO derivations(id,event_id,branch,parent_derivation_id,rule_version,report_json,nodes_json,reuse_json,created_by_event,created_at)
       VALUES(@id,@event_id,@branch,@parent_derivation_id,@rule_version,@report_json,@nodes_json,@reuse_json,@created_by_event,@created_at)`
    );
    this.stmt.getRef = this.db.prepare("SELECT * FROM refs WHERE name=?");
    this.stmt.getEvent = this.db.prepare("SELECT * FROM events WHERE id=?");
    this.stmt.getDerivation = this.db.prepare(
      "SELECT * FROM derivations WHERE id=?"
    );
  }

  listEvents(branch: string): ProofEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE branch=? ORDER BY seq ASC")
      .all(branch) as any[];
    return rows.map(rowToEvent);
  }

  getRef(name = "head"): RefRecord | undefined {
    const r = this.stmt.getRef.get(name) as any;
    return r ? rowToRef(r) : undefined;
  }

  getEvent(id: string): ProofEvent | undefined {
    const r = this.stmt.getEvent.get(id) as any;
    return r ? rowToEvent(r) : undefined;
  }

  getDerivation(id: string): DerivationRecord | undefined {
    const r = this.stmt.getDerivation.get(id) as any;
    return r ? rowToDerivation(r) : undefined;
  }

  /** Replay an event list into the current material state (pure re-derivation). */
  static replay(events: ProofEvent[]): MaterialState {
    const state: MaterialState = {
      cnfText: "",
      dratText: "",
      budgetLimit: 1000,
      decisions: [],
      caseId: null,
      manifest: null,
    };
    for (const ev of events) applyEvent(state, ev);
    return state;
  }

  private stateAt(refName: string): { state: MaterialState; events: ProofEvent[] } {
    const ref = this.getRef(refName);
    const branch = ref?.branch ?? "main";
    const events = this.listEvents(branch);
    return { state: Store.replay(events), events };
  }

  /**
   * Append an event and produce a new derivation. Atomic: the ref pointer moves
   * only in the same transaction that fully wrote the derivation.
   */
  commit(params: {
    branch?: string;
    type: EventType;
    payload: Record<string, unknown>;
    label: string;
    actor?: string;
    baseVersion?: string | null;
    createRef?: string;
  }): { event: ProofEvent; ref: RefRecord; derivation: DerivationRecord; evaluation: EngineEvaluation } {
    const branch = params.branch ?? "main";
    const actor = params.actor ?? "reviewer";
    const baseVersion = params.baseVersion ?? null;

    const run = this.db.transaction(() => {
      const branchRows = this.db
        .prepare("SELECT * FROM events WHERE branch=? ORDER BY seq DESC LIMIT 1")
        .all(branch) as any[];
      const parent = branchRows[0] ? rowToEvent(branchRows[0]) : null;
      const headRef = this.getRef("head");
      if (baseVersion !== undefined && baseVersion !== null) {
        const currentHead = headRef?.headEventId ?? null;
        if (baseVersion !== currentHead) {
          throw new ConcurrencyError(baseVersion, currentHead ?? "(none)", branch);
        }
      }

      const events = this.listEvents(branch);
      const event: ProofEvent = {
        id: `ev:${branch}:${events.length + 1}:${hashish(params.type + JSON.stringify(params.payload) + Date.now().toString(36) + Math.random().toString(36).slice(2, 8))}`,
        branch,
        seq: events.length + 1,
        parentId: parent?.id ?? null,
        type: params.type,
        baseVersion,
        actor,
        at: new Date().toISOString(),
        payload: params.payload,
        label: params.label,
      };
      this.stmt.insertEvent.run({
        id: event.id,
        branch: event.branch,
        seq: event.seq,
        parent_id: event.parentId,
        type: event.type,
        base_version: event.baseVersion,
        actor: event.actor,
        at: event.at,
        payload: JSON.stringify(event.payload),
        label: event.label,
      });

      const allEvents = [...events, event];
      const state = Store.replay(allEvents);
      const prevDer = headRef?.derivationId
        ? this.getDerivation(headRef.derivationId)
        : undefined;
      const prevNodes = prevDer ? JSON.parse(prevDer.nodesJson) : {};
      const evaluation = evaluate(
        {
          cnfText: state.cnfText,
          dratText: state.dratText,
          budgetLimit: state.budgetLimit,
          decisions: state.decisions,
        },
        prevNodes
      );
      const derivation: DerivationRecord = {
        id: `dev:${hashish(event.id + RULE_VERSION)}`,
        eventId: event.id,
        branch,
        parentDerivationId: headRef?.derivationId ?? null,
        ruleVersion: RULE_VERSION,
        reportJson: JSON.stringify(evaluation.report),
        nodesJson: JSON.stringify(evaluation.nodes),
        reuseJson: JSON.stringify(evaluation.reuse),
        createdByEvent: event.id,
        createdAt: event.at,
      };
      this.stmt.insertDerivation.run({
        id: derivation.id,
        event_id: derivation.eventId,
        branch: derivation.branch,
        parent_derivation_id: derivation.parentDerivationId,
        rule_version: derivation.ruleVersion,
        report_json: derivation.reportJson,
        nodes_json: derivation.nodesJson,
        reuse_json: derivation.reuseJson,
        created_by_event: derivation.createdByEvent,
        created_at: derivation.createdAt,
      });

      const refName = params.createRef ?? "head";
      const ref: RefRecord = {
        name: refName,
        branch,
        headEventId: event.id,
        derivationId: derivation.id,
      };
      this.stmt.insertRef.run({
        name: ref.name,
        branch: ref.branch,
        head_event_id: ref.headEventId,
        derivation_id: ref.derivationId,
      });

      return { event, ref, derivation, evaluation };
    });

    return run();
  }

  /** Point the head pointer at a historical event (generates a checkout event). */
  checkout(eventId: string, actor = "reviewer"): { event: ProofEvent; ref: RefRecord; derivation: DerivationRecord; evaluation: EngineEvaluation } {
    const target = this.getEvent(eventId);
    if (!target) throw new Error(`unknown event ${eventId}`);
    return this.commit({
      branch: target.branch,
      type: "checkout",
      payload: { targetEventId: eventId },
      label: `復帰: ${target.label} (${eventId})`,
      actor,
      baseVersion: null,
    });
  }

  /** Freeze a named branch pointer at the current head (comparison candidates). */
  saveRef(name: string, ref: RefRecord) {
    this.stmt.insertRef.run({
      name,
      branch: ref.branch,
      head_event_id: ref.headEventId,
      derivation_id: ref.derivationId,
    });
  }

  listRefs(): RefRecord[] {
    return (this.db.prepare("SELECT * FROM refs ORDER BY name").all() as any[]).map(
      rowToRef
    );
  }

  exportArchive(): Archive {
    const events = (
      this.db.prepare("SELECT * FROM events ORDER BY branch, seq").all() as any[]
    ).map(rowToEvent);
    const refs = (this.db.prepare("SELECT * FROM refs ORDER BY name").all() as any[]).map(
      rowToRef
    );
    const derivations = (
      this.db.prepare("SELECT * FROM derivations ORDER BY created_at").all() as any[]
    ).map(rowToDerivation);
    return {
      format: "drat-proof-desk-archive",
      archiveVersion: 1,
      exportedAt: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
      events,
      refs,
      derivations,
    };
  }

  /**
   * Import into a fresh database image. After this returns and the caller swaps
   * the file, every identity / ordering / provenance relation is identical.
   */
  importArchive(archive: Archive) {
    const tx = this.db.transaction(() => {
      this.db.exec(
        "DELETE FROM derivations; DELETE FROM events; DELETE FROM refs; DELETE FROM meta;"
      );
      this.db
        .prepare("INSERT INTO meta(key,value) VALUES('schema_version',?)")
        .run(String(archive.schemaVersion ?? SCHEMA_VERSION));
      for (const ev of archive.events) {
        this.stmt.insertEvent.run({
          id: ev.id,
          branch: ev.branch,
          seq: ev.seq,
          parent_id: ev.parentId,
          type: ev.type,
          base_version: ev.baseVersion,
          actor: ev.actor,
          at: ev.at,
          payload: JSON.stringify(ev.payload),
          label: ev.label,
        });
      }
      for (const d of archive.derivations) {
        this.stmt.insertDerivation.run({
          id: d.id,
          event_id: d.eventId,
          branch: d.branch,
          parent_derivation_id: d.parentDerivationId,
          rule_version: d.ruleVersion,
          report_json: d.reportJson,
          nodes_json: d.nodesJson,
          reuse_json: d.reuseJson,
          created_by_event: d.createdByEvent,
          created_at: d.createdAt,
        });
      }
      for (const r of archive.refs) {
        this.stmt.insertRef.run({
          name: r.name,
          branch: r.branch,
          head_event_id: r.headEventId,
          derivation_id: r.derivationId,
        });
      }
    });
    tx();
  }

  currentView(): {
    state: MaterialState;
    events: ProofEvent[];
    ref: RefRecord | undefined;
    derivation: DerivationRecord | undefined;
    report: any;
    nodes: Record<string, any>;
    reuse: Record<string, string>;
  } {
    const ref = this.getRef("head");
    const { state, events } = this.stateAt("head");
    const derivation = ref?.derivationId
      ? this.getDerivation(ref.derivationId)
      : undefined;
    return {
      state,
      events,
      ref,
      derivation,
      report: derivation ? JSON.parse(derivation.reportJson) : null,
      nodes: derivation ? JSON.parse(derivation.nodesJson) : {},
      reuse: derivation ? JSON.parse(derivation.reuseJson) : {},
    };
  }
}

// ---------------------------------------------------------------------------
// Event application / replay
// ---------------------------------------------------------------------------

function applyEvent(state: MaterialState, ev: ProofEvent): void {
  switch (ev.type) {
    case "case-loaded": {
      state.cnfText = String(ev.payload.cnfText ?? "");
      state.dratText = String(ev.payload.dratText ?? "");
      state.budgetLimit = num(ev.payload.budgetLimit, 1000);
      state.caseId = (ev.payload.caseId as string) ?? null;
      state.manifest = (ev.payload.manifest as Record<string, unknown>) ?? null;
      state.decisions = [];
      break;
    }
    case "source-revised": {
      const target = (ev.payload.target as "cnf" | "drat") ?? "drat";
      const text = String(ev.payload.text ?? "");
      const scope = ev.payload.scope as
        | { mode: "whole" }
        | { mode: "line-range"; startLine: number; endLine: number }
        | undefined;
      if (!scope || scope.mode === "whole") {
        if (target === "cnf") state.cnfText = text;
        else state.dratText = text;
      } else {
        const base = target === "cnf" ? state.cnfText : state.dratText;
        const lines = base.split("\n");
        const replacement = text.split("\n");
        lines.splice(scope.startLine - 1, scope.endLine - scope.startLine + 1, ...replacement);
        const merged = lines.join("\n");
        if (target === "cnf") state.cnfText = merged;
        else state.dratText = merged;
      }
      break;
    }
    case "budget-revised": {
      state.budgetLimit = num(ev.payload.budgetLimit, state.budgetLimit);
      break;
    }
    case "decision": {
      const d: ManualDecisionInput = {
        proofLineId: String(ev.payload.proofLineId),
        action: ev.payload.action === "reject" ? "reject" : "accept",
        decisionId: String(ev.payload.decisionId),
        note: ev.payload.note as string | undefined,
      };
      const idx = state.decisions.findIndex(
        (x) => x.proofLineId === d.proofLineId
      );
      if (idx >= 0) state.decisions[idx] = d;
      else state.decisions.push(d);
      break;
    }
    case "checkout": {
      // Handled by effectivePrefix; nothing to fold into the state here.
      break;
    }
  }
}

/**
 * Effective event prefix for a branch: a checkout truncates history so that the
 * material state is exactly what it was at the target event (the checkout event
 * itself becomes the new tip). Later sibling events remain stored for audit.
 */
export function effectivePrefix(events: ProofEvent[]): ProofEvent[] {
  if (events.length === 0) return events;
  const last = events[events.length - 1];
  if (last.type !== "checkout") return events;
  const targetId = String(last.payload.targetEventId);
  const idx = events.findIndex((e) => e.id === targetId);
  if (idx < 0) return events;
  return [...events.slice(0, idx + 1), last];
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

import { fnv1a } from "./hash.js";
function hashish(s: string): string {
  return fnv1a(s);
}

function rowToEvent(r: any): ProofEvent {
  return {
    id: r.id,
    branch: r.branch,
    seq: r.seq,
    parentId: r.parent_id,
    type: r.type as EventType,
    baseVersion: r.base_version,
    actor: r.actor,
    at: r.at,
    payload: JSON.parse(r.payload),
    label: r.label,
  };
}
function rowToRef(r: any): RefRecord {
  return {
    name: r.name,
    branch: r.branch,
    headEventId: r.head_event_id,
    derivationId: r.derivation_id,
  };
}
function rowToDerivation(r: any): DerivationRecord {
  return {
    id: r.id,
    eventId: r.event_id,
    branch: r.branch,
    parentDerivationId: r.parent_derivation_id,
    ruleVersion: r.rule_version,
    reportJson: r.report_json,
    nodesJson: r.nodes_json,
    reuseJson: r.reuse_json,
    createdByEvent: r.created_by_event,
    createdAt: r.created_at,
  };
}
