import { stableId } from './ids.js';

/** Machine-readable event envelope. Ids are content-addressed and survive export/import. */
export interface AppEvent<T = unknown> {
  id: string;            // evt_<hash>, stable
  caseId: string;
  seq: number;           // case-local order, preserved on import
  versionId: string | null;
  kind: EventKind;
  payload: T;
  createdAt: string;     // ISO 8601, unit: second, basis: UTC
}

export type EventKind =
  | 'import_documents'
  | 'verify_run'
  | 'rule_judgment'
  | 'param_revision'
  | 'source_change'
  | 'decision'
  | 'conflict_raised'
  | 'conflict_resolved'
  | 'branch_select'
  | 'restore_view';

export function makeEvent<T>(caseId: string, seq: number, versionId: string | null, kind: EventKind, payload: T, createdAt: string): AppEvent<T> {
  const id = stableId('evt', { caseId, seq, kind, payload });
  return { id, caseId, seq, versionId, kind, payload, createdAt };
}

/** Derivation node of the recompute dependency graph. */
export interface DerivationInput { type: 'document' | 'params' | 'event'; id: string }
export interface Derivation {
  id: string;            // drv_<hash>, stable
  caseId: string;
  versionId: string;
  dkey: string;          // e.g. "verify"
  inputs: DerivationInput[];
  status: 'valid' | 'stale';
  result: unknown;
  explanation: string;   // why this result is still valid / why it was recomputed
}
