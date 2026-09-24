/** Deterministic stable identities. Content-addressed, no randomness. */

export function hashString(input: string): string {
  // FNV-1a 32-bit, hex — stable across processes/import-export.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function clauseRef(sourceIndex: number, normalizedLiterals: readonly number[]): string {
  return `c:${sourceIndex}:${hashString(normalizedLiterals.join(','))}`;
}

export function proofLineRef(index: number, raw: string): string {
  return `p:${index}:${hashString(raw)}`;
}

export function tokenRef(source: 'cnf' | 'proof', startByte: number): string {
  return `t:${source}:${startByte}`;
}
