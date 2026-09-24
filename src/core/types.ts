/**
 * 核心领域类型：只描述 SAT / DRAT 核验语义，不涉及存储与界面。
 * 设计原则：
 *  - 导入层保留原始表示（token、坐标、量纲），派生层才做规范化；
 *  - 无法转换的值留在原位置并附诊断；
 *  - 判定区分 RUP / RAT、accepted / rejected / inconclusive，不吞掉多解。
 */

/** 字节偏移（基准：文件首个字节为 0，单位 byte）。 */
export type ByteOffset = number;
/** 行号（基准：第 1 行，单位 line）。 */
export type LineNo = number;
/** 列号（基准：该行第 1 列，单位 column）。 */
export type ColNo = number;

/** 原始坐标基准：每个 token 都能回溯到文件中的位置。 */
export interface Coord {
  /** 字节偏移，量纲 byte，基准 0。 */
  readonly offset: ByteOffset;
  /** 行号，量纲 line，基准 1。 */
  readonly line: LineNo;
  /** 列号，量纲 column，基准 1。 */
  readonly column: ColNo;
  /** 原始文本（零宽 token 时为 ""）。 */
  readonly text: string;
}

export type DiagnosticSeverity = "error" | "warning" | "info";

/** 机器可读诊断：挂在原始对象上，规范化不通过时不丢弃原值。 */
export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  /** 触发诊断的原始 token 坐标（若有）。 */
  readonly coord?: Coord;
}

/** 带单位的原始整数：解析失败时 value 为 null，token 与诊断保留在原位置。 */
export interface RawInt {
  readonly coord: Coord;
  /** 规范化后的整数值；无法转换时为 null（不丢弃 token）。 */
  readonly value: number | null;
  readonly diagnostics: readonly Diagnostic[];
}

export type TokenKind =
  | "int"
  | "zero"
  | "header"
  | "comment"
  | "garbage";

/** 原始 DIMACS token：完全保留输入表示。 */
export interface RawToken {
  readonly id: string;
  readonly kind: TokenKind;
  readonly coord: Coord;
  readonly rawInt?: RawInt;
}

/** 变量编号：规范化值 + 原始 token + 声明范围（量纲 variable）。 */
export interface VariableInfo {
  readonly id: string;
  /** 变量编号，量纲 variable，基准 1。 */
  readonly number: number;
  /** 声明上界（来自 p cnf nvar nclauses），量纲 variable。 */
  readonly declaredMax: number;
  readonly outOfRange: boolean;
  /** 该变量第一次出现的原始 token。 */
  readonly firstTokenId: string;
}

/** 原始 literal：符号与变量都可回溯到 token。 */
export interface RawLiteral {
  readonly id: string;
  readonly sign: 1 | -1;
  readonly variable: number;
  readonly tokenId: string;
  readonly coord: Coord;
}

/** 原始子句行（CNF 可能跨多行，以 0 结束；DRAT 一行一子句）。 */
export interface RawClause {
  readonly id: string;
  readonly literals: readonly RawLiteral[];
  /** 结束符 0 的 token；缺零时为 undefined。 */
  readonly terminatorTokenId?: string;
  readonly startTokenId: string;
  readonly endTokenId?: string;
  readonly diagnostics: readonly Diagnostic[];
}

export interface CnfHeader {
  readonly declaredVars: number | null;
  readonly declaredClauses: number | null;
  readonly tokenIds: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface ParsedCnf {
  readonly tokens: readonly RawToken[];
  readonly header: CnfHeader;
  readonly clauses: readonly RawClause[];
  readonly variables: readonly VariableInfo[];
  readonly diagnostics: readonly Diagnostic[];
}

export type ProofOp = "add" | "delete";

export interface ParsedProofLine {
  readonly id: string;
  /** 行号，量纲 line，基准 1。 */
  readonly lineNo: LineNo;
  readonly op: ProofOp;
  /** 原始输入片段（整行文本）。 */
  readonly sourceText: string;
  /** 字节偏移区间 [start, end)，单位 byte。 */
  readonly span: readonly [ByteOffset, ByteOffset];
  readonly clause: RawClause;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ParsedProof {
  readonly tokens: readonly RawToken[];
  readonly lines: readonly ParsedProofLine[];
  readonly diagnostics: readonly Diagnostic[];
}

/** 规范化 literal：非零有符号整数。0 表示空子句元素的语义另用 empty 标志。 */
export type Lit = number;

export interface NormalizedClause {
  /** 去重、排序后的 literals；空数组表示空子句 ()。 */
  readonly lits: readonly Lit[];
  readonly tautology: boolean;
  readonly duplicateLits: readonly Lit[];
}

/** 资源预算：所有“工作”都有统一计量单位 step（一次二元传播）。 */
export interface ResourceBudget {
  /** 传播步数上界，单位 step；null 表示无限制。 */
  readonly maxSteps: number | null;
}

export type VerdictKind = "accepted" | "rejected" | "inconclusive";
export type CheckKind = "RUP" | "RAT" | "syntax" | "none";

export interface PropStep {
  readonly stepNo: number;
  /** 被传播为真的 unit literal。 */
  readonly lit: Lit;
  /** 理由子句（在当时活跃多重集中的实例 id）。 */
  readonly reasonClauseId: string;
  /** 理由子句的规范化 literals。 */
  readonly reasonLits: readonly Lit[];
}

export interface RatPartner {
  /** 用于 RAT 消解的伙伴子句实例 id。 */
  readonly clauseInstanceId: string;
  readonly partnerLits: readonly Lit[];
  /** 与新子句消解得到的消解式（规范化后）。 */
  readonly resolventLits: readonly Lit[];
  /** RUP 核验该消解式时的传播理由（为空表示直接成立）。 */
  readonly propSteps: readonly PropStep[];
  readonly stepsUsed: number;
  /** 该伙伴 RUP 是否成立；预算耗尽时为 inconclusive。 */
  readonly holds: boolean | "inconclusive";
}

/** 单条 proof 行的核验结果。 */
export interface LineResult {
  readonly lineId: string;
  readonly op: ProofOp;
  readonly verdict: VerdictKind;
  /** 最终采用的检查类型。 */
  readonly check: CheckKind;
  /** RAT pivot（量纲 literal）；仅 check=RAT 时有值。 */
  readonly pivot?: Lit;
  /** RUP 传播理由（含导致矛盾的步骤）。 */
  readonly rupSteps?: readonly PropStep[];
  readonly rupStepsUsed?: number;
  /** 检查过的全部 RAT 候选 pivot（含未采纳者），键为 pivot literal。 */
  readonly ratCandidates?: Readonly<Record<string, RatCheckDetail>>;
  /** 删除操作的诊断（如删除不存在子句）。 */
  readonly deleteNote?: string;
  /** 被删除的子句实例 id（多重集身份，一次删一个）。 */
  readonly removedInstanceId?: string;
  readonly diagnostics: readonly Diagnostic[];
  /** 核验后该行新增到活跃集的实例 id（add 且成功时）。 */
  readonly addedInstanceId?: string;
}

export interface RatCheckDetail {
  readonly pivot: Lit;
  /** 含 -pivot 的伙伴核验明细；空伙伴列表 = 空真 RAT。 */
  readonly partners: readonly RatPartner[];
  readonly holds: boolean | "inconclusive";
  readonly stepsUsed: number;
  /** 是否为最终采纳的候选。 */
  readonly adopted: boolean;
}

/** 活跃多重集中的子句实例。 */
export interface ClauseInstance {
  /** 稳定实例 id：来源身份 + 出现序号，重放保持不变。 */
  readonly instanceId: string;
  /** 来源：CNF 子句 id 或 proof 行 id。 */
  readonly originClauseId: string;
  readonly originLineId?: string;
  readonly lits: readonly Lit[];
  /** 在该来源下，同身份子句第几次加入多重集（基准 1，单位 occurrence）。 */
  readonly occurrence: number;
}

export interface ReplayResult {
  readonly lineResults: readonly LineResult[];
  /** 最终活跃子句多重集。 */
  readonly active: readonly ClauseInstance[];
  /** 总传播步数消耗，单位 step。 */
  readonly stepsUsed: number;
  /** 最终是否导出空子句且全程接受。 */
  readonly derivesEmpty: boolean;
  /** 最短失败前缀：按行序第一个非 accepted 行；null 表示没有失败。 */
  readonly shortestFailureLineId: string | null;
  /** 资源是否在某行耗尽（inconclusive，非无效）。 */
  readonly budgetExhausted: boolean;
}
