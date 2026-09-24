import type {
  ByteOffset,
  CnfHeader,
  ColNo,
  Coord,
  Diagnostic,
  LineNo,
  ParsedCnf,
  ParsedProof,
  ParsedProofLine,
  RawClause,
  RawInt,
  RawLiteral,
  RawToken,
  TokenKind,
  VariableInfo
} from "./types.js";

/** 扫描结果：把输入切成带坐标的 token，原始文本全部保留。 */
interface ScannedToken {
  readonly id: string;
  readonly kind: TokenKind;
  readonly coord: Coord;
  readonly rawInt?: RawInt;
  /** proof 行首的 "d" 删除标记。 */
  readonly deleteMark?: boolean;
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\v" || ch === "\f";
}

function makeIntDiagnostics(coord: Coord, text: string, raw: number | null): readonly Diagnostic[] {
  if (raw !== null) return [];
  return [
    {
      code: "syntax:not-an-integer",
      severity: "error",
      message: `token ${JSON.stringify(text)} 不是合法整数，保留在原位置不参与规范化`,
      coord
    }
  ];
}

/** 扫描任意 DIMACS 风格文本；kindPrefix 决定 "c/p" 行如何分类。 */
function scan(
  text: string,
  idPrefix: string,
  opts: { proof: boolean }
): { tokens: readonly ScannedToken[]; diagnostics: readonly Diagnostic[] } {
  const tokens: ScannedToken[] = [];
  const diagnostics: Diagnostic[] = [];
  let line: LineNo = 1;
  let col: ColNo = 1;
  let offset: ByteOffset = 0;
  let tokenSeq = 0;

  const peekLineStart = (start: number): boolean => {
    let i = start - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === "\n") return true;
      if (!isWhitespace(ch)) return false;
      i -= 1;
    }
    return true;
  };

  while (offset < text.length) {
    const ch = text[offset]!;
    if (isWhitespace(ch)) {
      if (ch === "\n") {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      offset += 1;
      continue;
    }

    const startOffset = offset;
    const startLine = line;
    const startCol = col;
    while (offset < text.length && !isWhitespace(text[offset]!)) {
      offset += 1;
      col += 1;
      if (text[offset - 1] === "\n") break;
    }
    const word = text.slice(startOffset, offset);
    const coord: Coord = { offset: startOffset, line: startLine, column: startCol, text: word };
    const id = `${idPrefix}-tok-${String(tokenSeq).padStart(4, "0")}`;
    tokenSeq += 1;

    const atLineStart = peekLineStart(startOffset);

    if (atLineStart && word === "c") {
      // CNF 注释行：行内剩余内容作为一个 comment token 保留原文。
      let end = offset;
      let l2 = line;
      let c2 = col;
      while (end < text.length && text[end] !== "\n") {
        end += 1;
        c2 += 1;
      }
      const commentText = text.slice(startOffset, end);
      tokens.push({
        id,
        kind: "comment",
        coord: { offset: startOffset, line: startLine, column: startCol, text: commentText }
      });
      offset = end;
      line = l2;
      col = c2;
      continue;
    }

    if (!opts.proof && atLineStart && word === "p") {
      tokens.push({ id, kind: "header", coord });
      continue;
    }
    if (!opts.proof && atLineStart && (word === "cnf" || word === "CNF")) {
      tokens.push({ id, kind: "header", coord });
      continue;
    }

    if (opts.proof && atLineStart && word === "d") {
      tokens.push({ id, kind: "zero", coord, deleteMark: true });
      continue;
    }

    if (/^[+-]?\d+$/.test(word)) {
      const value = Number(word);
      if (word === "0") {
        tokens.push({ id, kind: "zero", coord });
      } else {
        const rawInt: RawInt = { coord, value, diagnostics: makeIntDiagnostics(coord, word, value) };
        tokens.push({ id, kind: "int", coord, rawInt });
      }
    } else {
      // 头部行的 nvar/nclauses 单词（cnf 等）走 header；其他不可识别 token 保留。
      const prev = tokens[tokens.length - 1];
      if (!opts.proof && prev?.kind === "header") {
        tokens.push({ id, kind: "header", coord });
      } else {
        const diag: Diagnostic = {
          code: "syntax:not-an-integer",
          severity: "error",
          message: `token ${JSON.stringify(word)} 不是合法整数，保留在原位置`,
          coord
        };
        diagnostics.push(diag);
        tokens.push({
          id,
          kind: "garbage",
          coord,
          rawInt: { coord, value: null, diagnostics: [diag] }
        });
      }
    }
  }
  return { tokens, diagnostics };
}

function literalOf(
  token: ScannedToken,
  litSeq: number,
  idPrefix: string
): { lit: RawLiteral; diag?: Diagnostic } {
  const value = token.rawInt?.value ?? null;
  const coord = token.coord;
  if (value === null || value === 0) {
    const diag: Diagnostic = {
      code: "syntax:not-a-literal",
      severity: "error",
      message: `token ${JSON.stringify(coord.text)} 不能作为 literal（需要非零整数），保留原位置`,
      coord
    };
    return {
      lit: {
        id: `${idPrefix}-lit-${String(litSeq).padStart(4, "0")}`,
        sign: 1,
        variable: NaN,
        tokenId: token.id,
        coord
      },
      diag
    };
  }
  return {
    lit: {
      id: `${idPrefix}-lit-${String(litSeq).padStart(4, "0")}`,
      sign: value > 0 ? 1 : -1,
      variable: Math.abs(value),
      tokenId: token.id,
      coord
    }
  };
}

/** 解析 CNF DIMACS：保留全部 token，子句按 0 终止跨行组装。 */
export function parseCnf(text: string, idPrefix = "cnf"): ParsedCnf {
  const { tokens: scanned, diagnostics: scanDiags } = scan(text, idPrefix, { proof: false });
  const tokens: RawToken[] = scanned.map((t) => ({
    id: t.id,
    kind: t.kind,
    coord: t.coord,
    ...(t.rawInt ? { rawInt: t.rawInt } : {})
  }));

  const diagnostics: Diagnostic[] = [...scanDiags];
  const header: CnfHeader = {
    declaredVars: null,
    declaredClauses: null,
    tokenIds: [],
    diagnostics: []
  };
  const headerTokenIds: string[] = [];
  const headerNums: number[] = [];
  for (const t of scanned) {
    if (t.kind !== "header") break;
    headerTokenIds.push(t.id);
    const v = t.rawInt?.value;
    if (typeof v === "number") headerNums.push(v);
  }
  const headerDiags: Diagnostic[] = [];
  let declaredVars: number | null = null;
  let declaredClauses: number | null = null;
  if (headerTokenIds.length > 0) {
    const first = scanned.find((t) => t.kind === "header");
    declaredVars = headerNums[0] ?? null;
    declaredClauses = headerNums[1] ?? null;
    if (declaredVars === null || declaredClauses === null) {
      headerDiags.push({
        code: "syntax:bad-header",
        severity: "error",
        message: "p cnf 头部缺少变量数或子句数，原值保留",
        coord: first?.coord
      });
    }
  }

  const clauses: RawClause[] = [];
  const variableMap = new Map<number, { firstTokenId: string }>();
  let clauseSeq = 0;
  let litSeq = 0;
  let current: RawLiteral[] = [];
  let currentDiags: Diagnostic[] = [];
  let startTokenId: string | null = null;
  const bodyStart = headerTokenIds.length;

  const flush = (terminatorTokenId: string | undefined, endTokenId: string | undefined) => {
    if (current.length === 0 && currentDiags.length === 0 && terminatorTokenId === undefined) return;
    const id = `${idPrefix}-cl-${String(clauseSeq).padStart(4, "0")}`;
    clauses.push({
      id,
      literals: current,
      ...(terminatorTokenId ? { terminatorTokenId } : {}),
      startTokenId: startTokenId ?? endTokenId ?? terminatorTokenId ?? id,
      ...(endTokenId ? { endTokenId } : {}),
      diagnostics: currentDiags
    });
    clauseSeq += 1;
    current = [];
    currentDiags = [];
    startTokenId = null;
  };

  for (let i = bodyStart; i < scanned.length; i++) {
    const t = scanned[i]!;
    if (t.kind === "comment") continue;
    if (t.kind === "header") continue;
    if (t.kind === "zero") {
      flush(t.id, t.id);
      continue;
    }
    if (startTokenId === null) startTokenId = t.id;
    const { lit, diag } = literalOf(t, litSeq, idPrefix);
    litSeq += 1;
    if (diag) {
      currentDiags.push(diag);
      diagnostics.push(diag);
      continue;
    }
    current.push(lit);
    if (!Number.isNaN(lit.variable) && !variableMap.has(lit.variable)) {
      variableMap.set(lit.variable, { firstTokenId: t.id });
    }
  }
  if (current.length > 0 || currentDiags.length > 0) {
    const diag: Diagnostic = {
      code: "syntax:unterminated-clause",
      severity: "error",
      message: "最后一条 CNF 子句缺少 0 终止符，按语法错误保留原行",
      coord: current[current.length - 1]?.coord ?? currentDiags[0]?.coord
    };
    currentDiags.push(diag);
    diagnostics.push(diag);
    flush(undefined, current[current.length - 1]?.tokenId);
  }

  const maxVar = declaredVars ?? 0;
  const variables: VariableInfo[] = [...variableMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, info]) => ({
      id: `${idPrefix}-var-${String(number).padStart(5, "0")}`,
      number,
      declaredMax: maxVar,
      outOfRange: number > maxVar,
      firstTokenId: info.firstTokenId
    }));
  if (declaredVars !== null) {
    for (const v of variables) {
      if (v.outOfRange) {
        const diag: Diagnostic = {
          code: "syntax:variable-out-of-declared-range",
          severity: "warning",
          message: `变量 ${v.number} 超出 p cnf 声明上界 ${declaredVars}（量纲 variable），原值保留并扩展编号表`,
          coord: tokens.find((tk) => tk.id === v.firstTokenId)?.coord
        };
        diagnostics.push(diag);
      }
    }
  }
  if (declaredClauses !== null && clauses.length !== declaredClauses) {
    diagnostics.push({
      code: "syntax:clause-count-mismatch",
      severity: "warning",
      message: `p cnf 声明 ${declaredClauses} 条子句，实际终止得到 ${clauses.length} 条（量纲 clause）`
    });
  }

  return {
    tokens,
    header: {
      declaredVars,
      declaredClauses,
      tokenIds: headerTokenIds,
      diagnostics: headerDiags
    },
    clauses,
    variables,
    diagnostics
  };
}
