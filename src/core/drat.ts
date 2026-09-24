import { stableId } from './ids.js';
import { analyzeClauseSyntax, clauseKey, ClauseSyntax, Diagnostic, INT32_MAX } from './dimacs.js';

export interface ProofLine {
  index: number;       // 0-based proof line order (preserved across export/import)
  id: string;          // stable identity
  kind: 'add' | 'del';
  lits: number[];
  key: string;
  raw: string;         // raw line text, original representation
  offsetBytes: number; // unit: byte
  line: number;        // basis: 1-based
  syntax: ClauseSyntax;
}

export interface DratParse {
  kind: 'drat';
  sourceName: string;
  text: string;
  lines: ProofLine[];
  diagnostics: Diagnostic[];
}

export function parseDrat(text: string, sourceName = '<proof>'): DratParse {
  const diagnostics: Diagnostic[] = [];
  const lines: ProofLine[] = [];
  let offsetBytes = 0;
  const rawLines = text.split('\n');
  for (let li = 0; li < rawLines.length; li++) {
    const rawLine = rawLines[li];
    const lineNo = li + 1;
    const lineOffset = offsetBytes;
    offsetBytes += Buffer.byteLength(rawLine + '\n', 'utf8');
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('c')) continue;

    let body = trimmed;
    let kind: 'add' | 'del' = 'add';
    if (/^d(\s|$)/.test(body)) { kind = 'del'; body = body.slice(1).trim(); }

    const parts = body.length === 0 ? [] : body.split(/\s+/);
    const lits: number[] = [];
    const huge: string[] = [];
    let zeroTerminated = false;
    let syntaxBroken = false;
    for (const p of parts) {
      if (!/^[+-]?\d+$/.test(p)) {
        diagnostics.push({ code: 'non_integer_token', severity: 'error', message: `proof line ${lineNo}: token "${p}" is not an integer; left in place`, offsetBytes: lineOffset, line: lineNo, tokenRaw: p });
        syntaxBroken = true;
        continue;
      }
      const v = Number(p);
      if (!Number.isSafeInteger(v)) {
        diagnostics.push({ code: 'non_integer_token', severity: 'error', message: `proof line ${lineNo}: token "${p}" is not a safe integer; left in place`, offsetBytes: lineOffset, line: lineNo, tokenRaw: p });
        syntaxBroken = true;
        continue;
      }
      if (v === 0) { zeroTerminated = true; break; }
      if (Math.abs(v) > INT32_MAX) {
        huge.push(p);
        diagnostics.push({ code: 'huge_variable_id', severity: 'warning', message: `proof line ${lineNo}: variable id ${p} exceeds int32 range; raw token preserved`, offsetBytes: lineOffset, line: lineNo, tokenRaw: p });
      }
      lits.push(v);
    }
    if (!zeroTerminated && !syntaxBroken) {
      diagnostics.push({ code: 'missing_zero_terminator', severity: 'error', message: `proof line ${lineNo} has no terminating 0 (syntactic)`, offsetBytes: lineOffset, line: lineNo });
    }
    const syntax = analyzeClauseSyntax(lits, zeroTerminated, huge);
    if (syntax.tautology) diagnostics.push({ code: 'tautology_clause', severity: 'info', message: `proof line ${lineNo}: tautological clause (syntactic)`, offsetBytes: lineOffset, line: lineNo });
    for (const d of syntax.duplicateLits) diagnostics.push({ code: 'duplicate_literal', severity: 'info', message: `proof line ${lineNo}: literal ${d} repeated (syntactic)`, offsetBytes: lineOffset, line: lineNo });

    lines.push({
      index: lines.length,
      id: stableId('pln', { source: 'drat', index: lines.length, kind, key: clauseKey(lits) }),
      kind, lits, key: clauseKey(lits), raw: rawLine,
      offsetBytes: lineOffset, line: lineNo, syntax,
    });
  }
  return { kind: 'drat', sourceName, text, lines, diagnostics };
}
