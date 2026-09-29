import type {
  CnfParseResult,
  Diagnostic,
  ParsedClause,
  ProofLine,
  ProofParseResult,
  RawToken
} from './types.js';

export interface NormResult {
  normLits: number[];
  isTautology: boolean;
  hasDuplicateLits: boolean;
}

export function normaliseLits(rawLits: number[]): NormResult {
  const seen = new Set<number>();
  let hasDuplicateLits = false;
  for (const l of rawLits) {
    if (seen.has(l)) hasDuplicateLits = true;
    seen.add(l);
  }
  const isTautology = rawLits.some((l) => seen.has(-l));
  const normLits = [...new Set(rawLits)].sort((a, b) => {
    const d = Math.abs(a) - Math.abs(b);
    return d !== 0 ? d : a - b;
  });
  return { normLits, isTautology, hasDuplicateLits };
}

export function canonicalKey(normLits: number[]): string {
  return normLits.join(',');
}

interface SourceLine {
  text: string;
  start: number;
  lineNo: number;
}

function splitLines(source: string): SourceLine[] {
  const out: SourceLine[] = [];
  let lineStart = 0;
  let lineNo = 1;
  for (let i = 0; i <= source.length; i++) {
    if (i === source.length || source[i] === '\n') {
      out.push({
        text: source.slice(lineStart, i),
        start: lineStart,
        lineNo
      });
      lineStart = i + 1;
      lineNo++;
      if (i === source.length) break;
    }
  }
  return out;
}

function tokensOfLine(line: SourceLine): RawToken[] {
  const tokens: RawToken[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line.text)) !== null) {
    tokens.push({
      text: m[0],
      offset: line.start + m.index,
      line: line.lineNo,
      col: m.index + 1
    });
  }
  return tokens;
}

const INT_RE = /^-?\d+$/;

export function parseCnf(source: string): CnfParseResult {
  const diagnostics: Diagnostic[] = [];
  const comments: CnfParseResult['comments'] = [];
  const tokens: RawToken[] = [];
  const clauses: ParsedClause[] = [];
  let declaredVars: number | null = null;
  let declaredClauses: number | null = null;
  let headerPresent = false;

  let pending: number[] = [];
  let pendingStart = -1;
  let pendingEnd = -1;
  let pendingLine = -1;

  const flushPending = (missingTerminator: boolean, lineNo: number) => {
    if (pending.length === 0) return;
    const norm = normaliseLits(pending);
    const oversizedVars =
      declaredVars === null
        ? []
        : [...new Set(norm.normLits.map((l) => Math.abs(l)).filter((v) => v > declaredVars!))];
    const stableId = `cnf:c${clauses.length}`;
    clauses.push({
      stableId,
      origin: 'cnf',
      rawLits: [...pending],
      normLits: norm.normLits,
      isTautology: norm.isTautology,
      hasDuplicateLits: norm.hasDuplicateLits,
      missingTerminator,
      tokenStart: pendingStart,
      tokenEnd: pendingEnd,
      endLine: lineNo,
      oversizedVars
    });
    if (norm.isTautology) {
      diagnostics.push({
        code: 'tautology',
        severity: 'warning',
        message: `子句 ${stableId} 含互补文字（tautology），按语法保留`,
        offset: pendingStart,
        endOffset: pendingEnd,
        refId: stableId
      });
    }
    if (norm.hasDuplicateLits) {
      diagnostics.push({
        code: 'duplicate-literal',
        severity: 'warning',
        message: `子句 ${stableId} 含重复 literal，原始表示保留，派生层规范化`,
        offset: pendingStart,
        endOffset: pendingEnd,
        refId: stableId
      });
    }
    if (missingTerminator) {
      diagnostics.push({
        code: 'missing-zero-terminator',
        severity: 'warning',
        message: `子句 ${stableId} 缺少零终止（EOF），按语法处理`,
        offset: pendingStart,
        endOffset: pendingEnd,
        refId: stableId
      });
    }
    for (const v of oversizedVars) {
      diagnostics.push({
        code: 'var-exceeds-header',
        severity: 'warning',
        message: `变量编号 ${v} 超出 p cnf 头声明的 ${declaredVars}，保留原值并诊断`,
        offset: pendingStart,
        endOffset: pendingEnd,
        refId: stableId
      });
    }
    pending = [];
  };

  for (const line of splitLines(source)) {
    const trimmed = line.text.trim();
    const lineTokens = tokensOfLine(line);
    if (trimmed === '') continue;
    if (trimmed.startsWith('c')) {
      comments.push({ text: trimmed, offset: line.start, line: line.lineNo });
      continue;
    }
    if (trimmed.startsWith('p')) {
      tokens.push(...lineTokens);
      const parts = trimmed.split(/\s+/);
      if (parts[0] === 'p' && parts[1] === 'cnf') {
        headerPresent = true;
        declaredVars = Number(parts[2]);
        declaredClauses = Number(parts[3]);
      } else {
        diagnostics.push({
          code: 'bad-header',
          severity: 'error',
          message: '无法识别的 p 行，期望 p cnf <vars> <clauses>',
          offset: line.start
        });
      }
      continue;
    }
    for (const tok of lineTokens) {
      tokens.push(tok);
      if (!INT_RE.test(tok.text)) {
        diagnostics.push({
          code: 'bad-token',
          severity: 'error',
          message: `无法解析的 token "${tok.text}"`,
          offset: tok.offset,
          endOffset: tok.offset + tok.text.length
        });
        continue;
      }
      const value = Number(tok.text);
      if (value === 0) {
        flushPending(false, tok.line);
        pending = [];
        continue;
      }
      if (pending.length === 0) {
        pendingStart = tok.offset;
        pendingLine = tok.line;
      }
      pendingEnd = tok.offset + tok.text.length;
      pending.push(value);
    }
  }
  if (pending.length > 0) {
    flushPending(true, pendingLine);
  }
  if (headerPresent && declaredClauses !== null && clauses.length !== declaredClauses) {
    diagnostics.push({
      code: 'clause-count-mismatch',
      severity: 'warning',
      message: `p cnf 头声明 ${declaredClauses} 条子句，实际解析 ${clauses.length} 条`,
    });
  }
  return {
    declaredVars,
    declaredClauses,
    headerPresent,
    clauses,
    tokens,
    comments,
    diagnostics
  };
}

export function parseProof(source: string): ProofParseResult {
  const diagnostics: Diagnostic[] = [];
  const comments: ProofParseResult['comments'] = [];
  const tokens: RawToken[] = [];
  const lines: ProofLine[] = [];

  for (const line of splitLines(source)) {
    const trimmed = line.text.trim();
    const lineTokens = tokensOfLine(line);
    if (trimmed === '') continue;
    if (trimmed.startsWith('c')) {
      comments.push({ text: trimmed, offset: line.start, line: line.lineNo });
      continue;
    }
    let kind: ProofLine['kind'] = 'addition';
    let scanStart = 0;
    if (lineTokens.length > 0 && lineTokens[0].text === 'd') {
      kind = 'deletion';
      scanStart = 1;
    }
    const lits: number[] = [];
    let tokenStart = -1;
    let tokenEnd = -1;
    let terminated = false;
    for (let ti = scanStart; ti < lineTokens.length; ti++) {
      const tok = lineTokens[ti];
      tokens.push(tok);
      if (!INT_RE.test(tok.text)) {
        diagnostics.push({
          code: 'bad-token',
          severity: 'error',
          message: `proof 行无法解析的 token "${tok.text}"`,
          offset: tok.offset,
          endOffset: tok.offset + tok.text.length,
          refId: `proof:l${lines.length}`
        });
        continue;
      }
      const value = Number(tok.text);
      if (value === 0) {
        terminated = true;
        continue;
      }
      if (lits.length === 0) tokenStart = tok.offset;
      tokenEnd = tok.offset + tok.text.length;
      lits.push(value);
    }
    if (lits.length === 0 && tokenStart === -1 && !terminated) {
      diagnostics.push({
        code: 'empty-proof-line',
        severity: 'error',
        message: '空的 proof 行（既无文字也无 0 终止）',
        offset: line.start,
        refId: `proof:l${lines.length}`
      });
    }
    const stableId = `proof:l${lines.length}`;
    const norm = normaliseLits(lits);
    const record: ProofLine = {
      stableId,
      index: lines.length,
      kind,
      rawLits: lits,
      normLits: norm.normLits,
      isTautology: norm.isTautology,
      hasDuplicateLits: norm.hasDuplicateLits,
      missingTerminator: !terminated,
      tokenStart: tokenStart === -1 ? line.start : tokenStart,
      tokenEnd: tokenEnd === -1 ? line.start + line.text.trimEnd().length : tokenEnd,
      lineNo: line.lineNo,
      rawText: trimmed
    };
    lines.push(record);
    if (norm.isTautology) {
      diagnostics.push({
        code: 'tautology',
        severity: 'warning',
        message: `${stableId} 含互补文字（tautology），按语法接受，不做 RUP/RAT`,
        offset: record.tokenStart,
        endOffset: record.tokenEnd,
        refId: stableId
      });
    }
    if (norm.hasDuplicateLits) {
      diagnostics.push({
        code: 'duplicate-literal',
        severity: 'warning',
        message: `${stableId} 含重复 literal，原始表示保留，派生层规范化`,
        offset: record.tokenStart,
        endOffset: record.tokenEnd,
        refId: stableId
      });
    }
    if (!terminated) {
      diagnostics.push({
        code: 'missing-zero-terminator',
        severity: 'warning',
        message: `${stableId} 缺少零终止（EOF），按语法处理`,
        offset: line.start,
        refId: stableId
      });
    }
  }
  return { lines, tokens, comments, diagnostics };
}
