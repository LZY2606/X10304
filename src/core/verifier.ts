import type {
  ActiveClause,
  BudgetCounters,
  ClauseSpec,
  Diagnostic,
  LineResult,
  ParsedCnf,
  ParsedProof,
  VerificationResult,
  VerifierParams
} from './types';
import { DEFAULT_PARAMS } from './types';
import { canonicalize, clauseText } from './parser';
import { checkRat, checkRup, statusOf, unitPropagate } from './engine';

interface VerifierState {
  active: ActiveClause[];
  dupCounter: Map<string, number>; // specId -> 已存在副本数
  counters: BudgetCounters;
}

function sameClause(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

function addActive(state: VerifierState, specId: string, lits: number[], introducedAt: number, tautology: boolean): ActiveClause {
  const n = state.dupCounter.get(specId) ?? 0;
  state.dupCounter.set(specId, n + 1);
  const inst: ActiveClause = {
    instanceId: n === 0 ? `act.${specId}` : `act.${specId}#${n}`,
    specId,
    lits: canonicalize(lits),
    introducedAt,
    multiplicity: { value: n + 1, unit: 'clause-copy' },
    tautology
  };
  state.active.push(inst);
  return inst;
}

export interface VerifyInput {
  cnf: ParsedCnf;
  proof: ParsedProof;
  params?: Partial<VerifierParams>;
  ruleSetId?: string;
}

export function verify(input: VerifyInput): VerificationResult {
  const params: VerifierParams = { ...DEFAULT_PARAMS, ...input.params };
  const ruleSetId = input.ruleSetId ?? 'rules.default.v1';
  const state: VerifierState = { active: [], dupCounter: new Map(), counters: { propagationSteps: 0, clauseVisits: 0 } };
  const diagnostics: Diagnostic[] = [...input.cnf.diagnostics, ...input.proof.diagnostics];
  const lineResults: LineResult[] = [];

  // 初始 CNF：多重集，重复子句保留多份，tautology 保留
  input.cnf.clauses.forEach((spec: ClauseSpec) => {
    addActive(state, spec.clauseId, spec.lits, -1, spec.tautology);
  });

  const varLimit = params.varBound === 'header' ? input.cnf.header.declaredVars : undefined;

  let firstFailure: number | undefined;
  let stopForBudget = false;

  input.proof.lines.forEach((line, step) => {
    if (stopForBudget) return; // 预算耗尽：不继续，但已产生 inconclusive 事件，不判证明无效
    const activeBefore = state.active.map((c) => c.instanceId);
    const budgetBefore: BudgetCounters = { ...state.counters };
    const stepDiags: Diagnostic[] = [];

    // 超大变量编号：按语法保留；varBound=header 时升级为 error
    const oversize = Math.max(0, ...line.lits.map((l) => Math.abs(l)));
    if (varLimit !== undefined && oversize > varLimit) {
      stepDiags.push({
        code: 'DRAT_VAR_OVERFLOW_STRICT',
        severity: 'error',
        message: `步骤 ${step} 变量 ${oversize} 超过严格上限 ${varLimit}（dimacs-var-1based）`,
        relatedIds: [line.lineId],
        rawValue: String(oversize)
      });
    }
    if (input.cnf.header.declaredVars !== undefined && oversize > input.cnf.header.declaredVars) {
      stepDiags.push({
        code: 'DRAT_VAR_OVERFLOW',
        severity: 'warning',
        message: `步骤 ${step} 出现变量 ${oversize} > 头声明 ${input.cnf.header.declaredVars}，原值保留`,
        relatedIds: [line.lineId],
        rawValue: String(oversize)
      });
    }
    if (!line.terminatorPresent && params.missingZero === 'error') {
      stepDiags.push({
        code: 'DRAT_MISSING_ZERO_FATAL',
        severity: 'error',
        message: `步骤 ${step} 缺零终止且参数 missingZero=error`,
        relatedIds: [line.lineId]
      });
    }

    if (line.kind === 'deletion') {
      // 删除：多重集定位。重复子句给出全部候选，逐副本删除。
      const targets = state.active.filter((c) => sameClause(c.lits, canonicalize(line.lits)));
      const targetIds = targets.map((t) => t.instanceId);
      if (targets.length === 0) {
        // 删除不存在子句：集合不变，只留诊断
        stepDiags.push({
          code: 'DRAT_DELETE_MISSING',
          severity: 'warning',
          message: `步骤 ${step} 请求删除不存在子句 [${clauseText(canonicalize(line.lits), false)}]，活跃多重集不变`,
          relatedIds: [line.lineId]
        });
        const budgetAfter = { ...state.counters };
        lineResults.push({
          lineId: line.lineId,
          step,
          mode: 'RUP',
          status: 'accepted',
          check: { kind: 'RUP', satisfied: true, budget: { propagationSteps: 0, clauseVisits: 0 }, budgetExhausted: false },
          dependencies: [],
          deletionTargets: [],
          activeClauseBefore: activeBefore,
          activeClauseAfter: [...activeBefore],
          budgetBefore,
          budgetAfter,
          budgetExhausted: false,
          diagnostics: stepDiags
        });
        return;
      }
      const idSet = new Set(targetIds);
      state.active = state.active.filter((c) => !idSet.has(c.instanceId));
      // 多次删除：副本计数不回收（身份不重用），只更新展示多重集
      const budgetAfter = { ...state.counters };
      lineResults.push({
        lineId: line.lineId,
        step,
        mode: 'RUP',
        status: 'accepted',
        check: { kind: 'RUP', satisfied: true, budget: { propagationSteps: 0, clauseVisits: 0 }, budgetExhausted: false },
        dependencies: targetIds,
        deletionTargets: targetIds,
        activeClauseBefore: activeBefore,
        activeClauseAfter: state.active.map((c) => c.instanceId),
        budgetBefore,
        budgetAfter,
        budgetExhausted: false,
        diagnostics: stepDiags
      });
      return;
    }

    // addition：先 RUP；RUP 不满足时再 RAT，两者结果都保留以显式区分。
    const rup = checkRup(state.active, line.lits, line.tautology, params, `step${step}.rup`);
    state.counters.propagationSteps += rup.budget.propagationSteps;
    state.counters.clauseVisits += rup.budget.clauseVisits;

    let mode: 'RUP' | 'RAT' = 'RUP';
    let adoptedPivot: number | undefined;
    let dependencies: string[] = [];
    let status = statusOf(rup);
    let budgetExhausted = rup.budgetExhausted;

    if (!rup.satisfied && !rup.budgetExhausted) {
      mode = 'RAT';
      const rat = checkRat(state.active, line.lits, line.tautology, params);
      rat.candidates.forEach((c) => {
        state.counters.propagationSteps += c.budget.propagationSteps;
        state.counters.clauseVisits += c.budget.clauseVisits;
      });
      status = statusOf(rat);
      const good = rat.candidates.filter((c) => c.satisfied && !c.budgetExhausted);
      // 无法唯一决定时保留全部合法候选；展示层/裁定可选择。默认不任意吞掉多解。
      adoptedPivot = good.length === 1 ? good[0].pivot : good.length > 1 ? good[0].pivot : undefined;
      dependencies = collectRatDependencies(rat, state.active, line.lits);
      if (status === 'inconclusive') budgetExhausted = true;
      if (good.length > 1) {
        stepDiags.push({
          code: 'DRAT_MULTIPLE_PIVOTS',
          severity: 'info',
          message: `步骤 ${step} 存在 ${good.length} 个合法 RAT pivot：${good.map((g) => g.pivot).join(',')}，全部保留`,
          relatedIds: [line.lineId]
        });
      }
      // 把 RAT 结果挂在 diagnostics 之外不可行（类型限制），用 result.check
      if (status === 'accepted') addActive(state, `line#${step}`, line.lits, step, line.tautology);
      const budgetAfter = { ...state.counters };
      if (status !== 'accepted' && firstFailure === undefined) firstFailure = step;
      if (budgetExhausted) stopForBudget = true;
      lineResults.push({
        lineId: line.lineId,
        step,
        mode: 'RAT',
        status,
        check: rat,
        adoptedPivot,
        dependencies,
        activeClauseBefore: activeBefore,
        activeClauseAfter: state.active.map((c) => c.instanceId),
        budgetBefore,
        budgetAfter,
        budgetExhausted,
        diagnostics: stepDiags
      });
      return;
    }

    // RUP 路径（含 tautology 短路）
    if (rup.chain) dependencies = collectChainDependencies(rup.chain);
    const hasFatal = stepDiags.some((d) => d.severity === 'error');
    if (rup.satisfied && !hasFatal) {
      addActive(state, `line#${step}`, line.lits, step, line.tautology);
    }
    if (rup.budgetExhausted) {
      status = 'inconclusive';
      budgetExhausted = true;
      stopForBudget = true;
      if (firstFailure === undefined) firstFailure = step;
    } else if (!rup.satisfied || hasFatal) {
      if (firstFailure === undefined) firstFailure = step;
      status = hasFatal ? 'rejected' : status;
    }
    const budgetAfter = { ...state.counters };
    lineResults.push({
      lineId: line.lineId,
      step,
      mode,
      status,
      check: rup,
      adoptedPivot,
      dependencies,
      activeClauseBefore: activeBefore,
      activeClauseAfter: state.active.map((c) => c.instanceId),
      budgetBefore,
      budgetAfter,
      budgetExhausted,
      diagnostics: stepDiags
    });
  });

  // 最终空子句：最后一个被采纳 addition 是否字面为空子句
  const lastLine = input.proof.lines[input.proof.lines.length - 1];
  const lastResult = lineResults[lineResults.length - 1];
  const finalEmptyClause = !!lastLine && lastLine.kind === 'addition' && lastLine.lits.length === 0 && lastResult?.status === 'accepted';
  const finalStatus = lineResults.length
    ? (lineResults[lineResults.length - 1].status === 'accepted' &&
      lineResults.every((r) => r.status === 'accepted')
      ? 'accepted'
      : lineResults.some((r) => r.status === 'rejected')
        ? 'rejected'
        : 'inconclusive')
    : 'inconclusive';

  diagnostics.push(...lineResults.flatMap((r) => r.diagnostics));

  return {
    ruleSetId,
    params,
    lineResults,
    shortestFailingPrefix: firstFailure,
    finalEmptyClause,
    finalStatus,
    diagnostics
  };
}

function collectChainDependencies(chain: { steps: { reasonClauseId: string }[]; conflictClauseId: string }): string[] {
  const ids = new Set<string>();
  chain.steps.forEach((s) => ids.add(s.reasonClauseId));
  ids.add(chain.conflictClauseId);
  return [...ids].filter((id) => id !== 'assumption').sort();
}

function collectRatDependencies(
  rat: ReturnType<typeof checkRat>,
  active: ActiveClause[],
  lineLits: number[]
): string[] {
  const ids = new Set<string>();
  for (const cand of rat.candidates) {
    if (!cand.satisfied) continue;
    for (const cl of active) {
      if (cl.lits.includes(-cand.pivot)) ids.add(cl.instanceId);
    }
    if (cand.chain) collectChainDependencies(cand.chain).forEach((id) => ids.add(id));
  }
  void lineLits;
  return [...ids].sort();
}

/** 供依赖图增量重算：返回某步结果所依赖的 instanceId -> 来源 specId 映射线索。 */
export function directUnitProps(clauses: ActiveClause[], assumptions: number[]) {
  return unitPropagate({
    clauses,
    assumptions,
    maxPropagationSteps: DEFAULT_PARAMS.maxPropagationSteps,
    maxClauseVisits: DEFAULT_PARAMS.maxClauseVisits,
    chainIdPrefix: 'probe'
  });
}
