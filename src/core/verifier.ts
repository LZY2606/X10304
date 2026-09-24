import {
  ActiveEntry,
  LineVerdict,
  ProofResult,
  PropStep,
  RatWitness,
  RuleParameters,
  VerdictStatus,
} from './types.js';
import { CnfDocument, ProofDocument, ProofLineData, ParsedClause } from './types.js';
import { clauseRef } from './ids.js';

/**
 * Active clause multiset keyed by normalized literal tuple string.
 * multiplicity is retained so repeated identical additions are real copies
 * and repeated deletions decrement one copy at a time.
 */
export class ClauseDatabase {
  private map = new Map<string, ActiveEntry>();

  static key(literals: readonly number[]): string {
    return [...new Set(literals)].sort((a, b) => a - b).join(',');
  }

  add(literals: number[], origin: ActiveEntry['origin'], proofIndex: number | null, span: { startByte: number; endByte: number }): { entry: ActiveEntry; isDuplicate: boolean } {
    const key = ClauseDatabase.key(literals);
    const norm = [...new Set(literals)].sort((a, b) => a - b);
    const existing = this.map.get(key);
    if (existing) {
      existing.multiplicity += 1;
      return { entry: existing, isDuplicate: true };
    }
    const entry: ActiveEntry = {
      ref: clauseRef(proofIndex ?? -1, norm),
      literals: norm,
      multiplicity: 1,
      origin,
      proofIndex,
      startByte: span.startByte,
      endByte: span.endByte,
    };
    this.map.set(key, entry);
    return { entry, isDuplicate: false };
  }

  has(literals: readonly number[]): boolean {
    return this.map.has(ClauseDatabase.key(literals));
  }

  get(literals: readonly number[]): ActiveEntry | undefined {
    return this.map.get(ClauseDatabase.key(literals));
  }

  delete(literals: readonly number[]): { existed: boolean; removed: boolean; entry: ActiveEntry | null } {
    const key = ClauseDatabase.key(literals);
    const existing = this.map.get(key);
    if (!existing) return { existed: false, removed: false, entry: null };
    existing.multiplicity -= 1;
    if (existing.multiplicity <= 0) {
      this.map.delete(key);
      return { existed: true, removed: true, entry: existing };
    }
    return { existed: true, removed: false, entry: existing };
  }

  all(): ActiveEntry[] {
    return [...this.map.values()];
  }

  snapshot(): ActiveEntry[] {
    return this.all().map((e) => ({ ...e, literals: [...e.literals] }));
  }
}

export interface PropagationOutcome {
  status: VerdictStatus;
  steps: PropStep[];
  conflictRef: string | null;
  budgetRemaining: number;
  exhausted: boolean;
  /** literals that remained unfalsified candidates when budget ran out */
  pendingCandidates: string[];
}

/**
 * RUP check: under the negation of `clause`, unit-propagate over `db`.
 * - conflict reached  => accepted (the clause is RUP).
 * - fixpoint without conflict => rejected (countermodel-ish witness).
 * - budget ran out before either => inconclusive. Resource exhaustion is
 *   never a proof of invalidity.
 */
export function rupCheck(
  db: ClauseDatabase,
  clause: readonly number[],
  params: RuleParameters,
): PropagationOutcome {
  const value = new Map<number, number>(); // variable -> signed assignment
  const steps: PropStep[] = [];
  let budget = params.maxPropagationSteps;
  let budgetUsed = 0;
  const conflictRef: { ref: string } | null = null;

  const litValue = (lit: number): number | undefined => {
    const v = value.get(Math.abs(lit));
    if (v === undefined) return undefined;
    return lit > 0 ? v : -v;
  };

  for (const lit of clause) {
    value.set(Math.abs(lit), lit > 0 ? -1 : 1); // negate clause assumptions
  }

  let propagated = true;
  let conflict: ActiveEntry | null = null;
  const pendingCandidates: string[] = [];

  outer: while (propagated && !conflict) {
    propagated = false;
    const clauses = db.all();
    for (const c of clauses) {
      let unassigned: number | null = null;
      let unassignedCount = 0;
      let allFalse = true;
      for (const lit of c.literals) {
        const v = litValue(lit);
        if (v === undefined) {
          allFalse = false;
          unassigned = lit;
          unassignedCount++;
        } else if (v === 1) {
          allFalse = false;
        }
      }
      if (allFalse) {
        conflict = c;
        break outer;
      }
      if (unassignedCount === 1 && unassigned !== null) {
        const target = unassigned;
        const varId = Math.abs(target);
        if (!value.has(varId)) {
          if (budget <= 0) {
            for (const cc of clauses) {
              let u = 0;
              let false2 = true;
              for (const lit of cc.literals) {
                const v = litValue(lit);
                if (v === undefined) u++;
                else if (v === 1) false2 = false;
              }
              if (false2 && u === 1) pendingCandidates.push(cc.ref);
            }
            return {
              status: 'inconclusive',
              steps,
              conflictRef: null,
              budgetRemaining: 0,
              exhausted: true,
              pendingCandidates: [...new Set(pendingCandidates)],
            };
          }
          value.set(varId, target > 0 ? 1 : -1);
          steps.push({
            step: ++budgetUsed,
            literal: target,
            reasonClauseRef: c.ref,
            reasonKind: budgetUsed <= clause.length ? 'input' : 'propagated',
            depthFromCandidates: budgetUsed,
            reasonOffset: { startByte: c.startByte, endByte: c.endByte },
          });
          budget--;
          propagated = true;
          continue outer;
        }
      }
    }
  }

  if (conflict) {
    return {
      status: 'accepted',
      steps,
      conflictRef: conflict.ref,
      budgetRemaining: budget,
      exhausted: false,
      pendingCandidates: [],
    };
  }
  return {
    status: 'rejected',
    steps,
    conflictRef: null,
    budgetRemaining: budget,
    exhausted: false,
    pendingCandidates: [],
  };
}

export interface RatOutcome {
  status: VerdictStatus;
  pivot: number;
  witnesses: RatWitness[];
  candidatesTested: number;
  failedWitnessRef: string | null;
  budgetRemaining: number;
  exhausted: boolean;
}

/**
 * RAT check for clause C with pivot p (default first literal):
 * for every active clause D containing -p, the resolvent
 * R = (C \ {p}) ∪ (D \ {-p}) must be RUP (and non-tautological).
 * RUP and RAT remain separate verdicts; a clause that is RUP never needs RAT.
 */
export function ratCheck(
  db: ClauseDatabase,
  clause: number[],
  params: RuleParameters,
  pivot?: number,
): RatOutcome {
  const p = pivot ?? clause[0];
  const witnesses: RatWitness[] = [];
  let candidateBudget = params.maxResolutionCandidates;
  const cRest = clause.filter((l) => l !== p);
  const sign = new Set(clause);
  let exhausted = false;

  if (p === undefined) {
    return { status: 'rejected', pivot: 0, witnesses, candidatesTested: 0, failedWitnessRef: null, budgetRemaining: candidateBudget, exhausted: false };
  }

  for (const d of db.all()) {
    if (!d.literals.includes(-p)) continue;
    if (candidateBudget <= 0) {
      exhausted = true;
      break;
    }
    candidateBudget--;
    const dRest = d.literals.filter((l) => l !== -p);
    const resolventSet = new Set<number>([...cRest, ...dRest]);
    const resolvent = [...resolventSet].sort((a, b) => a - b);
    let tautological = false;
    for (const l of resolvent) if (resolventSet.has(-l)) tautological = true;

    let rup: PropagationOutcome;
    if (tautological) {
      rup = { status: 'accepted', steps: [], conflictRef: null, budgetRemaining: 0, exhausted: false, pendingCandidates: [] };
    } else {
      rup = rupCheck(db, resolvent, params);
    }
    witnesses.push({
      witnessRef: d.ref,
      witnessOffset: { startByte: d.startByte, endByte: d.endByte },
      resolventRef: tautological ? null : `res:${d.ref}`,
      resolventLiterals: resolvent,
      rup: {
        kind: 'addition',
        isDuplicate: false,
        isTautology: tautological,
        hasDuplicateLiterals: false,
        rup: rup.status,
        rat: 'diagnostic',
        status: tautological ? 'accepted' : rup.status,
        adopted: tautological || rup.status === 'accepted',
        basis: tautological ? ['RESOLVENT_TAUTOLOGY'] : rup.status === 'accepted' ? ['RUP_CONFLICT'] : rup.exhausted ? ['BUDGET_EXHAUSTED'] : ['RUP_REJECTED'],
        propChain: rup.steps,
        conflictClauseRef: rup.conflictRef,
        ratPivot: p,
        ratWitnesses: [],
        failurePrefix: null,
        message: tautological ? 'resolvent is tautological' : '',
        propagationStepsUsed: rup.steps.length,
        budget: { maxPropagationSteps: params.maxPropagationSteps, maxResolutionCandidates: params.maxResolutionCandidates },
        budgetRemaining: rup.budgetRemaining,
      },
    });
    if (rup.status === 'rejected') {
      return { status: 'rejected', pivot: p, witnesses, candidatesTested: params.maxResolutionCandidates - candidateBudget, failedWitnessRef: d.ref, budgetRemaining: candidateBudget, exhausted: false };
    }
    if (rup.status === 'inconclusive') {
      exhausted = true;
      break;
    }
  }

  if (exhausted) {
    return { status: 'inconclusive', pivot: p, witnesses, candidatesTested: params.maxResolutionCandidates - candidateBudget, failedWitnessRef: null, budgetRemaining: candidateBudget, exhausted: true };
  }
  // No witness clauses: vacuously RAT (blocked/introduction), still recorded.
  return { status: 'accepted', pivot: p, witnesses, candidatesTested: params.maxResolutionCandidates - candidateBudget, failedWitnessRef: null, budgetRemaining: candidateBudget, exhausted: false };
}

export function buildInitialDatabase(cnf: CnfDocument): ClauseDatabase {
  const db = new ClauseDatabase();
  for (const c of cnf.clauses) {
    db.add(c.normalizedLiterals, 'input', null, { startByte: c.startByte, endByte: c.endByte });
  }
  return db;
}

function baseVerdict(line: ProofLineData, params: RuleParameters): LineVerdict {
  return {
    kind: line.deletion ? 'deletion' : 'addition',
    isDuplicate: false,
    isTautology: line.tautology,
    hasDuplicateLiterals: line.hasDuplicateLiterals,
    rup: 'inconclusive',
    rat: 'diagnostic',
    status: 'diagnostic',
    adopted: false,
    basis: [],
    propChain: [],
    conflictClauseRef: null,
    ratPivot: null,
    ratWitnesses: [],
    failurePrefix: null,
    message: '',
    propagationStepsUsed: 0,
    budget: {
      maxPropagationSteps: params.maxPropagationSteps,
      maxResolutionCandidates: params.maxResolutionCandidates,
    },
    budgetRemaining: params.maxPropagationSteps,
  };
}

export function verifyProof(
  cnf: CnfDocument,
  proof: ProofDocument,
  params: RuleParameters,
): ProofResult {
  const db = buildInitialDatabase(cnf);
  const verdicts: LineVerdict[] = [];
  let halted = false;
  let shortestFailurePrefix: number | null = null;
  let finalEmptyClause: LineVerdict | null = null;

  for (const line of proof.lines) {
    const v = baseVerdict(line, params);
    if (halted) {
      v.status = 'halted';
      v.basis.push('AFTER_HALT');
      v.message = 'not processed: proof already halted at an earlier line';
      verdicts.push(v);
      continue;
    }

    // Syntax-level handling (missing zero, bad tokens).
    const syntaxError = line.diagnostics.find((d) => d.severity === 'error');
    if (syntaxError) {
      v.status = 'rejected';
      v.basis.push(syntaxError.code);
      v.message = syntaxError.message;
      v.failurePrefix = line.index;
      shortestFailurePrefix = line.index;
      v.adopted = false;
      halted = true;
      verdicts.push(v);
      continue;
    }

    if (line.deletion) {
      const del = db.delete(line.literals);
      if (!del.existed) {
        v.status = 'diagnostic';
        v.basis.push('DELETE_NOT_PRESENT');
        v.message = `deletion targets a clause not present in the active multiset; multiset unchanged`;
        v.adopted = false;
      } else if (!del.removed) {
        v.status = 'accepted';
        v.basis.push('DELETE_ONE_COPY');
        v.message = `one copy deleted; ${del.entry!.multiplicity} cop(ies) still active`;
        v.adopted = true;
      } else {
        v.status = 'accepted';
        v.basis.push('DELETE_REMOVED');
        v.message = 'clause removed from the active multiset';
        v.adopted = true;
      }
      verdicts.push(v);
      continue;
    }

    // ADDITION
    const { isDuplicate } = db.add(line.literals, 'proof', line.index, {
      startByte: line.startByte,
      endByte: line.endByte,
    });
    v.isDuplicate = isDuplicate;

    if (line.literals.length === 0) {
      // Empty clause was tentatively inserted by the multiset add above;
      // remove it again so the RUP test runs against the prior database.
      db.delete(line.literals);
      const out2 = rupCheck(db, [], params);
      v.rup = out2.status;
      v.rat = 'diagnostic';
      v.propChain = out2.steps;
      v.conflictClauseRef = out2.conflictRef;
      v.propagationStepsUsed = out2.steps.length;
      v.budgetRemaining = out2.budgetRemaining;
      if (out2.status === 'accepted') {
        db.add(line.literals, 'proof', line.index, { startByte: line.startByte, endByte: line.endByte });
        v.status = 'accepted';
        v.adopted = true;
        v.basis.push('RUP_CONFLICT', 'EMPTY_CLAUSE');
        v.message = 'empty clause reached by unit conflict: formula is UNSAT';
        finalEmptyClause = v;
      } else if (out2.exhausted) {
        v.status = 'inconclusive';
        v.adopted = false;
        v.basis.push('BUDGET_EXHAUSTED');
        v.message = 'empty clause not confirmed: propagation budget exhausted (not invalid)';
        v.failurePrefix = line.index;
        shortestFailurePrefix = line.index;
        halted = true;
      } else {
        v.status = 'rejected';
        v.adopted = false;
        v.basis.push('RUP_REJECTED');
        v.message = 'empty clause claimed without unit conflict: proof fails';
        v.failurePrefix = line.index;
        shortestFailurePrefix = line.index;
        halted = true;
      }
      verdicts.push(v);
      continue;
    }

    if (line.tautology) {
      v.status = params.allowTautologyAddition ? 'accepted' : 'rejected';
      v.adopted = params.allowTautologyAddition;
      v.basis.push('TAUTOLOGY');
      if (isDuplicate) v.basis.push('DUPLICATE_CLAUSE');
      v.message = params.allowTautologyAddition
        ? 'tautology handled at syntax level: SAT-equivalent, adopted without RUP/RAT'
        : 'tautology addition disabled by current rule parameters';
      if (!params.allowTautologyAddition) {
        db.delete(line.literals);
        v.failurePrefix = line.index;
        shortestFailurePrefix = line.index;
        halted = true;
      }
      verdicts.push(v);
      continue;
    }

    // Non-tautological addition: RUP first (kept distinct from RAT).
    db.delete(line.literals); // check against DB without candidate
    const rup = rupCheck(db, line.literals, params);
    v.rup = rup.status;
    v.propChain = rup.steps;
    v.conflictClauseRef = rup.conflictRef;
    v.propagationStepsUsed = rup.steps.length;
    v.budgetRemaining = rup.budgetRemaining;

    if (rup.status === 'accepted') {
      db.add(line.literals, 'proof', line.index, { startByte: line.startByte, endByte: line.endByte });
      v.rat = 'diagnostic';
      v.status = 'accepted';
      v.adopted = true;
      v.basis.push('RUP_CONFLICT');
      if (isDuplicate) v.basis.push('DUPLICATE_CLAUSE');
      v.message = isDuplicate
        ? 'duplicate of an active clause; independently RUP-verified, multiplicity incremented'
        : 'unit propagation reached a conflict (RUP)';
      verdicts.push(v);
      continue;
    }

    if (rup.status === 'inconclusive') {
      v.rat = 'diagnostic';
      v.status = 'inconclusive';
      v.adopted = false;
      v.basis.push('BUDGET_EXHAUSTED');
      v.message = 'RUP inconclusive: propagation budget exhausted; not a verdict of invalidity';
      v.failurePrefix = line.index;
      shortestFailurePrefix = line.index;
      halted = true;
      verdicts.push(v);
      continue;
    }

    // RUP rejected: try RAT with the pivot (first literal by DRAT convention).
    if (params.ratMode === 'rup-only') {
      v.rat = 'diagnostic';
      v.status = 'rejected';
      v.adopted = false;
      v.basis.push('RUP_REJECTED', 'RAT_DISABLED');
      v.message = 'RUP failed and RAT is disabled by rule parameters';
      v.failurePrefix = line.index;
      shortestFailurePrefix = line.index;
      halted = true;
      verdicts.push(v);
      continue;
    }

    const pivot = line.literals[0];
    const rat = ratCheck(db, line.literals, params, pivot);
    v.rat = rat.status;
    v.ratPivot = pivot;
    v.ratWitnesses = rat.witnesses;
    v.budgetRemaining = rat.budgetRemaining;

    if (rat.status === 'accepted') {
      db.add(line.literals, 'proof', line.index, { startByte: line.startByte, endByte: line.endByte });
      v.status = 'accepted';
      v.adopted = true;
      v.basis.push('RAT_WITNESS');
      if (rat.witnesses.length === 0) v.basis.push('RAT_VACUOUS');
      v.message = `not RUP, but RAT holds for pivot ${pivot} (${rat.witnesses.length} witness resolvent(s) RUP)`;
    } else if (rat.status === 'inconclusive') {
      v.status = 'inconclusive';
      v.adopted = false;
      v.basis.push('BUDGET_EXHAUSTED');
      v.message = 'RAT inconclusive: resolution/propagation budget exhausted; not invalid';
      v.failurePrefix = line.index;
      shortestFailurePrefix = line.index;
      halted = true;
    } else {
      v.status = 'rejected';
      v.adopted = false;
      v.basis.push('RUP_REJECTED', 'RAT_REJECTED');
      v.message = `RAT fails for pivot ${pivot}: witness ${rat.failedWitnessRef} has a non-RUP resolvent`;
      v.failurePrefix = line.index;
      shortestFailurePrefix = line.index;
      halted = true;
    }
    verdicts.push(v);
  }

  return { verdicts, shortestFailurePrefix, finalEmptyClause, halted };
}
