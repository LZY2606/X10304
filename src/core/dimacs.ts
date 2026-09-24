// DIMACS CNF 解析：保留原始 token、变量编号、子句多重集所需的全部信息与解析偏移。
import type { CnfParse, Diagnostic, DimacsToken, ParsedClause } from './types';
import { offsetQty, qty, varQty } from './normalize';
import { stableId } from './id';

interface RawTok { raw: string; offset: number; line: number; col: number }

function lex(text: string): { toks: RawTok[]; comments: { raw: string; offset: number }[]; header: RawTok[] | null } {
  const toks: RawTok[] = [];
  const comments: { raw: string; offset: number }[] = [];
  let header: RawTok[] | null = null;
  let i = 0, line = 1, lineStart = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '\n') { line++; i++; lineStart = i; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === 'c' && (i === lineStart)) {
      const start = i;
      while (i < n && text[i] !== '\n') i++;
      comments.push({ raw: text.slice(start, i), offset: start });
      continue;
    }
    if (ch === 'p' && i === lineStart) {
      const start = i;
      while (i < n && text[i] !== '\n') i++;
      header = [];
      const parts = text.slice(start, i).trim().split(/\s+/);
      let off = start;
      for (const p of parts) {
        const at = text.indexOf(p, off);
        header.push({ raw: p, offset: at, line, col: at - lineStart + 1 });
        off = at + p.length;
      }
      continue;
    }
    // 数字 token（允许带符号）
    const start = i;
    while (i < n && !' \t\r\n'.includes(text[i])) i++;
    toks.push({ raw: text.slice(start, i), offset: start, line, col: start - lineStart + 1 });
  }
  return { toks, comments, header };
}

function toToken(t: RawTok): { tok: DimacsToken; diag?: Diagnostic } {
  const { q, diag } = varQty(t.raw);
  return { tok: { raw: t.raw, value: q.value, offset: offsetQty(t.offset), line: t.line, col: t.col }, diag };
}

export function parseCnf(sourceName: string, text: string): CnfParse {
  const { toks, comments, header } = lex(text);
  const diagnostics: Diagnostic[] = [];
  const clauses: ParsedClause[] = [];
  let hdr: CnfParse['header'] = null;
  if (header && header.length >= 4 && header[0].raw === 'p' && header[1].raw === 'cnf') {
    const v = varQty(header[2].raw);
    const c = varQty(header[3].raw);
    if (v.diag) diagnostics.push(v.diag);
    if (c.diag) diagnostics.push(c.diag);
    hdr = {
      vars: v.q, clauses: c.q,
      raw: header.map(h => h.raw).join(' '),
      offset: offsetQty(header[0].offset),
    };
  } else {
    diagnostics.push({ code: 'missing_header', message: '缺少 p cnf 头，变量上界未知', severity: 'warning' });
  }

  let cur: { toks: DimacsToken[]; diags: Diagnostic[]; start: RawTok } | null = null;
  const declaredVars = hdr?.vars.value ?? null;
  const finish = (zeroTerminated: boolean) => {
    if (!cur) return;
    const lits: number[] = [];
    for (const t of cur.toks) if (t.value !== null && t.value !== 0) lits.push(t.value);
    const id = stableId(sourceName, cur.start.offset, cur.toks.map(t => t.raw).join(' '));
    clauses.push({
      id, lits, rawTokens: cur.toks,
      offset: offsetQty(cur.start.offset), line: cur.start.line,
      zeroTerminated, diagnostics: cur.diags,
    });
    cur = null;
  };

  for (const t of toks) {
    const { tok, diag } = toToken(t);
    const diags: Diagnostic[] = [];
    if (diag) diags.push(diag);
    if (tok.value !== null && declaredVars !== null && Math.abs(tok.value) > declaredVars && tok.value !== 0) {
      diags.push({
        code: 'variable_exceeds_declared',
        message: `变量 ${tok.raw} 超过头部声明的 ${declaredVars}，按语法保留并记录诊断`,
        severity: 'warning',
      });
    }
    if (!cur) cur = { toks: [], diags: [], start: t };
    cur.toks.push(tok);
    cur.diags.push(...diags);
    if (tok.value === 0) finish(true);
  }
  if (cur) {
    cur.diags.push({
      code: 'missing_zero_terminator',
      message: '子句缺少 0 终止符，按语法在 EOF 处封闭并记录诊断',
      severity: 'warning',
    });
    finish(false);
  }
  return {
    sourceName, header: hdr,
    comments: comments.map(c => ({ raw: c.raw, offset: offsetQty(c.offset) })),
    clauses, diagnostics,
  };
}

// 子句多重集键：派生层规范化（去重、排序），原始 token 仍保留在 ParsedClause 上。
export function clauseKey(lits: number[]): string {
  const set = new Set<number>();
  for (const l of lits) set.add(l);
  return [...set].sort((a, b) => Math.abs(a) - Math.abs(b) || a - b).join(',');
}

export function isTautology(lits: number[]): boolean {
  const s = new Set(lits);
  for (const l of lits) if (s.has(-l)) return true;
  return false;
}

export function hasDuplicateLits(lits: number[]): boolean {
  return new Set(lits).size !== lits.length;
}
