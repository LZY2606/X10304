/** Shared domain types. All quantities carry a unit/coordinate basis:
 *  - offsets are byte offsets into the original text ("B")
 *  - budgets are counted in unit-propagation steps ("steps")
 *  - variable ids are DIMACS variable numbers (unitless, 1-based)
 */

export interface Diagnostic {
  code: string;
  message: string;
  offsetB?: number;
  line?: number;
}

export interface Token {
  raw: string;
  value: number;
  offsetB: number;
  line: number;
  col: number;
}

export interface ClauseSyntax {
  isTautology: boolean;
  hasDuplicateLiteral: boolean;
  terminated: boolean;
}

export interface ParsedClause extends ClauseSyntax {
  /** literals exactly as written, duplicates kept, terminator excluded */
  rawLits: number[];
  /** derived layer: sorted, de-duplicated, tautology preserved as-is */
  normalized: number[];
  tokens: Token[];
  startOffsetB: number;
  endOffsetB: number;
}

export interface CnfHeader {
  vars: number;
  clauses: number;
  raw: string;
  offsetB: number;
}

export interface CnfParse {
  kind: 'cnf';
  rawText: string;
  header: CnfHeader | null;
  clauses: ParsedClause[];
  tokens: Token[];
  maxVarDeclared: number | null;
  maxVarSeen: number;
  diagnostics: Diagnostic[];
}

export type ProofLineKind = 'add' | 'delete';

export interface ProofLine {
  id: string;
  index: number;
  kind: ProofLineKind;
  clause: ParsedClause;
  rawText: string;
  offsetB: number;
}

export interface ProofParse {
  kind: 'proof';
  rawText: string;
  lines: ProofLine[];
  diagnostics: Diagnostic[];
}

export interface Budget {
  maxPropagationSteps: number;
}

export const BUDGET_UNIT = 'steps';
export const OFFSET_UNIT = 'B';
