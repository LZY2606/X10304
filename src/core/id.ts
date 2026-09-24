import { createHash } from 'node:crypto';

// 稳定身份：内容寻址。导出/删除数据库/再导入后身份不变。
export function stableId(...parts: (string | number)[]): string {
  const h = createHash('sha1');
  for (const p of parts) h.update(String(p)).update('');
  return h.digest('hex').slice(0, 16);
}
