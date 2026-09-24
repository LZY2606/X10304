/** 子句规范化：只在派生层进行；原始 token 始终保留。 */

/** 多重集签名（保留重复 literal 与顺序无关性）。 */
export function multisetSignature(lits: number[]): string {
  return [...lits].sort((a, b) => a - b).join(',');
}

/** 集合签名（去重后），用于 RUP/RAT 语义。 */
export function setSignature(lits: number[]): string {
  return [...new Set(lits)].sort((a, b) => a - b).join(',');
}

export function isTautology(lits: number[]): boolean {
  const s = new Set(lits);
  for (const l of lits) if (s.has(-l)) return true;
  return false;
}

export function duplicateLiterals(lits: number[]): number[] {
  const seen = new Set<number>();
  const dup = new Set<number>();
  for (const l of lits) {
    if (seen.has(l)) dup.add(l);
    seen.add(l);
  }
  return [...dup].sort((a, b) => a - b);
}

export function normalizeClause(lits: number[]): number[] {
  return [...new Set(lits)].sort((a, b) => a - b);
}
