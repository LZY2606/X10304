// 核心核验规则：子句多重集、单位传播、RUP 与 RAT 的区分。
// 所有“解析偏移”(activeIndex) 指：理由子句在该次子句检查开始时冻结的活跃多重集中的下标。
// 资源预算单位：unit-propagation step；预算耗尽产生 unknown，绝不判证明无效。

import {
  type ActiveClauseView, type ClauseOccurrence, type PropStep,
  type RatPivotCandidate, type RatWitnessClause, type RupWitness,
} from './types';
import { scopedId } from './identity';

export interface ActiveEntry {
  occurrenceId: string;
  literals: number[];      // 语义计算用（重复 literal 去重后；原始重复仍在解析层 flags 中）
  original: number[];
  multisetKey: string;
  bornAtLine: number;
}

export function multisetKeyOf(literals: number[]): string {
  return [...new Set(literals)].sort((a, b) => a - b).join(',');
}

export function snapshotViews(active: ActiveEntry[]): ActiveClauseView[] {
  return active.map((e) => ({
    occurrenceId: e.occurrenceId,
    multisetKey: e.multisetKey,
    literals: [...e.literals],
    bornAtLine: e.bornAtLine,
  }));
}

// 确定性地从多重集移除一个匹配子句（最早进入者）。
export function removeOneByKey(active: ActiveEntry[], key: string): ActiveEntry | null {
  const idx = active.findIndex((e) => e.multisetKey === key);
  if (idx < 0) return null;
  const [removed] = active.splice(idx, 1);
  return removed;
}

class Budget {
  used = 0;
  constructor(public limit: number) {} // 0 = 不限
  consume(n = 1): boolean {
    this.used += n;
    return this.limit !== 0 && this.used > this.limit;
  }
}

export interface PropResult {
  witness: RupWitness;
  exhausted: boolean;
}

// 单位传播（assumptions 为被假设为真的字面量）。active 在调用期间冻结，解析偏移稳定。
export function unitPropagate(
  active: ActiveEntry[],
  assumptions: number[],
  limit: number,
  idScope: string,
): PropResult {
  const value = new Map<number, boolean>(); // var -> true 表示正文字为真
  const trail: PropStep[] = [];
  let order = 0;
  let conflictId: string | null = null;
  let conflictIndex: number | null = null;
  let exhausted = false;
  const budget = new Budget(limit);

  const assign = (lit: number, reason: PropStep['reason'], occId: string | null, idx: number | null): boolean => {
    const v = Math.abs(lit);
    const litValue = lit > 0;
    if (value.has(v)) {
      if (value.get(v) !== litValue) {
        conflictId = reason === 'assumption' ? 'assumption' : occId;
        conflictIndex = idx;
        return false;
      }
      return true;
    }
    value.set(v, litValue);
    trail.push({
      id: scopedId('step', idScope, order),
      order: order++,
      literal: lit,
      reason,
      reasonOccurrenceId: occId,
      activeIndex: idx,
    });
    return true;
  };

  for (const lit of assumptions) {
    if (!assign(lit, 'assumption', null, null)) break;
  }

  if (conflictId === null) {
    let changed = true;
    outer:
    while (changed && conflictId === null && !exhausted) {
      changed = false;
      for (let idx = 0; idx < active.length; idx++) {
        const entry = active[idx];
        let unassignedLit = 0;
        let unassignedCount = 0;
        let allFalse = true;
        for (const lit of entry.literals) {
          const v = Math.abs(lit);
          if (!value.has(v)) {
            unassignedCount++;
            unassignedLit = lit;
            allFalse = false;
          } else if (value.get(v) === (lit > 0)) {
            allFalse = false;
            break;
          }
        }
        if (allFalse) {
          conflictId = entry.occurrenceId;
          conflictIndex = idx;
          break outer;
        }
        if (unassignedCount === 1) {
          const uv = Math.abs(unassignedLit);
          if (value.has(uv)) {
            conflictId = entry.occurrenceId;
            conflictIndex = idx;
            break outer;
          }
          if (budget.consume(1)) { exhausted = true; break outer; }
          assign(unassignedLit, 'unit', entry.occurrenceId, idx);
          changed = true;
        }
      }
    }
  }

  const witness: RupWitness = {
    holds: !exhausted && conflictId !== null,
    exhausted,
    stepsUsed: budget.used,
    budget: limit,
    trail,
    conflictOccurrenceId: exhausted ? null : conflictId,
    conflictActiveIndex: exhausted ? null : conflictIndex,
  };
  return { witness, exhausted };
}

// RUP：¬C 下单位传播是否到达冲突。
export function checkRup(active: ActiveEntry[], clause: number[], limit: number, idScope: string): RupWitness {
  const assumptions = [...new Set(clause)].map((l) => -l);
  return unitPropagate(active, assumptions, limit, idScope).witness;
}

function resolvent(c: number[], d: number[], pivot: number): { lits: number[]; tautology: boolean } {
  const set = new Set<number>();
  for (const l of c) if (l !== pivot) set.add(l);
  for (const l of d) if (l !== -pivot) set.add(l);
  let tautology = false;
  for (const l of set) if (set.has(-l)) { tautology = true; break; }
  return { lits: [...set].sort((a, b) => a - b), tautology };
}

// RAT：逐 pivot 候选检查所有含 ¬p 的活跃子句；保留全部合法候选，不吞掉多解。
export function checkRat(
  active: ActiveEntry[],
  clause: number[],
  limit: number,
  idScope: string,
): { exhausted: boolean; candidates: RatPivotCandidate[] } {
  const pivots = [...new Set(clause)];
  const candidates: RatPivotCandidate[] = [];
  let exhausted = false;

  for (const pivot of pivots) {
    const witnesses: RatWitnessClause[] = [];
    let holds = true;
    let vacuous = true;
    let pivotExhausted = false;
    for (let idx = 0; idx < active.length; idx++) {
      const entry = active[idx];
      if (!entry.literals.includes(-pivot)) continue;
      vacuous = false;
      const r = resolvent(clause, entry.literals, pivot);
      if (r.tautology) {
        witnesses.push({
          occurrenceId: entry.occurrenceId,
          activeIndex: idx,
          resolvent: r.lits,
          resolventTautology: true,
          rup: null,
        });
        continue;
      }
      const { witness, exhausted: subEx } = unitPropagate(
        active, r.lits.map((l) => -l), limit, `${idScope}:p${pivot}:i${idx}`,
      );
      witnesses.push({
        occurrenceId: entry.occurrenceId,
        activeIndex: idx,
        resolvent: r.lits,
        resolventTautology: false,
        rup: witness,
      });
      if (subEx) { holds = false; pivotExhausted = true; exhausted = true; break; }
      if (!witness.holds) holds = false;
    }
    candidates.push({ pivot, vacuous, holds, exhausted: pivotExhausted, witnesses });
    if (exhausted) break;
  }
  return { exhausted, candidates };
}

// 无法唯一决定 pivot 时：holds 候选恰好 1 个才选中；多个或零个返回 null（保留全部候选）。
export function choosePivot(candidates: RatPivotCandidate[]): number | null {
  const legal = candidates.filter((c) => c.holds);
  return legal.length === 1 ? legal[0].pivot : null;
}

export function proofOccurrence(
  lineOrdinal: number, literals: number[], caseId: string, activeLen: number,
): ClauseOccurrence {
  const dedup = [...new Set(literals)];
  return {
    id: scopedId('cl:proof', caseId, lineOrdinal, multisetKeyOf(literals), activeLen),
    source: 'proof',
    ordinal: activeLen,
    lineOrdinal,
    literals: dedup,
    multisetKey: multisetKeyOf(literals),
    tokenIds: [],
  };
}
