/**
 * DIMACS CNF 导入：词法 + 语法。
 *
 * 保留原 DIMACS token、变量编号与每条原始行；所有诊断带坐标。
 * 解析失败的整数留在原位置（normalized=null + 诊断），不丢弃、不猜测。
 */

import { coordKey, ids, type Id } from './id.js';
import type {
  CnfDocument,
  Diagnostic,
  RawClause,
  Token,
  VarRecord,
} from './domain.js';

interface RawToken {
  text: string;
  line: number;
  col: number;
}

function tokenize(source: string, text: string): RawToken[] {
  const out: RawToken[] = [];
  let line = 1;
  let col = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\n') {
      line += 1;
      col = 0;
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      col += 1;
      i += 1;
      continue;
    }
    const start = i;
    const startCol = col;
    const startLine = line;
    while (
      i < text.length &&
      text[i] !== ' ' &&
      text[i] !== '\t' &&
      text[i] !== '\r' &&
      text[i] !== '\n'
    ) {
      i += 1;
      col += 1;
    }
    out.push({ text: text.slice(start, i), line: startLine, col: startCol });
  }
  void source;
  return out;
}

const INT_RE = /^[+-]?\d+$/;

export function parseDimacs(source: string, text: string): CnfDocument {
  const diagnostics: Diagnostic[] = [];
  const tokens: Token[] = [];
  const lines = text.split('\n');

  const mkDiag = (
    severity: Diagnostic['severity'],
    code: Diagnostic['code'],
    message: string,
    subjectId: Id,
    line: number,
    col: number,
  ): Diagnostic => {
    const d: Diagnostic = {
      id: ids('diag', source, line, col, code),
      severity,
      code,
      message,
      subjectId,
      coords: { source, line, col },
    };
    diagnostics.push(d);
    return d;
  };

  // 物理行 -> 是否注释
  const commentLines = new Set<number>();
  const headerLine = new Set<number>();
  lines.forEach((l, idx) => {
    const t = l.trim();
    if (t.startsWith('c')) commentLines.add(idx + 1);
    if (t.startsWith('p ') || t === 'p') headerLine.add(idx + 1);
  });

  const rawTokens = tokenize(source, text);
  let header: CnfDocument['header'] = {
    present: false,
    pLine: null,
    numVarsRaw: null,
    numVars: null,
    numClausesRaw: null,
    numClauses: null,
  };

  for (const rt of rawTokens) {
    const coords = { source, line: rt.line, col: rt.col };
    const id = ids('tok', coordKey(coords));
    if (commentLines.has(rt.line) || headerLine.has(rt.line)) {
      // 注释/头部的 token 也原样保留，供“原 DIMACS token”核对。
      tokens.push({
        id,
        kind: INT_RE.test(rt.text) ? 'integer' : 'garbage',
        text: rt.text,
        raw: rt.text,
        normalized: INT_RE.test(rt.text) ? Number(rt.text) : null,
        coords,
        unit: 'header-token',
      });
      continue;
    }
  }

  // 解析头部（取第一条 p 行）
  for (const [idx, l] of lines.entries()) {
    const t = l.trim();
    if (!t.startsWith('p ')) continue;
    const parts = t.split(/\s+/);
    header.present = true;
    header.pLine = t;
    if (parts[0] !== 'p' || parts[1] !== 'cnf' || parts.length !== 4) {
      mkDiag(
        'error',
        'BAD_HEADER',
        `头部应为 "p cnf <变量数> <子句数>"，实际为 "${t}"`,
        ids('header', source),
        idx + 1,
        0,
      );
    } else {
      header.numVarsRaw = parts[2]!;
      header.numClausesRaw = parts[3]!;
      header.numVars = INT_RE.test(parts[2]!) ? Number(parts[2]) : null;
      header.numClauses = INT_RE.test(parts[3]!) ? Number(parts[3]) : null;
      if (header.numVars === null)
        mkDiag('error', 'BAD_HEADER', `变量数无法解析: ${parts[2]}`, ids('header', source), idx + 1, t.indexOf(parts[2]!));
      if (header.numClauses === null)
        mkDiag('error', 'BAD_HEADER', `子句数无法解析: ${parts[3]}`, ids('header', source), idx + 1, t.indexOf(parts[3]!));
      if (header.numVars !== null && header.numVars < 0)
        mkDiag('error', 'BAD_HEADER', '变量数为负', ids('header', source), idx + 1, t.indexOf(parts[2]!),
      );
    }
    if (/\b0\b/.test(t.split('cnf')[1] ?? '')) {
      mkDiag('warning', 'ZERO_IN_HEADER', '头部行中出现独立的 0', ids('header', source), idx + 1, t.indexOf('0'));
    }
    break;
  }

  // 子句行（每条物理行一条子句，坐标基准清晰）
  const clauses: RawClause[] = [];
  const varMap = new Map<number, VarRecord>();
  for (const [idx, lineText] of lines.entries()) {
    const lineNo = idx + 1;
    if (commentLines.has(lineNo) || headerLine.has(lineNo)) continue;
    if (lineText.trim() === '') continue;
    const clauseId = ids('cnfclause', source, lineNo);
    const tokenIds: Id[] = [];
    const literals: Array<number | null> = [];
    let sawZero = false;
    let colCursor = 0;
    for (const piece of lineText.split(/(\s+)/)) {
      if (/^\s+$/.test(piece) || piece === '') {
        colCursor += piece.length;
        continue;
      }
      const coords = { source, line: lineNo, col: colCursor };
      const tokId = ids('tok', coordKey(coords));
      const isInt = INT_RE.test(piece);
      const value = isInt ? Number(piece) : null;
      tokens.push({
        id: tokId,
        kind: isInt ? 'integer' : 'garbage',
        text: piece,
        raw: piece,
        normalized: value,
        coords,
        unit: 'literal',
      });
      tokenIds.push(tokId);
      if (piece === '0') {
        sawZero = true;
      } else if (isInt && value !== 0) {
        literals.push(value);
        const v = Math.abs(value);
        if (!varMap.has(v)) {
          const rec: VarRecord = {
            id: ids('var', source, v),
            var: v,
            introducedByToken: tokId,
            firstSeenClause: clauseId,
          };
          varMap.set(v, rec);
        }
      } else if (!isInt) {
        literals.push(null);
        mkDiag('error', 'GARBAGE_INTEGER', `无法解析的整数 token "${piece}"`, tokId, lineNo, colCursor);
      }
      colCursor += piece.length;
    }
    if (!sawZero) {
      mkDiag(
        'warning',
        'CLAUSE_WITHOUT_ZERO',
        `第 ${lineNo} 行缺少零终止符 0（按语法记录为非终止子句，不自动补全）`,
        clauseId,
        lineNo,
        lineText.length,
      );
    }
    clauses.push({
      id: clauseId,
      source,
      lineNo,
      rawText: lineText,
      tokenIds,
      literals,
      zeroTerminated: sawZero,
      coords: { source, line: lineNo, col: 0 },
    });
  }

  const variables = [...varMap.values()].sort((a, b) => a.var - b.var);
  const declared = header.numVars;
  const tokenById = new Map(tokens.map((t) => [t.id, t]));
  if (declared !== null) {
    for (const v of variables) {
      if (v.var > declared) {
        const tok = tokenById.get(v.introducedByToken);
        mkDiag(
          'error',
          'VAR_OUT_OF_RANGE',
          `变量 ${v.var} 超出头部声明上界 ${declared}`,
          v.introducedByToken,
          tok?.coords.line ?? 1,
          tok?.coords.col ?? 0,
        );
      }
    }
  }

  return {
    id: ids('cnf', source),
    source,
    rawText: text,
    tokens: tokens.sort((a, b) =>
      a.coords.line === b.coords.line
        ? a.coords.col - b.coords.col
        : a.coords.line - b.coords.line,
    ),
    header,
    clauses,
    variables,
    diagnostics,
  };
}

