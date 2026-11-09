import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Audience, Calculation, Destination, GroupNode, Schema, Splits, Sync } from '../api'
import { BuilderProvider, filterColumns, GroupEditor, migrateDefinition } from '../components/builder/ConditionEditor'
import { Empty, ErrorBox, Spinner, StatusBadge, Toggle, useAsync } from '../components/ui'
import { askConfirm, toast } from '../components/kit'
import { ownerName, sizeState } from './Audiences'
import '../ux/segment.css'
import { useMe } from '../components/me'

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

type Draft = { name: string; description: string; definition: GroupNode; splits: Splits }
const snapshot = (d: Draft) => JSON.stringify(d)

/** Size card: the number stays visible after edits, but is clearly marked out of date until recalculated. */
function SizeCard({ parentName, calc, fresh, saved, savedState, calculating, error, hasFilters, onCalculate }: {
  parentName: string; calc: Calculation | null; fresh: boolean; saved: Audience | null
  savedState: { tone: string; text: string } | null; calculating: boolean; error: string | null; hasFilters: boolean; onCalculate: () => void
}) {
  const shown = calc ?? (saved?.last_size != null ? { size: saved.last_size, total: 0, steps: [] } : null)
  // a saved count is only flagged when it's actually doubtful (old, or filters changed since); a recent one is just labelled
  const stale = !!shown && !fresh && (!!calc || savedState?.tone === 'amber')
  return (
    <div className={`card card-pad stack seg-size ${stale ? 'stale' : ''}`}>
      <div className="spread"><h3>Audience size</h3>{calculating && <Spinner />}</div>
      <ErrorBox error={error} />
      {shown ? (<>
        <div>
          <div className="big-number" aria-live="polite">{fmt.num(shown.size)}</div>
          {shown.total > 0 && <div className="small muted">{fmt.pct(shown.size, shown.total)} of {fmt.num(shown.total)} {parentName.toLowerCase()}</div>}
        </div>
        {shown.total > 0 && <div className="meter"><div style={{ width: `${(shown.size / shown.total) * 100}%` }} /></div>}
        {stale ? (
          <div className="seg-stale-note" role="status">
            <strong>{calc ? 'Filters changed' : (savedState?.text ?? 'Saved count')}</strong>
            <span>{calc ? 'This number is for the previous filters — recalculate to see the new size.' : 'Recalculate to see who qualifies right now.'}</span>
          </div>
        ) : calc ? <div className="small muted">Counted just now in Databricks.{calc.steps.length > 1 ? ' The count after each filter is shown next to it.' : ''}</div>
          : <div className="small muted">{savedState?.text ?? 'Saved count'}.</div>}
      </>) : (
        <div className="small muted">{hasFilters ? 'Calculate to see how many people qualify right now.' : `No filters yet — every ${parentName.toLowerCase().replace(/s$/, '')} qualifies. Add a filter to narrow it down.`}</div>
      )}
      <button className={`btn ${stale || !shown ? 'primary' : ''}`} onClick={onCalculate} disabled={calculating}>
        {calculating ? 'Calculating…' : shown ? 'Recalculate' : 'Calculate size'}
      </button>
    </div>
  )
}

export default function AudienceBuilder() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const isNew = id === 'new'
  const me = useMe()
  const nav = useNavigate()
  const [parentId, setParentId] = useState<number | null>(params.get('parent') ? Number(params.get('parent')) : null)
  const schema = useAsync(() => (isNew || parentId ? api.get<Schema>(`/schema${parentId ? `?parent_id=${parentId}` : ''}`) : Promise.resolve(undefined)), [parentId])
  const audiences = useAsync(() => api.get<Audience[]>('/audiences'))
  const dests = useAsync(() => api.get<Destination[]>('/destinations'))
  const syncs = useAsync(() => (isNew ? Promise.resolve([]) : api.get<Sync[]>(`/syncs?audience_id=${id}`)), [id])

  const [draft, setDraft] = useState<Draft>({ name: 'Untitled audience', description: '', definition: EMPTY, splits: { enabled: false, groups: [] } })
  const [saved, setSaved] = useState<string>(snapshot(draft))
  const [record, setRecord] = useState<Audience | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [calc, setCalc] = useState<{ result: Calculation; key: string } | null>(null)
  const [calcError, setCalcError] = useState<string | null>(null)
  const [calculating, setCalculating] = useState(false)
  const [destPreview, setDestPreview] = useState<{ id: number; audience: number; after_rules: number; rules: number } | null>(null)
  const [tab, setTab] = useState<'preview' | 'sql'>('preview')
  const [preview, setPreview] = useState<{ columns: string[]; rows: unknown[][] } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [sql, setSql] = useState<string>('')
  const reqId = useRef(0)
  const { name, description, definition, splits } = draft
  const defKey = JSON.stringify(definition)
  const dirty = snapshot(draft) !== saved
  const fresh = !!calc && calc.key === defKey

  useEffect(() => {
    if (isNew) return
    api.get<Audience>(`/audiences/${id}`).then((a) => {
      const d = { name: a.name, description: a.description, definition: migrateDefinition(a.definition) as GroupNode,
        splits: a.splits?.groups ? a.splits : { enabled: false, groups: [] } }
      setDraft(d); setSaved(snapshot(d)); setRecord(a); setParentId(a.parent_id)
    }).catch((e) => setLoadError(e.message))
  }, [id, isNew])

  // leaving with unsaved work: the browser asks first
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  useEffect(() => {
    if (tab !== 'sql' || !schema.data?.parent) return
    api.post<{ sql: string; params: { name: string; value?: string }[] }>('/audiences/compile', { definition, parent_id: schema.data.parent.id })
      .then((r) => setSql(r.sql + (r.params.length ? `\n\n-- parameters\n${r.params.map((p) => `-- :${p.name} = ${JSON.stringify(p.value ?? null)}`).join('\n')}` : '')))
      .catch((e) => setSql(`-- ${e.message}`))
  }, [tab, defKey, schema.data]) // eslint-disable-line react-hooks/exhaustive-deps

  const pid = schema.data?.parent?.id
  const brandId = schema.data?.parent?.brand_id ?? null
  const canEdit = !!schema.data?.parent && me.can('audiences.edit', brandId)

  const calculate = async () => {
    const my = ++reqId.current
    const key = defKey
    setCalculating(true); setCalcError(null)
    try {
      const r = await api.post<Calculation>('/audiences/calculate', { definition, parent_id: pid })
      if (my === reqId.current) setCalc({ result: r, key })
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
    } catch (e) { setCalcError((e as Error).message) }
  }
  const loadPreview = async () => {
    setPreviewLoading(true)
    try { setPreview(await api.post('/audiences/preview', { definition, parent_id: pid })) } catch (e) { setCalcError((e as Error).message) } finally { setPreviewLoading(false) }
  }
  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const change = (d: GroupNode) => {
    update({ definition: d }); setPreview(null); setDestPreview(null)
    reqId.current++
    setCalculating(false)
  }

  const save = async () => {
    if (!canEdit || saving) return
    if (!name.trim()) { setSaveError('Give the audience a name'); return }
    setSaving(true); setSaveError(null)
    const body = { name: name.trim(), description, definition, splits, parent_id: pid, last_size: fresh ? calc!.result.size : undefined }
    try {
      if (isNew) {
        const a = await api.post<Audience>('/audiences', body)
        setSaved(snapshot(draft))
        toast(`“${a.name}” created`)
        nav(`/audiences/${a.id}`, { replace: true })
      } else {
        const a = await api.put<Audience>(`/audiences/${id}`, body)
        setSaved(snapshot({ ...draft, name: body.name })); setRecord(a); update({ name: body.name })
        toast('Audience saved')
      }
    } catch (e) { setSaveError((e as Error).message); toast("Couldn't save the audience", 'error') } finally { setSaving(false) }
  }
  // Ctrl/⌘+S saves
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveRef.current() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const discard = async () => {
    if (!await askConfirm({ title: 'Discard your changes?', body: 'The filters, name and splits go back to the last saved version.', confirmLabel: 'Discard changes', danger: true })) return
    const d = JSON.parse(saved) as Draft
    setDraft(d); setPreview(null); setDestPreview(null)
    if (isNew) nav('/audiences')
  }
  const copy = async () => {
    try {
      const a = await api.post<Audience>('/audiences', { name: `${name} (copy)`, description, definition, splits, parent_id: pid })
      toast(`Copied as “${a.name}”`)
      nav(`/audiences/${a.id}`)
    } catch (e) { toast((e as Error).message, 'error') }
  }
  const remove = async () => {
    const n = syncs.data?.length ?? 0
    if (n) {
      toast(`“${name}” is used by ${n} sync${n === 1 ? '' : 's'} — delete ${n === 1 ? 'it' : 'them'} first`, 'error')
      return
    }
    if (!await askConfirm({ title: `Delete “${name}”?`, body: 'The audience definition is removed for everyone. This can’t be undone.', confirmLabel: 'Delete audience', danger: true })) return
    try { await api.del(`/audiences/${id}`); setSaved(snapshot(draft)); toast(`“${name}” deleted`); nav('/audiences') } catch (e) { toast((e as Error).message, 'error') }
  }

  if (schema.loading || (!isNew && !parentId)) return <div className="page"><Spinner label="Loading audience…" />{loadError && <ErrorBox error={loadError} />}</div>
  if (!schema.data?.parent) {
    return (
      <div className="page">
        <Empty title="Set up your data first" action={<Link to="/schema" className="btn primary">Open data model</Link>}>
          A Platform Admin needs to choose the customer table in Databricks before audiences can be built.
        </Empty>
      </div>
    )
  }
  const parent = schema.data.parent
  const parents = schema.data.parents
  const canSync = me.can('syncs.edit', brandId)
  const status = isNew ? { cls: 'brand', text: 'New — not saved yet' } : dirty ? { cls: 'amber', text: 'Unsaved changes' } : { cls: 'green', text: 'Saved' }

  return (
    <BuilderProvider value={{ schema: schema.data, audiences: audiences.data ?? [], currentAudienceId: isNew ? undefined : Number(id), steps: fresh ? calc!.result.steps : undefined }}>
      <div className="page wide seg-builder">
        <div className="seg-head">
          <div className="seg-head-main">
            <div className="eyebrow"><span className="eyebrow-n">3</span>Step 3 · Segmentation · <Link to="/audiences">Audiences</Link></div>
            <div className="seg-title-row">
              {canEdit ? (
                <input className="seg-title-input" value={name} aria-label="Audience name" placeholder="Name this audience"
                  onChange={(e) => update({ name: e.target.value })} />
              ) : <h1 className="seg-title-static">{name}</h1>}
              {canEdit && <span className={`badge ${status.cls}`} role="status"><span className="dot" />{status.text}</span>}
            </div>
            {canEdit ? (
              <input className="seg-desc-input" placeholder="Add a description — who is this for and why?" aria-label="Description"
                value={description} onChange={(e) => update({ description: e.target.value })} />
            ) : description && <p className="muted" style={{ margin: '4px 0 0' }}>{description}</p>}
            <div className="seg-context">
              {isNew && parents.length > 1 ? (
                <label className="row small" style={{ gap: 6 }}>
                  <span className="muted">Build from</span>
                  <select className="input sm" value={parent.id} onChange={(e) => { setParentId(Number(e.target.value)); change(EMPTY) }}>
                    {parents.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
              ) : <span className="seg-chip">Built on <strong>{parent.name}</strong></span>}
              <span className="seg-chip">{me.brandName(brandId)}</span>
              {record?.created_by && <span className="seg-chip">Owner <strong>{ownerName(record.created_by)}</strong></span>}
              {record && <span className="seg-chip" title={new Date(record.updated_at).toLocaleString()}>Last saved {fmt.ago(record.updated_at)}</span>}
            </div>
          </div>
          <div className="seg-head-actions">
            {!isNew && canEdit && <button className="btn ghost danger" onClick={remove}>Delete</button>}
            {!isNew && canEdit && <button className="btn ghost" onClick={copy}>Duplicate</button>}
            {!isNew && canSync && <Link to={`/activations/new?audience=${id}`} className="btn">Send to a destination</Link>}
            {canEdit && (
              <button className="btn primary" onClick={save} disabled={saving || (!dirty && !isNew)} title="Ctrl / ⌘ + S">
                {saving ? 'Saving…' : isNew ? 'Save audience' : dirty ? 'Save changes' : 'Saved'}
              </button>
            )}
          </div>
        </div>
        {!canEdit && <div className="alert info seg-viewonly">View only — you can explore, count and preview this audience, but your role can’t change it.</div>}
        <ErrorBox error={loadError || saveError} />

        <div className="builder">
          <div className="stack" style={{ gap: 20 }}>
            <fieldset className="card seg-filters" disabled={!canEdit}>
              <div className="card-head">
                <div><h2>Who should be in this audience?</h2><div className="small muted">Everyone in {parent.name.toLowerCase()} who matches the filters below.</div></div>
                {definition.conditions.length > 0 && <span className="badge">{definition.conditions.length} filter{definition.conditions.length === 1 ? '' : 's'}</span>}
              </div>
              <div className="card-body">
                {definition.conditions.length === 0 && (
                  <div className="alert info" style={{ marginBottom: 12 }}>No filters yet, so this audience includes everyone. Add a filter to narrow it down.</div>
                )}
                <GroupEditor group={definition} onChange={change} />
              </div>
            </fieldset>

            <div className="card">
              <div className="card-body" style={{ paddingBottom: 0 }}>
                <div className="tabs" style={{ marginBottom: 0 }}>
                  <button className={`tab ${tab === 'preview' ? 'active' : ''}`} onClick={() => setTab('preview')}>Preview members</button>
                  <button className={`tab ${tab === 'sql' ? 'active' : ''}`} onClick={() => setTab('sql')}>Generated SQL</button>
                </div>
              </div>
              <div className="card-body">
                {tab === 'preview' ? (
                  preview ? (<>
                    <div className="spread small muted" style={{ marginBottom: 8 }}>
                      <span>First {preview.rows.length.toLocaleString()} matching {parent.name.toLowerCase()} — live from Databricks.</span>
                      <button className="btn ghost sm" onClick={loadPreview} disabled={previewLoading}>{previewLoading ? 'Refreshing…' : 'Refresh'}</button>
                    </div>
                    <div className="table-wrap" style={{ maxHeight: 420 }}>
                      <table className="table compact">
                        <thead><tr>{preview.columns.map((c) => <th key={c}>{parent.column_settings?.[c]?.alias || c}</th>)}</tr></thead>
                        <tbody>{preview.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v == null ? <span className="faint">—</span> : String(v)}</td>)}</tr>)}</tbody>
                      </table>
                    </div>
                    {!preview.rows.length && <div className="dm-none">Nobody matches these filters right now.</div>}
                  </>) : (
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
            <SizeCard parentName={parent.name} calc={calc?.result ?? null} fresh={fresh} saved={dirty || isNew ? (calc ? null : record) : record}
              savedState={record ? sizeState(record) : null} calculating={calculating} error={calcError}
              hasFilters={definition.conditions.length > 0} onCalculate={calculate} />

            {(dests.data?.length ?? 0) > 0 && (
              <div className="card card-pad stack">
                <h3>What a destination would receive</h3>
                <select className="input sm" value={destPreview?.id ?? ''} onChange={(e) => previewDestination(Number(e.target.value))} aria-label="Destination">
                  <option value="">Choose a destination…</option>
                  {dests.data!.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                {destPreview ? (
                  <div className="small muted">
                    {destPreview.rules ? <><strong>{fmt.num(destPreview.after_rules)}</strong> of {fmt.num(destPreview.audience)} would be sent after {destPreview.rules} destination rule{destPreview.rules > 1 ? 's' : ''} (consent, privacy…).</>
                      : <>No destination rules — all <strong>{fmt.num(destPreview.audience)}</strong> people would be sent.</>}
                  </div>
                ) : <div className="small faint">Destination rules can exclude people (e.g. without email consent) at send time.</div>}
              </div>
            )}

            <Insights schema={schema.data} definition={definition} audiences={audiences.data ?? []} currentId={isNew ? undefined : Number(id)} />
            <fieldset className="seg-fieldset" disabled={!canEdit}>
              <SplitsCard splits={splits} onChange={(s) => update({ splits: s })} />
            </fieldset>

            {!isNew && (
              <div className="card card-pad stack">
                <div className="spread"><h3>Where it's sent</h3>{canSync && <Link to={`/activations/new?audience=${id}`} className="small">+ Add sync</Link>}</div>
                {syncs.data?.length ? syncs.data.map((s) => (
                  <Link key={s.id} to={`/activations/${s.id}`} className="spread seg-sync-row">
                    <span>{s.destination_name}{s.config.split_group ? <span className="faint small"> · {s.config.split_group}</span> : null}</span>
                    <StatusBadge status={s.last_status} running={s.running} />
                  </Link>
                )) : <div className="small muted">Not sent anywhere yet.{canSync ? ' Add a sync to deliver it to Sailthru, Google Ad Manager or another tool.' : ''}</div>}
              </div>
            )}
          </div>
        </div>

        {canEdit && (dirty || isNew) && (
          <div className="dm-savebar seg-savebar" role="region" aria-label="Unsaved changes">
            <span>{isNew ? 'This audience isn’t saved yet.' : 'You have unsaved changes.'}</span>
            <span className="grow" />
            <button className="btn ghost sm" onClick={discard} disabled={saving}>{isNew ? 'Cancel' : 'Discard'}</button>
            <button className="btn primary sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : isNew ? 'Save audience' : 'Save changes'}</button>
          </div>
        )}
      </div>
    </BuilderProvider>
  )
}
