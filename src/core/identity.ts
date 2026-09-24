/**
 * 稳定身份工具。
 * 身份是内容无关的坐标身份（导入序号/行号/版本），保证：
 *  - 导出、删库、再导入后身份不变；
 *  - 源修订产生新命名空间，不覆盖旧身份；
 *  - 副本删除后身份不重用。
 */

export function cnfTokenId(revisionId: string, seq: number): string {
  return `${revPrefix(revisionId)}cnf.tok#${seq}`;
}
export function cnfClauseId(revisionId: string, idx: number): string {
  return `${revPrefix(revisionId)}cnf.cl#${idx}`;
}
export function proofTokenId(revisionId: string, seq: number): string {
  return `${revPrefix(revisionId)}prf.tok#${seq}`;
}
export function proofLineId(revisionId: string, idx: number): string {
  return `${revPrefix(revisionId)}prf.line#${idx}`;
}
export function activeInstanceId(specId: string, copy: number): string {
  return copy === 0 ? `act.${specId}` : `act.${specId}#${copy}`;
}
export function versionId(caseId: string, seq: number): string {
  return `${caseId}.v#${seq}`;
}
export function eventId(caseId: string, seq: number): string {
  return `${caseId}.e#${seq}`;
}
export function ruleSetId(version: number): string {
  return `rules.drat.v${version}`;
}

function revPrefix(revisionId: string): string {
  return revisionId === 'r0' ? '' : `${revisionId}.`;
}

/** 导出/导入指纹：对规范化档案计算，确认身份关系未漂移。 */
export async function fingerprint(obj: unknown): Promise<string> {
  const json = stableStringify(obj);
  const buf = new TextEncoder().encode(json);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((obj as Record<string, unknown>)[k])}`).join(',')}}`;
}
