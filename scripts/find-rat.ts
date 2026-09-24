import { unitPropagate } from '../src/core/checker.js';

function isRup(clauses: number[][], c: number[]): boolean {
  const cls = clauses.map((lits, i) => ({ id: `c${i}`, lits }));
  const asm = c.map((l) => ({ var: Math.abs(l), value: l < 0 }));
  return unitPropagate(cls, asm, 100000).status === 'conflict';
}
function isTaut(lits: number[]): boolean {
  const s = new Set(lits);
  return lits.some((l) => s.has(-l));
}
function resolvent(c: number[], pivot: number, d: number[]): number[] {
  const set = new Set<number>();
  for (const l of c) if (l !== pivot) set.add(l);
  for (const l of d) if (l !== -pivot) set.add(l);
  return [...set];
}
function isRat(clauses: number[][], c: number[]): { ok: boolean; pivot: number; partners: number } {
  for (const pivot of c) {
    const ds = clauses.filter((d) => d.includes(-pivot));
    if (ds.length === 0) continue; // want a real partner
    let ok = true;
    for (const d of ds) {
      const r = resolvent(c, pivot, d);
      if (isTaut(r)) continue;
      if (!isRup(clauses, r)) { ok = false; break; }
    }
    if (ok) return { ok: true, pivot, partners: ds.length };
  }
  return { ok: false, pivot: 0, partners: 0 };
}

// all non-tautological clauses over 3 vars, size 1..3
const lits = [1, -1, 2, -2, 3, -3];
const all: number[][] = [];
for (const a of lits) all.push([a]);
for (const a of lits) for (const b of lits) {
  if (Math.abs(a) >= Math.abs(b)) continue;
  if (a === -b) continue;
  all.push([a, b]);
}
for (const a of lits) for (const b of lits) for (const cc of lits) {
  if (Math.abs(a) >= Math.abs(b) || Math.abs(b) >= Math.abs(cc)) continue;
  const cl = [a, b, cc];
  if (isTaut(cl)) continue;
  all.push(cl);
}

let seed = 1234567;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

for (let iter = 0; iter < 200000; iter++) {
  const nCls = 4 + Math.floor(rand() * 4);
  const f: number[][] = [];
  const seen = new Set<string>();
  while (f.length < nCls) {
    const c = all[Math.floor(rand() * all.length)];
    const k = [...c].sort((x, y) => x - y).join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    f.push(c);
  }
  const cand = all[Math.floor(rand() * all.length)];
  if (cand.length > 2) continue;
  if (isTaut(cand)) continue;
  if (isRup(f, cand)) continue;
  const rat = isRat(f, cand);
  if (rat.ok) {
    console.log('FOUND RAT-not-RUP');
    console.log('clause:', cand.join(' '), 'pivot:', rat.pivot, 'partners:', rat.partners);
    f.forEach((c) => console.log('  ', c.join(' '), '0'));
    process.exit(0);
  }
}
console.log('not found');
