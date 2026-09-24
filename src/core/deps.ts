import { Derivation } from './events.js';

export interface ImpactReport {
  affected: { id: string; why: string }[];
  kept: { id: string; why: string }[];
}

/**
 * Dependency-graph propagation: a derivation is stale iff one of its direct
 * inputs changed. Derivations that do not depend on a changed input keep their
 * result, with an explicit reason.
 */
export function analyzeImpact(derivations: Derivation[], changedInputIds: string[]): ImpactReport {
  const changed = new Set(changedInputIds);
  const affected: ImpactReport['affected'] = [];
  const kept: ImpactReport['kept'] = [];
  for (const d of derivations) {
    const hit = d.inputs.find((i) => changed.has(i.id));
    if (hit) {
      affected.push({ id: d.id, why: `input ${hit.type}:${hit.id} changed; recomputation required` });
    } else {
      kept.push({ id: d.id, why: `no dependency on changed inputs {${changedInputIds.join(', ')}}; result still valid` });
    }
  }
  return { affected, kept };
}
