import { DimacsParse } from './dimacs.js';
import { DratParse, ProofLine } from './drat.js';
import { stableId } from './ids.js';

/** Resource budget. Unit of all counters: one unit-propagation assignment ("up-step"). */
export interface Budget { maxUpStepsPerStep: number; maxUpStepsTotal: number }
export const DEFAULT_BUDGET: Budget = { maxUpStepsPerStep: 10_000, maxUpStepsTotal: 1_000_000 };

export interface UpTraceStep {
  var: number;
  value: boolean;
  reasonClauseId: string;   // stable id of the clause that forced this assignment
  reasonClauseLits: number[];
}

export interface UpResult {
  status: 'conflict' | 'no_conflict' | 'resource_exhausted';
  conflictClauseId?: string;
  trace: UpTraceStep[];     // propagation reasons, in order
  stepsUsed: number;        // unit: up-step
}

interface DbEntry { key: string; lits: number[]; ids: string[]; count: number }

export class ClauseDb {
  private entries = new Map<string, DbEntry>();
  constructor(cnf: DimacsParse) {
    for (const c of cnf.clauses) {
      const e = this.entries.get(c.key) ?? { key: c.key, lits: c.lits, ids: [], count: 0 };
      e.ids.push(c.id);
      e.count += 1;
      this.entries.set(c.key, e);
    }
  }
  add(key: string, lits: number[], id: string): void {
    const e = this.entries.get(key) ?? { key, lits, ids: [], count: 0 };
    e.ids.push(id); e.count += 1;
    this.entries.set(key, e);
  }
  /** Remove one occurrence. Returns false (set unchanged) when the clause is absent. */
  remove(key: string): boolean {
    const e = this.entries.get(key);
    if (!e || e.count === 0) return false;
    e.count -= 1; e.ids.pop();
    if (e.count === 0) this.entries.delete(key);
    return true;
  }
  has(key: string): boolean { return this.entries.has(key); }
  active(): DbEntry[] { return [...this.entries.values()]; }
  activeCount(): number { let n = 0; for (const e of this.entries.values()) n += e.count; return n; }
  snapshot(): { key: string; lits: number[]; ids: string[]; count: number }[] {
    return this.active().map((e) => ({ key: e.key, lits: [...e.lits], ids: [...e.ids], count: e.count }));
  }
}

/** Unit propagation under assumptions. Deterministic clause scan order = insertion order. */
export function unitPropagate(
  clauses: { id: string; lits: number[] }[],
  assumptions: { var: number; value: boolean }[],
  budgetLeft: number,
): UpResult {
  const assign = new Map<number, boolean>();
  for (const a of assumptions) assign.set(a.var, a.value);
  const trace: UpTraceStep[] = [];
  let stepsUsed = 0;
  for (;;) {
    let progressed = false;
    for (const c of clauses) {
      let unassigned = 0;
      let lastUnassigned: number | null = null;
      let satisfied = false;
      for (const lit of c.lits) {
        const v = Math.abs(lit);
        const val = assign.get(v);
        if (val === undefined) { unassigned += 1; lastUnassigned = lit; }
        else if ((lit > 0) === val) { satisfied = true; break; }
      }
      if (satisfied) continue;
      if (unassigned === 0) {
        return { status: 'conflict', conflictClauseId: c.id, trace, stepsUsed };
      }
      if (unassigned === 1 && lastUnassigned !== null) {
        if (stepsUsed >= budgetLeft) return { status: 'resource_exhausted', trace, stepsUsed };
        const v = Math.abs(lastUnassigned);
        assign.set(v, lastUnassigned > 0);
        trace.push({ var: v, value: lastUnassigned > 0, reasonClauseId: c.id, reasonClauseLits: [...c.lits] });
        stepsUsed += 1;
        progressed = true;
      }
    }
    if (!progressed) return { status: 'no_conflict', trace, stepsUsed };
  }
}

export type StepVerdict =
  | { kind: 'added_rup'; clauseId: string; upSteps: number; trace: UpTraceStep[]; conflictClauseId: string }
  | { kind: 'added_rat'; clauseId: string; pivot: number; partners: { clauseId: string; resolvent: number[]; upSteps: number }[]; upSteps: number }
  | { kind: 'added_tautology'; clauseId: string }
  | { kind: 'deleted'; removed: boolean; diagnostic: string | null }
  | { kind: 'resource_exhausted'; clauseId: string; phase: 'rup' | 'rat'; upSteps: number }
  | { kind: 'rejected'; clauseId: string; reason: 'not_rup_not_rat'; upSteps: number };

export interface RuleJudgment { code: string; applies: boolean; detail: string }

export interface ProofStepResult {
  lineId: string;
  lineIndex: number;
  lineKind: 'add' | 'del';
  verdict: StepVerdict;
  activeCountAfter: number;
  activeAfter: { key: string; lits: number[]; ids: string[]; count: number }[];
  syntaxNotes: string[];
}

export interface ProofRunResult {
  id: string;
  status: 'verified' | 'refuted' | 'inconclusive';
  statusReason: string;
  steps: ProofStepResult[];
  failingPrefix: { lineIds: string[]; reason: string } | null;
  totalUpSteps: number; // unit: up-step
  budget: Budget;
  ruleJudgments: RuleJudgment[];
}

function resolvent(cLits: number[], pivot: number, dLits: number[]): number[] {
  const set = new Set<number>();
  for (const l of cLits) if (l !== pivot) set.add(l);
  for (const l of dLits) if (l !== -pivot) set.add(l);
  return [...set];
}
function isTautological(lits: number[]): boolean {
  const s = new Set(lits);
  for (const l of lits) if (s.has(-l)) return true;
  return false;
}

export function checkProof(cnf: DimacsParse, proof: DratParse, budget: Budget = DEFAULT_BUDGET): ProofRunResult {
  const db = new ClauseDb(cnf);
  const steps: ProofStepResult[] = [];
  const judgments: RuleJudgment[] = [];
  let totalUp = 0;
  let status: ProofRunResult['status'] = 'verified';
  let statusReason = 'empty clause derived; all additions are RUP/RAT, deletions applied to the multiset';
  let failingPrefix: ProofRunResult['failingPrefix'] = null;
  let emptyDerived = false;
  let sawRat = false, sawRup = false, sawDeleteMissing = false, sawTautology = false, sawExhaustion = false;

  const budgetLeftTotal = () => budget.maxUpStepsTotal - totalUp;

  for (const line of proof.lines) {
    const syntaxNotes: string[] = [];
    if (line.syntax.tautology) syntaxNotes.push('tautology_clause');
    if (line.syntax.duplicateLits.length > 0) syntaxNotes.push('duplicate_literal');
    if (!line.syntax.zeroTerminated) syntaxNotes.push('missing_zero_terminator');
    if (line.syntax.hugeLiterals.length > 0) syntaxNotes.push('huge_variable_id');

    let verdict: StepVerdict;
    if (line.kind === 'del') {
      const removed = db.remove(line.key);
      if (!removed) sawDeleteMissing = true;
      verdict = {
        kind: 'deleted', removed,
        diagnostic: removed ? null : 'delete_nonexistent_clause: multiset unchanged, diagnostic recorded',
      };
    } else if (line.syntax.tautology) {
      // Tautologies are handled syntactically: valid addition, no propagation needed.
      sawTautology = true;
      db.add(line.key, line.lits, line.id);
      verdict = { kind: 'added_tautology', clauseId: line.id };
    } else {
      const r = checkAddition(db, line, budget, budgetLeftTotal());
      if (r.verdict.kind === 'added_rup') { sawRup = true; db.add(line.key, line.lits, line.id); }
      else if (r.verdict.kind === 'added_rat') { sawRat = true; db.add(line.key, line.lits, line.id); }
      else if (r.verdict.kind === 'resource_exhausted') {
        sawExhaustion = true;
        // Resource exhaustion is NOT proof invalidity: run becomes inconclusive.
        if (status === 'verified') {
          status = 'inconclusive';
          statusReason = `resource budget exhausted at proof line ${line.line} (phase ${r.verdict.phase}); this is not a proof invalidity`;
        }
      } else {
        // genuinely rejected step: proof refuted, record shortest failing prefix
        status = 'refuted';
        statusReason = `proof line ${line.line} is neither RUP nor RAT`;
        failingPrefix = { lineIds: steps.map((s) => s.lineId).concat(line.id), reason: `addition at proof line ${line.line} is neither RUP nor RAT` };
      }
      totalUp += r.upUsed;
      verdict = r.verdict;
      if (verdict.kind === 'added_rup' || verdict.kind === 'added_rat' || verdict.kind === 'added_tautology') {
        if (line.lits.length === 0) emptyDerived = true;
      }
    }

    steps.push({
      lineId: line.id, lineIndex: line.index, lineKind: line.kind, verdict,
      activeCountAfter: db.activeCount(), activeAfter: db.snapshot(), syntaxNotes,
    });
    if (status === 'refuted') break; // shortest failing prefix stops here
  }

  if (status === 'verified' && !emptyDerived) {
    status = 'inconclusive';
    statusReason = 'proof ended without deriving the empty clause';
  }

  judgments.push({ code: 'rup_rat_distinguished', applies: sawRup || sawRat, detail: `RUP additions: ${sawRup}, RAT additions (pivot-based): ${sawRat}; the two checks are reported separately` });
  judgments.push({ code: 'delete_nonexistent_noop_with_diagnostic', applies: sawDeleteMissing, detail: 'deleting a clause absent from the multiset leaves the set unchanged and records a diagnostic' });
  judgments.push({ code: 'tautology_handled_syntactically', applies: sawTautology, detail: 'tautological clauses are accepted on syntactic grounds, no unit propagation spent' });
  judgments.push({ code: 'duplicate_literal_syntactic', applies: proof.lines.some((l) => l.syntax.duplicateLits.length > 0) || cnf.clauses.some((c) => c.syntax.duplicateLits.length > 0), detail: 'repeated literals are a syntactic note; the original token sequence is preserved' });
  judgments.push({ code: 'zero_terminator_syntactic', applies: proof.lines.some((l) => !l.syntax.zeroTerminated) || cnf.clauses.some((c) => !c.syntax.zeroTerminated), detail: 'a missing terminating 0 is a syntax diagnostic; the parsed literals stay in place' });
  judgments.push({ code: 'resource_exhaustion_not_invalidity', applies: sawExhaustion, detail: 'budget exhaustion yields status inconclusive, never refuted' });
  judgments.push({ code: 'duplicate_clause_multiset_preserved', applies: new Set(cnf.clauses.map((c) => c.key)).size !== cnf.clauses.length, detail: 'identical clauses are kept as multiset occurrences with distinct stable ids' });
  judgments.push({ code: 'huge_variable_id_preserved_raw', applies: cnf.clauses.some((c) => c.syntax.hugeLiterals.length > 0) || proof.lines.some((l) => l.syntax.hugeLiterals.length > 0), detail: 'variable ids beyond int32 are preserved as raw tokens with a diagnostic' });

  const id = stableId('run', {
    cnf: cnf.clauses.map((c) => c.id), proof: proof.lines.map((l) => l.id), budget,
    steps: steps.map((s) => [s.lineId, s.verdict.kind]),
  });
  return { id, status, statusReason, steps, failingPrefix, totalUpSteps: totalUp, budget, ruleJudgments: judgments };
}

function checkAddition(db: ClauseDb, line: ProofLine, budget: Budget, totalLeft: number): { verdict: StepVerdict; upUsed: number } {
  const active = db.active();
  const clauseList: { id: string; lits: number[] }[] = [];
  for (const e of active) for (let i = 0; i < e.count; i++) clauseList.push({ id: e.ids[i] ?? e.key, lits: e.lits });

  const perStep = Math.min(budget.maxUpStepsPerStep, totalLeft);
  // 1) RUP check: assume negation of the new clause, propagate to conflict.
  const assumptions = line.lits.map((l) => ({ var: Math.abs(l), value: l < 0 }));
  const rup = unitPropagate(clauseList, assumptions, perStep);
  if (rup.status === 'conflict') {
    return { verdict: { kind: 'added_rup', clauseId: line.id, upSteps: rup.stepsUsed, trace: rup.trace, conflictClauseId: rup.conflictClauseId! }, upUsed: rup.stepsUsed };
  }
  if (rup.status === 'resource_exhausted') {
    return { verdict: { kind: 'resource_exhausted', clauseId: line.id, phase: 'rup', upSteps: rup.stepsUsed }, upUsed: rup.stepsUsed };
  }

  // 2) RAT check: pivot = first literal as written.
  let upUsed = rup.stepsUsed;
  if (line.lits.length === 0) {
    return { verdict: { kind: 'rejected', clauseId: line.id, reason: 'not_rup_not_rat', upSteps: upUsed }, upUsed };
  }
  const pivot = line.lits[0];
  const partners: { clauseId: string; resolvent: number[]; upSteps: number }[] = [];
  for (const e of active) {
    if (!e.lits.includes(-pivot)) continue;
    const res = resolvent(line.lits, pivot, e.lits);
    if (isTautological(res)) { partners.push({ clauseId: e.ids[0] ?? e.key, resolvent: res, upSteps: 0 }); continue; }
    const left = Math.min(budget.maxUpStepsPerStep, totalLeft - upUsed);
    if (left <= 0) return { verdict: { kind: 'resource_exhausted', clauseId: line.id, phase: 'rat', upSteps: upUsed }, upUsed };
    const resAssumptions = res.map((l) => ({ var: Math.abs(l), value: l < 0 }));
    const r = unitPropagate(clauseList, resAssumptions, left);
    upUsed += r.stepsUsed;
    if (r.status === 'resource_exhausted') {
      return { verdict: { kind: 'resource_exhausted', clauseId: line.id, phase: 'rat', upSteps: upUsed }, upUsed };
    }
    if (r.status !== 'conflict') {
      return { verdict: { kind: 'rejected', clauseId: line.id, reason: 'not_rup_not_rat', upSteps: upUsed }, upUsed };
    }
    partners.push({ clauseId: e.ids[0] ?? e.key, resolvent: res, upSteps: r.stepsUsed });
  }
  return { verdict: { kind: 'added_rat', clauseId: line.id, pivot, partners, upSteps: upUsed }, upUsed };
}
