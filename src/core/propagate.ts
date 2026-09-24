/**
 * 单元传播引擎。
 *
 * - 记录完整传播链（trail）：每个赋值的来源子句实例与解析偏移（传播理由）。
 * - 资源预算：maxSteps 为单条检查允许的单传播赋值次数；耗尽 => 'budget-exhausted'，
 *   这是资源事件，不是证明无效。
 * - 解析偏移（resolution offset）基准：检查开始时的活跃子句多重集，按准入事件顺序编号（0 起）。
 */

import type { Id } from './id.js';
import { setSignature } from './clause.js';

export interface ClauseInstance {
  id: Id;
  /** 准入顺序号（多重集内的稳定序号）。 */
  ordinal: number;
  origin:
    | { kind: 'cnf'; clauseId: Id; lineNo: number }
    | { kind: 'addition'; lineId: Id; lineNo: number };
  /** 派生层规范化：去重 + 排序后的文字集合。 */
  lits: number[];
  /** 原始文字视图（保留重复与顺序）。 */
  rawLiterals: Array<number | null>;
  tautology: boolean;
  /** 若与更早的活跃实例集合签名相同，记录其 id（重复子句事件）。 */
  duplicateOf: Id | null;
  active: boolean;
  deletedBy: Id | null;
}

export class ClauseMultiset {
  private instances: ClauseInstance[] = [];
  private admissionCounter = 0;

  admit(inst: Omit<ClauseInstance, 'ordinal' | 'active' | 'deletedBy' | 'duplicateOf'>): ClauseInstance {
    const sig = setSignature(inst.lits);
    const earlier = this.instances.find(
      (i) => i.active && setSignature(i.lits) === sig,
    );
    const full: ClauseInstance = {
      ...inst,
      ordinal: this.admissionCounter++,
      active: true,
      deletedBy: null,
      duplicateOf: earlier ? earlier.id : null,
    };
    this.instances.push(full);
    return full;
  }

  /** 删除一个匹配集合签名的活跃实例（最早准入者）。返回 null 表示不存在（集合不变）。 */
  removeOneByLits(lits: number[]): ClauseInstance | null {
    const sig = setSignature(lits);
    const victim = this.instances.find((i) => i.active && setSignature(i.lits) === sig);
    if (!victim) return null;
    victim.active = false;
    return victim;
  }

  activeInstances(): ClauseInstance[] {
    return this.instances.filter((i) => i.active);
  }

  allInstances(): ClauseInstance[] {
    return [...this.instances];
  }

  /** 依赖指纹：只由活跃多重集决定；相同指纹 => 后续重放行为相同。 */
  fingerprint(): string {
    const parts = this.activeInstances().map(
      (i) => `${i.id}=${setSignature(i.lits)}`,
    );
    return fnv1a(parts.join('|'));
  }
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface TrailEntry {
  lit: number;
  /** 来源子句实例（传播理由）；假设文字为 null。 */
  reasonInstanceId: Id | null;
  /** 来源子句在检查开始时的解析偏移；假设文字为 null。 */
  reasonOffset: number | null;
  kind: 'assumption' | 'unit';
}

export interface UpResult {
  status: 'conflict' | 'saturated' | 'budget-exhausted' | 'offset-error';
  trail: TrailEntry[];
  conflictInstanceId: Id | null;
  conflictOffset: number | null;
  stepsUsed: number;
  /** hint 模式下的诊断信息（越界 / 未解析 hint）。 */
  notes: string[];
}

function evaluate(
  inst: ClauseInstance,
  assignment: Map<number, number>,
): { unassigned: number[]; falsified: number } {
  let falsified = 0;
  const unassigned: number[] = [];
  for (const lit of inst.lits) {
    const a = assignment.get(Math.abs(lit));
    if (a === undefined) unassigned.push(lit);
    else if (a !== lit) falsified++;
  }
  return { unassigned, falsified };
}

/** 无 hint 单元传播：扫描活跃多重集直到不动点或冲突或预算耗尽。 */
export function unitPropagate(
  active: ClauseInstance[],
  assumptions: number[],
  maxSteps: number,
): UpResult {
  const assignment = new Map<number, number>();
  const trail: TrailEntry[] = [];
  for (const lit of assumptions) {
    assignment.set(Math.abs(lit), lit);
    trail.push({ lit, reasonInstanceId: null, reasonOffset: null, kind: 'assumption' });
  }
  const offsets = new Map<Id, number>();
  active.forEach((inst, idx) => offsets.set(inst.id, idx));
  let steps = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const inst of active) {
      const { unassigned, falsified } = evaluate(inst, assignment);
      if (unassigned.length === 0 && falsified === inst.lits.length) {
        return {
          status: 'conflict',
          trail,
          conflictInstanceId: inst.id,
          conflictOffset: offsets.get(inst.id) ?? null,
          stepsUsed: steps,
          notes: [],
        };
      }
      if (unassigned.length === 1 && falsified === inst.lits.length - 1) {
        const lit = unassigned[0]!;
        if (steps >= maxSteps) {
          return {
            status: 'budget-exhausted',
            trail,
            conflictInstanceId: null,
            conflictOffset: null,
            stepsUsed: steps,
            notes: [`单传播预算 ${maxSteps} 耗尽（资源事件，非证明无效）`],
          };
        }
        assignment.set(Math.abs(lit), lit);
        trail.push({
          lit,
          reasonInstanceId: inst.id,
          reasonOffset: offsets.get(inst.id) ?? null,
          kind: 'unit',
        });
        steps++;
        changed = true;
      }
    }
  }
  return {
    status: 'saturated',
    trail,
    conflictInstanceId: null,
    conflictOffset: null,
    stepsUsed: steps,
    notes: [],
  };
}

/**
 * 带解析偏移 hint 的传播（LRAT 风格）：
 * 按 hint 顺序取子句；冲突即停；单元则传播；既不单元也不冲突则记录未解析 hint。
 * 偏移越界 => 'offset-error'（证明行引用不存在的子句）。
 */
export function hintedPropagate(
  active: ClauseInstance[],
  assumptions: number[],
  hints: number[],
  maxSteps: number,
): UpResult {
  const assignment = new Map<number, number>();
  const trail: TrailEntry[] = [];
  for (const lit of assumptions) {
    assignment.set(Math.abs(lit), lit);
    trail.push({ lit, reasonInstanceId: null, reasonOffset: null, kind: 'assumption' });
  }
  const notes: string[] = [];
  let steps = 0;
  for (const hint of hints) {
    const inst = active[hint];
    if (!inst) {
      notes.push(`解析偏移 ${hint} 越界：活跃子句数 ${active.length}`);
      return {
        status: 'offset-error',
        trail,
        conflictInstanceId: null,
        conflictOffset: null,
        stepsUsed: steps,
        notes,
      };
    }
    const { unassigned, falsified } = evaluate(inst, assignment);
    if (unassigned.length === 0 && falsified === inst.lits.length) {
      return {
        status: 'conflict',
        trail,
        conflictInstanceId: inst.id,
        conflictOffset: hint,
        stepsUsed: steps,
        notes,
      };
    }
    if (unassigned.length === 1 && falsified === inst.lits.length - 1) {
      const lit = unassigned[0]!;
      if (assignment.get(Math.abs(lit)) === undefined) {
        if (steps >= maxSteps) {
          notes.push(`单传播预算 ${maxSteps} 耗尽（资源事件，非证明无效）`);
          return {
            status: 'budget-exhausted',
            trail,
            conflictInstanceId: null,
            conflictOffset: null,
            stepsUsed: steps,
            notes,
          };
        }
        assignment.set(Math.abs(lit), lit);
        trail.push({ lit, reasonInstanceId: inst.id, reasonOffset: hint, kind: 'unit' });
        steps++;
      }
    } else {
      notes.push(`解析偏移 ${hint} 指向的子句既不单元也不冲突（hint 未解析）`);
    }
  }
  return {
    status: 'saturated',
    trail,
    conflictInstanceId: null,
    conflictOffset: null,
    stepsUsed: steps,
    notes,
  };
}
