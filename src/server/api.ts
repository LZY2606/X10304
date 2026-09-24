import { IncomingMessage, ServerResponse } from 'node:http';
import { Repo } from './repo.js';
import { parseDimacs } from '../core/dimacs.js';
import { parseDrat } from '../core/drat.js';
import { checkProof, Budget } from '../core/checker.js';
import { analyzeImpact } from '../core/deps.js';
import { computeDerivationId } from './casepack.js';

function send(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}
async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function caseSummary(repo: Repo, caseId: string) {
  const state = repo.caseState(caseId);
  const verify = state.derivations.find((d) => d.dkey === 'verify');
  const result = verify ? (verify.result as { status: string }) : null;
  return { currentVersion: state.current, status: result?.status ?? 'unknown', openConflicts: state.conflicts.filter((c) => c.status === 'open').length };
}

export function createApiHandler(repo: Repo) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      if (req.method === 'GET' && path === '/api/cases') {
        const cases = repo.listCases().map((c) => ({ ...c, ...caseSummary(repo, c.id) }));
        return send(res, 200, { cases });
      }
      const stateMatch = path.match(/^\/api\/cases\/([^/]+)\/state$/);
      if (req.method === 'GET' && stateMatch) {
        const caseId = stateMatch[1];
        const versionId = url.searchParams.get('versionId') ?? undefined;
        const state = repo.caseState(caseId, versionId);
        const docs = new Map<string, unknown>();
        for (const d of state.derivations) {
          for (const i of d.inputs) {
            if (i.type === 'document' || i.type === 'params') {
              const doc = repo.getDocument(i.id);
              if (doc) docs.set(doc.id, doc);
            }
          }
        }
        return send(res, 200, { ...state, documents: [...docs.values()] });
      }
      const decisionMatch = path.match(/^\/api\/cases\/([^/]+)\/decision$/);
      if (req.method === 'POST' && decisionMatch) {
        const body = await readBody(req);
        const outcome = repo.commit({
          caseId: decisionMatch[1], baseVersionId: body.baseVersionId, note: `decision: ${body.verdict}`,
          events: [{ kind: 'decision', payload: { verdict: body.verdict, rationale: body.rationale, target: body.target ?? 'verify', author: body.author ?? 'reviewer' } }],
          derivations: [], author: body.author ?? 'reviewer',
        });
        return send(res, 200, outcome);
      }
      const paramsMatch = path.match(/^\/api\/cases\/([^/]+)\/params$/);
      if (req.method === 'POST' && paramsMatch) {
        const caseId = paramsMatch[1];
        const body = await readBody(req);
        const state = repo.caseState(caseId);
        const verify = state.derivations.find((d) => d.dkey === 'verify');
        if (!verify) return send(res, 400, { error: 'no verify derivation' });
        const cnfDocId = verify.inputs[0].id, proofDocId = verify.inputs[1].id, oldParamsId = verify.inputs[2].id;
        const cnfDoc = repo.getDocument(cnfDocId)!;
        const proofDoc = repo.getDocument(proofDocId)!;
        const newBudget: Budget = { maxUpStepsPerStep: Number(body.maxUpStepsPerStep), maxUpStepsTotal: Number(body.maxUpStepsTotal) };
        const newParamsDoc = repo.addDocument('params', `budget-ui-${Date.now()}.json`, JSON.stringify({ ...newBudget, unit: 'up-step' }));
        const cnf = parseDimacs(cnfDoc.content, cnfDoc.name);
        const proof = parseDrat(proofDoc.content, proofDoc.name);
        const result = checkProof(cnf, proof, newBudget);
        const inputs = [
          { type: 'document' as const, id: cnfDocId },
          { type: 'document' as const, id: proofDocId },
          { type: 'params' as const, id: newParamsDoc.id },
        ];
        const impact = analyzeImpact(state.derivations, [oldParamsId]);
        const outcome = repo.commit({
          caseId, baseVersionId: body.baseVersionId, note: 'param revision via UI',
          events: [
            { kind: 'param_revision', payload: { before: { docId: oldParamsId }, after: { docId: newParamsDoc.id, budget: newBudget }, unit: 'up-step', impact } },
            { kind: 'verify_run', payload: { derivationId: computeDerivationId(caseId, 'verify', inputs, result), status: result.status, statusReason: result.statusReason, totalUpSteps: result.totalUpSteps, upStepUnit: 'up-step', failingPrefix: result.failingPrefix } },
            { kind: 'rule_judgment', payload: { judgments: result.ruleJudgments } },
          ],
          derivations: [{ dkey: 'verify', inputs, result, explanation: `recomputed because params:${oldParamsId} changed` }],
          author: body.author ?? 'reviewer',
        });
        return send(res, 200, outcome);
      }
      const restoreMatch = path.match(/^\/api\/cases\/([^/]+)\/restore$/);
      if (req.method === 'POST' && restoreMatch) {
        const body = await readBody(req);
        const caseId = restoreMatch[1];
        const state = repo.caseState(caseId);
        const outcome = repo.commit({
          caseId, baseVersionId: state.current?.id ?? null, note: `restore view to ${body.versionId}`,
          events: [{ kind: 'restore_view', payload: { restoredVersionId: body.versionId, restoredEventId: body.eventId ?? null } }],
          derivations: [],
        });
        return send(res, 200, outcome);
      }
      const resolveMatch = path.match(/^\/api\/conflicts\/([^/]+)\/resolve$/);
      if (req.method === 'POST' && resolveMatch) {
        const body = await readBody(req);
        const outcome = repo.resolveConflict(resolveMatch[1], Number(body.winnerIndex), body.author ?? 'reviewer');
        return send(res, 200, outcome);
      }
      const exportMatch = path.match(/^\/api\/cases\/([^/]+)\/export$/);
      if (req.method === 'GET' && exportMatch) {
        return send(res, 200, repo.exportCase(exportMatch[1]));
      }
      if (req.method === 'POST' && path === '/api/import') {
        const body = await readBody(req);
        repo.importCase(body);
        return send(res, 200, { ok: true, caseId: body.case.id });
      }
      send(res, 404, { error: `no route ${req.method} ${path}` });
    } catch (err) {
      send(res, 500, { error: String((err as Error).message ?? err) });
    }
  };
}
