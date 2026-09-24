// ---------------------------------------------------------------------------
// 证明轨迹台 — 核心领域类型
// 约定：所有领域量都携带单位/坐标基准。原始表示保存在 *_raw，规范化只发生在派生层。
// ---------------------------------------------------------------------------

/** 字符级坐标（基于导入的原始文本），offset 为 0 基字节偏移，line/col 为 1 基。 */
export interface Position {
  offset: number;
  line: number;
  col: number;
}

/** 一个原始 DIMACS token，保留原文与坐标，拥有稳定身份 tokenId。 */
export interface Token {
  tokenId: string;        // 稳定身份：doc 内 `tok@<offset>`
  text: string;           // 原始文本（不规范化）
  offset: number;         // 起始字节偏移
  line: number;           // 1 基
  col: number;            // 1 基
}

/** 字面量：值是带符号变量号；unit 固定为 DIMACS 字面量（带符号整数文本）。 */
export interface Lit {
  litId: string;          // `lit@<tokenId>`
  raw: string;            // 原始 token 文本
  varNo: number;          // 变量编号（>=1）；无法转换时为 -1
  sign: 1 | -1 | 0;       // 0 表示无法解析
  token: Position;
  diagnostic?: string;
}

/** 变量编号台账：声明上界 + 实际使用情况。 */
export interface VarTable {
  declaredMaxVar: number | null;  // p 行声明的变量数（单位：个，坐标来自 header token）
  usedMaxVar: number;             // 实际出现的最大变量号
  outOfRangeVars: number[];       // 超过声明上界的变量号（去重升序）
  headerTokens: Token[];          // p cnf 头的 token（保留）
}

export interface ClauseHint {
  resolvedClauseKey: string;  // 被解析的子句稳定键
  resolvedLit: number;        // 该步消解掉的字面量
  attOffset: number;          // 在该行 hint 序列中的下标（解析偏移坐标）
}

/** 规范化后的子句（派生层）。multisetKey 用于多重集身份。 */
export interface NormClause {
  clauseId: string;           // 稳定：`cl@<sha1(multisetKey)>`
  multisetKey: string;        // 多重集键：排序后字面量文本，含重复
  setKey: string;             // 去重+排序后的集合键
  lits: number[];             // 规范化字面量（保留重复次数）
  uniqueLits: number[];       // 去重字面量
  isTautology: boolean;       // 含 x 与 -x（语法判定）
  hasDupLit: boolean;         // 含重复字面量（语法判定）
  occurrences: number;        // 在活跃多重集中的重数
}

/** CNF 文档（原始层）。 */
export interface CNFDocument {
  docId: string;              // `cnf@<sha1(文本)>`
  rawText: string;
  tokens: Token[];
  clauses: RawClause[];
  varTable: VarTable;
  diagnostics: SyntaxDiagnostic[];
}

export interface RawClause {
  clauseId: string;           // `rawcl@<行号>`，身份只依赖原始行
  index: number;              // 0 基子句序号（不含注释）
  lits: Lit[];
  terminatorZero: boolean;    // 是否以 0 结尾
  start: Position;
  end: Position;
  /** EOF 处缺少 0 终止：保留在原位的诊断（不丢弃任何 token）。 */
  unterminatedAtEof?: boolean;
  note?: string;
}

export interface SyntaxDiagnostic {
  code: 'NON_INTEGER_TOKEN' | 'NEGATED_ZERO' | 'MISSING_ZERO_AT_EOF'
      | 'OUT_OF_RANGE_VAR' | 'BAD_HEADER' | 'ZERO_LITERAL_IN_BODY';
  message: string;
  position: Position;
  tokenId?: string;
  severity: 'error' | 'warning';
}

export type ProofKind = 'add' | 'delete';

/** 一条 DRAT proof 行（原始层 + 可选 LRAT 风格消解偏移/提示，保留原始 token）。 */
export interface ProofLine {
  lineId: string;             // `pf@<行号>`，身份只依赖原始行
  index: number;              // 0 基 proof 序号
  kind: ProofKind;
  markerToken?: Token;        // 行首 'd'
  litTokens: Token[];         // 零之前的字面量 token
  lits: number[];             // 规范化（派生时再决定是否采用）
  zeroToken?: Token;          // 终止 0
  hintTokens: Token[];        // 零之后、下一个 0 之前的提示 token
  hints: number[];            // 解析偏移（若文本提供）
  start: Position;
  end: Position;
  unterminatedAtEof?: boolean;
  rawText: string;
}

export interface DRATDocument {
  docId: string;              // `drat@<sha1(文本)>`
  rawText: string;
  lines: ProofLine[];
  usedMaxVar: number;
  diagnostics: SyntaxDiagnostic[];
}

/** 单位传播中的单步理由。 */
export interface PropStep {
  propagated: number;                 // 被传播为真的字面量
  reasonClauseId: string;             // 传播理由子句
  reasonLits: number[];
  depth: number;                      // 传播链深度（坐标基准：从假设起）
}

export type RUPVerdict = 'rup-conflict' | 'no-conflict' | 'inconclusive-budget';
export type RATPivotVerdict =
  | 'rat-ok'
  | 'rat-fail'
  | 'rat-vacuous'        // F 中不存在含 pivot 的子句：空连接，自动成立
  | 'rat-inconclusive'
  | 'rat-ambiguous';     // 多个合法 pivot，无法唯一决定

export interface PivotCandidate {
  pivot: number;
  verdict: RATPivotVerdict;
  witnessClauseIds: string[]; // 不满足 ¬p 的含 pivot 子句（无法被消解的反例）
}

/** 单行核验结果（派生层），RUP 与 RAT 严格分开记录。 */
export interface LineCheck {
  lineId: string;
  index: number;
  kind: ProofKind;
  clause: NormClause | null;
  // RUP
  rup: RUPVerdict;
  propTrail: PropStep[];            // 传播理由链
  expectedHints: ClauseHint[];      // 由传播反推出的解析偏移（与原文 hints 对比）
  hintsMatchInput: boolean | null;  // 原文未给提示 => null
  conflictClauseId?: string;
  // RAT
  ratChecked: boolean;              // 仅在 RUP 非冲突且为 add 时需要
  adoptedPivot: number | null;      // 实际采用的 pivot
  pivotCandidates: PivotCandidate[];// 保留全部合法候选
  rat: RATPivotVerdict | 'not-needed' | 'delete-line';
  // 语法标记（按语法处理，不混入语义判定）
  tags: Array<'tautology' | 'duplicate-clause' | 'duplicate-literal'
            | 'missing-zero' | 'oversize-var' | 'delete-missing'>;
  deleteMatchedIds?: string[];      // 删除命中的实例
  deleteMissing?: boolean;          // 删除不存在子句
  decision: 'accept' | 'reject' | 'inconclusive';
  reason: string;
  budgetBefore: number;
  budgetAfter: number;
  budgetUnit: 'unit-propagation-steps';
}

export type OverallStatus =
  | 'valid'                  // 到达空子句，全部行接受
  | 'invalid'                // 存在硬拒绝 => 最短失败前缀
  | 'inconclusive'           // 资源耗尽等，不是证明无效
  | 'empty-proof';

/** 一次完整重放/核验（派生版本）。 */
export interface VerificationRun {
  runId: string;             // 内容哈希：输入+参数+规则版本
  cnfDocId: string;
  dratDocId: string;
  params: VerifyParams;
  ruleVersion: string;
  lineChecks: LineCheck[];
  status: OverallStatus;
  shortestFailingIndex: number | null;
  finalEmptyClauseReached: boolean;
  events: DomainEvent[];
  activeClauseTimeline: ActiveClauseSnapshot[];
}

export interface VerifyParams {
  budget: number;            // 单位传播步数预算；单位见 budgetUnit
  budgetUnit: 'unit-propagation-steps';
  pivotPolicy: 'first' | 'any';
  deleteStrategy: 'lifo';
}

export const DEFAULT_PARAMS: VerifyParams = {
  budget: 1_000_000,
  budgetUnit: 'unit-propagation-steps',
  pivotPolicy: 'first',
  deleteStrategy: 'lifo',
};

export interface ActiveClauseSnapshot {
  lineId: string;
  index: number;
  activeIds: string[];       // 有序多重集实例身份
  size: number;
}

// ---------------------------------------------------------------------------
// 机器可读取事件 / 裁定 / 版本
// ---------------------------------------------------------------------------

export type EventKind =
  | 'import'
  | 'verify'
  | 'param-revision'
  | 'source-mutation'
  | 'duplicate-clause'
  | 'tautology'
  | 'rat-pivot'
  | 'multi-delete'
  | 'missing-zero'
  | 'oversize-var'
  | 'budget-exhausted'
  | 'delete-missing-diagnostic'
  | 'accept'
  | 'reject'
  | 'param-adjust'
  | 'branch-create'
  | 'branch-select'
  | 'candidate-retained'
  | 'diagnostic';

export interface DomainEvent {
  eventId: string;            // 内容派生：确定性；人工事件带时间与父事件
  seq: number;                // 在档案中的全局顺序
  kind: EventKind;
  at: string;                 // ISO 时间戳
  actor: 'system' | string;
  /** 受影响对象的稳定身份（子句/行/token/运行版本）。 */
  subjects: string[];
  /** 判定依据（机器可读）。 */
  basis: Record<string, unknown>;
  adopted: boolean;           // 被采纳
  /** 事件生成时依赖的版本指针。 */
  deps: { cnfDocId: string; dratDocId: string; runId: string | null;
          paramsVersion: number; ruleVersion: string };
  parentEventId: string | null;
  summary: string;
}

export interface VerifyResult {
  run: VerificationRun;
  events: DomainEvent[];      // 本次运行新产生的事件
}

export interface MutationSpec {
  id: string;
  label: string;
  kind: 'duplicate-clause' | 'tautology' | 'rat-pivot' | 'multi-delete'
      | 'missing-zero' | 'oversize-var' | 'budget-exhausted';
  description: string;
}

/** 导出档案：删除本地数据库再导入后身份/顺序/来源关系不变。 */
export interface ArchiveBundle {
  format: 'proof-trace-archive';
  formatVersion: number;
  exportedAt: string;
  cnf: { name: string; rawText: string };
  drat: { name: string; rawText: string };
  params: VerifyParams;
  paramsVersion: number;
  ruleVersion: string;
  baselineRunId: string;
  runs: VerificationRun[];
  events: DomainEvent[];
  decisions: DecisionRecord[];
  branches: BranchRecord[];
}

export interface DecisionRecord {
  decisionId: string;
  eventId: string;
  action: 'accept' | 'reject' | 'param-adjust' | 'continue-branch';
  fromRunId: string;
  toRunId: string | null;
  rationale: string;
  createdAt: string;
  baseVersion: number;       // 乐观并发基准
}

export interface BranchRecord {
  branchId: string;
  label: string;
  parentRunId: string;
  runId: string;
  selected: boolean;         // 未选分支同样保留
  createdAt: string;
}
