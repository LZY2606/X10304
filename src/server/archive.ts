// 反例档案构建：基线保留全部原始信息；每个变异只改动一个直接来源；
// 被采纳与未采纳的结果都保留，判定依据写成机器可读取的事件。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { parseCnf } from '../core/dimacs';
import { parseDrat } from '../core/drat';
import { checkProof, type CheckParams } from '../core/checker';
import { buildProofGraph, planRecompute } from '../core/graph';
import { stableId } from '../core/id';
import {
  appendEvent, beginVersion, completeVersion, currentVersion, putMaterial, saveDecision,
} from './db';

const CASEPACK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'casepack');

export interface EditSpec {
  type: 'proof.prepend' | 'proof.append' | 'proof.replaceLine' | 'proof.insertAfter' | 'proof.dropZeroTerminator' | 'params.budget';
  line?: string; lines?: string[]; index?: number; value?: number;
}

export function applyEdit(proofText: string, params: CheckParams, edit: EditSpec): { proofText: string; params: CheckParams } {
  const lines = proofText.split('\n');
  switch (edit.type) {
    case 'proof.prepend':
      return { proofText: edit.line + '\n' + proofText, params };
    case 'proof.append':
      return { proofText: proofText.replace(/\n?$/, '\n') + edit.line + '\n', params };
    case 'proof.replaceLine': {
      // index 以非空、非注释 proof 行计
      const idxs = lines.map((l, i) => ({ l, i })).filter(x => x.l.trim() !== '' && !x.l.trim().startsWith('c'));
      lines[idxs[edit.index!].i] = edit.line!;
      return { proofText: lines.join('\n'), params };
    }
    case 'proof.insertAfter': {
      const idxs = lines.map((l, i) => ({ l, i })).filter(x => x.l.trim() !== '' && !x.l.trim().startsWith('c'));
      lines.splice(idxs[edit.index!].i + 1, 0, ...edit.lines!);
      return { proofText: lines.join('\n'), params };
    }
    case 'proof.dropZeroTerminator': {
      const idxs = lines.map((l, i) => ({ l, i })).filter(x => x.l.trim() !== '' && !x.l.trim().startsWith('c'));
      const at = idxs[edit.index!].i;
      lines[at] = lines[at].replace(/\s+0\s*$/, '');
      return { proofText: lines.join('\n'), params };
    }
    case 'params.budget':
      return { proofText, params: { budget: edit.value! } };
  }
}

export function loadCasepack(dir = CASEPACK_DIR): any {
  return JSON.parse(readFileSync(join(dir, 'casepack.json'), 'utf8'));
}

export interface BuiltCase {
  caseId: string;
  versionId: string;
  kind: string;
  label: string;
  result: ReturnType<typeof checkProof>;
  recompute?: unknown;
}

// 把一个（来源, 参数）组合核验并存为独立版本；只有完整成功后才切换指针。
export function buildCase(
  db: DatabaseSync,
  opts: { parent: string | null; kind: string; label: string; cnfText: string; proofText: string; params: CheckParams; switchPointer?: boolean },
): BuiltCase {
  const cnfId = putMaterial(db, { kind: 'cnf', name: `${opts.label}.cnf`, raw: opts.cnfText });
  const proofId = putMaterial(db, { kind: 'proof', name: `${opts.label}.drat`, raw: opts.proofText });
  const cnf = parseCnf(`${opts.label}.cnf`, opts.cnfText);
  const proof = parseDrat(`${opts.label}.drat`, opts.proofText);
  const result = checkProof(cnf, proof, opts.params);

  const versionId = beginVersion(db, {
    parent: opts.parent, kind: opts.kind, label: opts.label,
    params: { ...opts.params, cnfMaterial: cnfId, proofMaterial: proofId },
  });
  // 机器可读取事件：判定依据（RUP/RAT 区分、删除诊断、语法处理、资源语义）
  appendEvent(db, versionId, {
    kind: 'case_source', status: 'ok',
    payload: {
      label: opts.label, cnfMaterial: cnfId, proofMaterial: proofId,
      preserved: ['dimacs_tokens', 'variable_numbers', 'proof_lines', 'clause_multiset', 'parse_offsets', 'resource_budget'],
      budget: result.params.budget,
    },
  });
  for (const e of result.events) {
    appendEvent(db, versionId, { id: stableId(opts.label, e.id), kind: e.kind, status: e.status, payload: e });
  }
  appendEvent(db, versionId, {
    kind: 'case_result', status: result.verdict === 'verified' ? 'ok' : result.verdict === 'failed' ? 'failed' : 'inconclusive',
    payload: {
      verdict: result.verdict, failingPrefix: result.failingPrefix,
      emptyClauseDerived: result.emptyClauseDerived, steps: result.steps.length,
    },
  });
  const conclusions = {
    verdict: result.verdict,
    failingPrefix: result.failingPrefix,
    emptyClauseDerived: result.emptyClauseDerived,
    result, // 当时可见结论快照：回到旧事件时恢复它，而不是最新计算
  };
  if (opts.switchPointer !== false) completeVersion(db, versionId, conclusions);
  return { caseId: opts.label, versionId, kind: opts.kind, label: opts.label, result };
}

// 构建完整档案：基线 + 单源变异 + 三个叙事场景。返回全部案例（含未采纳结果）。
export function buildArchive(db: DatabaseSync, dir = CASEPACK_DIR): BuiltCase[] {
  const pack = loadCasepack(dir);
  const cnfText = readFileSync(join(dir, pack.baseline.cnf), 'utf8');
  const proofText = readFileSync(join(dir, pack.baseline.proof), 'utf8');
  const baseParams: CheckParams = { budget: pack.baseline.params.budget };
  const built: BuiltCase[] = [];

  const baseline = buildCase(db, {
    parent: null, kind: 'baseline', label: 'baseline',
    cnfText, proofText, params: baseParams,
  });
  built.push(baseline);

  for (const m of pack.mutations as { id: string; title: string; edit: EditSpec; expect: string }[]) {
    const edited = applyEdit(proofText, baseParams, m.edit);
    const c = buildCase(db, {
      parent: baseline.versionId, kind: 'mutation', label: m.id,
      cnfText, proofText: edited.proofText, params: edited.params,
    });
    // 影响范围：依赖图说明哪些节点需要重算、哪些仍有效
    const graph = buildProofGraph(c.result.steps.length);
    const changed = m.edit.type === 'params.budget' ? ['src:params'] : ['src:proof'];
    c.recompute = planRecompute(graph, changed);
    appendEvent(db, c.versionId, {
      kind: 'mutation_scope', status: 'ok',
      payload: { mutation: m.id, expect: m.expect, changedSources: changed, recompute: c.recompute },
    });
    built.push(c);
  }

  for (const s of pack.scenarios as any[]) {
    if (s.kind === 'param_revision' || s.kind === 'source_change') {
      const edited = applyEdit(proofText, baseParams, s.edit as EditSpec);
      const c = buildCase(db, {
        parent: baseline.versionId, kind: s.kind, label: s.id,
        cnfText, proofText: edited.proofText, params: edited.params,
      });
      const graph = buildProofGraph(c.result.steps.length);
      const changed = s.kind === 'param_revision' ? ['src:params'] : ['src:proof'];
      c.recompute = planRecompute(graph, changed);
      appendEvent(db, c.versionId, {
        kind: 'scenario', status: 'ok',
        payload: { scenario: s.id, title: s.title, narrative: s.narrative, changedSources: changed, recompute: c.recompute },
      });
      built.push(c);
    } else if (s.kind === 'conflicting_decisions') {
      // 两位使用者从同一版本编辑：第二个保存会冲突，双方决定都保留、可解决。
      const target = built.find(b => b.caseId === 'rat_pivot')!;
      const base = currentVersion(db);
      const results: unknown[] = [];
      for (const d of s.decisions as { reviewer: string; choice: string; rationale: string; selected: boolean }[]) {
        const r = saveDecision(db, {
          baseVersion: base, branch: s.branch,
          payload: { reviewer: d.reviewer, choice: d.choice, rationale: d.rationale, caseId: target.caseId },
          selected: d.selected,
        });
        results.push(r);
      }
      appendEvent(db, target.versionId, {
        kind: 'scenario', status: 'ok',
        payload: { scenario: s.id, title: s.title, narrative: s.narrative, decisionResults: results },
      });
    }
  }
  return built;
}
