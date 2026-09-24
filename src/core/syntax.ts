// ---------------------------------------------------------------------------
// Syntax layer: tokenizes DIMACS CNF and DRAT proof text.
// It preserves every original token (text + line/column/offset coordinates) and
// reports tautology / repeated-literal / missing-zero syntactically without
// normalizing the stored literals away.
// ---------------------------------------------------------------------------

import type {
  Diagnostic,
  ParsedClause,
  ParsedCnf,
  ParsedDrat,
  ProofLine,
  RawToken,
} from "./types.js";

interface TokenCursor {
  tokens: RawToken[];
  seq: number;
}

function isInteger(s: string): boolean {
  return /^[+-]?\d+$/.test(s);
}

/** Tokenize whitespace-separated DIMACS text, retaining comments as tokens. */
export function tokenize(
  text: string,
  file: "cnf" | "drat",
  startSeq = 0
): { tokens: RawToken[]; diagnostics: Diagnostic[] } {
  const tokens: RawToken[] = [];
  const diagnostics: Diagnostic[] = [];
  let seq = startSeq;
  let offset = 0;
  const lines = text.split("\n");
  lines.forEach((rawLine, li) => {
    const lineNo = li + 1;
    let column = 1;
    // comments: 'c' line in CNF, and DRAT has no comments, but treat 'c' too.
    const stripped = rawLine.replace(/\r$/, "");
    if (file === "cnf" && /^\s*c(\s|$)/.test(stripped)) {
      tokens.push({
        id: `tok:${file}#${++seq}`,
        text: stripped.trim(),
        line: lineNo,
        column,
        offset,
        kind: "comment",
      });
      offset += rawLine.length + 1;
      return;
    }
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      const word = m[0];
      const col = m.index + 1;
      let kind: RawToken["kind"];
      if (word === "p" || /^[pcnf]$/.test(word)) kind = "header";
      else if (isInteger(word)) {
        kind = Number(word) === 0 ? "zero" : "integer";
      } else kind = "garbage";
      tokens.push({
        id: `tok:${file}#${++seq}`,
        text: word,
        line: lineNo,
        column: col,
        offset: offset + m.index,
        kind,
      });
      if (kind === "garbage") {
        diagnostics.push({
          code: "GARBAGE_TOKEN",
          severity: "error",
          message: `Token は整数ではありません: "${word}"`,
          where: { file, line: lineNo, column: col },
          tokenIds: [`tok:${file}#${seq}`],
        });
      }
      void column;
    }
    offset += rawLine.length + 1;
  });
  return { tokens, diagnostics };
}

function repeatedAndTautology(
  lits: number[],
  tokenIds: string[],
  file: "cnf" | "drat",
  line: number
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Map<number, number>();
  for (let i = 0; i < lits.length; i++) {
    const lit = lits[i];
    const prev = seen.get(lit);
    if (prev !== undefined) {
      out.push({
        code: "REPEATED_LITERAL",
        severity: "warning",
        message: `重複したリテラル ${lit} (位置 ${prev + 1} と ${i + 1}) は構文情報として保持されます`,
        where: { file, line },
        tokenIds: [tokenIds[prev], tokenIds[i]],
      });
    }
    seen.set(lit, i);
    if (seen.has(-lit)) {
      out.push({
        code: "TAUTOLOGY",
        severity: "info",
        message: `相補リテラル ${lit} / ${-lit} を含むトートロジです (構文層で検出)`,
        where: { file, line },
        tokenIds: tokenIds.filter(
          (id, j) => lits[j] === lit || lits[j] === -lit
        ),
      });
    }
  }
  return out;
}

export function parseCnf(text: string): ParsedCnf {
  const { tokens, diagnostics } = tokenize(text, "cnf");
  const cur: TokenCursor = { tokens, seq: 0 };
  const clauses: ParsedClause[] = [];
  let declaredVars: number | null = null;
  let declaredClauses: number | null = null;
  const problemLineTokenIds: string[] = [];

  // Handle the 'p cnf n m' problem line.
  const meaningful = tokens.filter(
    (t) => t.kind !== "comment"
  );
  let idx = 0;
  if (
    meaningful.length >= 4 &&
    meaningful[0].kind === "header" &&
    meaningful[0].text === "p" &&
    meaningful[1].text === "cnf"
  ) {
    problemLineTokenIds.push(
      meaningful[0].id,
      meaningful[1].id,
      meaningful[2].id,
      meaningful[3].id
    );
    declaredVars = Number(meaningful[2].text);
    declaredClauses = Number(meaningful[3].text);
    idx = 4;
  }

  // Group remaining integer tokens by zero terminators.
  let litBuf: number[] = [];
  let tokBuf: string[] = [];
  let startLine = 0;
  let clauseSeq = 0;

  const flush = (terminatorTokenId: string | null, endLine: number) => {
    if (litBuf.length === 0 && terminatorTokenId === null) return;
    const id = `cl:cnf#${++clauseSeq}`;
    const clauseDiagnostics = repeatedAndTautology(
      litBuf,
      tokBuf,
      "cnf",
      startLine || endLine
    );
    if (terminatorTokenId === null && litBuf.length > 0) {
      clauseDiagnostics.push({
        code: "MISSING_ZERO",
        severity: "error",
        message: "終端の 0 がありません (入力末尾までのリテラルを 1 節として保持)",
        where: { file: "cnf", line: endLine },
      });
    }
    clauses.push({
      id,
      origin: "cnf",
      literals: [...litBuf],
      literalTokenIds: [...tokBuf],
      terminatorTokenId,
      startLine: startLine || endLine,
      endLine,
      diagnostics: clauseDiagnostics,
    });
    litBuf = [];
    tokBuf = [];
    startLine = 0;
  };

  for (; idx < meaningful.length; idx++) {
    const t = meaningful[idx];
    if (t.kind === "integer") {
      if (!startLine) startLine = t.line;
      litBuf.push(Number(t.text));
      tokBuf.push(t.id);
    } else if (t.kind === "zero") {
      if (!startLine) startLine = t.line;
      flush(t.id, t.line);
    } else {
      // unexpected header word / garbage already reported
      if (!startLine) startLine = t.line;
    }
  }
  if (litBuf.length > 0) flush(null, meaningful[meaningful.length - 1]?.line ?? 1);

  if (
    declaredClauses !== null &&
    declaredClauses !== clauses.length
  ) {
    diagnostics.push({
      code: "HEADER_MISMATCH",
      severity: "warning",
      message: `ヘッダは節数 ${declaredClauses} を宣言していますが、実際は ${clauses.length} 節です`,
      where: { file: "cnf", line: 1 },
      tokenIds: problemLineTokenIds,
    });
  }

  return {
    tokens,
    clauses,
    header: { declaredVars, declaredClauses, problemLineTokenIds },
    diagnostics,
  };
}

export function parseDrat(text: string): ParsedDrat {
  const { tokens, diagnostics } = tokenize(text, "drat");
  const lines: ProofLine[] = [];
  const byLine = new Map<number, RawToken[]>();
  for (const t of tokens) {
    if (!byLine.has(t.line)) byLine.set(t.line, []);
    byLine.get(t.line)!.push(t);
  }
  const lineNos = [...byLine.keys()].sort((a, b) => a - b);
  let seq = 0;
  for (const lineNo of lineNos) {
    const toks = byLine.get(lineNo)!;
    if (toks.length === 0) continue;
    let op: ProofLine["op"] = "add";
    let prefixTokenId: string | null = null;
    let body = toks;
    const first = toks[0];
    if (first.text === "d" && /^[+-]?\d+$/.test(first.text) === false) {
      op = "delete";
      prefixTokenId = first.id;
      body = toks.slice(1);
    }
    const literals: number[] = [];
    const literalTokenIds: string[] = [];
    let terminatorTokenId: string | null = null;
    const lineDiagnostics: Diagnostic[] = [];
    for (const t of body) {
      if (t.kind === "zero") {
        terminatorTokenId = t.id;
      } else if (t.kind === "integer") {
        literals.push(Number(t.text));
        literalTokenIds.push(t.id);
      }
    }
    const id = `pl#${++seq}`;
    lineDiagnostics.push(
      ...repeatedAndTautology(literals, literalTokenIds, "drat", lineNo)
    );
    const rawText = toks.map((t) => t.text).join(" ");
    // A blank deletion prefix with nothing else is still "syntax" for RAT note.
    if (op === "delete" && literals.some((l) => l < 0)) {
      lineDiagnostics.push({
        code: "RAT_SYNTAX_DELETE",
        severity: "info",
        message:
          "削除節に負リテラルを含みます。RAT pivot は追加節の先頭リテラルで定義され、削除行は RAT 検査を持ちません",
        where: { file: "drat", line: lineNo },
        proofLineId: id,
      });
    }
    if (terminatorTokenId === null) {
      lineDiagnostics.push({
        code: "MISSING_ZERO",
        severity: "error",
        message: "proof 行が 0 で終了していません",
        where: { file: "drat", line: lineNo },
        proofLineId: id,
      });
    }
    lines.push({
      id,
      index: seq,
      op,
      literals,
      literalTokenIds,
      terminatorTokenId,
      prefixTokenId,
      startLine: lineNo,
      endLine: lineNo,
      rawText,
      diagnostics: lineDiagnostics,
    });
  }
  return { tokens, lines, diagnostics };
}

export function buildParsedClause(
  literals: number[],
  origin: ParsedClause["origin"],
  seq: number
): ParsedClause {
  return {
    id: origin === "cnf" ? `cl:cnf#${seq}` : `cl:add#${seq}`,
    origin,
    literals,
    literalTokenIds: [],
    terminatorTokenId: null,
    startLine: 0,
    endLine: 0,
    diagnostics: [],
  };
}
