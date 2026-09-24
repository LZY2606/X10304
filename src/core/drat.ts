/**
 * DRAT 证明导入。
 *
 * 每条 proof 行保留原始文本与 token；行内语法：
 *   addition : <lit>* 0 [<resolution-offset>*]
 *   deletion : d <lit>* 0 [<resolution-offset>*]
 * 零终止按语法处理：缺零不自动补全，记诊断并按恢复子句继续。
 * 删除单元子句行（d 后单文字）记 DELETE_UNIT_LINE 诊断。
 */

import { coordKey, ids, type Id } from './id.js';
import type { Diagnostic, Token } from './domain.js';

export interface ProofLine {
  id: Id;
  source: string;
  lineNo: number;
  rawText: string;
  kind: 'addition' | 'deletion';
  /** 删除单元子句行（语法诊断，仍按删除处理）。 */
  isUnitDeletion: boolean;
  clauseTokenIds: Id[];
  literals: Array<number | null>;
  zeroTerminated: boolean;
  /** 行内 0 之后的 token：解析偏移（resolution offsets），基准 = 行起点时的活跃子句多重集。 */
  hintTokenIds: Id[];
  hints: number[];
  coords: { source: string; line: number; col: number };
}

export interface ProofDocument {
  id: Id;
  source: string;
  rawText: string;
  tokens: Token[];
  lines: ProofLine[];
  diagnostics: Diagnostic[];
}

const INT_RE = /^[+-]?\d+$/;

export function parseDrat(source: string, text: string): ProofDocument {
  const diagnostics: Diagnostic[] = [];
  const tokens: Token[] = [];
  const lines: ProofLine[] = [];

  const mkDiag = (
    severity: Diagnostic['severity'],
    code: Diagnostic['code'],
    message: string,
    subjectId: Id,
    line: number,
    col: number,
  ): void => {
    diagnostics.push({
      id: ids('diag', source, line, col, code),
      severity,
      code,
      message,
      subjectId,
      coords: { source, line, col },
    });
  };

  const physical = text.split('\n');
  physical.forEach((lineText, idx) => {
    const lineNo = idx + 1;
    if (lineText.trim() === '') return;
    if (lineText.trimStart().startsWith('c')) return; // 注释行不进 proof 行，但 token 仍保留
    const lineId = ids('pline', source, lineNo);
    const parts: Array<{ text: string; col: number }> = [];
    let col = 0;
    for (const piece of lineText.split(/(\s+)/)) {
      if (/^\s*$/.test(piece)) {
        col += piece.length;
        continue;
      }
      parts.push({ text: piece, col });
      col += piece.length;
    }
    let kind: 'addition' | 'deletion' = 'addition';
    let cursor = 0;
    if (parts.length > 0 && parts[0]!.text === 'd') {
      kind = 'deletion';
      const t = parts[0]!;
      tokens.push({
        id: ids('ptok', coordKey({ source, line: lineNo, col: t.col })),
        kind: 'garbage',
        text: 'd',
        raw: 'd',
        normalized: null,
        coords: { source, line: lineNo, col: t.col },
        unit: 'deletion-marker',
      });
      cursor = 1;
    }
    const clauseTokenIds: Id[] = [];
    const literals: Array<number | null> = [];
    const hintTokenIds: Id[] = [];
    const hints: number[] = [];
    let zeroTerminated = false;
    let afterZero = false;
    for (; cursor < parts.length; cursor++) {
      const p = parts[cursor]!;
      const coords = { source, line: lineNo, col: p.col };
      const tokId = ids('ptok', coordKey(coords));
      const isInt = INT_RE.test(p.text);
      const value = isInt ? Number(p.text) : null;
      tokens.push({
        id: tokId,
        kind: isInt ? 'integer' : 'garbage',
        text: p.text,
        raw: p.text,
        normalized: value,
        coords,
        unit: afterZero ? 'resolution-offset' : 'literal',
      });
      if (!afterZero && p.text === '0') {
        zeroTerminated = true;
        afterZero = true;
        continue;
      }
      if (afterZero) {
        hintTokenIds.push(tokId);
        if (isInt && value !== null && value >= 0) {
          hints.push(value);
        } else {
          mkDiag('error', 'GARBAGE_INTEGER', `解析偏移必须是 ≥0 的整数，得到 "${p.text}"`, tokId, lineNo, p.col);
        }
      } else {
        clauseTokenIds.push(tokId);
        if (isInt && value !== null) {
          literals.push(value);
        } else {
          literals.push(null);
          mkDiag('error', 'GARBAGE_INTEGER', `无法解析的文字 token "${p.text}"`, tokId, lineNo, p.col);
        }
      }
    }
    if (!zeroTerminated) {
      mkDiag(
        'warning',
        'CLAUSE_WITHOUT_ZERO',
        `proof 第 ${lineNo} 行缺少零终止符 0（按语法记录，不自动补全）`,
        lineId,
        lineNo,
        lineText.length,
      );
    }
    const isUnitDeletion = kind === 'deletion' && literals.filter((l) => l !== null).length === 1;
    if (isUnitDeletion) {
      mkDiag(
        'warning',
        'DELETE_UNIT_LINE',
        `第 ${lineNo} 行为删除单元子句行（d 后单文字），按语法记录诊断`,
        lineId,
        lineNo,
        0,
      );
    }
    lines.push({
      id: lineId,
      source,
      lineNo,
      rawText: lineText,
      kind,
      isUnitDeletion,
      clauseTokenIds,
      literals,
      zeroTerminated,
      hintTokenIds,
      hints,
      coords: { source, line: lineNo, col: 0 },
    });
  });

  return {
    id: ids('proof', source),
    source,
    rawText: text,
    tokens,
    lines,
    diagnostics,
  };
}
