/**
 * 稳定身份（stable identity）。
 *
 * 身份基于来源坐标（文件、行号、token 序号）而不是数组下标或自增主键：
 * 导出 -> 删除本地数据库 -> 再导入后，身份、顺序与来源关系不变。
 */

export type Id = string;

export interface Coords {
  /** 来源名，例如 "formula.cnf" / "proof.drat"，是导入时保留的原始文件名。 */
  source: string;
  /** 1-based 行号（物理行，按 \n 切分）。 */
  line: number;
  /** 0-based 物理列偏移（字节/字符偏移，以 JS UTF-16 码元计）。 */
  col: number;
}

export function coordKey(c: Coords): Id {
  return `${c.source}@${c.line}:${c.col}`;
}

/** 域内前缀，防止不同对象类型的身份空间冲突。 */
export function ids(prefix: string, ...parts: Array<string | number>): Id {
  return `${prefix}:${parts.join('|')}`;
}

/** 为案例内对象加命名空间；导出/导入保持 caseId 不变，从而身份完全稳定。 */
export function namespaced(caseId: string, local: Id): Id {
  return `case:${caseId}/${local}`;
}
