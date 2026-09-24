import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDimacs } from '../core/dimacs.js';
import { parseDrat } from '../core/drat.js';
import { checkProof, Budget, DEFAULT_BUDGET, ProofRunResult } from '../core/checker.js';
import { analyzeImpact } from '../core/deps.js';
import { Derivation, DerivationInput } from '../core/events.js';
import { stableId } from '../core/ids.js';
import { Repo } from './repo.js';

interface CaseDef {
  slug: string; title: string; cnf: string; proof: string; expect: string;
  mutates?: string; budget?: Budget;
}
interface PackManifest { name: string; title: string; units: Record<string, string>; cases: CaseDef[] }

export function computeDerivationId(caseId: string, dkey: string, inputs: DerivationInput[], result: unknown): string {
  return stableId('drv', { caseId, dkey, inputs, result });
}

function verifyDerivation(caseId: string, cnfDocId: string, proofDocId: string, paramsDocId: string, cnfText: string, proofText: string, budget: Budget, explanation: string) {
  const cnf = parseDimacs(cnfText);
  const proof = parseDrat(proofText);
  const result = checkProof(cnf, proof, budget);
  const inputs: DerivationInput[] = [
    { type: 'document', id: cnfDocId },
    { type: 'document', id: proofDocId },
    { type: 'params', id: paramsDocId },
  ];
  return { cnf, proof, result, derivation: { dkey: 'verify', inputs, result, explanation } };
}

/** Build the whole offline case pack: baseline, one-source mutations, revisions, conflict. */
export function seedCasePack(repo: Repo, fixturesDir: string): void {
  const manifest = JSON.parse(readFileSync(join(fixturesDir, 'casepack.json'), 'utf8')) as PackManifest;
  const read = (f: string) => readFileSync(join(fixturesDir, f), 'utf8');

  const defaultParamsDoc = repo.addDocument('params', 'default-budget.json', JSON.stringify({ ...DEFAULT_BUDGET, unit: 'up-step' }));
  const caseIds: Record<string, string> = {};

  for (const def of manifest.cases) {
    const caseId = repo.createCase(def.slug, def.title);
    caseIds[def.slug] = caseId;
    const cnfText = read(def.cnf);
    const proofText = read(def.proof);
    const cnfDoc = repo.addDocument('cnf', def.cnf, cnfText);
    const proofDoc = repo.addDocument('drat', def.proof, proofText);
    const budget = def.budget ?? DEFAULT_BUDGET;
    const paramsDoc = def.budget
      ? repo.addDocument('params', `budget-${def.slug}.json`, JSON.stringify({ ...budget, unit: 'up-step' }))
      : defaultParamsDoc;

    const { cnf, proof, result, derivation } = verifyDerivation(caseId, cnfDoc.id, proofDoc.id, paramsDoc.id, cnfText, proofText, budget, 'initial verification from imported sources');
    const drvId = computeDerivationId(caseId, 'verify', derivation.inputs, result);
    repo.commit({
      caseId, baseVersionId: null, note: `import ${def.slug}`,
      events: [
        { kind: 'import_documents', payload: {
            documents: [cnfDoc, proofDoc, paramsDoc].map((d) => ({ id: d.id, kind: d.kind, name: d.name, hash: d.hash })),
            preserved: {
              dimacsTokens: cnf.tokens.length, variables: cnf.maxVar, clauses: cnf.clauses.length,
              proofLines: proof.lines.length, offsetUnit: 'byte', budget: { ...budget, unit: 'up-step' },
              rawRepresentationsKept: true,
            },
            cnfParse: cnf, dratParse: proof,
          } },
        { kind: 'verify_run', payload: { derivationId: drvId, status: result.status, statusReason: result.statusReason, totalUpSteps: result.totalUpSteps, upStepUnit: 'up-step', failingPrefix: result.failingPrefix } },
        { kind: 'rule_judgment', payload: { judgments: result.ruleJudgments } },
      ],
      derivations: [derivation],
    });
  }

  // --- Revision 1: parameter revision on budget-exhaust (budget 5 -> 50 up-steps per step) ---
  const budgetCase = caseIds['budget-exhaust'];
  {
    const state = repo.caseState(budgetCase);
    const verify = state.derivations.find((d) => d.dkey === 'verify')!;
    const oldResult = verify.result as ProofRunResult;
    const cnfDocId = (verify.inputs.find((i) => i.type === 'document')!).id;
    const inputs = verify.inputs;
    const proofDocId = inputs[1].id;
    const oldParamsId = inputs[2].id;
    const cnfDoc = repo.getDocument(cnfDocId)!;
    const proofDoc = repo.getDocument(proofDocId)!;
    const newBudget: Budget = { maxUpStepsPerStep: 50, maxUpStepsTotal: 1000 };
    const newParamsDoc = repo.addDocument('params', 'budget-exhaust-raised.json', JSON.stringify({ ...newBudget, unit: 'up-step' }));
    const { result } = verifyDerivation(budgetCase, cnfDocId, proofDocId, newParamsDoc.id, cnfDoc.content, proofDoc.content, newBudget, 'recomputed: params input changed (budget raised)');
    const allDrv = repo.derivationsAt(budgetCase, state.viewVersion!.seq);
    const impact = analyzeImpact(allDrv, [oldParamsId]);
    repo.commit({
      caseId: budgetCase, baseVersionId: state.current!.id, note: 'param revision: raise up-step budget',
      events: [
        { kind: 'param_revision', payload: { before: { docId: oldParamsId, budget: oldResult.budget }, after: { docId: newParamsDoc.id, budget: newBudget }, unit: 'up-step', impact } },
        { kind: 'verify_run', payload: { derivationId: computeDerivationId(budgetCase, 'verify', [
            { type: 'document', id: cnfDocId }, { type: 'document', id: proofDocId }, { type: 'params', id: newParamsDoc.id },
          ], result), status: result.status, statusReason: result.statusReason, totalUpSteps: result.totalUpSteps, upStepUnit: 'up-step', failingPrefix: result.failingPrefix } },
        { kind: 'rule_judgment', payload: { judgments: result.ruleJudgments } },
      ],
      derivations: [{ dkey: 'verify', inputs: [
        { type: 'document', id: cnfDocId }, { type: 'document', id: proofDocId }, { type: 'params', id: newParamsDoc.id },
      ], result, explanation: `recomputed because params:${oldParamsId} changed; unaffected inputs kept` }],
    });
  }

  // --- Revision 2: local source change on missing-zero (fix line 3 terminator) ---
  const mzCase = caseIds['missing-zero'];
  {
    const state = repo.caseState(mzCase);
    const verify = state.derivations.find((d) => d.dkey === 'verify')!;
    const cnfDocId = verify.inputs[0].id;
    const proofDocId = verify.inputs[1].id;
    const paramsId = verify.inputs[2].id;
    const cnfDoc = repo.getDocument(cnfDocId)!;
    const proofDoc = repo.getDocument(proofDocId)!;
    const fixedText = proofDoc.content.replace('d 1 2\n', 'd 1 2 0\n');
    const newProofDoc = repo.addDocument('drat', 'mut-missing-zero-fixed.drat', fixedText);
    const budget = JSON.parse(repo.getDocument(paramsId)!.content) as Budget;
    const { proof: newParse, result } = verifyDerivation(mzCase, cnfDocId, newProofDoc.id, paramsId, cnfDoc.content, fixedText, budget, 'recomputed: proof source changed (zero terminator fixed)');
    const impact = analyzeImpact(repo.derivationsAt(mzCase, state.viewVersion!.seq), [proofDocId]);
    repo.commit({
      caseId: mzCase, baseVersionId: state.current!.id, note: 'source change: add missing zero terminator on proof line 3',
      events: [
        { kind: 'source_change', payload: { scope: 'proof', beforeDocId: proofDocId, afterDocId: newProofDoc.id, changedLines: [3], dratParse: newParse, impact } },
        { kind: 'verify_run', payload: { derivationId: computeDerivationId(mzCase, 'verify', [
            { type: 'document', id: cnfDocId }, { type: 'document', id: newProofDoc.id }, { type: 'params', id: paramsId },
          ], result), status: result.status, statusReason: result.statusReason, totalUpSteps: result.totalUpSteps, upStepUnit: 'up-step', failingPrefix: result.failingPrefix } },
        { kind: 'rule_judgment', payload: { judgments: result.ruleJudgments } },
      ],
      derivations: [{ dkey: 'verify', inputs: [
        { type: 'document', id: cnfDocId }, { type: 'document', id: newProofDoc.id }, { type: 'params', id: paramsId },
      ], result, explanation: `recomputed because document:${proofDocId} changed; cnf and params inputs unchanged` }],
    });
  }

  // --- Revision 3: two reviewers decide from the same version -> resolvable conflict ---
  {
    const state = repo.caseState(budgetCase);
    const base = state.current!.id;
    const decisionA = { kind: 'decision' as const, payload: { verdict: 'accept', rationale: '预算提高后空子句在 12 个 up-step 内导出，证明有效', target: 'verify', author: 'reviewer-A' } };
    const decisionB = { kind: 'decision' as const, payload: { verdict: 'reject', rationale: '原预算下证明不完整，不应采纳', target: 'verify', author: 'reviewer-B' } };
    const first = repo.commit({ caseId: budgetCase, baseVersionId: base, note: 'decision A', events: [decisionA], derivations: [], author: 'reviewer-A' });
    if (first.outcome !== 'committed') throw new Error('expected first decision to commit');
    const second = repo.commit({ caseId: budgetCase, baseVersionId: base, note: 'decision B', events: [decisionB], derivations: [], author: 'reviewer-B' });
    if (second.outcome !== 'conflict') throw new Error('expected second decision to conflict');
    repo.commit({
      caseId: budgetCase, baseVersionId: repo.currentVersion(budgetCase)!.id, note: 'conflict raised',
      events: [{ kind: 'conflict_raised', payload: { conflictId: second.conflictId, base, candidates: ['reviewer-A: accept', 'reviewer-B: reject'] } }],
      derivations: [],
    });
    repo.resolveConflict(second.conflictId, -1); // keep reviewer-A branch; reviewer-B candidate preserved
  }
}
