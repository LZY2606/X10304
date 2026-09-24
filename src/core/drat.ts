// DRAT proof 解析：逐行保留原文、偏移、零终止状态与语法诊断。
import type { Diagnostic, DimacsToken, ProofLine, ProofParse } from './types';
import { offsetQty, varQty } from './normalize';
import { stableId } from './id';
import { hasDuplicateLits, isTautology } from './dimacs';

export function parseDrat(sourceName: string, text: string): ProofParse {
  const diagnostics: Diagnostic[] = [];
  const lines: ProofLine[] = [];
  const physical = text.split('\n');
  let offset = 0;
  let index = 0;
  for (let li = 0; li < physical.length; li++) {
    const rawLine = physical[li];
    const lineOffset = offset;
    offset += rawLine.length + 1;
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('c')) continue;
    const parts = trimmed.split(/\s+/);
    let kind: 'add' | 'delete' = 'add';
    let startIdx = 0;
    if (parts[0] === 'd') { kind = 'delete'; startIdx = 1; }
    const rawTokens: DimacsToken[] = [];
    const diags: Diagnostic[] = [];
    const lits: number[] = [];
    let zeroTerminated = false;
    let cursor = lineOffset + (kind === 'delete' ? rawLine.indexOf('d') + 1 : 0);
    for (let pi = startIdx; pi < parts.length; pi++) {
      const raw = parts[pi];
      const at = rawLine.indexOf(raw, cursor - lineOffset);
      const tokOffset = lineOffset + (at >= 0 ? at : 0);
      cursor = tokOffset + raw.length;
      const { q, diag } = varQty(raw);
      if (diag) diags.push(diag);
      rawTokens.push({ raw, value: q.value, offset: offsetQty(tokOffset), line: li + 1, col: (at >= 0 ? at : 0) + 1 });
      if (q.value === 0) { zeroTerminated = true; break; }
      if (q.value !== null) lits.push(q.value);
    }
    if (!zeroTerminated) {
      diags.push({
        code: 'missing_zero_terminator',
        message: `proof 行缺少 0 终止符，按语法在行尾封闭并记录诊断`,
        severity: 'warning',
      });
    }
    if (isTautology(lits)) {
      diags.push({ code: 'tautology', message: '子句含有互补 literal（tautology），按语法处理', severity: 'info' });
    }
    if (hasDuplicateLits(lits)) {
      diags.push({ code: 'duplicate_literal', message: '子句含有重复 literal，按语法处理（派生层去重）', severity: 'info' });
    }
    const id = stableId(sourceName, lineOffset, kind, rawLine.trim());
    lines.push({
      id, index: index++, kind, lits, rawTokens, raw: rawLine,
      offset: offsetQty(lineOffset), line: li + 1, zeroTerminated, diagnostics: diags,
    });
  }
  return { sourceName, lines, diagnostics };
}
