import { parseCnf, clauseKey, isTautology } from './src/core/dimacs.ts';
import { readFileSync } from 'node:fs';
import { parseDrat } from './src/core/drat.ts';
import { checkProof } from './src/core/checker.ts';

const cnfText = readFileSync('fixtures/casepack/baseline.cnf','utf8');
const cnf = parseCnf('b.cnf', cnfText);
// simulate after deleting C2 (-1 2)
const cnf2 = parseCnf('b.cnf', cnfText);
(cnf2 as any).clauses = cnf2.clauses.filter(c => clauseKey(c.lits) !== '-1,2');

// candidate clauses from literals ±1..±3, sizes 1..2
const lits = [1,2,3,-1,-2,-3];
const cands: number[][] = [];
for (const l of lits) cands.push([l]);
for (const a of lits) for (const b of lits) {
  if (a === b || a === -b) continue;
  const c = [a,b].sort((x,y)=>Math.abs(x)-Math.abs(y));
  if (!cands.some(x=>clauseKey(x)===clauseKey([a,b]))) cands.push([a,b]);
}
for (const c of cands) {
  // try both orderings
  for (const ord of [c, [...c].reverse()]) {
    const proof = ord.join(' ') + ' 0\n';
    const r = checkProof(cnf2, parseDrat('x.drat', proof), {budget:64});
    const s = r.steps[0];
    if (s.kind !== 'add') continue;
    const rat = s.events.find((e:any)=>e.kind==='rat_check');
    if (rat && rat.status === 'diagnostic') {
      console.log('FOUND', JSON.stringify(ord), JSON.stringify(rat.details.okPivots),
        JSON.stringify(s.pivotCandidates.map((pc:any)=>({p:pc.pivot,ok:pc.ok,res:pc.resolvents}))));
    }
  }
}
