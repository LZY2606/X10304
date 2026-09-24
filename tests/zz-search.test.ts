import { it } from 'vitest';
import { parseCnf, clauseKey } from '../src/core/dimacs';
import { parseDrat } from '../src/core/drat';
import { checkProof } from '../src/core/checker';

const CNF = `p cnf 4 12
1 2 0
-1 2 0
1 -2 0
-1 -2 3 0
-1 -3 0
1 -3 0
1 4 -3 0
1 4 0
3 -4 0
3 -2 4 0
-2 3 0
-4 1 -2 0
`;

it('extended baseline', () => {
  const cnf = parseCnf('b.cnf', CNF);
  const proof = ['2 1 0','3 0','-1 0','1 0','2 0','-2 0','d 1 2 0','0'].join('\n') + '\n';
  const r = checkProof(cnf, parseDrat('b.drat', proof), { budget: 64 });
  console.log('verdict', r.verdict);
  for (const s of r.steps) {
    const rat = s.events.find((e:any)=>e.kind==='rat_check');
    console.log(s.lineIndex, s.kind, JSON.stringify(s.lits), s.status,
      rat ? `rat=${rat.status} okPivots=${JSON.stringify((rat.details as any).okPivots)}` : '');
  }
  // find a clause where RAT fails completely (for the mutation), at prefix 0
  const lits = [1,2,3,4,-1,-2,-3,-4];
  const pairs: number[][] = [];
  for (const a of lits) for (const b of lits) {
    if (a === b || a === -b) continue;
    if (!pairs.some(x=>clauseKey(x)===clauseKey([a,b]))) pairs.push([a,b]);
  }
  for (const C of pairs) {
    const rr = checkProof(cnf, parseDrat('x.drat', C.join(' ') + ' 0\n'), {budget:64});
    const s0 = rr.steps[0];
    const rat = s0.events.find((e:any)=>e.kind==='rat_check');
    if (rat && rat.status === 'failed') {
      console.log('FAILCASE', JSON.stringify(C), JSON.stringify(s0.pivotCandidates.map((p:any)=>p.pivot)));
      break;
    }
  }
});
