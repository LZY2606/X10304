/**
 * Core domain model for the SAT/DRAT proof-trace bench.
 *
 * Design invariants:
 *  - Original representation is preserved (tokens, raw lines, raw literals);
 *    normalization happens only in the derived layer.
 *  - Verdict is never collapsed to a single boolean: rup/rat/tautology/duplicate
 *    checks stay distinct and inconclusive (resource exhaustion) is a first
 *    class status.
 *  - Every domain quantity carries a stable identity and a coordinate basis
 *    (file offsets, line indices, literal sign convention).
 */

export type VerdictStatus =
  | 'accepted'
  | 'rejected'
  | 'inconclusive'
  | 'diagnostic'
  | 'halted';

export type UnitReason = 'input' | 'propagated';

/** A single unit-propagation assignment on the failure path. */
export interface PropStep {
  step: number;
  literal: number;
  reasonClauseRef: string;
  reasonKind: UnitReason;
  depthFromCandidates: number;
  /** file offset range of the reason clause, 1-based [startByte,endByte) */
  reasonOffset: { startByte: number; endByte: number };
}

/** Resolvent evidence for one RAT witness. */
export interface RatWitness {
  witnessRef: string;
  witnessOffset: { startByte: number; endByte: number };
  resolventRef: string | null;
  resolventLiterals: number[];
  rup: LineVerdict;
}

/** Machine-readable judgment for one proof line. */
export interface LineVerdict {
  kind: 'addition' | 'deletion';
  /** distinct checks, never merged into one boolean */
  isDuplicate: boolean;
  isTautology: boolean;
  hasDuplicateLiterals: boolean;
  rup: VerdictStatus;
  rat: VerdictStatus;
  /** final adopted status of this line */
  status: VerdictStatus;
  adopted: boolean;
  /** short machine codes, e.g. RUP_CONFLICT, RAT_WITNESS, BUDGET_EXHAUSTED */
  basis: string[];
  propChain: PropStep[];
  conflictClauseRef: string | null;
  ratPivot: number | null;
  ratWitnesses: RatWitness[];
  /** 1-based proof-line index where verification first could not proceed */
  failurePrefix: number | null;
  message: string;
  propagationStepsUsed: number;
  budget: ResourceBudget;
  budgetRemaining: number;
}

export interface ResourceBudget {
  /** unit: propagation steps (unit propagations) */
  maxPropagationSteps: number;
  /** unit: candidate resolutions tested during RAT search */
  maxResolutionCandidates: number;
}

export interface TokenSpan {
  /** original DIMACS token text, verbatim */
  text: string;
  kind: 'comment' | 'header' | 'integer' | 'terminator' | 'garbage';
  /** 0-based byte offsets in the source text */
  startByte: number;
  endByte: number;
  line: number;
  col: number;
}

export interface ParseDiagnostic {
  code:
    | 'MISSING_ZERO_TERMINATOR'
    | 'OVERSIZED_VARIABLE'
    | 'DUPLICATE_LITERAL'
    | 'BAD_HEADER'
    | 'NON_INTEGER_TOKEN'
    | 'EMPTY_PROOF';
  severity: 'error' | 'warning' | 'info';
  message: string;
  line: number;
  startByte: number;
  endByte: number;
}

export interface ParsedClause {
  /** stable intrinsic id: "c:<clause index within source>:<sorted abs lits hash>" */
  ref: string;
  sourceIndex: number;
  rawLiterals: number[];
  normalizedLiterals: number[];
  duplicates: number[];
  tautology: boolean;
  startByte: number;
  endByte: number;
  lineStart: number;
  lineEnd: number;
}

export interface CnfDocument {
  source: string;
  declaredVariables: number | null;
  maxVariableSeen: number;
  variables: { id: number; basis: 'declared-header' | 'observed-literal' }[];
  tokens: TokenSpan[];
  clauses: ParsedClause[];
  diagnostics: ParseDiagnostic[];
  parsed: boolean;
}

export interface ProofLineData {
  index: number;
  raw: string;
  startByte: number;
  endByte: number;
  deletion: boolean;
  literals: number[];
  terminated: boolean;
  tautology: boolean;
  hasDuplicateLiterals: boolean;
  diagnostics: ParseDiagnostic[];
}

export interface ProofDocument {
  source: string;
  lines: ProofLineData[];
  diagnostics: ParseDiagnostic[];
  parsed: boolean;
}

/** Active clause multiset entry. */
export interface ActiveEntry {
  ref: string;
  literals: number[];
  multiplicity: number;
  origin: 'input' | 'proof';
  proofIndex: number | null;
  startByte: number;
  endByte: number;
}

export interface ProofResult {
  verdicts: LineVerdict[];
  /** global shortest failing prefix (1-based line index), null if fully verified */
  shortestFailurePrefix: number | null;
  finalEmptyClause: LineVerdict | null;
  halted: boolean;
}

export type RuleParamKey =
  | 'maxPropagationSteps'
  | 'maxResolutionCandidates'
  | 'allowTautologyAddition'
  | 'ratMode';

export interface RuleParameters extends ResourceBudget {
  allowTautologyAddition: boolean;
  /** 'rat' (default DRAT) | 'rup-only' */
  ratMode: 'rat' | 'rup-only';
}

export const DEFAULT_RULE_PARAMETERS: RuleParameters = {
  maxPropagationSteps: 5000,
  maxResolutionCandidates: 5000,
  allowTautologyAddition: true,
  ratMode: 'rat',
};
