// 派生层规范化：原始字符串在导入时已保留，这里只做带单位/基准的转换。
// 无法转换的值留在原位置（value=null, raw 保留）并附诊断，绝不为了派生计算丢掉。
import type { Diagnostic, Quantity } from './types';

export function qty(value: number | null, unit: string, basis: string, raw: string): Quantity {
  return { value, unit, basis, raw };
}

export function toIntQuantity(raw: string, unit: string, basis: string): { q: Quantity; diag?: Diagnostic } {
  if (!/^[+-]?\d+$/.test(raw)) {
    return {
      q: qty(null, unit, basis, raw),
      diag: { code: 'not_an_integer', message: `无法把 "${raw}" 解析为整数，原值保留`, severity: 'error' },
    };
  }
  const v = Number(raw);
  if (!Number.isSafeInteger(v)) {
    return {
      q: qty(null, unit, basis, raw),
      diag: {
        code: 'unsafe_integer',
        message: `整数 ${raw} 超出安全范围（>2^53），保留原始 token，不参与规范化计算`,
        severity: 'warning',
      },
    };
  }
  return { q: qty(v, unit, basis, raw) };
}

export function offsetQty(byteOffset: number): Quantity {
  return qty(byteOffset, 'byte', 'file-offset-0', String(byteOffset));
}

export function varQty(raw: string): { q: Quantity; diag?: Diagnostic } {
  return toIntQuantity(raw, '1', 'dimacs-variable-index');
}

export function budgetQty(steps: number): Quantity {
  return qty(steps, 'propagation-step', 'rup-check', String(steps));
}
