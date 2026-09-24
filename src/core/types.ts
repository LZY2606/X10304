// 领域类型定义：证明轨迹台（SAT/DRAT 核验）
// 设计原则：导入层只做保真记录（原始 token、坐标、编号、预算），派生层才规范化。

// ---------- 坐标基准与单位 ----------
// 所有位置都带坐标基准：char = Unicode 码位偏移；line/col 从 1 开始。
export interface Coord {
  index: number; // 源文本中的码位偏移（基准：char，0-based）
  line: number;  // 1-based
  col: number;   // 1-based 码位列
}

export type RawTokenKind = 'comment' | 'header' | 'int' | 'zero' | 'unknown';

export interface RawToken {
  id: string;
  kind: RawTokenKind;
  text: string;
  start: Coord;
  end: Coord; // 半开区间 end.index 为下一个码位
}

// 语法标记：按语法处理，不提前做语义判定
export interface SyntaxFlags {
  tautology: boolean;            // 同时含 l 与 -l
  duplicateLiterals: number[];   // 重复 literal 的出现下标（0-based，保留全部）
  hasZeroTerminator: boolean;    // 行尾/子句尾是否有 0
  oversizedVars: number[];       // abs(lit) > nvars 的 literal 出现下标
}

export interface ClauseOccurrence {
  id: string;            // 稳定身份：cl:<source>:<ordinal>
  source: 'cnf' | 'proof';
  ordinal: number;       // 在来源中的子句序号（0-based）
  lineOrdinal: number;   // 所在行（DRAT 行号 / CNF 子句号；0-based）
  literals: number[];    // 原始顺序（有符号整数，单位：literal = ±变量编号）
  multisetKey: string;   // 规范化多重集键：按有符号整数升序
  tokenIds: string[];    // 来源 token 身份
}

export interface ActiveClauseView {
  occurrenceId: string;
  multisetKey: string;
  literals: number[];
  bornAtLine: number; // 进入活跃集合的 proof 行（CNF 为 -1）
}

// ---------- 传播 / RUP / RAT 见证 ----------
export interface PropStep {
  id: string;
  order: number;
  literal: number;
  reason: 'assumption' | 'unit' ;
  reasonOccurrenceId: string | null;
  activeIndex: number | null; // 解析偏移：理由子句在当时活跃多重集中的下标（0-based）
}

export interface RupWitness {
  holds: boolean;
  exhausted: boolean;
  stepsUsed: number;          // 单位：unit-propagation step
  budget: number;             // 单位：unit-propagation step
  trail: PropStep[];
  conflictOccurrenceId: string | null;
  conflictActiveIndex: number | null;
}

export interface RatWitnessClause {
  occurrenceId: string;
  activeIndex: number;
  resolvent: number[];
  resolventTautology: boolean;
  rup: RupWitness | null; // tautology 时无需 RUP，留 null
}

export interface RatPivotCandidate {
  pivot: number;
  vacuous: boolean;
  holds: boolean;
  exhausted: boolean;
  witnesses: RatWitnessClause[];
}

// ---------- 机器可读取事件 ----------
export type EventCode =
  | 'CNF_PARSED'
  | 'PROOF_PARSED'
  | 'PARSE_MISSING_ZERO'
  | 'PARSE_VAR_OUT_OF_RANGE'
  | 'PARSE_BAD_TOKEN'
  | 'SYN_TAUTOLOGY'
  | 'SYN_DUPLICATE_LITERAL'
  | 'ADD_ACCEPT_RUP'
  | 'ADD_ACCEPT_RAT'
  | 'ADD_ACCEPT_TAUTOLOGY'
  | 'ADD_REJECT'
  | 'DELETE_APPLIED'
  | 'DELETE_ABSENT'
  | 'RESOURCE_EXHAUSTED'
  | 'EMPTY_CLAUSE_DERIVED'
  | 'BUDGET_REVISED'
  | 'HUMAN_DECISION'
  | 'DECISION_CONFLICT'
  | 'VERSION_CREATED';

export type Severity = 'info' | 'diagnostic' | 'warning' | 'error';

export interface TraceEvent {
  id: string;
  seq: number;
  code: EventCode;
  severity: Severity;
  lineOrdinal: number | null;
  subjectIds: string[];   // 受影响对象的稳定身份
  adopted: boolean;       // 该事件对应的判定/对象是否被采纳
  message: string;
  data?: Record<string, unknown>;
}

// ---------- 参数（资源预算，单位显式） ----------
export interface VerifyParams {
  id: string;
  maxPropSteps: number; // 每次子句检查的预算，单位：unit-propagation step（0 表示不限）
  oversizedVarPolicy: 'reject' | 'allow';
}

// ---------- proof 行与重放结果 ----------
export type LineVerdict =
  | 'add-rup'
  | 'add-rat'
  | 'add-tautology'
  | 'add-rejected'
  | 'delete-applied'
  | 'delete-absent'
  | 'syntax-error'
  | 'resource-exhausted';

export interface ProofLineView {
  id: string;
  ordinal: number;
  raw: string;
  kind: 'add' | 'delete';
  literals: number[];
  tokenIds: string[];
  flags: SyntaxFlags;
  verdict: LineVerdict;
  executed: boolean;
  adopted: boolean;
  rup: RupWitness | null;
  ratCandidates: RatPivotCandidate[] | null;
  chosenPivot: number | null; // 无法唯一决定时为 null，保留全部候选
  removedOccurrenceId?: string | null;
  activeAfter: ActiveClauseView[];
  events: TraceEvent[];
}

export type OverallVerdict =
  | 'valid'               // 到空句且全程通过
  | 'invalid-rejected'    // 存在被 RUP/RAT 拒绝的添加
  | 'invalid-syntax'      // 缺零终止等语法错误
  | 'unknown-resource'    // 预算耗尽：不是证明无效
  | 'incomplete';         // 正常结束但未导出空句

export interface ReplayResult {
  caseId: string;
  branchId: string;
  cnf: CnfDocument;
  proof: DratDocument;
  params: VerifyParams;
  lines: ProofLineView[];
  events: TraceEvent[];
  finalActive: ActiveClauseView[];
  emptyClauseLine: number | null;
  shortestFailingPrefix: number | null; // 首个无法采纳的行（0-based）；valid 时为 null
  overall: OverallVerdict;
  depGraph: DepGraph;
}

export interface CnfDocument {
  caseId: string;
  sourceId: string; // src:cnf
  raw: string;
  tokens: RawToken[];
  declaredVars: number | null; // p cnf <nvar> 声明的变量编号上界（单位：variable id）
  maxVarObserved: number;
  clauses: ClauseOccurrence[];
}

export interface DratDocument {
  caseId: string;
  sourceId: string; // src:drat
  raw: string;
  tokens: RawToken[];
  lines: ProofLine[];
}

export interface ProofLine {
  id: string;
  ordinal: number;
  raw: string;
  start: Coord;
  end: Coord;
  kind: 'add' | 'delete';
  literals: number[];
  tokenIds: string[];
  flags: SyntaxFlags;
}

// ---------- 依赖图 ----------
export type DepNodeKind =
  | 'source'
  | 'parse'
  | 'multiset'
  | 'proof-line'
  | 'active-set'
  | 'verdict';

export interface DepNode {
  id: string;
  kind: DepNodeKind;
  label: string;
  inputsHash: string;  // 直接输入内容的哈希
  resultHash: string;  // 本节点结果哈希
  dependsOn: string[];
  status: 'valid' | 'recomputed' | 'stale' | 'error' | 'blocked';
  reason: string;      // 为何仍有效 / 为何需要重算（机器可读 message）
  lineOrdinal: number | null;
  affectedByDirectSource: boolean;
}

export interface DepGraph {
  nodes: DepNode[];
  edges: Array<[string, string]>;
  changedDirectSources: string[]; // 相对父版本的直接来源
}

// ---------- 档案 / 版本 ----------
export type MutationKind =
  | 'baseline'
  | 'duplicate-clause'
  | 'tautology'
  | 'rat-pivot'
  | 'multiple-deletion'
  | 'missing-zero'
  | 'oversized-variable'
  | 'budget-exhausted'
  | 'param-revision'
  | 'local-source-edit'
  | 'conflicting-decision';

export interface CaseInputs {
  cnfText: string;
  dratText: string;
  params: VerifyParams;
}

export interface HumanDecision {
  kind: 'accept' | 'reject';
  targetLineOrdinal: number | null; // null = 整体
  note: string;
}

export interface CaseBranch {
  id: string;
  caseId: string;
  parentId: string | null;
  label: string;
  narrative: string;
  kind: MutationKind;
  directSourceChanged: 'cnf' | 'drat' | 'params' | 'decision' | null;
  inputs: CaseInputs;
  adopted: boolean;        // 该分支整体是否被当前复核路径采纳
  decision: HumanDecision | null;
  decisionConflictOf: string | null; // 与哪个分支的人工决定冲突
  replay: ReplayResult;
  createdAtSeq: number;
}

export interface ArchiveCase {
  id: string;
  title: string;
  narrative: string[];
  baselineId: string;
  currentBranchId: string; // 当前指针（仅完整成功后切换）
  branches: CaseBranch[];
}
