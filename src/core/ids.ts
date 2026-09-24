import { createHash } from 'node:crypto';

/** Canonical JSON: object keys sorted recursively so hashing is stable. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Stable, content-addressed identity. Same content => same id, across export/import. */
export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${contentHash(value).slice(0, 20)}`;
}
