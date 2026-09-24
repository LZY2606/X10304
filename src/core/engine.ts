import type {
  ActiveClause,
  Budget,
  ClauseCheck,
  LineStatus,
  PropStep,
  Qty,
  RatCandidate,
  ResolutionChain,
  RupCheck
} from './types';
import { DEFAULT_PARAMS } from './types';
import type { VerifierParams } from './types';
import { canonicalize } from './parser';

const qty = (value: number, unit: string): Qty => ({ value, unit });

export interface PropInput {
  clauses: ActiveClause[];
  assumptions: number[];
  maxPropagationSteps: number;
  maxClauseVisits: number;
  chainIdPrefix: string;
}

export type PropOutcome =
  | { conflict: true; chain: ResolutionChain; budget: Budget; trail: Map<number, PropStep> }
  | { conflict: false; fixpoint: number[]; budget: Budget; exhausted: boolean; trail: Map<number, PropStep> };

const neg = (lit: number): number => -lit;

function valueOf(lit: number, assign: Map<number, boolean>): boolean | undefined {
  const v = assign.get(Math.abs(lit));
  if (v === undefined) return undefined;
  return lit > 0 ? v : !v;
}
function setLit(lit: number, assign: Map<number, boolean>): void {
  assign.set(Math.abs(lit), lit > 0);
}

/**
 * 预算受限的前向单位传播（带理由记录）。
 * 扫描顺序固定：instanceId 字典序；每轮全表扫描，保证确定式可重复。
 */
export function unitPropagate(input: PropInput): PropOutcome {
  const { clauses, assumptions } = input;
  const assign = new Map<number, boolean>();
  const trail = new Map<number, PropStep>();
  const budget: Budget = {
    maxPropagationSteps: input.maxPropagationSteps,
    maxClauseVisits: input.maxClauseVisits,
    counters: { propagationSteps: 0, clauseVisits: 0 },
    exhausted: false
  };

  for (const a of assumptions) {
    const cur = valueOf(a, assign);
    if (cur === false) {
      return { conflict: true, chain: emptyChain(input.chainIdPrefix, 'assumption'), budget, trail };
    }
    if (cur === undefined) setLit(a, assign);
  }

  const sorted = [...clauses].sort((x, y) => (x.instanceId < y.instanceId ? -1 : 1));
  const clauseById = new Map(sorted.map((c) => [c.instanceId, c]));

  for (;;) {
    let conflictClause: ActiveClause | undefined;
    let unitLit = 0;
    let unitClause: ActiveClause | undefined;
    let unitOffset = -1;

    for (const cl of sorted) {
      budget.counters.clauseVisits += 1;
      if (budget.counters.clauseVisits > budget.maxClauseVisits) {
        budget.exhausted = true;
        budget.exhaustedOn = 'clause-visit';
        return { conflict: false, fixpoint: currentFixpoint(assign), budget, exhausted: true, trail };
      }
      let unassignedCount = 0;
      let candidateLit = 0;
      let candidateOffset = -1;
      let satisfied = false;
      cl.lits.forEach((lit, offset) => {
        const val = valueOf(lit, assign);
        if (val === true) satisfied = true;
        else if (val === undefined) {
          unassignedCount += 1;
          candidateLit = lit;
          candidateOffset = offset;
        }
      });
      if (satisfied) continue;
      if (unassignedCount === 0) {
        conflictClause = cl;
        break;
      }
      if (unassignedCount === 1 && unitClause === undefined) {
        unitLit = candidateLit;
        unitClause = cl;
        unitOffset = candidateOffset;
      }
    }

    if (conflictClause) {
      return {
        conflict: true,
        chain: buildChain(conflictClause, trail, input.chainIdPrefix, clauseById),
        budget,
        trail
      };
    }
    if (unitClause) {
      budget.counters.propagationSteps += 1;
      if (budget.counters.propagationSteps > budget.maxPropagationSteps) {
        budget.exhausted = true;
        budget.exhaustedOn = 'propagation-step';
        return { conflict: false, fixpoint: currentFixpoint(assign), budget, exhausted: true, trail };
      }
      if (valueOf(unitLit, assign) === false) {
        return { conflict: true, chain: buildChain(unitClause, trail, input.chainIdPrefix, clauseById), budget, trail };
      }
      if (valueOf(unitLit, assign) === undefined) {
        setLit(unitLit, assign);
        trail.set(unitLit, {
          stepNo: qty(trail.size + 1, 'prop-step'),
          literal: unitLit,
          reasonClauseId: unitClause.instanceId,
          pivotOffsetInReason: qty(unitOffset, 'lit-index'),
          decisionLevel: qty(0, 'dl')
        });
        continue;
      }
    }
    break;
  }

  return { conflict: false, fixpoint: currentFixpoint(assign), budget, exhausted: false, trail };
}

function currentFixpoint(assign: Map<number, boolean>): number[] {
  return [...assign.keys()].sort((a, b) => a - b).map((v) => (assign.get(v) ? v : -v));
}

function emptyChain(prefix: string, conflictClauseId: string): ResolutionChain {
  return { chainId: `${prefix}.chain#0`, steps: [], conflictClauseId, resolutionOffsets: [], resolventTrace: [] };
}

/**
 * 沿理由链回溯构造解析链。
 * 收集冲突子句假 literal 的传递理由，按传播编号排序，依次消元；
 * 每步记录理由子句中的解析偏移与当前预解式。
 */
function buildChain(
  conflictClause: ActiveClause,
  trail: Map<number, PropStep>,
  prefix: string,
  clauseById: Map<string, ActiveClause>
): ResolutionChain {
  const wanted = new Set<number>(); // 被传播为真的 literal
  const collect = (falseLitInClause: number): void => {
    const trueLit = -falseLitInClause; // 子句中该 literal 为假，其反面被传播
    const step = trail.get(trueLit);
    if (!step || wanted.has(trueLit)) return;
    wanted.add(trueLit);
    const reason = clauseById.get(step.reasonClauseId);
    if (reason) for (const l of reason.lits) if (l !== step.literal) collect(l);
  };
  conflictClause.lits.forEach(collect);

  const ordered = [...wanted]
    .map((trueLit) => trail.get(trueLit)!)
    .sort((a, b) => a.stepNo.value - b.stepNo.value);

  const steps: PropStep[] = [];
  const offsets: Qty[] = [];
  const resolventTrace: number[][] = [];
  let resolvent = canonicalize(conflictClause.lits);
  for (const step of ordered) {
    const reason = clauseById.get(step.reasonClauseId);
    if (!reason) continue;
    steps.push(step);
    offsets.push(step.pivotOffsetInReason);
    resolvent = resolveClauses(resolvent, reason.lits, step.literal);
    resolventTrace.push([...resolvent]);
  }
  return {
    chainId: `${prefix}.chain#${steps.length}`,
    steps,
    conflictClauseId: conflictClause.instanceId,
    resolutionOffsets: offsets,
    resolventTrace
  };
}

export function resolveClauses(a: number[], b: number[], pivot: number): number[] {
  const out: number[] = [];
  for (const lit of a) if (Math.abs(lit) !== Math.abs(pivot) && !out.includes(lit)) out.push(lit);
  for (const lit of b) if (Math.abs(lit) !== Math.abs(pivot) && !out.includes(lit)) out.push(lit);
  return out;
}

/**
 * RUP：假设新增子句 literal 全为假，UP 到冲突。
 * tautology 在语法层标记，核验时短路为合法（不产生传播）。
 */
export function checkRup(
  clauses: ActiveClause[],
  rawLits: number[],
  isTautology: boolean,
  params: VerifierParams = DEFAULT_PARAMS,
  chainIdPrefix = 'rup'
): RupCheck {
  if (isTautology) {
    return { kind: 'RUP', satisfied: true, budget: { propagationSteps: 0, clauseVisits: 0 }, budgetExhausted: false };
  }
  const outcome = unitPropagate({
    clauses,
    assumptions: canonicalize(rawLits).map(neg),
    maxPropagationSteps: params.maxPropagationSteps,
    maxClauseVisits: params.maxClauseVisits,
    chainIdPrefix
  });
  if (outcome.conflict) {
    return { kind: 'RUP', satisfied: true, chain: outcome.chain, budget: { ...outcome.budget.counters }, budgetExhausted: false };
  }
  return { kind: 'RUP', satisfied: false, budget: { ...outcome.budget.counters }, budgetExhausted: outcome.exhausted };
}

/**
 * RAT：对新增子句每个 pivot p 检查所有含 ¬p 的活跃子句 D，
 * 要求 RUP((C\\{p}) ∪ (D\\{-p}))。每个 pivot 候选都保留。
 */
export function checkRat(
  clauses: ActiveClause[],
  rawLits: number[],
  isTautology: boolean,
  params: VerifierParams = DEFAULT_PARAMS
): RatCheck {
  const cLits = canonicalize(rawLits);
  const sortedClauses = [...clauses].sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1));
  const candidates: RatCandidate[] = cLits.map((pivot, offset) => {
    const base = { pivot, pivotOffset: qty(offset, 'lit-index') };
    if (isTautology) {
      return { ...base, satisfied: true, budget: { propagationSteps: 0, clauseVisits: 0 }, budgetExhausted: false };
    }
    const witnesses = sortedClauses.filter((cl) => cl.lits.includes(-pivot));
    if (witnesses.length === 0) {
      return { ...base, satisfied: true, budget: { propagationSteps: 0, clauseVisits: 0 }, budgetExhausted: false };
    }
    let allSatisfied = true;
    let anyExhausted = false;
    let lastChain: ResolutionChain | undefined;
    const totalBudget = { propagationSteps: 0, clauseVisits: 0 };
    for (const w of witnesses) {
      const merged = canonicalize([
        ...cLits.filter((l) => l !== pivot),
        ...w.lits.filter((l) => l !== -pivot)
      ]);
      const outcome = unitPropagate({
        clauses: sortedClauses,
        assumptions: merged.map(neg),
        maxPropagationSteps: params.maxPropagationSteps,
        maxClauseVisits: params.maxClauseVisits,
        chainIdPrefix: `rat.${pivot}.${w.instanceId}`
      });
      totalBudget.propagationSteps += outcome.budget.counters.propagationSteps;
      totalBudget.clauseVisits += outcome.budget.counters.clauseVisits;
      if (outcome.conflict) {
        lastChain = outcome.chain;
        continue;
      }
      if (outcome.exhausted) anyExhausted = true;
      allSatisfied = false;
    }
    return {
      ...base,
      negWitnessInstanceId: witnesses[0]?.instanceId,
      satisfied: allSatisfied,
      chain: lastChain,
      budget: totalBudget,
      budgetExhausted: anyExhausted && !allSatisfied
    };
  });
  return { kind: 'RAT', candidates };
}
export function statusOf(check: ClauseCheck): LineStatus {
  if (check.kind === 'RUP') {
    if (check.satisfied) return 'accepted';
    return check.budgetExhausted ? 'inconclusive' : 'rejected';
  }
  if (check.candidates.some((c) => c.satisfied && !c.budgetExhausted)) return 'accepted';
  return check.candidates.some((c) => c.budgetExhausted) ? 'inconclusive' : 'rejected';
}
