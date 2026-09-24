// 稳定身份与内容哈希。
// 身份只由语义内容/坐标决定，不依赖进程随机数或自增序列，
// 因此导出 -> 删除本地数据库 -> 重新导入后，身份、顺序与来源关系保持一致。

// FNV-1a 64 位，用两个 32 位整数模拟；输出 16 位 hex。
function fnv1a64(text: string): string {
  let hi = 0x811c9dc5;
  let lo = 0x84222325;
  const bytes = new TextEncoder().encode(text);
  for (const b of bytes) {
    lo ^= b;
    hi ^= 0;
    // lo * 0x01000193
    const loMul = Math.imul(lo, 0x01000193);
    // 64 位乘法的高位：近似取 hi*prime + 进位
    hi = Math.imul(hi, 0x01000193) + ((Math.imul(lo, 0x01000193) - loMul) / 0x100000000 | 0) + Math.floor(lo / 0x100000000) * 0x193;
    lo = loMul;
  }
  const h = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return h(hi) + h(lo);
}

export function contentHash(parts: Array<string | number | boolean | null | undefined | object>): string {
  const canonical = parts.map((p) => {
    if (typeof p === 'string') return JSON.stringify(p);
    if (p === null || p === undefined) return 'null';
    if (typeof p === 'object') return stableStringify(p);
    return String(p);
  }).join('|');
  return fnv1a64(canonical);
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

let counter = 0;
export function localSeq(): number {
  return ++counter;
}

export function makeId(parts: Array<string | number | boolean | object>): string {
  return contentHash(parts);
}

// 确定性短 id（档案 id 用可读前缀 + 内容哈希前 10 位）
export function scopedId(prefix: string, ...parts: Array<string | number | boolean | object>): string {
  return `${prefix}_${contentHash(parts).slice(0, 10)}`;
}
