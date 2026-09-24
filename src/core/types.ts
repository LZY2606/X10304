// 领域类型：所有领域量携带单位或坐标基准；原始表示在导入层保留，派生层才规范化。

export interface Quantity {
  value: number | null; // 无法转换时为 null，原值留在 raw
  unit: string;         // 例如 'byte' | 'propagation-step' | 'clause' | '1'
  basis: string;        // 坐标基准，例如 'file-offset-0' | 'dimacs-variable-index'
  raw: string;          // 导入时的原始表示，永不丢失
}

export interface Diagnostic {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  offset?: Quantity;
}

export interface DimacsToken {
  raw: string;
  value: number | null; // 超出安全整数范围时为 null（保留 raw）
  offset: Quantity;
  line: number;
  col: number;
}

export interface ParsedClause {
  id: string; // 稳定身份：来源名 + 偏移 + 原文 的内容寻址哈希
  lits: number[];
  rawTokens: DimacsToken[];
  offset: Quantity;
  line: number;
  zeroTerminated: boolean;
  diagnostics: Diagnostic[];
}

export interface CnfParse {
  sourceName: string;
  header: { vars: Quantity; clauses: Quantity; raw: string; offset: Quantity } | null;
  comments: { raw: string; offset: Quantity }[];
  clauses: ParsedClause[];
  diagnostics: Diagnostic[];
}

export interface ProofLine {
  id: string;
  index: number;
  kind: 'add' | 'delete';
  lits: number[];
  rawTokens: DimacsToken[];
  raw: string;
  offset: Quantity;
  line: number;
  zeroTerminated: boolean;
  diagnostics: Diagnostic[];
}

export interface ProofParse {
  sourceName: string;
  lines: ProofLine[];
  diagnostics: Diagnostic[];
}

export type CheckStatus = 'ok' | 'diagnostic' | 'failed' | 'exhausted' | 'inconclusive';

export interface PropStep {
  lit: number;
  reasonClauseKey: string | null; // null 表示假设（被否定子句的 literal）
  assignment: Record<string, boolean>;
}

export interface CheckEvent {
  id: string; // 稳定身份：内容寻址
  step: number; // proof 行序号，-1 表示全局
  kind: 'syntax' | 'add_clause' | 'delete_clause' | 'rup_check' | 'rat_check' | 'budget' | 'verdict';
  status: CheckStatus;
  summary: string;
  details: Record<string, unknown>;
}

export interface ClauseEntry { key: string; count: number; clauseIds: string[] }

export interface StepResult {
  lineIndex: number;
  lineId: string;
  kind: 'add' | 'delete';
  lits: number[];
  clauseKey: string;
  status: CheckStatus;
  events: CheckEvent[];
  pivot: number | null;
  pivotCandidates: { pivot: number; ok: boolean; resolvents: { withClause: string; resolvent: number[]; rup: string }[] }[];
  propagation: PropStep[];
  propagationsUsed: number;
  activeAfter: ClauseEntry[]; // 该步之后的活跃子句多重集
}

export interface CheckResult {
  params: { budget: Quantity };
  initialActive: ClauseEntry[]; // proof 开始前的 CNF 多重集快照
  steps: StepResult[];
  events: CheckEvent[];
  verdict: 'verified' | 'failed' | 'inconclusive_resource';
  failingPrefix: number | null; // 最短失败前缀长度（proof 行数）
  emptyClauseDerived: boolean;
}
