// ---------------------------------------------------------------------------
// Core domain model: every imported quantity keeps its original representation.
// Normalization (canonical clause keys, signed-literal maps) lives only in the
// derivation layer; raw text/tokens/coordinates are never discarded.
// ---------------------------------------------------------------------------

/** A signed literal is a non-zero integer; sign is polarity, magnitude is var. */
export type Literal = number;

export type VarId = string;

export interface RawToken {
  /** Stable identity of the token inside its file (1-based per file). */
  id: string;
  /** Exact source characters as typed. */
  text: string;
  /** 1-based line in the source file. */
  line: number;
  /** 1-based column offset of the first character on its line. */
  column: number;
  /** Byte-ish character offset from the start of the file. */
  offset: number;
  kind: "comment" | "header" | "integer" | "zero" | "garbage";
}

export interface HeaderInfo {
  declaredVars: number | null;
  declaredClauses: number | null;
  problemLineTokenIds: string[];
}

/** A clause as it was parsed syntactically, preserving literal token order. */
export interface ParsedClause {
  /** Stable syntactic identity, independent of later derivation versions. */
  id: string;
  origin: "cnf" | "proof-add";
  /** Raw signed literals in source order (repeated literals retained). */
  literals: Literal[];
  /** Token ids aligned 1:1 with `literals`. */
  literalTokenIds: string[];
  /** Token id of the terminating 0, or null when the terminator is missing. */
  terminatorTokenId: string | null;
  /** 1-based source line of the first token. */
  startLine: number;
  endLine: number;
  /** Syntax-layer observations; the clause still exists in the multiset. */
  diagnostics: Diagnostic[];
}

export interface ParsedCnf {
  tokens: RawToken[];
  clauses: ParsedClause[];
  header: HeaderInfo;
  diagnostics: Diagnostic[];
}

export type ProofOp = "add" | "delete";

export interface ProofLine {
  id: string;
  /** 1-based proof step index (line order, including malformed lines). */
  index: number;
  op: ProofOp;
  literals: Literal[];
  literalTokenIds: string[];
  terminatorTokenId: string | null;
  prefixTokenId: string | null;
  startLine: number;
  endLine: number;
  rawText: string;
  diagnostics: Diagnostic[];
}

export interface ParsedDrat {
  tokens: RawToken[];
  lines: ProofLine[];
  diagnostics: Diagnostic[];
}

export type DiagnosticCode =
  | "REPEATED_LITERAL"
  | "TAUTOLOGY"
  | "MISSING_ZERO"
  | "VARIABLE_OUT_OF_RANGE"
  | "GARBAGE_TOKEN"
  | "HEADER_MISMATCH"
  | "DELETE_MISSING"
  | "DELETE_AMBIGUOUS"
  | "BUDGET_EXHAUSTED"
  | "RAT_PIVOT"
  | "RAT_SYNTAX_DELETE"
  | "EMPTY_CLAUSE_RUP_ONLY";

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  /** Coordinate basis: file + 1-based line/column. */
  where?: { file: "cnf" | "drat"; line: number; column?: number };
  tokenIds?: string[];
  clauseId?: string;
  proofLineId?: string;
}

export type CheckStatus =
  | "valid"
  | "invalid"
  | "inconclusive"
  | "syntax-rejected"
  | "accepted-tautology"
  | "accepted-rup"
  | "accepted-rat";

export type CheckKind = "RUP" | "RAT";

/** A single unit propagation / conflict assignment with provenance. */
export interface PropStep {
  literal: Literal;
  reasonClauseId: string;
  /** Other clause literals at the moment of propagation. */
  reasonLiterals: Literal[];
  /** Which check (line id) this propagation belongs to. */
  checkId: string;
  /** Ordinal within the check; assumption assignments are negative. */
  order: number;
  isAssumption: boolean;
}

export interface ConflictInfo {
  reasonClauseId: string;
  reasonLiterals: Literal[];
}

export interface ResolventTrace {
  /** Active clause that resolves against the candidate clause. */
  activeClauseId: string;
  activeLiterals: Literal[];
  pivot: Literal;
  /** Signed-literal index at which the complementary pivot sits. */
  resolutionOffset: number;
  /** The resolvent, expressed in original signed literals (deduped for math). */
  resolvent: Literal[];
  checkKind: CheckKind;
  status: CheckStatus;
  propSteps: PropStep[];
  conflict: ConflictInfo | null;
  budgetUsed: number;
  budgetLimit: number;
  exhausted: boolean;
}

export interface CandidateClauseRef {
  clauseId: string;
  addedAtProofLineId: string | null;
}

export interface StepResult {
  lineId: string;
  index: number;
  op: ProofOp;
  displayLiterals: Literal[];
  isEmptyClause: boolean;
  status: CheckStatus;
  checkKind: CheckKind | null;
  pivot: Literal | null;
  /** RAT: every active clause containing -pivot, each with a resolvent trace. */
  resolvents: ResolventTrace[];
  /** For RUP / RAT resolvent checks. */
  rupTrace: ResolventTrace | null;
  /** Candidates considered on deletion, incl. unselected ones (ambiguity kept). */
  deletionCandidates: CandidateClauseRef[];
  selectedClauseId: string | null;
  diagnostics: Diagnostic[];
  /** Gate node identity: the exact active multiset snapshot this step sees. */
  activeSnapshotId: string;
  /** Dependency-graph node identity of this step's acceptance gate. */
  gateNodeId?: string;
  /** True when the step changed the active clause multiset. */
  adopted: boolean;
}

export interface ActiveClauseView {
  clauseId: string;
  literals: Literal[];
  multiplicity: number;
  addedAtProofLineId: string | null;
  deletedAtProofLineId: string | null;
}

export interface ShortestFailure {
  prefixLength: number;
  failingLineId: string;
  failingIndex: number;
  status: CheckStatus;
  reason: string;
}

export interface BudgetState {
  /** Resource budget per RUP/RAT sub-check, in propagation-step units. */
  limit: number;
  unit: "propagation-steps";
}

export interface EngineReport {
  nvars: number;
  budget: BudgetState;
  steps: StepResult[];
  activeAfter: ActiveClauseView[];
  shortestFailure: ShortestFailure | null;
  finalEmptyClause: { lineId: string; index: number } | null;
  provedUnsat: boolean;
  proofVerdict: "proved" | "rejected" | "incomplete";
  diagnostics: Diagnostic[];
}
