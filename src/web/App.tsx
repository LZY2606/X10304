import { useCallback, useEffect, useMemo, useState } from 'react';
import { get, post } from './api';

type AnyEv = { id: string; kind: string; status: string; seq: number; payload: any };

const STATUS_LABEL: Record<string, string> = {
  ok: '通过', diagnostic: '诊断', failed: '失败', exhausted: '预算耗尽',
  inconclusive: '不确定', inconclusive_resource: '不确定(资源)', verified: '已核验',
};
const KIND_LABEL: Record<string, string> = {
  baseline: '基线', mutation: '单源变异', param_revision: '参数修订',
  source_change: '源数据改动', conflicting_decisions: '冲突决定', derived: '派生',
};

function Badge({ s }: { s: string }) {
  return <span className={`badge st-${s}`}>{STATUS_LABEL[s] ?? s}</span>;
}

function Qty({ q }: { q: any }) {
  if (!q) return null;
  return (
    <span className="qty" title={`原始表示 "${q.raw}" · 基准 ${q.basis}`}>
      {q.value ?? q.raw}
      <small> {q.unit}</small>
    </span>
  );
}

export function App() {
  const [archive, setArchive] = useState<any>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [view, setView] = useState<any>(null);
  const [prefix, setPrefix] = useState(0);
  const [stepIdx, setStepIdx] = useState<number | null>(null);
  const [sample, setSample] = useState<any>(null);
  const [sampleAt, setSampleAt] = useState(-1);
  const [notice, setNotice] = useState('');

  const reload = useCallback(async () => {
    const a = await get('/api/archive');
    setArchive(a);
    return a;
  }, []);

  const openVersion = useCallback(async (id: string) => {
    const v = await get(`/api/versions/${id}`);
    setVersionId(id);
    setView(v);
    const n = v.conclusions?.result?.steps?.length ?? 0;
    setPrefix(n);
    setStepIdx(n > 0 ? n - 1 : null);
  }, []);

  useEffect(() => {
    (async () => {
      const a = await reload();
      const s = await get('/api/sample');
      setSample(s);
      const first = a.current ?? a.versions[0]?.id;
      if (first) await openVersion(first);
    })();
  }, [reload, openVersion]);

  const result = view?.conclusions?.result;
  const steps = result?.steps ?? [];
  const step = stepIdx !== null ? steps[stepIdx] : null;
  const active = prefix === 0 ? result?.initialActive ?? [] : steps[prefix - 1]?.activeAfter ?? [];

  const gotoSampleStop = async (i: number) => {
    if (!sample) return;
    const stop = sample.stops[i];
    setSampleAt(i);
    if (stop.versionId) await openVersion(stop.versionId);
    setNotice(`样例路径 ${i + 1}/${sample.stops.length}：${stop.title}`);
  };

  const doExport = async () => {
    const data = await get('/api/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'drat-archive.json';
    a.click();
    setNotice('已导出档案（身份为内容寻址，重导入后保持一致）');
  };
  const doImport = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = async () => {
      const text = await input.files![0].text();
      await post('/api/import', JSON.parse(text));
      await reload();
      setNotice('导入完成：身份、顺序与来源关系保持');
    };
    input.click();
  };
  const doReset = async () => {
    await post('/api/reset', {});
    const a = await reload();
    if (a.current) await openVersion(a.current);
    setNotice('本地数据库已删除并重建（演示崩溃恢复 / 重导入路径）');
  };

  if (!archive) return <div className="loading">加载证明轨迹台…</div>;

  return (
    <div className="app">
      <header>
        <h1>证明轨迹台 <small>SAT DRAT 子句、传播链与失败前缀</small></h1>
        <div className="toolbar">
          <button onClick={() => gotoSampleStop((sampleAt + 1) % (sample?.stops.length ?? 1))}>
            样例路径下一站
          </button>
          <button onClick={doExport}>导出档案</button>
          <button onClick={doImport}>导入档案</button>
          <button onClick={doReset}>删除本地库重建</button>
        </div>
      </header>
      {notice && <div className="notice" onClick={() => setNotice('')}>{notice}</div>}
      <div className="layout">
        <aside>
          <h2>档案版本</h2>
          <ul className="versions">
            {archive.versions.map((v: any) => (
              <li key={v.id} className={v.id === versionId ? 'sel' : ''}>
                <button onClick={() => openVersion(v.id)}>
                  <span className="vlabel">{v.label}</span>
                  <span className="vkind">{KIND_LABEL[v.kind] ?? v.kind}</span>
                  {v.conclusions && <Badge s={v.conclusions.verdict} />}
                </button>
                <code className="id">{v.id}</code>
              </li>
            ))}
          </ul>
          <DecisionPanel archive={archive} reload={reload} />
        </aside>
        <main>
          {view && (
            <>
              <section className="meta">
                <h2>{view.label} <code className="id">{view.id}</code></h2>
                <div>
                  判定：<Badge s={view.conclusions?.verdict ?? 'ok'} />
                  {view.conclusions?.failingPrefix != null && (
                    <span className="failprefix">最短失败前缀：前 {view.conclusions.failingPrefix} 行</span>
                  )}
                  <span className="budget">传播预算 <Qty q={result?.params?.budget} /></span>
                </div>
                <p className="hint">此处展示的是该版本写入时冻结的可见结论快照，回到旧版本不会被最新计算覆盖。</p>
              </section>
              <div className="columns">
                <section className="timeline">
                  <h3>proof 时间线</h3>
                  <input
                    type="range" min={0} max={steps.length} value={prefix}
                    onChange={e => { const p = Number(e.target.value); setPrefix(p); setStepIdx(p > 0 ? p - 1 : null); }}
                  />
                  <div className="prefix-label">重放前缀：{prefix} / {steps.length} 行</div>
                  <ol>
                    {steps.map((s: any, i: number) => (
                      <li
                        key={s.lineId}
                        className={[
                          i === stepIdx ? 'sel' : '',
                          i < prefix ? 'in-prefix' : '',
                          result?.failingPrefix != null && i === result.failingPrefix - 1 ? 'failing' : '',
                        ].join(' ')}
                        onClick={() => { setStepIdx(i); setPrefix(i + 1); }}
                      >
                        <span className="mono">{s.kind === 'delete' ? 'd ' : ''}{s.lits.join(' ') || '∅'}</span>
                        <Badge s={s.status} />
                        {s.pivot !== null && <span className="pivot">pivot {s.pivot}</span>}
                      </li>
                    ))}
                  </ol>
                </section>
                <section className="detail">
                  {step ? <StepDetail step={step} /> : <p>选择时间线上的一步查看 pivot、传播理由与诊断。</p>}
                </section>
                <section className="active">
                  <h3>活跃子句多重集（前缀 {prefix}）</h3>
                  <ul>
                    {active.map((c: any) => (
                      <li key={c.key}>
                        <span className="mono">[{c.key || '∅'}]</span>
                        {c.count > 1 && <span className="count">×{c.count}</span>}
                        <code className="id">{c.clauseIds[0]}</code>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
              <EventLog events={view.events} />
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function StepDetail({ step }: { step: any }) {
  return (
    <>
      <h3>步骤详情 <code className="id">{step.lineId}</code></h3>
      <p>
        {step.kind === 'delete' ? '删除' : '加入'}子句 <span className="mono">[{step.clauseKey || '∅'}]</span>{' '}
        <Badge s={step.status} /> · 传播 {step.propagationsUsed} 步
      </p>
      {step.pivotCandidates?.length > 0 && (
        <div className="candidates">
          <h4>RAT pivot 候选（全部保留，不吞掉多解）</h4>
          {step.pivotCandidates.map((c: any) => (
            <div key={c.pivot} className={c.ok ? 'cand ok' : 'cand'}>
              <b>pivot {c.pivot}</b> {c.ok ? '✓ 合法' : '✗ 不成立'}
              <ul>
                {c.resolvents.map((r: any, i: number) => (
                  <li key={i}>
                    与 [{r.withClause}] 归结 → [{r.resolvent.join(' ') || '∅'}]：RUP {r.rup}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {step.propagation?.length > 0 && (
        <div>
          <h4>传播理由链</h4>
          <ol className="prop">
            {step.propagation.map((p: any, i: number) => (
              <li key={i}>
                <span className="mono">{p.lit}</span>
                {p.reasonClauseKey === null ? <em>（假设：被否定的子句 literal）</em> : <> 由子句 <span className="mono">[{p.reasonClauseKey}]</span> 传播</>}
              </li>
            ))}
          </ol>
        </div>
      )}
      <div>
        <h4>本步事件</h4>
        {step.events.map((e: AnyEv) => (
          <div key={e.id} className={`ev st-${e.status}`}>
            <Badge s={e.status} /> <b>{e.kind}</b> {e.summary} <code className="id">{e.id}</code>
          </div>
        ))}
      </div>
    </>
  );
}

function EventLog({ events }: { events: AnyEv[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="events">
      <h3>机器可读取事件流（判定依据）</h3>
      {events.map(e => (
        <div key={e.id} className={`ev st-${e.status}`} onClick={() => setOpen(open === e.id ? null : e.id)}>
          <Badge s={e.status} /> <b>{e.kind}</b> #{e.seq}{' '}
          {e.payload?.summary ?? e.payload?.label ?? e.payload?.verdict ?? ''}
          <code className="id">{e.id}</code>
          {open === e.id && <pre>{JSON.stringify(e.payload, null, 2)}</pre>}
        </div>
      ))}
    </section>
  );
}

function DecisionPanel({ archive, reload }: { archive: any; reload: () => Promise<any> }) {
  const [msg, setMsg] = useState('');
  const branches = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const d of archive.decisions ?? []) {
      const arr = m.get(d.branch) ?? [];
      arr.push(d);
      m.set(d.branch, arr);
    }
    return [...m.entries()];
  }, [archive]);

  const resolve = async (branch: string, selectedId: string) => {
    await post('/api/decisions/resolve', { branch, selectedId });
    await reload();
    setMsg('已切换采纳决定；未选候选仍然保留');
  };
  const tryStaleSave = async (branch: string) => {
    // 模拟第二位使用者拿着过期基线保存：应得到可解决的冲突
    const r = await post('/api/decisions', {
      baseVersion: 'stale-version-that-is-not-current',
      branch,
      payload: { reviewer: 'reviewer-C', choice: 'late-arrival', rationale: '基于过期版本的编辑' },
    });
    if (r.status === 409) setMsg(`冲突可解决：当前版本 ${r.body.currentVersion}，过期编辑已保留为冲突记录`);
    else setMsg('保存成功');
  };

  if (branches.length === 0) return null;
  return (
    <section className="decisions">
      <h2>人工决定（冲突可解决）</h2>
      {branches.map(([branch, ds]) => (
        <div key={branch} className="branch">
          <h3>{branch}</h3>
          {ds.map((d: any) => (
            <label key={d.id} className={d.selected ? 'dec sel' : 'dec'}>
              <input type="radio" checked={!!d.selected} onChange={() => resolve(branch, d.id)} />
              <b>{d.payload.reviewer}</b>：{d.payload.choice}
              <small>{d.payload.rationale}</small>
              <code className="id">{d.id}</code>
            </label>
          ))}
          <button onClick={() => tryStaleSave(branch)}>模拟过期基线保存</button>
        </div>
      ))}
      {msg && <p className="hint">{msg}</p>}
    </section>
  );
}
