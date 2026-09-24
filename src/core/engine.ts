// ---------------------------------------------------------------------------
// DRAT verification engine.
//
// Semantic guarantees enforced here:
//  - RUP and RAT are distinct checks. A clause that is not RUP may still be RAT.
//  - Deleting a clause absent from the active multiset leaves the multiset
//    unchanged but emits a DELETE_MISSING diagnostic.
//  - Tautology, repeated literals and the trailing 0 are syntax concerns.
//  - Exhausting the propagation budget is INCONCLUSIVE, never "proof invalid".
//  - Multiple legal deletion targets are all retained as candidates; the
//    most recently added instance is deterministically selected.
//
// The engine also builds a dependency graph of content-addressed nodes so that
// a later recomputation can explain which results stayed valid and which were
// recomputed (incremental propagation).
// ---------------------------------------------------------------------------

import { parseCnf, parseDrat } from "./syntax.js";
import { stableHash } from "./hash.js";
import type {
  ActiveClauseView,
  BudgetState,
  CheckStatus,
  ConflictInfo,
  Diagnostic,
  EngineReport,
  ParsedCnf,
  ParsedDrat,
  PropStep,
  ResolventTrace,
  ShortestFailure,
  StepResult,
} from "./types.js";

export const RULE_VERSION = "drat-rules-1.0.0";

export type NodeKind =
  | "cnf-file"
  | "drat-file"
  | "cnf-clause"
  | "proof-line"
  | "active-snapshot"
  | "propagation"
  | "conflict"
  | "rat-resolvent"
  | "step-gate"
  | "verdict";

export interface EngineNode {
  id: string;
  kind: NodeKind;
  deps: string[];
  /** Short human-readable label shown in the UI source chain. */
  label: string;
  payload: Record<string, unknown>;
}

export interface EngineEvaluation {
  report: EngineReport;
  nodes: Record<string, EngineNode>;
  /**
   * For each node id present in the previous derivation, whether it was
   * reused (identical inputs+rule) or recomputed.
   */
  reuse: Record<string, "reused" | "recomputed" | "new">;
  ruleVersion: string;
}

export interface ClauseInstance {
  instanceId: string;
  /** Content identity (sorted distinct signed literals). */
  key: string;
  literals: number[];
  origin: "cnf" | "proof-add";
  addedAtProofLineId: string | null;
  seq: number;
}

export function canonicalClauseKey(literals: number[]): string {
  return [...new Set(literals)].sort((a, b) => a - b).join(",");
}

interface ActiveEntry {
  instance: ClauseInstance;
  deletedAtProofLineId: string | null;
}

export interface ManualDecisionInput {
  proofLineId: string;
  action: "accept" | "reject";
  decisionId: string;
  note?: string;
}

export interface EvaluationInput {
  cnfText: string;
  dratText: string;
  budgetLimit: number;
  decisions?: ManualDecisionInput[];
}

// ---------------------------------------------------------------------------
// Unit propagation (the RUP sub-routine)
// ---------------------------------------------------------------------------

export interface RupOutcome {
  status: "conflict" | "exhausted" | "no-conflict";
  propSteps: PropStep[];
  conflict: ConflictInfo | null;
  budgetUsed: number;
}

type Polarity = 0 | 1 | -1;

interface PropContext {
  assignment: Map<number, Polarity>; // var -> 1 true / -1 false / 0 mixed
  reasons: Map<number, PropStep>;
  checkId: string;
  budgetLeft: number;
  propSteps: PropStep[];
  order: number;
}

function evalLit(
  ctx: PropContext,
  lit: number
): "true" | "false" | "unassigned" {
  const v = Math.abs(lit);
  const p = ctx.assignment.get(v);
  if (p === undefined) return "unassigned";
  if (p === 0) return "false"; // mixed: treat as conflicting, handled elsewhere
  const truth = lit > 0 ? p === 1 : p === -1;
  return truth ? "true" : "false";
}

function assignLiteral(ctx: PropContext, lit: number): boolean {
  const v = Math.abs(lit);
  const want: Polarity = lit > 0 ? 1 : -1;
  const existing = ctx.assignment.get(v);
  if (existing !== undefined) return existing === want;
  ctx.assignment.set(v, want);
  return true;
}

/**
 * Run unit propagation over an active clause multiset.
 * `assumptions` are the negated candidate literals (they are not charged to the
 * budget). Each propagation assignment costs one budget unit; finding a fully
 * falsified clause is the conflict.
 */
export function runUnitPropagation(
  activeClauses: ClauseInstance[],
  assumptions: number[],
  budgetLimit: number,
  checkId: string
): RupOutcome {
  const ctx: PropContext = {
    assignment: new Map(),
    reasons: new Map(),
    checkId,
    budgetLeft: budgetLimit,
    propSteps: [],
    order: 0,
  };

  // Seed assumptions, recording conflict if they directly clash.
  for (const lit of assumptions) {
    const v = Math.abs(lit);
    const want: Polarity = lit > 0 ? 1 : -1;
    const existing = ctx.assignment.get(v);
    if (existing === -want) {
      // Complementary assumptions (only possible for repeated/tauto inputs).
      return {
        status: "conflict",
        propSteps: ctx.propSteps,
        conflict: {
          reasonClauseId: "assumption",
          reasonLiterals: assumptions,
        },
        budgetUsed: 0,
      };
    }
    if (existing === undefined) {
      ctx.assignment.set(v, want);
      ctx.propSteps.push({
        literal: lit,
        reasonClauseId: "assumption",
        reasonLiterals: assumptions,
        checkId,
        order: ctx.order--,
        isAssumption: true,
      });
    }
  }
  ctx.order = 1;

  const clauses = activeClauses.map((c) => ({
    instance: c,
    lits: c.literals,
  }));

  // Trail queue of propagated literals.
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of clauses) {
      let falseCount = 0;
      let unassigned: number[] = [];
      let hasTrue = false;
      for (const lit of entry.lits) {
        const st = evalLit(ctx, lit);
        if (st === "true") {
          hasTrue = true;
          break;
        }
        if (st === "false") falseCount++;
        else unassigned.push(lit);
      }
      if (hasTrue) continue;

      if (unassigned.length === 0) {
        // Conflict: all literals false under the current trail.
        return {
          status: "conflict",
          propSteps: ctx.propSteps,
          conflict: {
            reasonClauseId: entry.instance.instanceId,
            reasonLiterals: [...entry.lits],
          },
          budgetUsed: budgetLimit - ctx.budgetLeft,
        };
      }

      if (unassigned.length === 1) {
        const unit = unassigned[0];
        const v = Math.abs(unit);
        if (ctx.assignment.get(v) === undefined) {
          if (ctx.budgetLeft <= 0) {
            return {
              status: "exhausted",
              propSteps: ctx.propSteps,
              conflict: null,
              budgetUsed: budgetLimit,
            };
          }
          ctx.budgetLeft--;
          assignLiteral(ctx, unit);
          const step: PropStep = {
            literal: unit,
            reasonClauseId: entry.instance.instanceId,
            reasonLiterals: [...entry.lits],
            checkId,
            order: ctx.order++,
            isAssumption: false,
          };
          ctx.propSteps.push(step);
          ctx.reasons.set(v, step);
          changed = true;
        }
      }
    }
  }

  return {
    status: "no-conflict",
    propSteps: ctx.propSteps,
    conflict: null,
    budgetUsed: budgetLimit - ctx.budgetLeft,
  };
}

// ---------------------------------------------------------------------------
// RAT checking
// ---------------------------------------------------------------------------

function buildRupTrace(
  active: ClauseInstance[],
  assumptions: number[],
  budgetLimit: number,
  checkId: string,
  kind: "RUP" | "RAT"
): ResolventTrace {
  const outcome = runUnitPropagation(active, assumptions, budgetLimit, checkId);
  const status: CheckStatus =
    outcome.status === "conflict"
      ? "valid"
      : outcome.status === "exhausted"
      ? "inconclusive"
      : "invalid";
  return {
    activeClauseId: "",
    activeLiterals: [],
    pivot: 0,
    resolutionOffset: -1,
    resolvent: [],
    checkKind: kind,
    status,
    propSteps: outcome.propSteps,
    conflict: outcome.conflict,
    budgetUsed: outcome.budgetUsed,
    budgetLimit,
    exhausted: outcome.status === "exhausted",
  };
}

function isTautology(literals: number[]): boolean {
  const s = new Set<number>();
  for (const l of literals) {
    if (s.has(-l)) return true;
    s.add(l);
  }
  return false;
}

function distinctSorted(lits: number[]): number[] {
  return [...new Set(lits)].sort((a, b) => a - b);
}

interface ActiveMultiset {
  entries: ActiveEntry[];
}

function snapshotId(entries: ActiveEntry[]): string {
  return "snap:" + stableHash(
    entries
      .filter((e) => e.deletedAtProofLineId === null)
      .map((e) => e.instance.instanceId)
  );
}

function findByKey(
  ms: ActiveMultiset,
  key: string
): ActiveEntry[] {
  return ms.entries.filter(
    (e) => e.deletedAtProofLineId === null && e.instance.key === key
  );
}

interface StepContext {
  ms: ActiveMultiset;
  steps: StepResult[];
  nodes: Record<string, EngineNode>;
  previous: Record<string, EngineNode>;
  reuse: Record<string, "reused" | "recomputed" | "new">;
  diagnostics: Diagnostic[];
  nvars: number;
  budget: BudgetState;
  blocked: boolean;
  shortestFailure: ShortestFailure | null;
  decisionsByLine: Map<string, ManualDecisionInput>;
  decisionIdByLine: Map<string, string>;
  addSeq: number;
}

function registerNode(
  ctx: StepContext,
  node: Omit<EngineNode, "id">,
  idHint: string
): EngineNode {
  // Explicit identity is used for source-bearing / coordinate nodes; derived
  // nodes pass a content-addressed id hint as well. Same id + identical payload
  // across runs means the dependency result stayed valid ("reused").
  const id = idHint;
  const existing = ctx.nodes[id];
  if (existing) return existing;
  const was = ctx.previous[id];
  if (was && stableHash(was.payload) === stableHash(node.payload)) {
    ctx.reuse[id] = "reused";
  } else if (was) {
    ctx.reuse[id] = "recomputed";
  } else {
    ctx.reuse[id] = "new";
  }
  ctx.nodes[id] = { ...node, id };
  return ctx.nodes[id];
}

function makeTraceNode(
  ctx: StepContext,
  trace: ResolventTrace,
  deps: string[],
  idHint: string
) {
  registerNode(
    ctx,
    {
      kind: trace.conflict ? "conflict" : "propagation",
      deps,
      label: `${trace.checkKind} ${trace.conflict ? "conflict" : "propagation"} (${trace.budgetUsed}/${trace.budgetLimit} ${trace.budgetLimit === 1 ? "step" : "steps"})`,
      payload: {
        checkKind: trace.checkKind,
        status: trace.status,
        pivot: trace.pivot,
        propSteps: trace.propSteps.map((p) => ({
          literal: p.literal,
          reason: p.reasonClauseId,
          order: p.order,
        })),
        conflictReason: trace.conflict?.reasonClauseId ?? null,
        budgetUsed: trace.budgetUsed,
        budgetLimit: trace.budgetLimit,
      },
    },
    idHint
  );
}

function rupCheck(
  ctx: StepContext,
  active: ClauseInstance[],
  candidate: number[],
  checkId: string
): ResolventTrace {
  const assumptions = candidate.map((l) => -l);
  const trace = buildRupTrace(active, assumptions, ctx.budget.limit, checkId, "RUP");
  const snapId = snapshotId(ctx.ms.entries);
  makeTraceNode(ctx, trace, [snapId], `node:${checkId}:rup`);
  return trace;
}

function ratCheck(
  ctx: StepContext,
  active: ClauseInstance[],
  candidate: number[],
  checkId: string
): { trace: ResolventTrace | null; resolvents: ResolventTrace[] } {
  if (candidate.length === 0) {
    return { trace: null, resolvents: [] };
  }
  const pivot = candidate[0];
  const resolvents: ResolventTrace[] = [];
  const negPivot = -pivot;
  for (const clause of active) {
    if (!clause.literals.includes(negPivot)) continue;
    const offset = clause.literals.indexOf(negPivot);
    const resolvent = distinctSorted(
      [...candidate, ...clause.literals].filter(
        (l) => l !== pivot && l !== negPivot
      )
    );
    const assumptions = resolvent.map((l) => -l);
    const trace = buildRupTrace(
      active,
      assumptions,
      ctx.budget.limit,
      checkId,
      "RAT"
    );
    trace.activeClauseId = clause.instanceId;
    trace.activeLiterals = [...clause.literals];
    trace.pivot = pivot;
    trace.resolutionOffset = offset;
    trace.resolvent = resolvent;
    resolvents.push(trace);
    const snapId = snapshotId(ctx.ms.entries);
    registerNode(
      ctx,
      {
        kind: "rat-resolvent",
        deps: [snapId, clause.instanceId],
        label: `RAT resolvent @ ${clause.instanceId} (pivot ${pivot}, offset ${offset})`,
        payload: {
          activeClauseId: clause.instanceId,
          pivot,
          resolutionOffset: offset,
          resolvent,
          status: trace.status,
          budgetUsed: trace.budgetUsed,
          conflictReason: trace.conflict?.reasonClauseId ?? null,
        },
      },
      `node:${checkId}:rat:${clause.instanceId}`
    );
    makeTraceNode(
      ctx,
      trace,
      [snapId, clause.instanceId],
      `node:${checkId}:rat:${clause.instanceId}:trace`
    );
  }
  return { trace: null, resolvents };
}

function outOfRange(lits: number[], nvars: number): number | null {
  for (const l of lits) if (Math.abs(l) > nvars) return l;
  return null;
}

function addStep(ctx: StepContext, line: ParsedDrat["lines"][number]): StepResult {
  const checkId = line.id;
  const activeSnapshot = snapshotId(ctx.ms.entries);
  registerNode(
    ctx,
    {
      kind: "active-snapshot",
      deps: ctx.ms.entries
        .filter((e) => e.deletedAtProofLineId === null)
        .map((e) => e.instance.instanceId),
      label: `active multiset @ ${line.id}`,
      payload: {
        lineId: line.id,
        active: ctx.ms.entries
          .filter((e) => e.deletedAtProofLineId === null)
          .map((e) => e.instance.instanceId),
      },
    },
    `node:${line.id}:snapshot`
  );

  const diagnostics: Diagnostic[] = [...line.diagnostics];
  const isEmpty = line.literals.length === 0;
  const active = ctx.ms.entries
    .filter((e) => e.deletedAtProofLineId === null)
    .map((e) => e.instance);
  const tauto = isTautology(line.literals);
  const dup = new Set(line.literals).size !== line.literals.length;
  const distinct = distinctSorted(line.literals);
  const key = canonicalClauseKey(line.literals);

  const base: StepResult = {
    lineId: line.id,
    index: line.index,
    op: "add",
    displayLiterals: [...line.literals],
    isEmptyClause: isEmpty,
    status: "invalid",
    checkKind: null,
    pivot: null,
    resolvents: [],
    rupTrace: null,
    deletionCandidates: [],
    selectedClauseId: null,
    diagnostics,
    activeSnapshotId: activeSnapshot,
  };

  // Variable range check (oversized variable number).
  const bad = outOfRange(line.literals, ctx.nvars);
  if (bad !== null) {
    diagnostics.push({
      code: "VARIABLE_OUT_OF_RANGE",
      severity: "error",
      message: `変数番号 ${Math.abs(bad)} は宣言された最大変数 ${ctx.nvars} を超えています`,
      where: { file: "drat", line: line.startLine },
      proofLineId: line.id,
    });
    base.status = "syntax-rejected";
    return finishGate(ctx, base, line, false, null);
  }

  // Missing zero terminator: syntax rejects the whole line.
  if (line.terminatorTokenId === null) {
    base.status = "syntax-rejected";
    return finishGate(ctx, base, line, false, null);
  }

  if (ctx.blocked) {
    diagnostics.push({
      code: "BUDGET_EXHAUSTED",
      severity: "info",
      message:
        "先行するステップで検証が停止しているため、このステップは評価されません",
      where: { file: "drat", line: line.startLine },
      proofLineId: line.id,
    });
    base.status = "invalid";
    return finishGate(ctx, base, line, false, "blocked");
  }

  // Empty clause: only derivable by RUP (final conflict).
  if (isEmpty) {
    base.checkKind = "RUP";
    const trace = rupCheck(ctx, active, [], checkId);
    base.rupTrace = trace;
    base.status =
      trace.status === "valid"
        ? "accepted-rup"
        : trace.status === "inconclusive"
        ? "inconclusive"
        : "invalid";
    if (trace.exhausted) {
      diagnostics.push({
        code: "BUDGET_EXHAUSTED",
        severity: "warning",
        message: `予算 ${ctx.budget.limit} propagation-steps を消費しました。証明無効ではなく不確定(inconclusive)です`,
        where: { file: "drat", line: line.startLine },
        proofLineId: line.id,
      });
    }
    const adopted = base.status === "accepted-rup";
    return finishGate(ctx, base, line, adopted, trace.status);
  }

  // Tautology clauses are admitted syntactically, no propagation needed.
  if (tauto) {
    base.checkKind = null;
    base.status = "accepted-tautology";
    void dup;
    return adoptAdded(ctx, base, line, key, distinct);
  }

  // 1) Try RUP first (RUP and RAT must be distinguished).
  const rupTrace = rupCheck(ctx, active, distinct, checkId);
  base.rupTrace = rupTrace;
  if (rupTrace.status === "valid") {
    base.checkKind = "RUP";
    base.status = "accepted-rup";
    return adoptAdded(ctx, base, line, key, distinct);
  }

  // 2) RAT with pivot = first literal.
  const pivot = line.literals[0];
  diagnostics.push({
    code: "RAT_PIVOT",
    severity: "info",
    message: `RUP 不成立のため RAT 検査へ: pivot = ${pivot} (先頭リテラル)。-pivot を含む全活性節との各 resolvent を RUP で検査します`,
    where: { file: "drat", line: line.startLine },
    proofLineId: line.id,
  });
  const { resolvents } = ratCheck(ctx, active, distinct, checkId);
  base.resolvents = resolvents;
  base.pivot = pivot;
  base.checkKind = "RAT";

  if (rupTrace.status === "inconclusive") {
    base.status = "inconclusive";
    diagnostics.push({
      code: "BUDGET_EXHAUSTED",
      severity: "warning",
      message: "RUP が予算切れです。RAT 候補も含めて結論は保留されます",
      where: { file: "drat", line: line.startLine },
      proofLineId: line.id,
    });
    return finishGate(ctx, base, line, false, "inconclusive");
  }

  if (resolvents.length === 0) {
    // No clause contains -pivot: RAT holds vacuously.
    base.status = "accepted-rat";
    return adoptAdded(ctx, base, line, key, distinct);
  }
  const anyInc = resolvents.some((r) => r.status === "inconclusive");
  const allValid = resolvents.every((r) => r.status === "valid");
  if (anyInc) {
    base.status = "inconclusive";
    diagnostics.push({
      code: "BUDGET_EXHAUSTED",
      severity: "warning",
      message: "RAT resolvent のいずれかが予算切れです (証明無効ではない)",
      where: { file: "drat", line: line.startLine },
      proofLineId: line.id,
    });
    return finishGate(ctx, base, line, false, "inconclusive");
  }
  if (allValid) {
    base.status = "accepted-rat";
    return adoptAdded(ctx, base, line, key, distinct);
  }
  base.status = "invalid";
  return finishGate(ctx, base, line, false, "invalid");
}

function adoptAdded(
  ctx: StepContext,
  base: StepResult,
  line: ParsedDrat["lines"][number],
  key: string,
  distinct: number[]
): StepResult {
  const instance: ClauseInstance = {
    instanceId: `inst:${line.id}`,
    key,
    literals: distinct,
    origin: "proof-add",
    addedAtProofLineId: line.id,
    seq: ++ctx.addSeq,
  };
  // Content-addressed clause node (multiset keeps separate instances).
  registerNode(
    ctx,
    {
      kind: "cnf-clause",
      deps: [line.id],
      label: `adopted clause ${formatLits(distinct)} @ ${line.id}`,
      payload: { instanceId: instance.instanceId, literals: distinct, key },
    },
    instance.instanceId
  );
  ctx.ms.entries.push({ instance, deletedAtProofLineId: null });
  base.selectedClauseId = instance.instanceId;
  return finishGate(ctx, base, line, true, base.status);
}

function deleteStep(
  ctx: StepContext,
  line: ParsedDrat["lines"][number]
): StepResult {
  const activeSnapshot = snapshotId(ctx.ms.entries);
  registerNode(
    ctx,
    {
      kind: "active-snapshot",
      deps: ctx.ms.entries
        .filter((e) => e.deletedAtProofLineId === null)
        .map((e) => e.instance.instanceId),
      label: `active multiset @ ${line.id}`,
      payload: {
        lineId: line.id,
        active: ctx.ms.entries
          .filter((e) => e.deletedAtProofLineId === null)
          .map((e) => e.instance.instanceId),
    },
    },
    `node:${line.id}:snapshot`
  );
  const diagnostics: Diagnostic[] = [...line.diagnostics];
  const key = canonicalClauseKey(line.literals);
  const candidates = findByKey(ctx.ms, key);
  const result: StepResult = {
    lineId: line.id,
    index: line.index,
    op: "delete",
    displayLiterals: [...line.literals],
    isEmptyClause: line.literals.length === 0,
    status: "invalid",
    checkKind: null,
    pivot: null,
    resolvents: [],
    rupTrace: null,
    deletionCandidates: candidates.map((c) => ({
      clauseId: c.instance.instanceId,
      addedAtProofLineId: c.instance.addedAtProofLineId,
    })),
    selectedClauseId: null,
    diagnostics,
    activeSnapshotId: activeSnapshot,
  };

  const bad = outOfRange(line.literals, ctx.nvars);
  if (bad !== null) {
    diagnostics.push({
      code: "VARIABLE_OUT_OF_RANGE",
      severity: "error",
      message: `変数番号 ${Math.abs(bad)} は宣言された最大変数 ${ctx.nvars} を超えています`,
      where: { file: "drat", line: line.startLine },
      proofLineId: line.id,
    });
    result.status = "syntax-rejected";
    return finishGate(ctx, result, line, false, null);
  }
  if (line.terminatorTokenId === null) {
    result.status = "syntax-rejected";
    return finishGate(ctx, result, line, false, null);
  }
  if (ctx.blocked) {
    result.status = "invalid";
    return finishGate(ctx, result, line, false, "blocked");
  }

  if (candidates.length === 0) {
    // Deleting a non-existent clause: set unchanged, diagnostic retained.
    diagnostics.push({
      code: "DELETE_MISSING",
      severity: "warning",
      message: `削除対象節 ${formatLits(line.literals)} は活性多重集合に存在しません。集合は変更されません`,
      where: { file: "drat", line: line.startLine },
      proofLineId: line.id,
    });
    result.status = "invalid";
    return finishGate(ctx, result, line, false, "delete-missing");
  }
  // Deterministic: newest instance. Multiple legal targets kept as candidates.
  if (candidates.length > 1) {
    diagnostics.push({
      code: "DELETE_AMBIGUOUS",
      severity: "info",
      message: `同一内容の活性節が ${candidates.length} 個あります。規則では最新追加インスタンスを削除しますが、全候補を保存します`,
      where: { file: "drat", line: line.startLine },
      proofLineId: line.id,
    });
  }
  const chosen = candidates.reduce((a, b) =>
    a.instance.seq >= b.instance.seq ? a : b
  );
  chosen.deletedAtProofLineId = line.id;
  result.selectedClauseId = chosen.instance.instanceId;
  result.status = "valid";
  return finishGate(ctx, result, line, true, "deleted");
}

function finishGate(
  ctx: StepContext,
  result: StepResult,
  line: ParsedDrat["lines"][number],
  adopted: boolean,
  semantic: string | null
): StepResult {
  // Manual decision override support.
  const decision = ctx.decisionsByLine.get(line.id);
  let gateStatus: CheckStatus = result.status;
  let override: ManualDecisionInput | null = decision ?? null;
  let finalAdopted = adopted;
  if (decision && decision.action === "accept" && !adopted) {
    gateStatus = "valid";
    override = decision;
    if (line.op === "add" && line.literals.length > 0 && !isTautology(line.literals)) {
      const key = canonicalClauseKey(line.literals);
      const distinct = distinctSorted(line.literals);
      const bad = outOfRange(distinct, ctx.nvars);
      if (bad === null && line.terminatorTokenId !== null) {
        ctx.ms.entries.push({
          instance: {
            instanceId: `inst:${line.id}:dec:${decision.decisionId}`,
            key,
            literals: distinct,
            origin: "proof-add",
            addedAtProofLineId: line.id,
            seq: ++ctx.addSeq,
          },
          deletedAtProofLineId: null,
        });
        finalAdopted = true;
      }
    }
  } else if (decision && decision.action === "reject" && adopted) {
    gateStatus = "invalid";
    override = decision;
    finalAdopted = false;
  }

  const gateId = `node:${line.id}:gate:${stableHash({
    snap: result.activeSnapshotId,
    sem: result.status,
    adopted,
    decision: override ? `${override.decisionId}:${override.action}` : null,
    rule: RULE_VERSION,
    budget: ctx.budget.limit,
  })}`;
  registerNode(
    ctx,
    {
      kind: "step-gate",
      deps: [
        result.activeSnapshotId,
        `node:${line.id}`,
        ...(override ? [`decision:${override.decisionId}`] : []),
      ],
      label: `${line.id} ${line.op} → ${gateStatus}`,
      payload: {
        lineId: line.id,
        index: line.index,
        op: line.op,
        status: gateStatus,
        engineStatus: result.status,
        checkKind: result.checkKind,
        adopted,
        semantic,
        override: override
          ? { decisionId: override.decisionId, action: override.action }
          : null,
      },
    },
    gateId
  );

  result.gateNodeId = gateId;
  result.adopted = finalAdopted;

  // A rejected addition (incl. malformed/empty) or an inconclusive step blocks
  // later derivation. A missing delete is only a diagnostic: never blocks.
  const blocks =
    line.op === "add" &&
    (result.status === "syntax-rejected" ||
      result.status === "invalid" ||
      result.status === "inconclusive");
  if (blocks) {
    ctx.blocked = true;
    if (!ctx.shortestFailure) {
      ctx.shortestFailure = {
        prefixLength: line.index,
        failingLineId: line.id,
        failingIndex: line.index,
        status: result.status,
        reason:
          result.status === "inconclusive"
            ? "resource-budget-exhausted"
            : result.status === "syntax-rejected"
            ? "syntax-error"
            : "additive-clause-not-RUP/RAT",
      };
    }
  }
  void semantic;
  return { ...result, status: gateStatus, gateNodeId: gateId, adopted: finalAdopted };
}

function formatLits(lits: number[]): string {
  return lits.length ? lits.join(" ") : "□";
}

export interface CnfSummary {
  parsed: ParsedCnf;
  nvars: number;
}

export function summarizeCnf(cnfText: string): CnfSummary {
  const parsed = parseCnf(cnfText);
  let maxVar = 0;
  for (const c of parsed.clauses)
    for (const l of c.literals) maxVar = Math.max(maxVar, Math.abs(l));
  const nvars =
    parsed.header.declaredVars !== null
      ? Math.max(parsed.header.declaredVars, maxVar)
      : maxVar;
  return { parsed, nvars };
}

export function evaluate(
  input: EvaluationInput,
  previousNodes: Record<string, EngineNode> = {}
): EngineEvaluation {
  const { parsed: cnf, nvars } = summarizeCnf(input.cnfText);
  const drat = parseDrat(input.dratText);
  const budget: BudgetState = {
    limit: input.budgetLimit,
    unit: "propagation-steps",
  };

  const nodes: Record<string, EngineNode> = {};
  const ctx: StepContext = {
    ms: { entries: [] },
    steps: [],
    nodes,
    previous: previousNodes,
    reuse: {},
    diagnostics: [...cnf.diagnostics, ...drat.diagnostics],
    nvars,
    budget,
    blocked: false,
    shortestFailure: null,
    decisionsByLine: new Map(),
    decisionIdByLine: new Map(),
    addSeq: 0,
  };
  for (const d of input.decisions ?? []) {
    ctx.decisionsByLine.set(d.proofLineId, d);
    ctx.decisionIdByLine.set(d.proofLineId, d.decisionId);
    registerNode(
      ctx,
      {
        kind: "verdict",
        deps: [],
        label: `manual decision ${d.action} @ ${d.proofLineId}`,
        payload: {
          decisionId: d.decisionId,
          proofLineId: d.proofLineId,
          action: d.action,
          note: d.note ?? null,
        },
      },
      `decision:${d.decisionId}`
    );
  }

  // CNF file node.
  const cnfFileId = registerNode(
    ctx,
    {
      kind: "cnf-file",
      deps: [],
      label: "original CNF DIMACS source",
      payload: {
        tokens: cnf.tokens.map((t) => t.id),
        nvars,
        declaredVars: cnf.header.declaredVars,
        declaredClauses: cnf.header.declaredClauses,
        ruleVersion: RULE_VERSION,
      },
    },
    "file:cnf"
  ).id;

  // Seed the multiset with original CNF clauses (multiset preserved).
  cnf.clauses.forEach((c) => {
    const instance: ClauseInstance = {
      instanceId: `inst:cnf:${c.id}`,
      key: canonicalClauseKey(c.literals),
      literals: distinctSorted(c.literals),
      origin: "cnf",
      addedAtProofLineId: null,
      seq: ctx.addSeq++,
    };
    ctx.ms.entries.push({ instance, deletedAtProofLineId: null });
    registerNode(
      ctx,
      {
        kind: "cnf-clause",
        deps: [cnfFileId],
        label: `CNF clause ${formatLits(c.literals)} (${c.id})`,
        payload: {
          instanceId: instance.instanceId,
          clauseId: c.id,
          literals: c.literals,
          key: instance.key,
        },
      },
      instance.instanceId
    );
  });

  const dratFileId = registerNode(
    ctx,
    {
      kind: "drat-file",
      deps: [],
      label: "original DRAT proof source",
      payload: {
        tokens: drat.tokens.map((t) => t.id),
        lines: drat.lines.map((l) => l.id),
      },
    },
    "file:drat"
  ).id;

  drat.lines.forEach((line) => {
    registerNode(
      ctx,
      {
        kind: "proof-line",
        deps: [dratFileId],
        label: `${line.id} ${line.op} ${line.rawText}`,
        payload: {
          lineId: line.id,
          index: line.index,
          op: line.op,
          startLine: line.startLine,
          literals: line.literals,
          hasTerminator: line.terminatorTokenId !== null,
          rawText: line.rawText,
        },
      },
      line.id
    );
    const step =
      line.op === "delete" ? deleteStep(ctx, line) : addStep(ctx, line);
    ctx.steps.push(step);
  });

  // Active clause views with multiplicities.
  const byKey = new Map<string, ActiveClauseView>();
  for (const e of ctx.ms.entries) {
    if (e.deletedAtProofLineId !== null) continue;
    const cur = byKey.get(e.instance.key);
    if (cur) cur.multiplicity++;
    else
      byKey.set(e.instance.key, {
        clauseId: e.instance.instanceId,
        literals: [...e.instance.literals],
        multiplicity: 1,
        addedAtProofLineId: e.instance.addedAtProofLineId,
        deletedAtProofLineId: null,
      });
  }
  const activeAfter = [...byKey.values()];

  const finalEmpty = ctx.steps.find(
    (s) => s.isEmptyClause && s.op === "add"
  );
  const finalEmptyAccepted =
    finalEmpty?.status === "accepted-rup" ||
    (finalEmpty?.status === "valid" && finalEmpty.checkKind === "RUP");
  const anyRejected = ctx.steps.some(
    (step) =>
      step.status === "syntax-rejected" ||
      (step.op === "add" && step.status === "invalid")
  );
  const anyInconclusive = ctx.steps.some((s) => s.status === "inconclusive");
  const provedUnsat = !!finalEmptyAccepted;
  const proofVerdict: EngineReport["proofVerdict"] = provedUnsat
    ? "proved"
    : anyRejected
    ? "rejected"
    : anyInconclusive
    ? "incomplete"
    : "incomplete";

  registerNode(
    ctx,
    {
      kind: "verdict",
      deps: ctx.steps.map((step) => step.gateNodeId!).filter(Boolean),
      label: `verdict: ${proofVerdict}`,
      payload: {
        verdict: proofVerdict,
        provedUnsat,
        shortestFailure: ctx.shortestFailure,
        finalEmptyClause: finalEmpty
          ? { lineId: finalEmpty.lineId, index: finalEmpty.index }
          : null,
        ruleVersion: RULE_VERSION,
      },
    },
    "verdict:final"
  );

  const report: EngineReport = {
    nvars,
    budget,
    steps: ctx.steps,
    activeAfter,
    shortestFailure: ctx.shortestFailure,
    finalEmptyClause: finalEmpty
      ? { lineId: finalEmpty.lineId, index: finalEmpty.index }
      : null,
    provedUnsat,
    proofVerdict,
    diagnostics: ctx.diagnostics,
  };

  return { report, nodes: ctx.nodes, reuse: ctx.reuse, ruleVersion: RULE_VERSION };
}
