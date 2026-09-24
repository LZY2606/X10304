/**
 * 领域量与原始表示。
 *
 * 原则：导入时保留原始表示（raw），派生层才做规范化（normalized）。
 * 无法转换的值留在原位置并附诊断（diagnostics），不能为了画图而丢掉。
 * 所有领域量携带单位或坐标基准。
 */

import type { Coords, Id } from './id.js';

/** 带单位/基准与原始表示的标量。 */
export interface DomainScalar<V> {
  /** 原始词法表示，例如 "3"、"007"、"-12"。 */
  raw: string;
  /** 规范化后的解析值；无法转换时为 null，诊断挂在所在 token/行上。 */
  normalized: V | null;
  /** 坐标基准。 */
  coords: Coords;
  /** 量纲/语义角色，例如 "literal"、"var"、"resolution-offset"。 */
  unit: string;
}

export interface Token extends DomainScalar<number> {
  id: Id;
  kind: 'integer' | 'garbage';
  /** 原始 token 文本。raw 与文本一致。 */
  text: string;
}

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  id: Id;
  severity: Severity;
  code:
    | 'GARBAGE_INTEGER'
    | 'CLAUSE_WITHOUT_ZERO'
    | 'ZERO_IN_HEADER'
    | 'BAD_HEADER'
    | 'VAR_OUT_OF_RANGE'
    | 'RESOLUTION_OFFSET_OUT_OF_RANGE'
    | 'DELETE_UNIT_LINE'
    | 'RAT_HINT_ZERO_MISSING'
    | 'RAT_HINT_UNRESOLVED'
    | 'RESOLVENT_NOT_EMPTY'
    | 'DUPLICATE_LITERAL'
    | 'TAUTOLOGY_CLAUSE'
    | 'DUPLICATE_CLAUSE'
    | 'DELETE_NOT_PRESENT'
    | 'RUP_FAILED'
    | 'RAT_FAILED'
    | 'BUDGET_EXHAUSTED'
    | 'EMPTY_FORMULA'
    | 'HINT_ZERO_MISSING'
    | 'PROPAGATION_BUDGET_EXCEEDED';
  message: string;
  /** 受影响对象（token id / 行 id / 子句实例 id），供界面“从异常点进入来源链”。 */
  subjectId: Id;
  coords: Coords;
}

/** 逻辑文字：非零带符号整数；单位 = signed variable id，基准 = 头声明 numVars。 */
export type Lit = number;
export function litVar(l: Lit): number {
  return Math.abs(l);
}
export function litNeg(l: Lit): Lit {
  return -l as Lit;
}

export interface RawClause {
  id: Id;
  source: string;
  /** 1-based 行号。 */
  lineNo: number;
  /** 原始行文本（去掉行终止符）。 */
  rawText: string;
  /** 原 DIMACS token 的有序引用（保留重复 literal 与原始表示）。 */
  tokenIds: Id[];
  /** 派生：文字视图，解析失败的位置为 null（留在原位置）。 */
  literals: Array<number | null>;
  /** 行是否以零终止（语法事实，不自动补救）。 */
  zeroTerminated: boolean;
  coords: Coords;
}

/** 变量编号登记：保留原始 token 与规范化编号。 */
export interface VarRecord {
  id: Id;
  var: number;
  /** 第一次出现的 token。 */
  introducedByToken: Id;
  firstSeenClause: Id;
}

export interface CnfDocument {
  id: Id;
  source: string;
  rawText: string;
  /** 全部原始 token（含头部），按物理顺序。 */
  tokens: Token[];
  header: {
    present: boolean;
    pLine: string | null;
    /** 声明变量数；单位 = 变量编号上界。 */
    numVarsRaw: string | null;
    numVars: number | null;
    numClausesRaw: string | null;
    numClauses: number | null;
  };
  clauses: RawClause[];
  variables: VarRecord[];
  diagnostics: Diagnostic[];
}
