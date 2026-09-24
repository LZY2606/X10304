import './styles.css';

/* ---------- types mirrored from core (display layer only) ---------- */
interface Diagnostic { code: string; severity: string; message: string; offsetBytes?: number; line?: number; tokenRaw?: string }
interface ClauseRec { id: string; occurrence: number; lits: number[]; key: string; rawText: string; offsetBytes: number; line: number; syntax: { tautology: boolean; duplicateLits: number[]; zeroTerminated: boolean; hugeLiterals: string[] } }
interface CnfParse { clauses: ClauseRec[]; tokens: { raw: string; value: number | null; offsetBytes: number; line: number }[]; diagnostics: Diagnostic[]; maxVar: number; header: { raw: string; offsetBytes: number; line: number } | null }
interface ProofLineT { index: number; id: string; kind: 'add' | 'del'; lits: number[]; raw: string; offsetBytes: number; line: number; syntax: ClauseRec['syntax'] }
interface DratParseT { lines: ProofLineT[]; diagnostics: Diagnostic[] }
interface UpTrace { var: number; value: boolean; reasonClauseId: string; reasonClauseLits: number[] }
interface StepT { lineId: string; lineIndex: number; lineKind: string; verdict: any; activeCountAfter: number; activeAfter: { key: string; lits: number[]; ids: string[]; count: number }[]; syntaxNotes: string[] }
interface RunResult { id: string; status: string; statusReason: string; steps: StepT[]; failingPrefix: { lineIds: string[]; reason: string } | null; totalUpSteps: number; budget: { maxUpStepsPerStep: number; maxUpStepsTotal: number }; ruleJudgments: { code: string; applies: boolean; detail: string }[] }
interface EventT { id: string; seq: number; versionId: string | null; kind: string; payload: any; createdAt: string }
interface DerivationT { id: string; dkey: string; inputs: { type: string; id: string }[]; result: RunResult; explanation: string }
interface State {
  versions: { id: string; seq: number; note: string }[]; current: { id: string; seq: number } | null;
  viewVersion: { id: string; seq: number; note: string } | null;
  events: EventT[]; derivations: DerivationT[];
  conflicts: { id: string; status: string; candidates: string; resolution: string | null }[];
  documents: { id: string; kind: string; name: string; content: string }[];
}
interface CaseItem { id: string; name: string; title: string; status: string; openConflicts: number }

/* ---------- state ---------- */
let cases: CaseItem[] = [];
let activeCase = '';
let state: State | null = null;
let selectedStep = -1;
let viewingVersion: string | null = null; // historical view

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const idTag = (id: string) => `<span class="id" title="stable identity">${esc(id)}</span>`;

async function api(path: string, body?: unknown): Promise<any> {
  const res = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function loadCases(): Promise<void> {
  const data = await api('/api/cases');
  cases = data.cases;
  if (!activeCase && cases.length) activeCase cases[0].id;
}
