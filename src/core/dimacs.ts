import { stableId } from './ids.js';

/** Diagnostics are machine-readable; `unit`/`basis` give the coordinate base of domain quantities. */
export interface Diagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  offsetBytes?: number; // unit: byte
  line?: number;        // basis: 1-based line in source text
  tokenRaw?: string;
}

export interface DimacsToken {
  index: number;
  raw: string;            // original representation, never normalized away
  value: number | null;   // null when not a safe integer
  offsetBytes: number;    // unit: byte
  line: number;
  col: number;
  kind: 'int' | 'word';
}

export interface ClauseSyntax {
  tautology: boolean;
  duplicateLits: number[];
  zeroTerminated: boolean;
  hugeLiterals: string[]; // raw tokens beyond int32 DIMACS range
}

export interface ClauseRecord {
  id: string;          // stable identity: content + occurrence index
  occurrence: number;  // multiset occurrence of the same normalized key
  lits: number[];      // as parsed, duplicates kept
  key: string;         // normalized multiset key (sorted, multiplicity kept)
  rawText: string;
  offsetBytes: number; // unit: byte
  line: number;
  syntax: ClauseSyntax;
}

export interface DimacsParse {
  kind: 'cnf';
  sourceName: string;
  text: string;
  header: { raw: string; vars: number | null; clauses: number | null; offsetBytes: number; line: number } | null;
  tokens: DimacsToken[];
  clauses: ClauseRecord[];
  diagnostics: Diagnostic[];
  maxVar: number;
  declaredVars: number | null;
}

export const INT32_MAX = 2147483647;

export function clauseKey(lits: number[]): string {
  return [...lits].sort((a, b) => a - b).join(',');
}

export function analyzeClauseSyntax(lits: number[], zeroTerminated: boolean, hugeRaw: string[]): ClauseSyntax {
  const seen = new Set<number>();
  const duplicateLits: number[] = [];
  let tautology = false;
  for (const lit of lits) {
    if (seen.has(-lit)) tautology = true;
    if (seen.has(lit) && !duplicateLits.includes(lit)) duplicateLits.push(lit);
    seen.add(lit);
  }
  return { tautology, duplicateLits, zeroTerminated, hugeLiterals: hugeRaw };
}

interface ScanToken { raw: string; offsetBytes: number; line: number; col: number }

function scanTokens(text: string): { tokens: ScanToken[]; comments: { raw: string; offsetBytes: number; line: number }[] } {
  const tokens: ScanToken[] = [];
  const comments: { raw: string; offsetBytes: number; line: number }[] = [];
  let i = 0, line = 1, col = 1, offsetBytes = 0;
  const advance = (ch: string) => {
    offsetBytes += Buffer.byteLength(ch, 'utf8');
    if (ch === '\n') { line += 1; col = 1; } else { col += 1; }
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === 'c' && (i === 0 || text[i - 1] === '\n')) {
      const start = offsetBytes, startLine = line;
      let raw = '';
      while (i < text.length && text[i] !== '\n') { raw += text[i]; advance(text[i]); i++; }
      comments.push({ raw, offsetBytes: start, line: startLine });
      continue;
    }
    if (/\s/.test(ch)) { advance(ch); i++; continue; }
    const start = offsetBytes, startLine = line, startCol = col;
    let raw = '';
    while (i < text.length && !/\s/.test(text[i])) { raw += text[i]; advance(text[i]); i++; }
    tokens.push({ raw, offsetBytes: start, line: startLine, col: startCol });
  }
  return { tokens, comments };
}

function toInt(raw: string): number | null {
  if (!/^[+-]?\d+$/.test(raw)) return null;
  const v = Number(raw);
  return Number.isSafeInteger(v) ? v : null;
}

export function parseDimacs(text: string, sourceName = '<input>'): DimacsParse {
  const diagnostics: Diagnostic[] = [];
  const { tokens: scanned } = scanTokens(text);
  const tokens: DimacsToken[] = [];
  const clauses: ClauseRecord[] = [];
  let header: DimacsParse['header'] = null;
  let maxVar = 0;
  let declaredVars: number | null = null;
  let declaredClauses: number | null = null;

  let idx = 0;
  // header: p cnf <vars> <clauses>
  if (scanned.length > 0 && scanned[0].raw === 'p') {
    const h = scanned[0];
    const vars = scanned[1] ? toInt(scanned[1].raw) : null;
    const kind = scanned[1]?.raw === 'cnf' ? 2 : 1;
    const vTok = scanned[kind], cTok = scanned[kind + 1];
    declaredVars = vTok ? toInt(vTok.raw) : null;
    declaredClauses = cTok ? toInt(cTok.raw) : null;
    header = { raw: scanned.slice(0, kind + 2).map((t) => t.raw).join(' '), vars: declaredVars, clauses: declaredClauses, offsetBytes: h.offsetBytes, line: h.line };
    idx = kind + 2;
    if (scanned[1]?.raw !== 'cnf') {
      diagnostics.push({ code: 'header_not_cnf', severity: 'warning', message: `header kind is "${scanned[1]?.raw ?? ''}", expected cnf`, offsetBytes: h.offsetBytes, line: h.line });
    }
    void vars;
  }

  let curLits: number[] = [];
  let curHuge: string[] = [];
  let curStart: ScanToken | null = null;
  let curRaw: string[] = [];
  const occurrenceCount = new Map<string, number>();

  const flushClause = (zeroTerminated: boolean) => {
    if (curLits.length === 0 && curRaw.length === 0 && zeroTerminated) return;
    const syntax = analyzeClauseSyntax(curLits, zeroTerminated, curHuge);
    const key = clauseKey(curLits);
    const occurrence = occurrenceCount.get(key) ?? 0;
    occurrenceCount.set(key, occurrence + 1);
    const id = stableId('cls', { source: 'dimacs', key, occurrence });
    clauses.push({
      id, occurrence, lits: [...curLits], key,
      rawText: curRaw.join(' '),
      offsetBytes: curStart ? curStart.offsetBytes : 0,
      line: curStart ? curStart.line : 1,
      syntax,
    });
    if (syntax.tautology) diagnostics.push({ code: 'tautology_clause', severity: 'info', message: `clause [${curLits.join(' ')}] is a tautology (syntactic)`, offsetBytes: curStart?.offsetBytes, line: curStart?.line });
    for (const d of syntax.duplicateLits) diagnostics.push({ code: 'duplicate_literal', severity: 'info', message: `literal ${d} repeated in clause (syntactic)`, offsetBytes: curStart?.offsetBytes, line: curStart?.line });
    if (!zeroTerminated) diagnostics.push({ code: 'missing_zero_terminator', severity: 'error', message: 'clause run reached end of input without terminating 0', offsetBytes: curStart?.offsetBytes, line: curStart?.line });
    curLits = []; curHuge = []; curStart = null; curRaw = [];
  };

  for (; idx < scanned.length; idx++) {
    const t = scanned[idx];
    const value = toInt(t.raw);
    tokens.push({ index: tokens.length, raw: t.raw, value, offsetBytes: t.offsetBytes, line: t.line, col: t.col, kind: value === null ? 'word' : 'int' });
    if (value === null) {
      if (t.raw === '%') { flushClause(false); break; }
      diagnostics.push({ code: 'non_integer_token', severity: 'error', message: `token "${t.raw}" is not an integer; left in place`, offsetBytes: t.offsetBytes, line: t.line, tokenRaw: t.raw });
      continue;
    }
    if (value === 0) { flushClause(true); continue; }
    if (!curStart) curStart = t;
    curRaw.push(t.raw);
    if (Math.abs(value) > INT32_MAX) {
      curHuge.push(t.raw);
      diagnostics.push({ code: 'huge_variable_id', severity: 'warning', message: `variable id ${t.raw} exceeds int32 DIMACS range; raw token preserved`, offsetBytes: t.offsetBytes, line: t.line, tokenRaw: t.raw });
    }
    curLits.push(value);
    if (Math.abs(value) > maxVar) maxVar = Math.abs(value);
  }
  if (curLits.length > 0 || curRaw.length > 0) flushClause(false);

  if (declaredClauses !== null && declaredClauses !== clauses.length) {
    diagnostics.push({ code: 'header_clause_count_mismatch', severity: 'warning', message: `header declares ${declaredClauses} clauses, parsed ${clauses.length}`, line: header?.line });
  }
  if (declaredVars !== null && maxVar > declaredVars) {
    diagnostics.push({ code: 'header_var_count_mismatch', severity: 'warning', message: `header declares ${declaredVars} vars, max var seen ${maxVar}`, line: header?.line });
  }

  return { kind: 'cnf', sourceName, text, header, tokens, clauses, diagnostics, maxVar, declaredVars };
}
