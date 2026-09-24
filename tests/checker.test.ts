import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCnf } from '../src/core/dimacs';
import { parseDrat } from '../src/core/drat';
import { checkProof } from '../src/core/checker';
import { applyEdit } from '../src/server/archive';

const dir = join(__dirname, '..', 'fixtures', 'casepack');
const cnfText = readFileSync(join(dir, 'baseline.cnf'), 'utf8');
const proofText = readFileSync(join(dir, 'baseline.drat'), 'utf8');
const run = (p: string, budget = 64) =>
  checkProof(parseCnf('b.cnf', cnfText), parseDrat('b.drat', p), { budget });

describe('基线：RUP/RAT 区分、最终空子句', () => {
  const r = run(proofText);
  it('证明核验通过且空子句推出', () => {
    expect(r.verdict).toBe('verified');
    expect(r.emptyClauseDerived).toBe(true);
    expect(r.failingPrefix).toBeNull();
  });
  it('步骤 2 的引理是 RAT 而非 RUP（pivot=2）', () => {
    const s = r.steps[1];
    expect(s.pivot).toBe(2);
    const rup = s.events.find(e => e.kind === 'rup_check');
    // RUP 先失败：不产生 rup_check 成功事件；成功的是 rat_check
    expect(rup).toBeUndefined();
    const rat = s.events.find(e => e.kind === 'rat_check');
    expect(rat?.status).toBe('ok');
    expect(rat!.details.okPivots).toEqual([2]);
  });
  it('步骤 3 是 RUP 通过并携带传播理由链', () => {
    const s = r.steps[2];
    expect(s.events.some(e => e.kind === 'rup_check' && e.status === 'ok')).toBe(true);
    expect(s.propagation.length).toBeGreaterThan(1);
    const propagated = s.propagation.filter(p => p.reasonClauseKey !== null);
    expect(propagated.length).toBe(s.propagationsUsed);
  });
  it('活跃多重集随删除与加入正确变化', () => {
    const afterDelete = r.steps[0].activeAfter.find(c => c.key === '-1,2');
    expect(afterDelete).toBeUndefined();
    const afterAddEmpty = r.steps[r.steps.length - 1].activeAfter;
    expect(afterAddEmpty.some(c => c.key === '')).toBe(true);
  });
});

describe('删除语义：删除不存在子句不改变集合但留诊断', () => {
  const p = applyEdit(proofText, { budget: 64 }, { type: 'proof.insertAfter', index: 0, lines: ['d -1 2 0', 'd 9 9 0'] }).proofText;
  const r = run(p);
  it('两条删除诊断，集合不变', () => {
    const diag = r.events.filter(e => e.kind === 'delete_clause' && e.status === 'diagnostic');
    expect(diag).toHaveLength(2);
    // 初始与首个合法删除后的集合一致：-1,2 已经不在，后续不存在的删除不产生新键
    expect(r.verdict).toBe('verified');
  });
});

describe('重复子句与 tautology：按语法处理', () => {
  it('重复子句计数加一', () => {
    const p = applyEdit(proofText, { budget: 64 }, { type: 'proof.prepend', line: '1 2 0' }).proofText;
    const r = run(p);
    expect(r.steps[0].activeAfter.find((c: any) => c.key === '1,2')?.count).toBe(2);
  });
  it('tautology 子句被语法接受且证明仍通过', () => {
    const p = applyEdit(proofText, { budget: 64 }, { type: 'proof.prepend', line: '1 -1 0' }).proofText;
    const r = run(p);
    expect(r.events.some(e => e.details.code === 'tautology')).toBe(true);
    expect(r.verdict).toBe('verified');
  });
});

describe('RAT pivot：保留全部合法候选，不吞掉多解', () => {
  const p = applyEdit(proofText, { budget: 64 }, { type: 'proof.replaceLine', index: 1, line: '3 -1 0' }).proofText;
  const r = run(p);
  it('首选 pivot=3 不成立但 pivot=-1 成立，候选全保留', () => {
    const s = r.steps[1];
    const rat = s.events.find(e => e.kind === 'rat_check');
    expect(rat?.status).toBe('diagnostic');
    expect(rat!.details.okPivots).toEqual([-1]);
    expect(s.pivotCandidates.length).toBe(2);
  });
  it('后续步骤失败时报告最短失败前缀', () => {
    expect(r.verdict).toBe('failed');
    expect(r.failingPrefix).toBe(4);
  });
});

describe('资源语义：预算耗尽不是证明无效', () => {
  const r = run(proofText, 1);
  it('结论为 inconclusive_resource 而非 failed', () => {
    expect(r.verdict).toBe('inconclusive_resource');
    expect(r.events.some(e => e.kind === 'budget')).toBe(true);
  });
});

describe('缺零终止：语法封闭后继续核验', () => {
  const p = applyEdit(proofText, { budget: 64 }, { type: 'proof.dropZeroTerminator', index: 2 }).proofText;
  const r = run(p);
  it('诊断存在且证明仍核验通过', () => {
    expect(r.events.some(e => e.details.code === 'missing_zero_terminator')).toBe(true);
    expect(r.verdict).toBe('verified');
  });
});
