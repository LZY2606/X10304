/**
 * 领域核心类型。所有领域量在需要时携带单位/坐标基准：
 *  - offset: 源文本字符偏移（0-based char offset）
 *  - line/col: 1-based
 *  - 变量编号: DIMACS 无单位整数（dimensionless index）
 *  - 资源预算: 每次检查允许的 unit propagation 步数
 */

export interface UnitMeta {
  offset: string;
  line: string;
  column: string;
  variable: string;
  budget: string;
}

export interface Diagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  offset?: number;
  endOffset?: number;
  refId?: string;
}

export interface RawToken {
  text: string;
  offset: number;
  line: number;
  col: number;
}

export interface ParsedClause {
  stableId: string;
  origin: 'cnf' | 'proof';
  rawLits: number[];
  normLits: number[];
  isTautology: boolean;
  hasDuplicateLits: boolean;
  missingTerminator: boolean;
  tokenStart: number;
  tokenEnd: number;
  endLine: number;
  oversizedVars: number[];
}

export interface CnfParseResult {
  declaredVars: number | null;
  declaredClauses: number | null;
  headerPresent: boolean;
  clauses: ParsedClause[];
  tokens: RawToken[];
  comments: { text: string; offset: number; line: number }[];
  diagnostics: Diagnostic[];
}

export interface ProofLine {
  stableId: string;
  index: number;
  kind: 'addition' | 'deletion';
  rawLits: number[];
  normLits: number[];
  isTautology: boolean;
  hasDuplicateLits: boolean;
  missingTerminator: boolean;
  tokenStart: number;
  tokenEnd: number;
  lineNo: number;
  rawText: string;
}

export interface ProofParseResult {
  lines: ProofLine[];
  tokens: RawToken[];
  comments: { text: string; offset: number; line: number }[];
  diagnostics: Diagnostic[];
}
