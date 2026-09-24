/**
 * 领域模型：DIMACS CNF + DRAT 证明核验。
 *
 * 设计原则：
 *  - 导入层只保留原始表示（raw token、偏移、编号），规范化只发生在派生层。
 *  - 所有量携带单位/坐标基准（见 Qty 与 Location）。
 *  - 多解/不确定不坍缩：RAT pivot 候选、传播候选、删除目标全部保留。
 */

/** 带单位的量。value 永远是数值，unit 标明坐标基准，禁止裸数字跨层传递。 */
export interface Qty {
  value: number;
  unit: string;
}

/** 原文坐标：基于导入文本的字符偏移（codePoint 计数，unit: char-offset）。 */
export interface Location {
  startOffset: Qty; // char-offset
  endOffset: Qty;   // char-offset，半开区间
  line: Qty;        // 1-based 行号 unit: line
  col: Qty;         // 1-based 列 unit: column
}

export type TokenKind =
  | 'comment'       // c 开头整行（保留原文，不参与语法）
  | 'p-header'      // p cnf n m
  | 'integer'       // 有符号整数（literal / 头字段）
  | 'terminator'    // 0
  | 'deletion-mark' // 行首 'd'
  | 'garbage';      // 无法解析的 token，留在原位附诊断

export interface Token {
  tokenId: string;   // 稳定身份：cnf.tok#<序号> / prf.tok#<序号>
  kind: TokenKind;
  raw: string;
  loc: Location;
}

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code: string;              // 例如 DRAT_MISSING_ZERO
  severity: Severity;
  message: string;
  loc?: Location;
  relatedIds?: string[];     // 受影响对象（token/子句/proof 行）
  /** 无法转换的值保留原值时，记录原始表示。 */
  rawValue?: string;
}

/** DIMACS 变量编号：1-based，坐标基准 dimacs-var-1based。 */
export interface VarRef {
  num: number;
  basis: 'dimacs-var-1based';
}

/** 子句的语法记录（导入层，不做语义增删）。 */
export interface ClauseSpec {
  clauseId: string;          // cnf.cl#<idx> / prf.cl#<lineIdx>
  origin: 'cnf' | 'proof';
  originLine: Qty;           // 来源行号
  lits: number[];            // 规范化后的 literal（派生层可见，导入层仍以 token 为准）
  literalTokenIds: string[]; // 与 lits 等长（重复 literal 也逐一保留）
  terminatorTokenId?: string;
  /** 语法性质（按语法处理，不提前当语义错误）。 */
  tautology: boolean;        // 同时含 x 与 -x
  tautologyVars?: number[];
  duplicateLiterals: number[]; // 出现 >1 次的变量编号（绝对值）
  activeTokenCount: Qty;
}

export interface CnfHeader {
  declaredVars?: number;     // p cnf n m 中的 n；缺头时为 undefined
  declaredClauses?: number;
  headerTokenIds: string[];
}

export interface ParsedCnf {
  sourceId: string;
  clauses: ClauseSpec[];
  tokens: Token[];
  header: CnfHeader;
  maxVar: number;
  diagnostics: Diagnostic[];
}

export type ProofLineKind = 'addition' | 'deletion';

export interface ProofLine {
  lineId: string;            // prf.line#<idx>
  index: Qty;                // 0-based 证明行序号 unit: proof-step
  sourceLine: Qty;           // 在 proof 文本中的 1-based 行号
  kind: ProofLineKind;
  lits: number[];
  literalTokenIds: string[];
  deletionMarkTokenId?: string;
  terminatorTokenId?: string;
  terminatorPresent: boolean;
  tautology: boolean;
  tautologyVars?: number[];
  duplicateLiterals: number[];
  rawText: string;
  loc: Location;
}

export interface ParsedProof {
  sourceId: string;
  lines: ProofLine[];
  tokens: Token[];
  diagnostics: Diagnostic[];
}

/** 活跃多重集中的一个子句实例。重复子句各有独立 instanceId。 */
export interface ActiveClause {
  instanceId: string;        // act.<clauseId>#<dup>
  specId: string;            // 指向 ClauseSpec / ProofLine 派生 spec
  lits: number[];
  introducedAt: number;      // proof step；初始子句为 -1
  multiplicity: Qty;         // unit: clause-copy，多重集计数
  tautology: boolean;
}

/** 单位传播中的一步赋值与理由（含解析偏移）。 */
export interface PropStep {
  stepNo: Qty;               // unit: prop-step
  literal: number;
  reasonClauseId: string;    // 活跃子句 instanceId
  /** 被理由子句传播的 literal 在该子句规范化 literal 数组中的偏移（0-based）。 */
  pivotOffsetInReason: Qty;  // unit: lit-index
  decisionLevel: Qty;        // unit: dl
}

/** 一次解析链：从假设到空子句（冲突）。 */
export interface ResolutionChain {
  chainId: string;
  steps: PropStep[];
  conflictClauseId: string;
  /** 解析偏移序列：每一步与当前预解式在 pivot 上的偏移（unit: lit-index）。 */
  resolutionOffsets: Qty[];
  resolventTrace: number[][]; // 每步预解式 literal 序列，供界面回读
}

export interface BudgetCounters {
  propagationSteps: number;  // unit: prop-step
  clauseVisits: number;      // unit: clause-visit
}

export interface Budget {
  maxPropagationSteps: number;
  maxClauseVisits: number;
  counters: BudgetCounters;
  exhausted: boolean;
  exhaustedOn?: string;
}

/** RUP：假设 C 中 literal 全为假后，单位传播导出空。 */
export interface RupCheck {
  kind: 'RUP';
  satisfied: boolean;       // true=空冲突到达
  chain?: ResolutionChain;
  budget: BudgetCounters;
  budgetExhausted: boolean;
}

export interface RatCandidate {
  pivot: number;             // RAT pivot literal
  pivotOffset: Qty;          // 在新增子句中的偏移 unit: lit-index
  negWitnessInstanceId?: string; // 含 ¬pivot 的活跃子句；undefined 表示无此子句（自动满足）
  satisfied: boolean;        // RUP((C \ {p}) ∪ (D \ {-p}))
  chain?: ResolutionChain;
  budget: BudgetCounters;
  budgetExhausted: boolean;
}

/** RAT：对每个 pivot 保留一个候选；无法唯一决定时全部保留。 */
export interface RatCheck {
  kind: 'RAT';
  candidates: RatCandidate[]; // 与新增子句非 tautology literal 一一对应
}

export type ClauseCheck = RupCheck | RatCheck;
export type CheckMode = 'RUP' | 'RAT';

export type LineStatus =
  | 'accepted'       // 核验通过（RUP 或存在 RAT pivot 合法）
  | 'rejected'       // 明确非法
  | 'inconclusive';  // 预算耗尽等：不是证明无效

export interface LineResult {
  lineId: string;
  step: number;
  mode: CheckMode;
  status: LineStatus;
  check: ClauseCheck;
  /** 被采纳的 pivot（仅 RAT 且可唯一/裁定选择时）。 */
  adoptedPivot?: number;
  /** 该步推导依赖的活跃子句 instanceId 集合（依赖图边）。 */
  dependencies: string[];
  /** 删除操作：多重集中全部匹配实例都保留为候选。 */
  deletionTargets?: string[];
  activeClauseBefore: string[];   // instanceId 快照（稳定身份）
  activeClauseAfter: string[];
  budgetBefore: BudgetCounters;
  budgetAfter: BudgetCounters;
  budgetExhausted: boolean;
  diagnostics: Diagnostic[];
}

export interface VerificationResult {
  ruleSetId: string;
  params: VerifierParams;
  lineResults: LineResult[];
  /** 最短失败前缀：第一个非 accepted 行的步长；全部通过为 undefined。 */
  shortestFailingPrefix?: number;
  finalEmptyClause: boolean;
  finalStatus: LineStatus;
  diagnostics: Diagnostic[];
}

export interface VerifierParams {
  /** 严格变量上限：'header' 使用 p cnf 声明值；'none' 不限制（默认，只产生诊断）。 */
  varBound: 'header' | 'none';
  /** 缺零终止：'diagnostic'（默认，仍解析）或 'error'。 */
  missingZero: 'diagnostic' | 'error';
  /** 传播/访问预算。 */
  maxPropagationSteps: number;
  maxClauseVisits: number;
}

export const DEFAULT_PARAMS: VerifierParams = {
  varBound: 'none',
  missingZero: 'diagnostic',
  maxPropagationSteps: 10000,
  maxClauseVisits: 50000
};

/** 机器可读取事件。所有界面显示值都由事件携带稳定身份回读。 */
export type EventType =
  | 'source.imported'
  | 'source.revised'
  | 'params.revised'
  | 'line.checked'
  | 'clause.activated'
  | 'clause.deleted'
  | 'delete.missing'
  | 'syntax.flag'
  | 'budget.exhausted'
  | 'verdict.produced'
  | 'decision.accept'
  | 'decision.reject'
  | 'decision.param'
  | 'branch.selected'
  | 'candidate.retained';

export interface DeskEvent {
  eventId: string;
  caseId: string;
  versionId: string;
  seq: number;
  type: EventType;
  at: string; // ISO
  /** 本事件依赖的前序事件（依赖图）。 */
  parentEventIds: string[];
  actor: 'system' | 'reviewer:a' | 'reviewer:b';
  payload: unknown;
  relatedIds?: string[];
}
