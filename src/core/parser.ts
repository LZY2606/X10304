// 导入层：只做保真解析。
// 保留原 DIMACS token、坐标基准（char/line/col）、变量编号与语法标记。
// 语法层面：tautology、重复 literal、零终止在此标记；不做“是否合法证明”的语义判断。

import {
  type CnfDocument, type ClauseOccurrence, type DratDocument, type ProofLine,
  type RawToken, type RawTokenKind, type SyntaxFlags, type Coord,
} from './types';
import { scopedId } from './identity';

function scanTokens(raw: string): { tokens: RawToken[]; lineStarts: number[] } {
  const tokens: RawToken[] = [];
  const lineStarts: number[] = [0];
  let i = 0;
  let line = 1;
  let col = 1;

  const coordAt = (index: number): Coord => ({
    index,
    line,
    col: index - lineStarts[line - 1] + 1,
  });

  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\n') {
      lineStarts[line] = i + 1;
      line++;
      col = 1;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      col++;
      continue;
    }
    const startIndex = i;
    let text = '';
    let kind: RawTokenKind;
    if (ch === 'c' && (i + 1 >= raw.length || raw[i + 1] === ' ' || raw[i + 1] === '\t')) {
      // 注释吃到行尾
      while (i < raw.length && raw[i] !== '\n') { text += raw[i]; i++; }
      kind = 'comment';
    } else if (raw.startsWith('p cnf', i) || raw.startsWith('p ', i)) {
      while (i < raw.length && raw[i] !== '\n' && raw[i] !== ' ' && raw[i] !== '\t') {
        text += raw[i]; i++; col++;
      }
      // 把剩余 header 内容一起吃掉（行内）
      if (text === 'p') {
        while (i < raw.length && raw[i] !== '\n') {
          const c = raw[i];
          if (c !== ' ' && c !== '\t' && c !== '\r') { text += c; }
          i++; col++;
        }
      }
      kind = 'header';
    } else if (/[0-9+-]/.test(ch)) {
      while (i < raw.length && /[0-9+\-]/.test(raw[i])) { text += raw[i]; i++; col++; }
      if (/^[+-]?\d+$/.test(text) && !/^[+-]?0+\d/.test(text)) {
        kind = text === '0' ? 'zero' : 'int';
      } else {
        kind = 'unknown';
      }
    } else {
      text = ch;
      kind = 'unknown';
      i++;
      col++;
    }
    tokens.push({
      id: scopedId('tok', raw, startIndex, text),
      kind,
      text,
      start: coordAt(startIndex),
      end: coordAt(i),
    });
  }
  return { tokens, lineStarts };
}

function syntaxFlags(literals: number[], declaredVars: number | null): SyntaxFlags {
  const seen = new Map<number, number[]>();
  literals.forEach((lit, idx) => {
    const arr = seen.get(lit) ?? [];
    arr.push(idx);
    seen.set(lit, arr);
  });
  const duplicateLiterals: number[] = [];
  for (const positions of seen.values()) {
    if (positions.length > 1) duplicateLiterals.push(...positions.slice(1));
  }
  duplicateLiterals.sort((a, b) => a - b);
  const signs = new Set(literals.map((l) => Math.abs(l)));
  let tautology = false;
  for (const v of signs) {
    if (seen.has(v) && seen.has(-v)) { tautology = true; break; }
  }
  const oversizedVars: number[] = [];
  if (declaredVars !== null) {
    literals.forEach((lit, idx) => {
      if (Math.abs(lit) > declaredVars) oversizedVars.push(idx);
    });
  }
  return {
    tautology,
    duplicateLiterals,
    hasZeroTerminator: false,
    oversizedVars,
  };
}

export interface ParseCnfResult {
  doc: CnfDocument;
  parseErrors: Array<{ message: string; tokenId: string | null; line: number }>;
}

export function parseCnf(caseId: string, raw: string): ParseCnfResult {
  const { tokens } = scanTokens(raw);
  const sourceId = 'src:cnf';
  let declaredVars: number | null = null;
  const parseErrors: ParseCnfResult['parseErrors'] = [];

  for (const tok of tokens) {
    if (tok.kind === 'header') {
      const m = tok.text.split(/\s+/);
      if (m[0] === 'p' && m[1] === 'cnf') {
        declaredVars = Number(m[2]);
      }
    } else if (tok.kind === 'unknown') {
      parseErrors.push({ message: `无法识别的 CNF token：${JSON.stringify(tok.text)}`, tokenId: tok.id, line: tok.start.line });
    }
  }

  const clauses: ClauseOccurrence[] = [];
  let buffer: number[] = [];
  let bufferTokenIds: string[] = [];
  let clauseStartToken: RawToken | null = null;
  let ordinal = 0;

  const flush = (terminatedByZero: boolean, endLine: number) => {
    if (buffer.length === 0) { buffer = []; bufferTokenIds = []; clauseStartToken = null; return; }
    const flags = syntaxFlags(buffer, declaredVars);
    flags.hasZeroTerminator = terminatedByZero;
    const normalized = [...buffer].sort((a, b) => a - b);
    const multisetKey = normalized.join(',');
    clauses.push({
      id: scopedId('cl:cnf', caseId, ordinal, multisetKey),
      source: 'cnf',
      ordinal,
      lineOrdinal: clauseStartToken ? clauseStartToken.start.line - 1 : endLine - 1,
      literals: buffer,
      multisetKey,
      tokenIds: [...bufferTokenIds],
    });
    ordinal++;
    buffer = [];
    bufferTokenIds = [];
    clauseStartToken = null;
  };

  for (const tok of tokens) {
    if (tok.kind === 'comment' || tok.kind === 'header') continue;
    if (tok.kind === 'unknown') continue;
    if (!clauseStartToken) clauseStartToken = tok;
    if (tok.kind === 'zero') {
      flush(true, tok.start.line);
    } else if (tok.kind === 'int') {
      buffer.push(Number(tok.text));
      bufferTokenIds.push(tok.id);
    }
  }
  // 缺零终止：CNF 末尾允许省略（DIMACS 约定），但显式记录为语法诊断由上层产生事件
  flush(false, tokens.length ? tokens[tokens.length - 1].end.line : 1);

  const maxVarObserved = clauses.reduce((m, c) => Math.max(m, ...c.literals.map((l) => Math.abs(l))), 0);
  const doc: CnfDocument = {
    caseId,
    sourceId,
    raw,
    tokens,
    declaredVars,
    maxVarObserved,
    clauses,
  };
  return { doc, parseErrors };
}

export interface ParseDratResult {
  doc: DratDocument;
  parseErrors: Array<{ message: string; line: number; lineOrdinal: number | null; missingZero: boolean; tokenId: string | null }>;
}

// 按物理行切分 DRAT（每条 proof 一行；行首 d 表示删除）
export function parseDrat(caseId: string, raw: string): ParseDratResult {
  const { tokens } = scanTokens(raw);
  const sourceId = 'src:drat';
  const parseErrors: ParseDratResult['parseErrors'] = [];
  const lines: ProofLine[] = [];

  // 按行分组 token
  const byLine = new Map<number, RawToken[]>();
  for (const tok of tokens) {
    if (tok.kind === 'comment') continue;
    const arr = byLine.get(tok.start.line) ?? [];
    arr.push(tok);
    byLine.set(tok.start.line, arr);
  }
  const physicalLines = [...byLine.keys()].sort((a, b) => a - b);

  let ordinal = 0;
  for (const pline of physicalLines) {
    const toks = byLine.get(pline)!;
    let kind: 'add' | 'delete' = 'add';
    let startTok = toks[0];
    let work = toks;
    if (toks[0] && /^d$/i.test(toks[0].text)) {
      kind = 'delete';
      startTok = toks[1] ?? toks[0];
      work = toks.slice(1);
    }
    const nums: number[] = [];
    const tokenIds: string[] = [];
    let unknown: RawToken | null = null;
    let hasZero = false;
    for (const t of work) {
      if (t.kind === 'header') { unknown = t; continue; }
      if (t.kind === 'unknown') { unknown = t; continue; }
      if (t.kind === 'zero') { hasZero = true; continue; }
      if (t.kind === 'int') { nums.push(Number(t.text)); tokenIds.push(t.id); }
    }
    const rawLine = raw.split('\n')[pline - 1] ?? '';
    const flags = syntaxFlags(nums, null);
    flags.hasZeroTerminator = hasZero;
    const lineId = scopedId('pl', caseId, ordinal);
    if (unknown) {
      parseErrors.push({ message: `proof 第 ${ordinal} 行存在无法识别 token：${JSON.stringify(unknown.text)}`, line: pline, lineOrdinal: ordinal, missingZero: false, tokenId: unknown.id });
    }
    if (!hasZero && nums.length >= 0 && rawLine.trim().length > 0) {
      // DRAT 每行必须以 0 终止
      parseErrors.push({ message: `proof 第 ${ordinal} 行缺少 0 终止`, line: pline, lineOrdinal: ordinal, missingZero: true, tokenId: null });
    }
    lines.push({
      id: lineId,
      ordinal,
      raw: rawLine,
      start: { index: startTok.start.index, line: startTok.start.line, col: startTok.start.col },
      end: toks.length ? { ...toks[toks.length - 1].end } : startTok.end,
      kind,
      literals: nums,
      tokenIds,
      flags,
    });
    ordinal++;
  }

  const doc: DratDocument = { caseId, sourceId, raw, tokens, lines };
  return { doc, parseErrors };
}
