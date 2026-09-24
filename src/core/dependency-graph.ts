/**
 * 依赖图 + 增量重算。
 *
 * 节点：source token/子句/proof 行、参数版本、规则版本、逐行结果、最终裁定、人工决定。
 * 边：derived -> dependsOn。源修订不就地覆盖：旧修订节点保留，新修订产生新节点。
 *
 * 一个节点仍有效 ⇔ 它 closure 内所有依赖的内容指纹与记录一致。
 */

export type NodeKind =
  | 'cnf-source'
  | 'cnf-clause'
  | 'cnf-token'
  | 'proof-source'
  | 'proof-line'
  | 'proof-token'
  | 'params'
  | 'ruleset'
  | 'line-result'
  | 'verdict'
  | 'decision';

export interface GraphNode {
  nodeId: string;
  kind: NodeKind;
  revisionId: string;
  /** 内容指纹：源节点对原始文本；派生节点对其计算输入。 */
  fingerprint: string;
  createdAt: string;
  deprecatedBy?: string; // 被哪个修订节点取代（旧节点仍在）
}

export interface GraphEdge {
  from: string; // 依赖者
  to: string;   // 被依赖者
  role: 'data' | 'rule' | 'params' | 'decision' | 'line-order';
}

export interface RecomputePlan {
  changedNodes: string[];
  invalidated: { nodeId: string; reason: string }[];
  stillValid: { nodeId: string; reason: string }[];
  recomputeOrder: string[];
}

export class DependencyGraph {
  nodes = new Map<string, GraphNode>();
  edges: GraphEdge[] = [];

  upsertNode(node: GraphNode): void {
    this.nodes.set(node.nodeId, node);
  }
  addEdge(edge: GraphEdge): void {
    if (!this.edges.some((e) => e.from === edge.from && e.to === edge.to && e.role === edge.role)) {
      this.edges.push(edge);
    }
  }
  deprecate(oldId: string, newId: string): void {
    const n = this.nodes.get(oldId);
    if (n) n.deprecatedBy = newId;
  }
  dependentsOf(id: string): GraphEdge[] {
    return this.edges.filter((e) => e.to === id);
  }
  dependenciesOf(id: string): GraphEdge[] {
    return this.edges.filter((e) => e.from === id);
  }

  /**
   * 给定发生变化的源节点集合（其 fingerprint 已更新或节点为新修订），
   * 沿反向边传播失效；未受波及的派生节点给出“仍有效”理由。
   */
  planRecompute(changedSourceIds: string[], allDerivedIds: string[]): RecomputePlan {
    const invalid = new Map<string, string>();
    const queue: { id: string; reason: string }[] = changedSourceIds.map((id) => ({
      id,
      reason: `源节点 ${id} 已修订`
    }));
    while (queue.length) {
      const { id, reason } = queue.shift()!;
      for (const edge of this.dependentsOf(id)) {
        const ownReason = `${describeRole(edge.role)}依赖 ${id} 失效（${reason}）`;
        if (!invalid.has(edge.from)) {
          invalid.set(edge.from, ownReason);
          queue.push({ id: edge.from, reason: ownReason });
        }
      }
    }
    const recomputeOrder: string[] = [];
    const seen = new Set<string>();
    const visit = (id: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const e of this.dependenciesOf(id)) if (invalid.has(e.to)) visit(e.to);
      recomputeOrder.push(id);
    };
    [...invalid.keys()].sort().forEach(visit);

    const stillValid = allDerivedIds
      .filter((id) => !invalid.has(id))
      .map((id) => {
        const deps = this.dependenciesOf(id).map((e) => e.to);
        return {
          nodeId: id,
          reason: deps.length
            ? `依赖闭包 [${deps.join(', ')}] 指纹未变，结果仍有效`
            : '无依赖，结果仍有效'
        };
      });

    return {
      changedNodes: [...changedSourceIds],
      invalidated: [...invalid.entries()].map(([nodeId, reason]) => ({ nodeId, reason })),
      stillValid,
      recomputeOrder
    };
  }
}

function describeRole(role: GraphEdge['role']): string {
  switch (role) {
    case 'data':
      return '数据';
    case 'rule':
      return '规则';
    case 'params':
      return '参数';
    case 'decision':
      return '决定';
    case 'line-order':
      return '顺序';
  }
}
