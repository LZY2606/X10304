// 依赖图传播式重算：只更新受影响部分，并能说明某项结果为何仍有效或为何需要重算。
export interface DerivationNode { key: string; deps: string[] }

export interface RecomputePlan {
  affected: string[];                       // 需要重算的节点
  reused: { key: string; reason: string }[]; // 仍有效的节点及原因
}

export function buildProofGraph(proofLineCount: number): DerivationNode[] {
  const nodes: DerivationNode[] = [
    { key: 'parse:cnf', deps: ['src:cnf'] },
    { key: 'parse:proof', deps: ['src:proof'] },
    { key: 'params', deps: ['src:params'] },
  ];
  for (let i = 0; i < proofLineCount; i++) {
    const deps = ['parse:proof', 'params'];
    if (i > 0) deps.push(`step:${i - 1}`);
    else deps.push('parse:cnf');
    nodes.push({ key: `step:${i}`, deps });
  }
  nodes.push({ key: 'verdict', deps: proofLineCount > 0 ? [`step:${proofLineCount - 1}`] : ['parse:cnf'] });
  return nodes;
}

export function planRecompute(nodes: DerivationNode[], changedKeys: string[]): RecomputePlan {
  const byKey = new Map(nodes.map(n => [n.key, n]));
  const affected = new Set<string>();
  const queue = [...changedKeys];
  while (queue.length) {
    const k = queue.shift()!;
    for (const n of nodes) {
      if (n.deps.includes(k) && !affected.has(n.key)) {
        affected.add(n.key);
        queue.push(n.key);
      }
    }
  }
  for (const k of changedKeys) affected.delete(k); // 源本身不是派生节点
  const reused = nodes
    .filter(n => !affected.has(n.key) && !changedKeys.includes(n.key))
    .map(n => ({
      key: n.key,
      reason: `依赖（${n.deps.join(', ')}）均未变化，结果仍有效`,
    }))
    .filter(n => byKey.has(n.key));
  return { affected: [...affected].sort(), reused };
}
