import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCnf, clauseKey, isTautology, hasDuplicateLits } from '../src/core/dimacs';
import { parseDrat } from '../src/core/drat';

const dir = join(__dirname, '..', 'fixtures', 'casepack');
const cnfText = readFileSync(join(dir, 'baseline.cnf'), 'utf8');
const proofText = readFileSync(join(dir, 'baseline.drat'), 'utf8');

describe('DIMACS 解析：原始 token、变量编号、解析偏移均保留', () => {
  const cnf = parseCnf('baseline.cnf', cnfText);
  it('头部与注释保留原文和偏移', () => {
    expect(cnf.header?.vars.value).toBe(3);
    expect(cnf.header?.vars.unit).toBe('1');
    expect(cnf.header?.vars.basis).toBe('dimacs-variable-index');
    expect(cnf.header?.raw).toBe('p cnf 3 6');
    expect(cnf.comments).toHaveLength(1);
    expect(cnf.comments[0].offset.unit).toBe('byte');
  });
  it('每条子句保留 rawTokens 与字节偏移', () => {
    expect(cnf.clauses).toHaveLength(6);
    const c0 = cnf.clauses[0];
    expect(c0.lits).toEqual([1, 2]);
    expect(c0.rawTokens.map(t => t.raw)).toEqual(['1', '2', '0']);
    expect(c0.zeroTerminated).toBe(true);
    // 偏移指向原文真实位置
    expect(cnfText.slice(Number(c0.offset.value))).toMatch(/^1 2 0/);
  });
  it('稳定身份由内容寻址，重复解析一致', () => {
    const again = parseCnf('baseline.cnf', cnfText);
    expect(again.clauses.map(c => c.id)).toEqual(cnf.clauses.map(c => c.id));
  });
});

describe('DRAT 解析：每条 proof 行保留', () => {
  const proof = parseDrat('baseline.drat', proofText);
  it('逐行解析 add/delete 与零终止', () => {
    expect(proof.lines).toHaveLength(6);
    expect(proof.lines[0].kind).toBe('delete');
    expect(proof.lines[0].lits).toEqual([-1, 2]);
    expect(proof.lines[5].lits).toEqual([]); // 空子句行 "0"
    expect(proof.lines.every(l => l.zeroTerminated)).toBe(true);
  });
  it('缺零终止按语法处理并留诊断', () => {
    const p = parseDrat('x.drat', '1 2\n3 0\n');
    expect(p.lines[0].zeroTerminated).toBe(false);
    expect(p.lines[0].diagnostics.map(d => d.code)).toContain('missing_zero_terminator');
    expect(p.lines[0].lits).toEqual([1, 2]); // 行尾封闭，仍参与核验
  });
  it('超大变量编号保留原始 token 并附诊断', () => {
    const p = parseDrat('x.drat', '-3 9007199254740993 0\n');
    const tok = p.lines[0].rawTokens[1];
    expect(tok.raw).toBe('9007199254740993');
    expect(tok.value).toBeNull();
    expect(p.lines[0].diagnostics.map(d => d.code)).toContain('unsafe_integer');
    expect(p.lines[0].lits).toEqual([-3]); // 无法转换的值留在原位置，不进派生层
  });
  it('tautology 与重复 literal 是语法诊断', () => {
    const p = parseDrat('x.drat', '1 -1 2 2 0\n');
    const codes = p.lines[0].diagnostics.map(d => d.code);
    expect(codes).toContain('tautology');
    expect(codes).toContain('duplicate_literal');
  });
});

describe('子句多重集键（派生层规范化）', () => {
  it('去重并排序，原式不受影响', () => {
    expect(clauseKey([2, 1, 2])).toBe('1,2');
    expect(isTautology([1, -1])).toBe(true);
    expect(hasDuplicateLits([3, 3])).toBe(true);
  });
});
