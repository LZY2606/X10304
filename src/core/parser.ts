import {
  CnfDocument,
  ParseDiagnostic,
  ParsedClause,
  ProofDocument,
  ProofLineData,
  TokenSpan,
} from './types.js';
import { clauseRef } from './ids.js';

/** Byte offsets (Buffer-like on UTF-8 source). Source is assumed ASCII DIMACS. */
function byteLength(s: string): number {
  let n = 0;
  for (const ch of s) n += ch.charCodeAt(0) > 255 ? Buffer.from(ch).length : 1;
  return n;
}

interface RawToken extends TokenSpan {
  numeric?: number;
}

/** Tokenize CNF preserving comments, header, integers and offsets. */
export function tokenizeCnf(source: string): { tokens: RawToken[]; diagnostics: ParseDiagnostic[] } {
  const tokens: RawToken[] = [];
  const diagnostics: ParseDiagnostic[] = [];
  let pos = 0;
  let line = 1;
  let lineStart = 0;

  const push = (text: string, kind: TokenSpan['kind'], start: number, numeric?: number) => {
    tokens.push({
      text,
      kind,
      startByte: start,
      endByte: start + byteLength(text),
      line,
      col: start - lineStart + 1,
      ...(numeric === undefined ? {} : { numeric }),
    });
  };

  while (pos < source.length) {
    const ch = source[pos];
    if (ch === '\n') {
      line++;
      lineStart = pos + 1;
      pos++;
      continue;
    }
    if (/\s/.test(ch)) {
      pos++;
      continue;
    }
    const start = pos;
    if (ch === 'c') {
      // comment to end of line (only at token start)
      while (pos < source.length && source[pos] !== '\n') pos++;
      push(source.slice(start, pos), 'comment', start);
      continue;
    }
    if (ch === 'p') {
      while (pos < source.length && source[pos] !== '\n') pos++;
      push(source.slice(start, pos), 'header', start);
      continue;
    }
    if (/[+-]?\d/.test(ch) || ch === '-') {
      while (pos < source.length && /\S/.test(source[pos])) pos++;
      const text = source.slice(start, pos);
      if (/^[+-]?\d+$/.test(text)) {
        push(text, 'integer', start, Number(text));
      } else {
        push(text, 'garbage', start);
        diagnostics.push({
          code: 'NON_INTEGER_TOKEN',
          severity: 'error',
          message: `token "${text}" is not an integer`,
          line,
          startByte: start,
          endByte: pos,
        });
      }
      continue;
    }
    while (pos < source.length && /\S/.test(source[pos])) pos++;
    push(source.slice(start, pos), 'garbage', start);
  }
  return { tokens, diagnostics };
}

function analyzeClause(
  sourceIndex: number,
  rawLiterals: number[],
  startByte: number,
  endByte: number,
  lineStart: number,
  lineEnd: number,
): { clause: ParsedClause; duplicateLits: number[]; tautology: boolean } {
  const counts = new Map<number, number>();
  for (const lit of rawLiterals) counts.set(lit, (counts.get(lit) ?? 0) + 1);
  const duplicates = [...counts].filter(([, n]) => n > 1).map(([l]) => l);
  const sign = new Set<number>();
  let tautology = false;
  for (const lit of rawLiterals) {
    if (sign.has(-lit)) tautology = true;
    sign.add(lit);
  }
  const normalizedLiterals = [...new Set(rawLiterals)].sort((a, b) => a - b);
  const clause: ParsedClause = {
    ref: clauseRef(sourceIndex, normalizedLiterals),
    sourceIndex,
    rawLiterals,
    normalizedLiterals,
    duplicates,
    tautology,
    startByte,
    endByte,
    lineStart,
    lineEnd,
  };
  return { clause, duplicateLits: duplicates, tautology };
}

export function parseCnf(source: string): CnfDocument {
  const { tokens, diagnostics } = tokenizeCnf(source);
  let declaredVariables: number | null = null;
  let maxVariableSeen = 0;

  const dataTokens = tokens.filter((t) => t.kind === 'integer' || t.kind === 'garbage');
  let cursor = 0;
  for (const tok of tokens) {
    if (tok.kind !== 'header') continue;
    const parts = tok.text.trim().split(/\s+/);
    if (parts[0] === 'p' && parts[1] === 'cnf') {
      const n = Number(parts[2]);
      const m = Number(parts[3]);
      if (Number.isInteger(n) && Number.isInteger(m)) declaredVariables = n;
      else
        diagnostics.push({
          code: 'BAD_HEADER',
          severity: 'error',
          message: `malformed header "${tok.text.trim()}"`,
          line: tok.line,
          startByte: tok.startByte,
          endByte: tok.endByte,
        });
    }
  }

  const clauses: ParsedClause[] = [];
  let cur: number[] = [];
  let clauseStart = -1;
  let clauseLineStart = 0;
  let clauseLineEnd = 0;
  let pendingNonTerminated = false;

  for (const tok of dataTokens) {
    const v = tok.numeric!;
    if (cur.length === 0) clauseStart = tok.startByte;
    clauseLineEnd = tok.line;
    if (clauseLineStart === 0 || cur.length === 0) clauseLineStart = tok.line;
    if (v === 0) {
      const end = tok.endByte;
      const { clause, duplicateLits } = analyzeClause(
        clauses.length,
        cur,
        clauseStart,
        end,
        clauseLineStart,
        clauseLineEnd,
      );
      clauses.push(clause);
      for (const dl of duplicateLits)
        diagnostics.push({
          code: 'DUPLICATE_LITERAL',
          severity: 'warning',
          message: `literal ${dl} repeated in clause ${clause.sourceIndex} (kept verbatim, normalized away)`,
          line: clauseLineStart,
          startByte: clauseStart,
          endByte: end,
        });
      cur = [];
      clauseStart = -1;
      clauseLineStart = 0;
      pendingNonTerminated = false;
      continue;
    }
    cur.push(v);
    maxVariableSeen = Math.max(maxVariableSeen, Math.abs(v));
    pendingNonTerminated = true;
  }

  if (pendingNonTerminated && cur.length > 0) {
    const { clause } = analyzeClause(
      clauses.length,
      cur,
      clauseStart,
      dataTokens[dataTokens.length - 1]?.endByte ?? clauseStart,
      clauseLineStart,
      clauseLineEnd,
    );
    clauses.push(clause);
    const lastTok = dataTokens[dataTokens.length - 1];
    diagnostics.push({
      code: 'MISSING_ZERO_TERMINATOR',
      severity: 'error',
      message: `final clause ${clause.sourceIndex} is not terminated by 0; retained in place with diagnostic`,
      line: lastTok?.line ?? 1,
      startByte: clauseStart,
      endByte: lastTok?.endByte ?? clauseStart,
    });
  }

  if (declaredVariables !== null && maxVariableSeen > declaredVariables) {
    const offenders = tokens.filter(
      (t) => t.kind === 'integer' && t.numeric !== 0 && Math.abs(t.numeric!) > declaredVariables!,
    );
    const first = offenders[0];
    diagnostics.push({
      code: 'OVERSIZED_VARIABLE',
      severity: 'error',
      message: `variable ${Math.abs(first?.numeric ?? 0)} exceeds declared n=${declaredVariables}; original token retained, clause not normalized into declared range`,
      line: first?.line ?? 1,
      startByte: first?.startByte ?? 0,
      endByte: first?.endByte ?? 0,
    });
  }

  const seen = new Set<number>();
  const variables: CnfDocument['variables'] = [];
  if (declaredVariables !== null) {
    for (let i = 1; i <= declaredVariables; i++) {
      variables.push({ id: i, basis: 'declared-header' });
      seen.add(i);
    }
  }
  for (let i = 1; i <= maxVariableSeen; i++) {
    if (!seen.has(i)) variables.push({ id: i, basis: 'observed-literal' });
  }
  for (const v of variables) seen.add(v.id);
  if (maxVariableSeen > (declaredVariables ?? 0)) {
    for (let i = (declaredVariables ?? 0) + 1; i <= maxVariableSeen; i++) {
      if (!variables.some((x) => x.id === i))
        variables.push({ id: i, basis: 'observed-literal' });
    }
  }

  const fatal = diagnostics.some((d) => d.severity === 'error');
  return {
    source,
    declaredVariables,
    maxVariableSeen,
    variables: variables.sort((a, b) => a.id - b.id),
    tokens,
    clauses,
    diagnostics,
    parsed: !fatal,
  };
}

/** Parse DRAT proof text. Deletion lines start with "d ". */
export function parseProof(source: string): ProofDocument {
  const diagnostics: ParseDiagnostic[] = [];
  const lines: ProofLineData[] = [];
  const rawLines = source.split('\n');
  let offset = 0;

  rawLines.forEach((raw, li) => {
    const index = li + 1;
    const startByte = offset;
    const trimmed = raw.trim();
    offset += byteLength(raw) + 1;
    if (trimmed === '' || trimmed.startsWith('c')) return;

    let deletion = false;
    let body = trimmed;
    if (body.startsWith('d ')) {
      deletion = true;
      body = body.slice(2).trim();
    } else if (body === 'd') {
      deletion = true;
      body = '';
    }

    const tokens = body.split(/\s+/).filter(Boolean);
    const literals: number[] = [];
    const lineDiags: ParseDiagnostic[] = [];
    let bad = false;
    for (const tok of tokens) {
      if (/^[+-]?\d+$/.test(tok)) literals.push(Number(tok));
      else {
        bad = true;
        lineDiags.push({
          code: 'NON_INTEGER_TOKEN',
          severity: 'error',
          message: `proof line ${index}: token "${tok}" is not an integer`,
          line: index,
          startByte,
          endByte: startByte + byteLength(raw),
        });
      }
    }
    let terminated = false;
    if (literals[literals.length - 1] === 0) {
      terminated = true;
      literals.pop();
    }
    const counts = new Map<number, number>();
    for (const lit of literals) counts.set(lit, (counts.get(lit) ?? 0) + 1);
    const hasDuplicateLiterals = [...counts.values()].some((n) => n > 1);
    const sign = new Set<number>();
    let tautology = false;
    for (const lit of literals) {
      if (sign.has(-lit)) tautology = true;
      sign.add(lit);
    }

    if (!terminated && literals.length >= 0 && !bad) {
      lineDiags.push({
        code: 'MISSING_ZERO_TERMINATOR',
        severity: 'error',
        message: `proof line ${index} missing 0 terminator`,
        line: index,
        startByte,
        endByte: startByte + byteLength(raw),
      });
    }

    lines.push({
      index,
      raw: trimmed,
      startByte,
      endByte: startByte + byteLength(raw),
      deletion,
      literals,
      terminated,
      tautology,
      hasDuplicateLiterals,
      diagnostics: lineDiags,
    });
    diagnostics.push(...lineDiags);
  });

  if (lines.length === 0) {
    diagnostics.push({
      code: 'EMPTY_PROOF',
      severity: 'warning',
      message: 'proof contains no clause lines',
      line: 1,
      startByte: 0,
      endByte: 0,
    });
  }

  return {
    source,
    lines,
    diagnostics,
    parsed: !diagnostics.some((d) => d.severity === 'error'),
  };
}
