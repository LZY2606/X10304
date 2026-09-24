import type {
  CnfHeader,
  ClauseSpec,
  Diagnostic,
  Location,
  ParsedCnf,
  ParsedProof,
  ProofLine,
  Qty,
  Token
} from './types';

const qty = (value: number, unit: string): Qty => ({ value, unit });

export function makeLoc(start: number, end: number, line: number, col: number): Location {
  return {
    startOffset: qty(start, 'char-offset'),
    endOffset: qty(end, 'char-offset'),
    line: qty(line, 'line'),
    col: qty(col, 'column')
  };
}

interface SplitToken {
  raw: string;
  start: number;
  end: number;
  line: number;
  lineStart: number;
}

/** 按空白切分，同时记录每个 token 的字符偏移与行列。 */
export function splitTokens(text: string): SplitToken[] {
  const out: SplitToken[] = [];
  let line = 1;
  let lineStart = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') {
      line += 1;
      i += 1;
      lineStart = i;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < text.length && !/\s/.test(text[i])) i += 1;
    out.push({ raw: text.slice(start, i), start, end: i, line, lineStart });
  }
  return out;
}

const INT_RE = /^[+-]?\d+$/;

export function parseCnf(sourceId: string, text: string): ParsedCnf {
  const tokens: Token[] = [];
  const clauses: ClauseSpec[] = [];
  const diagnostics: Diagnostic[] = [];
  const header: CnfHeader = { headerTokenIds: [] };

  let maxVar = 0;
  let clauseIndex = 0;
  let curLits: number[] = [];
  let curTokIds: string[] = [];
  let curLine = -1;
  let curTerminator: string | undefined;
  let curStartTok: Token | undefined;

  const pushClause = (terminatorPresent: boolean) => {
    if (curLits.length === 0 && terminatorPresent && curStartTok === undefined) return;
    const clauseId = `${sourceId}.cl#${clauseIndex}`;
    const { tautology, tautologyVars, duplicates } = analyzeLits(curLits);
    clauses.push({
      clauseId,
      origin: 'cnf',
      originLine: qty(curLine, 'line'),
      lits: [...curLits],
      literalTokenIds: [...curTokIds],
      terminatorTokenId: curTerminator,
      tautology,
      tautologyVars,
      duplicateLiterals: duplicates,
      activeTokenCount: qty(curLits.length, 'literal')
    });
    if (!terminatorPresent && curLits.length > 0) {
      diagnostics.push({
        code: 'DIMACS_MISSING_ZERO',
        severity: 'warning',
        message: `初始子句 #${clauseIndex}（行 ${curLine}）缺少 0 终止符，按行结束隐式终止`,
        relatedIds: [clauseId],
        loc: curStartTok?.loc
      });
    }
    clauseIndex += 1;
    curLits = [];
    curTokIds = [];
    curTerminator = undefined;
    curStartTok = undefined;
  };

  const rawLines = text.split('\n');
  const split = splitTokens(text);
  let tokenSeq = 0;

  // 注释按整行处理（保留原文为 comment token）
  const commentLines = new Set<number>();
  rawLines.forEach((rl, idx) => {
    if (rl.trimStart().startsWith('c')) commentLines.add(idx + 1);
  });

  for (const st of split) {
    const col = st.start - st.lineStart + 1;
    const loc = makeLoc(st.start, st.end, st.line, col);
    if (commentLines.has(st.line)) {
      const tokenId = `${sourceId}.tok#${tokenSeq++}`;
      tokens.push({ tokenId, kind: 'comment', raw: st.raw, loc });
      header.headerTokenIds;
      continue;
    }
    if (st.raw === 'p') {
      // p cnf n m 头：本行剩余整数均归头
      const tokenId = `${sourceId}.tok#${tokenSeq++}`;
      tokens.push({ tokenId, kind: 'p-header', raw: st.raw, loc });
      header.headerTokenIds.push(tokenId);
      const rest = rawLines[st.line - 1]
        .split(/\s+/)
        .slice(1)
        .filter(Boolean);
      rest.forEach((rv, off) => {
        const t2: Token = {
          tokenId: `${sourceId}.tok#${tokenSeq++}`,
          kind: 'p-header',
          raw: rv,
          loc: makeLoc(st.end + 1 + off, st.end + 2 + off, st.line, col + 2 + off)
        };
        tokens.push(t2);
        header.headerTokenIds.push(t2.tokenId);
      });
      const nums = rest.filter((r) => INT_RE.test(r)).map(Number);
      if (nums.length >= 2) {
        header.declaredVars = nums[1];
        header.declaredClauses = nums[2];
      }
      tokenSeq; // noop
      continue;
    }

    if (!INT_RE.test(st.raw)) {
      const tokenId = `${sourceId}.tok#${tokenSeq++}`;
      tokens.push({ tokenId, kind: 'garbage', raw: st.raw, loc });
      diagnostics.push({
        code: 'DIMACS_BAD_TOKEN',
        severity: 'error',
        message: `无法解析的 token “${st.raw}”（行 ${st.line}），保留原位不参与子句`,
        loc,
        rawValue: st.raw,
        relatedIds: []
      });
      continue;
    }

    const value = Number(st.raw);
    if (value === 0) {
      const tokenId = `${sourceId}.tok#${tokenSeq++}`;
      tokens.push({ tokenId, kind: 'terminator', raw: st.raw, loc });
      if (curLine !== st.line && curLits.length > 0) {
        // 换行后才出现 0：先隐式结束上一子句
        pushClause(false);
      }
      curLine = st.line;
      curTerminator = tokenId;
      pushClause(true);
      continue;
    }

    const tokenId = `${sourceId}.tok#${tokenSeq++}`;
    tokens.push({ tokenId, kind: 'integer', raw: st.raw, loc });
    if (curLine !== st.line) {
      if (curLits.length > 0) pushClause(false);
      curLine = st.line;
      curStartTok = tokens[tokens.length - 1];
    } else if (curStartTok === undefined) {
      curStartTok = tokens[tokens.length - 1];
    }
    curLits.push(value);
    curTokIds.push(tokenId);
    maxVar = Math.max(maxVar, Math.abs(value));
  }
  if (curLits.length > 0) pushClause(false);

  if (header.declaredVars !== undefined && maxVar > header.declaredVars) {
    diagnostics.push({
      code: 'DIMACS_VAR_OVERFLOW',
      severity: 'warning',
      message: `出现变量 ${maxVar} 超过 p cnf 声明上限 ${header.declaredVars}（按语法保留）`,
      rawValue: String(maxVar)
    });
  }

  return { sourceId, clauses, tokens, header, maxVar, diagnostics };
}

export function analyzeLits(lits: number[]): {
  tautology: boolean;
  tautologyVars: number[];
  duplicates: number[];
} {
  const seen = new Map<number, number>();
  const pos = new Set<number>();
  const neg = new Set<number>();
  for (const lit of lits) {
    seen.set(lit, (seen.get(lit) ?? 0) + 1);
    const v = Math.abs(lit);
    if (lit > 0) pos.add(v);
    else neg.add(v);
  }
  const tautologyVars: number[] = [];
  for (const v of pos) if (neg.has(v)) tautologyVars.push(v);
  const duplicates: number[] = [];
  for (const [lit, count] of seen) if (count > 1) duplicates.push(Math.abs(lit));
  return {
    tautology: tautologyVars.length > 0,
    tautologyVars: tautologyVars.sort((a, b) => a - b),
    duplicates: duplicates.sort((a, b) => a - b)
  };
}

export function parseProof(sourceId: string, text: string): ParsedProof {
  const tokens: Token[] = [];
  const lines: ProofLine[] = [];
  const diagnostics: Diagnostic[] = [];
  const rawLines = text.split('\n');
  let tokenSeq = 0;
  let lineIndex = 0;

  rawLines.forEach((rawText, oneBased) => {
    const trimmed = rawText.trim();
    if (trimmed === '' || trimmed.startsWith('c')) {
      // 注释/空行：注释保留为 token
      if (trimmed.startsWith('c')) {
        const start = rawText.indexOf('c');
        tokens.push({
          tokenId: `${sourceId}.tok#${tokenSeq++}`,
          kind: 'comment',
          raw: rawText,
          loc: makeLoc(start, rawText.length, oneBased, start + 1)
        });
      }
      return;
    }
    const parts = rawText.split(/\s+/).filter(Boolean);
    let kind: ProofLine['kind'] = 'addition';
    let nums = parts;
    let deletionMarkTokenId: string | undefined;
    const baseCol = (p: string) => rawText.indexOf(p) + 1;

    if (parts[0] === 'd') {
      kind = 'deletion';
      const idx = rawText.indexOf('d');
      const tok: Token = {
        tokenId: `${sourceId}.tok#${tokenSeq++}`,
        kind: 'deletion-mark',
        raw: 'd',
        loc: makeLoc(idx, idx + 1, oneBased, idx + 1)
      };
      tokens.push(tok);
      deletionMarkTokenId = tok.tokenId;
      nums = parts.slice(1);
    }

    const lits: number[] = [];
    const literalTokenIds: string[] = [];
    let terminatorPresent = false;
    let terminatorTokenId: string | undefined;
    let lineHasGarbage = false;

    nums.forEach((p) => {
      const col = baseCol(p);
      const start = rawText.indexOf(p, col - 1);
      const loc = makeLoc(start, start + p.length, oneBased, col);
      if (!INT_RE.test(p)) {
        tokens.push({ tokenId: `${sourceId}.tok#${tokenSeq++}`, kind: 'garbage', raw: p, loc });
        lineHasGarbage = true;
        diagnostics.push({
          code: 'DRAT_BAD_TOKEN',
          severity: 'error',
          message: `proof 行 ${oneBased} 含无法解析 token “${p}”，保留原位`,
          loc,
          rawValue: p
        });
        return;
      }
      const v = Number(p);
      if (v === 0) {
        const tok = { tokenId: `${sourceId}.tok#${tokenSeq++}`, kind: 'terminator' as const, raw: p, loc };
        tokens.push(tok);
        terminatorPresent = true;
        terminatorTokenId = tok.tokenId;
        return;
      }
      const tok = { tokenId: `${sourceId}.tok#${tokenSeq++}`, kind: 'integer' as const, raw: p, loc };
      tokens.push(tok);
      lits.push(v);
      literalTokenIds.push(tok.tokenId);
    });

    const { tautology, tautologyVars, duplicates } = analyzeLits(lits);
    const lineId = `${sourceId}.line#${lineIndex}`;
    const startOff = rawText.length - rawText.trimStart().length;
    const line: ProofLine = {
      lineId,
      index: qty(lineIndex, 'proof-step'),
      sourceLine: qty(oneBased, 'line'),
      kind,
      lits,
      literalTokenIds,
      deletionMarkTokenId,
      terminatorTokenId,
      terminatorPresent,
      tautology,
      tautologyVars,
      duplicateLiterals: duplicates,
      rawText,
      loc: makeLoc(startOff, rawText.trimEnd().length, oneBased, startOff + 1)
    };
    lines.push(line);

    if (!terminatorPresent) {
      diagnostics.push({
        code: 'DRAT_MISSING_ZERO',
        severity: 'warning',
        message: `proof 行 ${oneBased}（步骤 ${lineIndex}）缺少 0 终止符，按行结束隐式终止`,
        loc: line.loc,
        relatedIds: [lineId]
      });
    }
    if (tautology) {
      diagnostics.push({
        code: 'DRAT_TAUTOLOGY',
        severity: 'info',
        message: `步骤 ${lineIndex} 是 tautology（变量 ${tautologyVars.join(',')}），按语法保留，核验层短路为合法`,
        loc: line.loc,
        relatedIds: [lineId]
      });
    }
    if (duplicates.length) {
      diagnostics.push({
        code: 'DRAT_DUP_LITERAL',
        severity: 'info',
        message: `步骤 ${lineIndex} 含重复 literal（变量 ${duplicates.join(',')}），语法层逐 token 保留`,
        loc: line.loc,
        relatedIds: [lineId]
      });
    }
    if (lineHasGarbage) {
      diagnostics.push({ code: 'DRAT_LINE_HAS_GARBAGE', severity: 'error', message: `步骤 ${lineIndex} 存在非法 token`, relatedIds: [lineId] });
    }
    lineIndex += 1;
  });

  return { sourceId, lines, tokens, diagnostics };
}

/** 派生层：规范化 literal（去重保序）。原始层不受影响。 */
export function canonicalize(lits: number[]): number[] {
  const out: number[] = [];
  for (const lit of lits) if (!out.includes(lit)) out.push(lit);
  return out;
}

export function clauseText(lits: number[], terminator = true): string {
  return lits.join(' ') + (terminator ? ' 0' : '');
}

export type { ClauseSpec, Diagnostic };
