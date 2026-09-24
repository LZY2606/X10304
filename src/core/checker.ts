// DRAT 核验器：RUP 与 RAT 检查区分；删除不存在子句不改变集合但留诊断；
// tautology / 重复 literal / 零终止按语法处理；资源耗尽不是证明无效。
import type {
  CheckEvent, CheckResult, CheckStatus, ClauseEntry, CnfParse, ProofParse, PropStep, StepResult,
} from './types';
import { clauseKey, isTautology, hasDuplicateLits } from './dimacs';
import { budgetQty } from './normalize';
import { stableId } from './id';

export interface CheckParams { budget: number }

type Multiset = Map<string, { count: number; clauseIds: string[]; lits: number[] }>;

function snapshot(ms: Multiset): ClauseEntry[] {
  return [...ms.entries()]
    .map(([key, v]) => ({ key, count: v.count, clauseIds: [...v.clauseIds] }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

interface PropOutcome {
  status: 'conflict' | 'ok' | 'exhausted';
  trace: PropStep[];
  propagations: number;
  conflictClauseKey: string | null;
}

// 朴素单元传播：记录每一步传播理由（来源子句），预算单位是 propagation-step。
function unitPropagate(
  clauses: { key: string; lits: number[] }[],
  assumptions: number[],
  budget: number,
): PropOutcome {
  const assignment = new Map<number, boolean>();
  const trace: PropStep[] = [];
  let propagations = 0;
  const assign = (lit: number, reason: string | null): boolean => {
    const v = Math.abs(lit), val = lit > 0;
    const cur = assignment.get(v);
    if (cur !== undefined) return cur === val;
    assignment.set(v, val);
    trace.push({ lit, reasonClauseKey: reason, assignment: { [v]: val } });
    if (reason !== null) propagations++;
    return true;
  };
  for (const a of assumptions) assign(a, null);
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of clauses) {
      let satisfied = false, unassigned = 0, lastLit = 0;
      for (const l of c.lits) {
        const val = assignment.get(Math.abs(l));
        if (val === undefined) { unassigned++; lastLit = l; }
        else if (val === l > 0) { satisfied = true; break; }
      }
      if (satisfied) continue;
      if (unassigned === 0) {
        return { status: 'conflict', trace, propagations, conflictClauseKey: c.key };
      }
      if (unassigned === 1) {
        if (propagations + 1 > budget) {
          return { status: 'exhausted', trace, propagations, conflictClauseKey: null };
        }
        if (assign(lastLit, c.key)) changed = true;
      }
    }
  }
  return { status: 'ok', trace, propagations, conflictClauseKey: null };
}

interface RupOutcome { result: 'verified' | 'failed' | 'exhausted'; prop: PropOutcome }

function rupCheck(ms: Multiset, clause: number[], budget: number): RupOutcome {
  const clauses = [...ms.values()].flatMap(v => Array.from({ length: 1 }, () => ({ key: clauseKey(v.lits), lits: v.lits })));
  const prop = unitPropagate(clauses, clause.map(l => -l), budget);
  return { result: prop.status === 'conflict' ? 'verified' : prop.status === 'exhausted' ? 'exhausted' : 'failed', prop };
}

function resolveClause(c: number[], d: number[], pivot: number): number[] {
  const out = new Set<number>();
  for (const l of c) if (l !== pivot) out.add(l);
  for (const l of d) if (l !== -pivot) out.add(l);
  return [...out];
}

export function checkProof(cnf: CnfParse, proof: ProofParse, params: CheckParams): CheckResult {
  const events: CheckEvent[] = [];
  const steps: StepResult[] = [];
  const ms: Multiset = new Map();
  const ev = (step: number, kind: CheckEvent['kind'], status: CheckStatus, summary: string, details: Record<string, unknown>) => {
    const id = stableId(proof.sourceName, step, kind, summary);
    const e: CheckEvent = { id, step, kind, status, summary, details };
    events.push(e);
    return e;
  };

  for (const c of cnf.clauses) {
    const key = clauseKey(c.lits);
    const cur = ms.get(key) ?? { count: 0, clauseIds: [], lits: c.lits };
    cur.count++; cur.clauseIds.push(c.id);
    ms.set(key, cur);
  }
  const initialActive = snapshot(ms);
  ev(-1, 'syntax', 'ok', `导入 CNF：${cnf.clauses.length} 条子句进入多重集`, {
    clauses: cnf.clauses.length, diagnostics: cnf.diagnostics.map(d => d.code),
  });

  let verdict: CheckResult['verdict'] = 'verified';
  let failingPrefix: number | null = null;
  let emptyClauseDerived = false;
  let sawExhausted = false;

  for (const line of proof.lines) {
    const key = clauseKey(line.lits);
    const stepEvents: CheckEvent[] = [];
    const mark = (kind: CheckEvent['kind'], status: CheckStatus, summary: string, details: Record<string, unknown>) => {
      const e = ev(line.index, kind, status, summary, details);
      stepEvents.push(e);
      return e;
    };
    for (const d of line.diagnostics) {
      mark('syntax', 'diagnostic', d.message, { code: d.code, severity: d.severity });
    }

    let status: CheckStatus = 'ok';
    let pivot: number | null = null;
    let pivotCandidates: StepResult['pivotCandidates'] = [];
    let propagation: PropStep[] = [];
    let propagationsUsed = 0;

    if (line.kind === 'delete') {
      const cur = ms.get(key);
      if (!cur || cur.count === 0) {
        status = 'diagnostic';
        mark('delete_clause', 'diagnostic', `删除不存在的子句 [${key}]：集合不变，保留诊断`, { clauseKey: key });
      } else {
        cur.count--; cur.clauseIds.shift();
        if (cur.count === 0) ms.delete(key);
        mark('delete_clause', 'ok', `删除子句 [${key}]，多重集计数减一`, { clauseKey: key });
      }
    } else {
      const taut = isTautology(line.lits);
      if (taut) {
        mark('add_clause', 'diagnostic', 'tautology 子句永真，按语法接受', { code: 'tautology', clauseKey: key });
      }
      if (ms.has(key)) {
        mark('add_clause', 'diagnostic', '重复子句：已在活跃多重集中，计数加一', { code: 'duplicate_clause', clauseKey: key });
      }
      const rup = rupCheck(ms, line.lits, params.budget);
      propagation = rup.prop.trace;
      propagationsUsed = rup.prop.propagations;
      if (rup.result === 'verified') {
        mark('rup_check', 'ok', `RUP 通过：${rup.prop.propagations} 次传播后冲突`, {
          clauseKey: key, propagations: rup.prop.propagations,
          conflictClauseKey: rup.prop.conflictClauseKey,
        });
      } else if (rup.result === 'exhausted') {
        status = 'exhausted';
        sawExhausted = true;
        mark('budget', 'exhausted', `传播预算 ${params.budget} 步耗尽：资源耗尽不是证明无效，结论为不确定`, {
          clauseKey: key, budget: params.budget,
        });
      } else {
        // RUP 失败 → RAT 检查。pivot 首选第一个 literal；同时评估全部合法候选并保留。
        const candidates: StepResult['pivotCandidates'] = [];
        for (const p of new Set(line.lits)) {
          const resolvents: StepResult['pivotCandidates'][number]['resolvents'] = [];
          let allOk = true;
          let anyExhausted = false;
          for (const [dKey, d] of ms) {
            if (!d.lits.includes(-p)) continue;
            const resolvent = resolveClause(line.lits, d.lits, p);
            const r = rupCheck(ms, resolvent, params.budget);
            resolvents.push({ withClause: dKey, resolvent, rup: r.result });
            if (r.result === 'exhausted') anyExhausted = true;
            if (r.result !== 'verified') allOk = false;
          }
          candidates.push({ pivot: p, ok: allOk, resolvents });
        }
        pivotCandidates = candidates;
        const primary = line.lits[0];
        const primaryOk = candidates.find(c => c.pivot === primary)?.ok ?? false;
        const okPivots = candidates.filter(c => c.ok).map(c => c.pivot);
        if (primaryOk) {
          pivot = primary;
          mark('rat_check', 'ok', `RAT 通过：pivot=${primary}，全部归结式 RUP 成立`, {
            clauseKey: key, pivot: primary, okPivots, candidates,
          });
        } else if (okPivots.length > 0) {
          status = 'diagnostic';
          pivot = okPivots[0];
          mark('rat_check', 'diagnostic', `首选 pivot=${primary} 不成立，但存在合法候选 pivot：${okPivots.join('/')}（全部保留）`, {
            clauseKey: key, okPivots, candidates,
          });
        } else if (candidates.some(c => c.resolvents.some(r => r.rup === 'exhausted'))) {
          status = 'exhausted';
          sawExhausted = true;
          mark('budget', 'exhausted', 'RAT 归结式检查中预算耗尽：结论不确定而非无效', { clauseKey: key, candidates });
        } else {
          status = 'failed';
          mark('rat_check', 'failed', `RUP 与 RAT 均不成立：子句 [${key}] 不可加入`, { clauseKey: key, candidates });
        }
      }
      if (status !== 'failed' && status !== 'exhausted') {
        const cur = ms.get(key) ?? { count: 0, clauseIds: [], lits: line.lits };
        cur.count++; cur.clauseIds.push(line.id);
        ms.set(key, cur);
        if (line.lits.length === 0) emptyClauseDerived = true;
      }
      if (status === 'failed' && failingPrefix === null) {
        failingPrefix = line.index + 1; // 最短失败前缀
        mark('verdict', 'failed', `最短失败前缀：前 ${failingPrefix} 行 proof`, { failingPrefix });
        steps.push({
          lineIndex: line.index, lineId: line.id, kind: line.kind, lits: line.lits,
          clauseKey: key, status, events: stepEvents, pivot, pivotCandidates,
          propagation, propagationsUsed, activeAfter: snapshot(ms),
        });
        break;
      }
    }
    steps.push({
      lineIndex: line.index, lineId: line.id, kind: line.kind, lits: line.lits,
      clauseKey: key, status, events: stepEvents, pivot, pivotCandidates,
      propagation, propagationsUsed, activeAfter: snapshot(ms),
    });
  }

  if (failingPrefix !== null) {
    verdict = 'failed';
  } else if (sawExhausted) {
    verdict = 'inconclusive_resource';
  } else if (!emptyClauseDerived) {
    verdict = 'failed';
    failingPrefix = proof.lines.length;
    ev(proof.lines.length - 1, 'verdict', 'failed', 'proof 结束但未推出空子句', { failingPrefix });
  } else {
    ev(proof.lines.length - 1, 'verdict', 'ok', '空子句已推出，UNSAT 证明核验通过', {});
  }

  return {
    params: { budget: budgetQty(params.budget) },
    initialActive,
    steps, events, verdict, failingPrefix, emptyClauseDerived,
  };
}
