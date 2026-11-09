import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Audience, Calculation, Destination, GroupNode, Schema, Splits, Sync } from '../api'
import { BuilderProvider, filterColumns, GroupEditor, migrateDefinition } from '../components/builder/ConditionEditor'
import { Empty, ErrorBox, Spinner, StatusBadge, Toggle, useAsync } from '../components/ui'

const EMPTY: GroupNode = { type: 'group', op: 'and', conditions: [] }
type Bar = { value: string | null; count: number }

function Bars({ data }: { data: Bar[] }) {
  const max = Math.max(1, ...data.map((b) => b.count))
  if (!data.length) return <div className="small muted">Nothing to show.</div>
  return (
    <div className="bars">
      {data.map((b) => (
        <div key={String(b.value)} className="bar-row" title={`${b.value ?? 'Unknown'}: ${b.count.toLocaleString()}`}>
          <span className="name">{b.value ?? 'Unknown'}</span>
          <span className="track"><div style={{ width: `${(b.count / max) * 100}%` }} /></span>
          <span className="n">{b.count.toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}

function Insights({ schema, definition, audiences, currentId }: { schema: Schema; definition: GroupNode; audiences: Audience[]; currentId?: number }) {
  const parent = schema.parent!
  const [tab, setTab] = useState<'breakdown' | 'overlap'>('breakdown')
  const [source, setSource] = useState<'property' | 'model'>('property')
  const groupable = [...filterColumns(parent).filter((c) => c.type === 'string' || c.type === 'boolean').map((c) => ({ name: c.name, label: c.label })),
    ...schema.virtual_columns.filter((v) => v.type === 'string' || v.type === 'boolean').map((v) => ({ name: v.name, label: `${v.label} (${v.group.toLowerCase()})` }))]
  const [column, setColumn] = useState(groupable.find((c) => /country|type|segment|status/i.test(c.name))?.name ?? groupable[0]?.name ?? '')
  const [modelId, setModelId] = useState(schema.models[0]?.id)
  const model = schema.models.find((m) => m.id === modelId)
  const [modelCol, setModelCol] = useState('')
  const [metric, setMetric] = useState<'users' | 'rows'>('users')
  const [bars, setBars] = useState<Bar[] | null>(null)
  const [other, setOther] = useState<number | ''>('')
  const [overlap, setOverlap] = useState<{ this: number; other: number; both: number; total: number; other_name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const others = audiences.filter((a) => a.id !== currentId && a.parent_id === parent.id)

  useEffect(() => { setBars(null); setOverlap(null) }, [definition])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const loadBreakdown = () => run(async () => {
    const body = source === 'property' ? { definition, column, parent_id: parent.id }
      : { definition, source: 'model', model_id: modelId, column: modelCol || model?.columns.find((c) => c.type === 'string')?.name, metric, parent_id: parent.id }
    setBars(await api.post<Bar[]>('/audiences/breakdown', body))
  })
  const loadOverlap = () => run(async () => {
    if (other) setOverlap(await api.post('/audiences/overlap', { definition, audience_id: other, parent_id: parent.id }))
  })

  return (
    <div className="card card-pad stack">
      <div className="spread">
        <h3>Insights</h3>
        <Toggle value={tab} onChange={(t) => setTab(t)} options={[{ value: 'breakdown', label: 'Breakdown' }, { value: 'overlap', label: 'Overlap' }]} />
      </div>
      {tab === 'breakdown' ? (<>
        <div className="row wrap">
          <select className="input sm" value={source} onChange={(e) => { setSource(e.target.value as 'property' | 'model'); setBars(null) }}>
            <option value="property">Properties & traits</option>
            <option value="model">Relations & events</option>
          </select>
          {source === 'property' ? (
            <select className="input sm grow" value={column} onChange={(e) => { setColumn(e.target.value); setBars(null) }}>
              {groupable.map((c) => <option key={c.name} value={c.name}>{c.label}</option>)}
            </select>
          ) : (<>
            <select className="input sm" value={modelId} onChange={(e) => { setModelId(Number(e.target.value)); setModelCol(''); setBars(null) }}>
              {schema.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <select className="input sm" value={modelCol} onChange={(e) => { setModelCol(e.target.value); setBars(null) }}>
              {model && filterColumns(model).filter((c) => c.type === 'string').map((c) => <option key={c.name} value={c.name}>{c.label}</option>)}
            </select>
            <select className="input sm" value={metric} onChange={(e) => { setMetric(e.target.value as 'users' | 'rows'); setBars(null) }}>
              <option value="users">Unique {parent.name.toLowerCase()}</option>
              <option value="rows">Total rows</option>
            </select>
          </>)}
        </div>
        {bars ? <Bars data={bars} /> : <button className="btn" onClick={loadBreakdown} disabled={busy}>{busy ? 'Loading…' : 'Show breakdown'}</button>}
      </>) : (<>
        <select className="input sm" value={other} onChange={(e) => { setOther(e.target.value ? Number(e.target.value) : ''); setOverlap(null) }}>
          <option value="">Compare with audience…</option>
          {others.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        {overlap ? (
          <div className="stack" style={{ gap: 8 }}>
            <div className="overlap">
              <div className="ov a"><strong>{fmt.num(overlap.this - overlap.both)}</strong><span>only this audience</span></div>
              <div className="ov both"><strong>{fmt.num(overlap.both)}</strong><span>in both</span></div>
              <div className="ov b"><strong>{fmt.num(overlap.other - overlap.both)}</strong><span>only “{overlap.other_name}”</span></div>
            </div>
            <div className="small muted">{fmt.pct(overlap.both, overlap.this)} of this audience is also in “{overlap.other_name}”.</div>
          </div>
        ) : <button className="btn" onClick={loadOverlap} disabled={busy || !other}>{busy ? 'Calculating…' : 'Calculate overlap'}</button>}
      </>)}
      <ErrorBox error={error} />
    </div>
  )
}

function SplitsCard({ splits, onChange }: { splits: Splits; onChange: (s: Splits) => void }) {
  const total = splits.groups.reduce((a, g) => a + Number(g.percent || 0), 0)
  return (
    <div className="card card-pad stack">
      <div className="spread">
        <h3>Splits</h3>
        <label className="row small"><input type="checkbox" checked={splits.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked, groups: splits.groups.length ? splits.groups : [{ name: 'treatment', percent: 90 }, { name: 'holdout', percent: 10 }] })} /> A/B split</label>
      </div>
      {splits.enabled ? (<>
        <div className="small muted">Members are assigned randomly (and permanently, by ID) to groups. Pick a group when you create a sync.</div>
        {splits.groups.map((g, i) => (
          <div key={i} className="row">
            <input className="input sm grow" value={g.name} onChange={(e) => onChange({ ...splits, groups: splits.groups.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
            <input className="input sm num" type="number" value={g.percent} style={{ width: 70 }}
              onChange={(e) => onChange({ ...splits, groups: splits.groups.map((x, j) => (j === i ? { ...x, percent: Number(e.target.value) } : x)) })} />%
            {splits.groups.length > 2 && <button className="btn ghost icon sm" onClick={() => onChange({ ...splits, groups: splits.groups.filter((_, j) => j !== i) })}>✕</button>}
          </div>
        ))}
        <div className="spread">
          <button className="btn ghost sm" onClick={() => onChange({ ...splits, groups: [...splits.groups, { name: `group ${splits.groups.length + 1}`, percent: 0 }] })}>+ Add group</button>
          <span className={`small ${total === 100 ? 'muted' : ''}`} style={total === 100 ? undefined : { color: 'var(--red)' }}>Total {total}%</span>
        </div>
      </>) : <div className="small muted">Split members into treatment and holdout groups to measure lift.</div>}
    </div>
  )
}

export default function AudienceBuilder() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const isNew = id === 'new'
  const nav = useNavigate()
  const [parentId, setParentId] = useState<number | null>(params.get('parent') ? Number(params.get('parent')) : null)
  const schema = useAsync(() => (isNew || parentId ? api.get<Schema>(`/schema${parentId ? `?parent_id=${parentId}` : ''}`) : Promise.resolve(undefined)), [parentId])
  const audiences = useAsync(() => api.get<Audience[]>('/audiences'))
  const dests = useAsync(() => api.get<Destination[]>('/destinations'))
  const syncs = useAsync(() => (isNew ? Promise.resolve([]) : api.get<Sync[]>(`/syncs?audience_id=${id}`)), [id])

  const [name, setName] = useState('Untitled audience')
  const [description, setDescription] = useState('')
  const [definition, setDefinition] = useState<GroupNode>(EMPTY)
  const [splits, setSplits] = useState<Splits>({ enabled: false, groups: [] })
  const [dirty, setDirty] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [calc, setCalc] = useState<Calculation | null>(null)
  const [calcError, setCalcError] = useState<string | null>(null)
  const [calculating, setCalculating] = useState(false)
  const [destPreview, setDestPreview] = useState<{ id: number; audience: number; after_rules: number; rules: number } | null>(null)
  const [tab, setTab] = useState<'preview' | 'sql'>('preview')
  const [preview, setPreview] = useState<{ columns: string[]; rows: unknown[][] } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [sql, setSql] = useState<string>('')
  const reqId = useRef(0)

  useEffect(() => {
    if (isNew) return
    api.get<Audience>(`/audiences/${id}`).then((a) => {
      setName(a.name); setDescription(a.description); setDefinition(migrateDefinition(a.definition) as GroupNode)
      setSplits(a.splits?.groups ? a.splits : { enabled: false, groups: [] }); setParentId(a.parent_id); setDirty(false)
    }).catch((e) => setLoadError(e.message))
  }, [id, isNew])

  useEffect(() => {
    if (tab !== 'sql' || !schema.data?.parent) return
    api.post<{ sql: string; params: { name: string; value?: string }[] }>('/audiences/compile', { definition, parent_id: schema.data.parent.id })
      .then((r) => setSql(r.sql + (r.params.length ? `\n\n-- parameters\n${r.params.map((p) => `-- :${p.name} = ${JSON.stringify(p.value ?? null)}`).join('\n')}` : '')))
      .catch((e) => setSql(`-- ${e.message}`))
  }, [tab, definition, schema.data])

  const pid = schema.data?.parent?.id
  const calculate = async () => {
    const my = ++reqId.current
    setCalculating(true); setCalcError(null)
    try {
      const r = await api.post<Calculation>('/audiences/calculate', { definition, parent_id: pid })
      if (my === reqId.current) setCalc(r)
    } catch (e) {
      if (my === reqId.current) setCalcError((e as Error).message)
    } finally {
      if (my === reqId.current) setCalculating(false)
    }
  }
  const previewDestination = async (destId: number) => {
    if (!destId) { setDestPreview(null); return }
    try {
      const r = await api.post<{ audience: number; after_rules: number; rules: number }>('/destination-rules/preview', { definition, destination_id: destId, parent_id: pid })
      setDestPreview({ id: destId, ...r })
    }
    catch (e) { setCalcError((e as Error).message) }
  }
  const loadPreview = async () => {
    setPreviewLoading(true)
    try { setPreview(await api.post('/audiences/preview', { definition, parent_id: pid })) } catch (e) { setCalcError((e as Error).message) } finally { setPreviewLoading(false) }
  }
  const change = (d: GroupNode) => {
    setDefinition(d); setDirty(true); setPreview(null); setCalc(null); setDestPreview(null)
    reqId.current++
    setCalculating(false)
  }
  const save = async () => {
    setSaving(true); setSaveError(null)
    const body = { name, description, definition, splits, parent_id: pid, last_size: calc ? calc.size : undefined }
    try {
      if (isNew) {
        const a = await api.post<Audience>('/audiences', body)
        setDirty(false)
        nav(`/audiences/${a.id}`, { replace: true })
      } else {
        await api.put(`/audiences/${id}`, body)
        setDirty(false)
      }
    } catch (e) { setSaveError((e as Error).message) } finally { setSaving(false) }
  }
  const copy = async () => {
    try {
      const a = await api.post<Audience>('/audiences', { name: `${name} (copy)`, description, definition, splits, parent_id: pid })
      nav(`/audiences/${a.id}`)
    } catch (e) { setSaveError((e as Error).message) }
  }
  const remove = async () => {
    if (!confirm(`Delete audience “${name}”?`)) return
    try { await api.del(`/audiences/${id}`); nav('/audiences') } catch (e) { setSaveError((e as Error).message) }
  }

  if (schema.loading || (!isNew && !parentId)) return <div className="page"><Spinner label="Loading…" />{loadError && <ErrorBox error={loadError} />}</div>
  if (!schema.data?.parent) {
    return (
      <div className="page">
        <Empty title="Set up your data first" action={<Link to="/setup" className="btn primary">Open data setup</Link>}>
          Choose your customer table in Databricks before building audiences.
        </Empty>
      </div>
    )
  }
  const parent = schema.data.parent
  const parents = schema.data.parents

  return (
    <BuilderProvider value={{ schema: schema.data, audiences: audiences.data ?? [], currentAudienceId: isNew ? undefined : Number(id), steps: calc?.steps }}>
      <div className="page">
        <div className="page-head">
          <div className="grow">
            <div className="eyebrow"><span className="eyebrow-n">3</span>Step 3 · Segmentation · <Link to="/audiences">Audiences</Link></div>
            <input className="input title" style={{ width: '100%', display: 'block' }} value={name} onChange={(e) => { setName(e.target.value); setDirty(true) }} />
            <input className="input sm" style={{ width: '100%', border: 'none', background: 'transparent', paddingLeft: 0 }} placeholder="Add a description…"
              value={description} onChange={(e) => { setDescription(e.target.value); setDirty(true) }} />
          </div>
          <div className="row">
            {!isNew && <button className="btn ghost danger" onClick={remove}>Delete</button>}
            {!isNew && <button className="btn ghost" onClick={copy}>Make a copy</button>}
            {!isNew && <Link to={`/activations/new?audience=${id}`} className="btn">Add sync</Link>}
            <button className="btn primary" onClick={save} disabled={saving || (!dirty && !isNew)}>{saving ? 'Saving…' : isNew ? 'Save audience' : dirty ? 'Save changes' : 'Saved'}</button>
          </div>
        </div>
        <ErrorBox error={loadError || saveError} />

        <div className="builder">
          <div className="stack" style={{ gap: 20 }}>
            <div className="card">
              <div className="card-head">
                <div><h2>Who should be in this audience?</h2><div className="small muted">All {parent.name.toLowerCase()} who match the filters below.</div></div>
                {isNew && parents.length > 1 ? (
                  <select className="input sm" value={parent.id} onChange={(e) => { setParentId(Number(e.target.value)); change(EMPTY) }}>
                    {parents.map((p) => <option key={p.id} value={p.id}>Build from: {p.name}</option>)}
                  </select>
                ) : <span className="badge">{parent.name}</span>}
              </div>
              <div className="card-body">
                {definition.conditions.length === 0 && (
                  <div className="alert info" style={{ marginBottom: 12 }}>No filters yet, so this audience includes everyone. Add a filter to narrow it down.</div>
                )}
                <GroupEditor group={definition} onChange={change} />
              </div>
            </div>

            <div className="card">
              <div className="card-body" style={{ paddingBottom: 0 }}>
                <div className="tabs" style={{ marginBottom: 0 }}>
                  <button className={`tab ${tab === 'preview' ? 'active' : ''}`} onClick={() => setTab('preview')}>Preview members</button>
                  <button className={`tab ${tab === 'sql' ? 'active' : ''}`} onClick={() => setTab('sql')}>Generated SQL</button>
                </div>
              </div>
              <div className="card-body">
                {tab === 'preview' ? (
                  preview ? (
                    <div className="table-wrap" style={{ maxHeight: 420 }}>
                      <table className="table compact">
                        <thead><tr>{preview.columns.map((c) => <th key={c}>{parent.column_settings?.[c]?.alias || c}</th>)}</tr></thead>
                        <tbody>{preview.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v == null ? <span className="faint">null</span> : String(v)}</td>)}</tr>)}</tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="row">
                      <button className="btn" onClick={loadPreview} disabled={previewLoading}>{previewLoading ? 'Loading…' : 'Show first 100 members'}</button>
                      <span className="small muted">Runs live against Databricks. Redacted columns stay hidden.</span>
                    </div>
                  )
                ) : <pre className="code">{sql || 'Compiling…'}</pre>}
              </div>
            </div>
          </div>

          <div className="insights">
            <div className="card card-pad stack">
              <div className="spread"><h3>Audience size</h3>{calculating && <Spinner />}</div>
              <ErrorBox error={calcError} />
              {calc ? (<>
                <div>
                  <div className="big-number">{fmt.num(calc.size)}</div>
                  <div className="small muted">{fmt.pct(calc.size, calc.total)} of {fmt.num(calc.total)} {parent.name.toLowerCase()}</div>
                </div>
                <div className="meter"><div style={{ width: `${calc.total ? (calc.size / calc.total) * 100 : 0}%` }} /></div>
                {calc.steps.length > 1 && <div className="small muted">The count after each filter is shown in the builder.</div>}
              </>) : (
                <div className="small muted">{definition.conditions.length ? 'Calculate to see how many people qualify right now.' : 'Everyone qualifies until you add a filter.'}</div>
              )}
              <button className="btn primary" onClick={calculate} disabled={calculating}>{calculating ? 'Calculating…' : 'Calculate size'}</button>
              {(dests.data?.length ?? 0) > 0 && (
                <div className="stack" style={{ gap: 6 }}>
                  <select className="input sm" value={destPreview?.id ?? ''} onChange={(e) => previewDestination(Number(e.target.value))}>
                    <option value="">Preview a destination…</option>
                    {dests.data!.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                  {destPreview && (
                    <div className="small muted">
                      {destPreview.rules ? <><strong>{fmt.num(destPreview.after_rules)}</strong> of {fmt.num(destPreview.audience)} would be sent after {destPreview.rules} destination rule{destPreview.rules > 1 ? 's' : ''}.</>
                        : 'No destination rules — everyone in the audience would be sent.'}
                    </div>
                  )}
                </div>
              )}
            </div>

            <Insights schema={schema.data} definition={definition} audiences={audiences.data ?? []} currentId={isNew ? undefined : Number(id)} />
            <SplitsCard splits={splits} onChange={(s) => { setSplits(s); setDirty(true) }} />

            {!isNew && (
              <div className="card card-pad stack">
                <div className="spread"><h3>Syncs</h3><Link to={`/activations/new?audience=${id}`} className="small">+ Add sync</Link></div>
                {syncs.data?.length ? syncs.data.map((s) => (
                  <Link key={s.id} to={`/activations/${s.id}`} className="spread" style={{ color: 'inherit' }}>
                    <span>{s.destination_name}{s.config.split_group ? <span className="faint small"> · {s.config.split_group}</span> : null}</span>
                    <StatusBadge status={s.last_status} running={s.running} />
                  </Link>
                )) : <div className="small muted">Not synced anywhere yet.</div>}
              </div>
            )}
          </div>
        </div>
      </div>
    </BuilderProvider>
  )
}
