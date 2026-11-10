import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Audience, Calculation, Destination, GroupNode, Schema, Splits, Sync } from '../api'
import { BuilderProvider, conditionText, filterColumns, GroupEditor, migrateDefinition } from '../components/builder/ConditionEditor'
import { Empty, ErrorBox, Spinner, useAsync } from '../components/ui'
import { askConfirm, SkeletonRows, toast } from '../components/kit'
import { Funnel, TopValues } from '../components/viz'
import { BrandLogo } from '../components/logos'
import { Glyph, ownerName, Pill, sizeState, syncState } from '../ux/segment-kit'
import '../ux/segment.css'
import { useMe } from '../components/me'

const EMPTY: GroupNode = { type: 'group', op: 'and', conditions: [] }
type Bar = { value: string | null; count: number }

/** Breakdown · Overlap · Delivery check — the "explore this audience" tools, one at a time. */
function Explore({ schema, definition, audiences, currentId, dests }: { schema: Schema; definition: GroupNode; audiences: Audience[]; currentId?: number; dests: Destination[] }) {
  const parent = schema.parent!
  const [tab, setTab] = useState<'breakdown' | 'overlap' | 'delivery'>('breakdown')
  const groupable = [...filterColumns(parent).filter((c) => c.type === 'string' || c.type === 'boolean').map((c) => ({ name: c.name, label: c.label })),
    ...schema.virtual_columns.filter((v) => v.type === 'string' || v.type === 'boolean').map((v) => ({ name: v.name, label: `${v.label} (${v.group.toLowerCase()})` }))]
  const [column, setColumn] = useState(groupable.find((c) => /country|type|segment|status|section/i.test(c.name))?.name ?? groupable[0]?.name ?? '')
  const [bars, setBars] = useState<Bar[] | null>(null)
  const [other, setOther] = useState<number | ''>('')
  const [overlap, setOverlap] = useState<{ this: number; other: number; both: number; total: number; other_name: string } | null>(null)
  const [destId, setDestId] = useState<number | ''>('')
  const [delivery, setDelivery] = useState<{ audience: number; after_rules: number; rules: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const others = audiences.filter((a) => a.id !== currentId && a.parent_id === parent.id)

  useEffect(() => { setBars(null); setOverlap(null); setDelivery(null) }, [definition])
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const tabs = [['breakdown', 'Breakdown'], ['overlap', 'Overlap'], ...(dests.length ? [['delivery', 'Delivery check']] : [])] as [typeof tab, string][]
  return (
    <div className="sg-explore">
      <div className="seg sg-explore-tabs" role="tablist">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'breakdown' && (<>
        <p className="sg-explore-help">Who is in this audience, split by one attribute.</p>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <select className="input sm grow" value={column} onChange={(e) => { setColumn(e.target.value); setBars(null) }} aria-label="Break down by">
            {groupable.map((c) => <option key={c.name} value={c.name}>{c.label}</option>)}
          </select>
          <button className="btn sm" disabled={busy || !column} onClick={() => run(async () => setBars(await api.post<Bar[]>('/audiences/breakdown', { definition, column, parent_id: parent.id })))}>
            {busy ? 'Loading…' : bars ? 'Refresh' : 'Show'}</button>
        </div>
        {bars && (bars.length ? <TopValues items={bars.map((b) => ({ label: b.value ?? '(empty)', value: b.count }))} /> : <div className="sg-hint">Nobody matches these filters right now.</div>)}
      </>)}
      {tab === 'overlap' && (<>
        <p className="sg-explore-help">How many people are also in another audience — useful before sending competing messages.</p>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <select className="input sm grow" value={other} onChange={(e) => { setOther(e.target.value ? Number(e.target.value) : ''); setOverlap(null) }} aria-label="Compare with">
            <option value="">Compare with…</option>
            {others.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button className="btn sm" disabled={busy || !other} onClick={() => run(async () => setOverlap(await api.post('/audiences/overlap', { definition, audience_id: other, parent_id: parent.id })))}>{busy ? 'Comparing…' : 'Compare'}</button>
        </div>
        {!others.length && <div className="sg-hint">There's no other audience on {parent.name} to compare with yet.</div>}
        {overlap && (
          <div className="sg-overlap">
            <TopValues unit="people" total={overlap.this + overlap.other - overlap.both} items={[
              { label: 'Only this audience', value: overlap.this - overlap.both },
              { label: 'In both', value: overlap.both },
              { label: `Only “${overlap.other_name}”`, value: overlap.other - overlap.both },
            ]} />
            <div className="sg-hint"><strong>{fmt.pct(overlap.both, overlap.this)}</strong> of this audience is also in “{overlap.other_name}”.</div>
          </div>
        )}
      </>)}
      {tab === 'delivery' && (<>
        <p className="sg-explore-help">Destination rules (consent, privacy) can hold some people back at send time. See how many would actually be sent.</p>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <select className="input sm grow" value={destId} onChange={(e) => { setDestId(e.target.value ? Number(e.target.value) : ''); setDelivery(null) }} aria-label="Destination">
            <option value="">Choose a destination…</option>
            {dests.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button className="btn sm" disabled={busy || !destId} onClick={() => run(async () => setDelivery(await api.post('/destination-rules/preview', { definition, destination_id: destId, parent_id: parent.id })))}>{busy ? 'Checking…' : 'Check'}</button>
        </div>
        {delivery && (
          <div className="sg-delivery">
            <div className="sg-delivery-n"><strong>{fmt.num(delivery.after_rules)}</strong><span>of {fmt.num(delivery.audience)} would be sent</span></div>
            <div className="meter"><div style={{ width: `${delivery.audience ? (delivery.after_rules / delivery.audience) * 100 : 0}%` }} /></div>
            <div className="sg-hint">{delivery.rules ? `${delivery.rules} destination rule${delivery.rules > 1 ? 's' : ''} apply.` : 'No destination rules — everyone is sent.'}</div>
          </div>
        )}
      </>)}
      <ErrorBox error={error} />
    </div>
  )
}

function SplitsCard({ splits, onChange }: { splits: Splits; onChange: (s: Splits) => void }) {
  const total = splits.groups.reduce((a, g) => a + Number(g.percent || 0), 0)
  const set = (i: number, patch: Partial<Splits['groups'][number]>) => onChange({ ...splits, groups: splits.groups.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
  return (
    <section className="card sg-split">
      <div className="sg-card-head">
        <div><h2>A/B split <span className="sg-optional">optional</span></h2><p>Hold some people back to measure whether the campaign actually works.</p></div>
        <label className="sg-switch">
          <input type="checkbox" checked={splits.enabled} aria-label="A/B split"
            onChange={(e) => onChange({ enabled: e.target.checked, groups: splits.groups.length ? splits.groups : [{ name: 'treatment', percent: 90 }, { name: 'holdout', percent: 10 }] })} />
          <span aria-hidden="true" />
        </label>
      </div>
      {splits.enabled && (
        <div className="sg-card-body sg-split-body">
          <div className="sg-split-bar" aria-hidden="true">
            {splits.groups.map((g, i) => <span key={i} className={`k${i % 3}`} style={{ flex: Math.max(Number(g.percent) || 0, 0.001) }}>{Number(g.percent) >= 8 ? `${g.name} ${g.percent}%` : ''}</span>)}
          </div>
          {splits.groups.map((g, i) => (
            <div key={i} className="sg-split-row">
              <span className={`sg-split-key k${i % 3}`} aria-hidden="true" />
              <input className="input sm grow" value={g.name} aria-label={`Group ${i + 1} name`} onChange={(e) => set(i, { name: e.target.value })} />
              <input className="input sm num" type="number" min={0} max={100} value={g.percent} style={{ width: 76 }} aria-label={`${g.name} percent`}
                onChange={(e) => set(i, { percent: Number(e.target.value) })} />
              <span className="muted small">%</span>
              {splits.groups.length > 2 && <button className="btn ghost icon sm" aria-label={`Remove ${g.name}`} onClick={() => onChange({ ...splits, groups: splits.groups.filter((_, j) => j !== i) })}>✕</button>}
            </div>
          ))}
          <div className="spread">
            <button className="btn ghost sm" onClick={() => onChange({ ...splits, groups: [...splits.groups, { name: `group ${splits.groups.length + 1}`, percent: 0 }] })}>+ Add group</button>
            <span className={`small ${total === 100 ? 'muted' : 'sg-bad'}`}>{total === 100 ? 'Adds up to 100%' : `Adds up to ${total}% — must be 100%`}</span>
          </div>
          <div className="sg-hint">People are assigned randomly and permanently by ID. Choose which group a sync sends when you set it up.</div>
        </div>
      )}
    </section>
  )
}

type Draft = { name: string; description: string; definition: GroupNode; splits: Splits }
const snapshot = (d: Draft) => JSON.stringify(d)

/** The size: stays visible after edits, but clearly marked out of date until recounted; funnel per filter. */
function SizeBlock({ parentName, calc, fresh, saved, savedState, calculating, error, filterLabels, op, onCalculate }: {
  parentName: string; calc: Calculation | null; fresh: boolean; saved: Audience | null
  savedState: { tone: string; text: string } | null; calculating: boolean; error: string | null
  filterLabels: string[]; op: 'and' | 'or'; onCalculate: () => void
}) {
  const shown = calc ?? (saved?.last_size != null ? { size: saved.last_size, total: 0, steps: [] } : null)
  // a saved count is only flagged when it's actually doubtful (old, or filters changed since); a recent one is just labelled
  const stale = !!shown && !fresh && (!!calc || savedState?.tone === 'amber')
  const steps = fresh && calc && op === 'and' && calc.steps.length === filterLabels.length && filterLabels.length > 1
    ? filterLabels.map((l, i) => ({ label: l, value: calc.steps[i] })) : null
  const who = parentName.toLowerCase()
  return (
    <div className={`sg-size ${stale ? 'stale' : ''}`}>
      <div className="sg-size-head"><span>Audience size</span>{calculating && <Spinner />}</div>
      {shown ? (<>
        <div className="sg-size-n" aria-live="polite">{fmt.num(shown.size)}<small>people</small></div>
        {shown.total > 0 && (<>
          <div className="meter"><div style={{ width: `${Math.max((shown.size / shown.total) * 100, 0.8)}%` }} /></div>
          <div className="sg-size-sub">{fmt.pct(shown.size, shown.total)} of {fmt.num(shown.total)} {who}</div>
        </>)}
        {stale ? (
          <div className="sg-stale" role="status"><strong>{calc ? 'Filters changed' : (savedState?.text ?? 'Saved count')}</strong>
            <span>{calc ? 'This number is for the previous filters.' : 'Recount to see who qualifies right now.'}</span></div>
        ) : <div className="sg-size-sub">{calc ? 'Counted just now in Databricks' : savedState?.text ?? 'Saved count'}</div>}
      </>) : (
        <div className="sg-size-empty">{filterLabels.length ? 'Count to see how many people qualify right now.' : `No filters yet — every ${who.replace(/s$/, '')} qualifies.`}</div>
      )}
      <ErrorBox error={error} />
      <button className={`btn ${stale || !shown ? 'primary' : ''} sg-size-btn`} onClick={onCalculate} disabled={calculating}>
        {calculating ? 'Counting…' : shown ? 'Recount' : 'Count audience'}
      </button>
      {steps && <div className="sg-size-funnel"><div className="sg-size-head"><span>Filter by filter</span></div><Funnel steps={steps} total={calc!.total} /></div>}
    </div>
  )
}

function MoreMenu({ items }: { items: { label: string; danger?: boolean; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  return (
    <div className="add-menu" ref={ref}>
      <button className="btn icon" aria-label="More actions" aria-expanded={open} onClick={() => setOpen(!open)}>⋯</button>
      {open && (
        <div className="menu sg-more" style={{ right: 0, left: 'auto' }}>
          {items.map((i) => <button key={i.label} className={i.danger ? 'danger' : ''} onClick={() => { setOpen(false); i.onClick() }}><div><strong>{i.label}</strong></div></button>)}
        </div>
      )}
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
  const loadPreview = async () => {
    setPreviewLoading(true)
    try { setPreview(await api.post('/audiences/preview', { definition, parent_id: pid })) } catch (e) { setCalcError((e as Error).message) } finally { setPreviewLoading(false) }
  }
  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const change = (d: GroupNode) => {
    update({ definition: d }); setPreview(null)
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
    setDraft(d); setPreview(null)
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

  if (schema.loading || (!isNew && !parentId)) return <div className="page wide"><SkeletonRows rows={6} />{loadError && <ErrorBox error={loadError} />}</div>
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
  const ctx = { schema: schema.data, audiences: audiences.data ?? [] }
  const filterLabels = definition.conditions.map((c) => conditionText(c, ctx) || 'Custom filter')
  const brandDests = (dests.data ?? []).filter((d) => d.brand_id == null || d.brand_id === brandId)
  const status = isNew ? { cls: 'brand', text: 'Draft' } : dirty ? { cls: 'amber', text: 'Unsaved changes' } : { cls: 'green', text: 'Saved' }

  return (
    <BuilderProvider value={{ schema: schema.data, audiences: audiences.data ?? [], currentAudienceId: isNew ? undefined : Number(id) }}>
      <div className="page wide sg-builder">
        <div className="sg-crumbs"><Link to="/audiences">Audiences</Link><span aria-hidden="true">/</span><span>{isNew ? 'New audience' : name}</span></div>
        <header className="sg-head">
          <Glyph kind="audience" size={48} />
          <div className="sg-head-main">
            <div className="sg-title-row">
              {canEdit ? (
                <input className="sg-title-input" value={name} aria-label="Audience name" placeholder="Name this audience"
                  onChange={(e) => update({ name: e.target.value })} />
              ) : <h1 className="sg-title-static">{name}</h1>}
              {canEdit && (isNew || dirty) && <span className={`badge ${status.cls}`} role="status"><span className="dot" />{status.text}</span>}
              {!canEdit && <span className="badge" title="Your role can explore this audience but not change it">View only</span>}
            </div>
            {canEdit ? (
              <input className="sg-desc-input" placeholder="Add a description — who is this for and why?" aria-label="Description"
                value={description} onChange={(e) => update({ description: e.target.value })} />
            ) : description && <p className="sg-desc-static">{description}</p>}
            <div className="sg-context">
              {isNew && parents.length > 1 ? (
                <label className="row small" style={{ gap: 6 }}>
                  <span className="muted">Build from</span>
                  <select className="input sm" value={parent.id} onChange={(e) => { setParentId(Number(e.target.value)); change(EMPTY) }}>
                    {parents.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
              ) : <span>Built on <strong>{parent.name}</strong></span>}
              <span>{me.brandName(brandId)}</span>
              {record?.created_by && <span>Owner <strong>{ownerName(record.created_by)}</strong></span>}
              {record && <span title={new Date(record.updated_at).toLocaleString()}>Saved {fmt.ago(record.updated_at)}</span>}
            </div>
          </div>
          <div className="sg-head-actions">
            {!isNew && canSync && <Link to={`/activations/new?audience=${id}`} className="btn">Send to a destination</Link>}
            {canEdit && (
              <button className="btn primary" onClick={save} disabled={saving || (!dirty && !isNew)} title="Ctrl / ⌘ + S">
                {saving ? 'Saving…' : isNew ? 'Save audience' : dirty ? 'Save changes' : 'Saved'}
              </button>
            )}
            {!isNew && canEdit && <MoreMenu items={[{ label: 'Duplicate', onClick: copy }, { label: 'Delete audience', danger: true, onClick: remove }]} />}
          </div>
        </header>
        <ErrorBox error={loadError || saveError} />

        <div className="sg-builder-grid">
          <div className="sg-builder-main">
            <fieldset className="card sg-filters" disabled={!canEdit}>
              <div className="sg-card-head">
                <div><h2>Who should be in this audience?</h2><p>Everyone in {parent.name.toLowerCase()} who matches the filters below.</p></div>
                {definition.conditions.length > 0 && <span className="cx-count">{definition.conditions.length} filter{definition.conditions.length === 1 ? '' : 's'}</span>}
              </div>
              <div className="sg-card-body">
                {definition.conditions.length === 0 && (
                  <div className="sg-start">
                    <strong>Start with a filter</strong>
                    <span>Pick a profile property (e.g. country), something people did (e.g. watched a video in the last 30 days) or a computed trait.</span>
                  </div>
                )}
                <GroupEditor group={definition} onChange={change} />
              </div>
            </fieldset>

            <fieldset className="sg-fieldset" disabled={!canEdit}>
              <SplitsCard splits={splits} onChange={(s) => update({ splits: s })} />
            </fieldset>

            <section className="card sg-peek">
              <div className="sg-card-head">
                <div className="seg" role="tablist">
                  <button role="tab" aria-selected={tab === 'preview'} className={tab === 'preview' ? 'on' : ''} onClick={() => setTab('preview')}>Members</button>
                  <button role="tab" aria-selected={tab === 'sql'} className={tab === 'sql' ? 'on' : ''} onClick={() => setTab('sql')}>SQL</button>
                </div>
                {tab === 'preview' && preview && <button className="btn ghost sm" onClick={loadPreview} disabled={previewLoading}>{previewLoading ? 'Refreshing…' : 'Refresh'}</button>}
              </div>
              <div className="sg-card-body">
                {tab === 'preview' ? (
                  preview ? (<>
                    <div className="small muted" style={{ marginBottom: 8 }}>First {preview.rows.length.toLocaleString()} matching {parent.name.toLowerCase()} — live from Databricks. Private columns stay hidden.</div>
                    <div className="table-wrap" style={{ maxHeight: 420 }}>
                      <table className="table compact">
                        <thead><tr>{preview.columns.map((c) => <th key={c}>{parent.column_settings?.[c]?.alias || c}</th>)}</tr></thead>
                        <tbody>{preview.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v == null ? <span className="faint">—</span> : String(v)}</td>)}</tr>)}</tbody>
                      </table>
                    </div>
                    {!preview.rows.length && <div className="dm-none">Nobody matches these filters right now.</div>}
                  </>) : (
                    <div className="sg-peek-empty">
                      <span>See real people who match — useful to sanity-check the filters before sending.</span>
                      <button className="btn" onClick={loadPreview} disabled={previewLoading}>{previewLoading ? 'Loading…' : 'Show first 100 members'}</button>
                    </div>
                  )
                ) : <pre className="code">{sql || 'Compiling…'}</pre>}
              </div>
            </section>
          </div>

          <aside className="card sg-summary" aria-label="Audience summary">
            <SizeBlock parentName={parent.name} calc={calc?.result ?? null} fresh={fresh} saved={dirty || isNew ? (calc ? null : record) : record}
              savedState={record ? sizeState(record) : null} calculating={calculating} error={calcError}
              filterLabels={filterLabels} op={definition.op} onCalculate={calculate} />
            <Explore schema={schema.data} definition={definition} audiences={audiences.data ?? []} currentId={isNew ? undefined : Number(id)} dests={brandDests} />
            {!isNew && (
              <div className="sg-sent">
                <div className="sg-size-head"><span>Where it's sent</span>{canSync && <Link to={`/activations/new?audience=${id}`} className="small">+ Add</Link>}</div>
                {syncs.data?.length ? (<>
                  {syncs.data.slice(0, 4).map((s) => {
                    const ss = syncState(s)
                    return (
                      <Link key={s.id} to={`/activations/${s.id}`} className="sg-send compact" title={`${s.name} → ${s.destination_name}`}>
                        <BrandLogo type={s.destination_type} size={26} />
                        <span className="sg-send-main"><strong>{s.destination_name}</strong>{s.config.split_group && <small>{s.config.split_group}</small>}</span>
                        <Pill tone={ss.tone}>{ss.text}</Pill>
                      </Link>
                    )
                  })}
                  {syncs.data.length > 4 && <Link className="small sg-more-link" to={`/activations?q=${encodeURIComponent(name)}`}>+{syncs.data.length - 4} more syncs</Link>}
                </>) : <div className="sg-hint">Not sent anywhere yet.</div>}
              </div>
            )}
          </aside>
        </div>

        {canEdit && (dirty || isNew) && (
          <div className="dm-savebar sg-savebar" role="region" aria-label="Unsaved changes">
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
