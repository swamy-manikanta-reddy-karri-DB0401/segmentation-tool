import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import type { Audience, ColumnType, Schema, Sync, TimeWindow, Trait, TraitConfig, TraitMethod } from '../api'
import { BuilderProvider, filterColumns } from '../components/builder/ConditionEditor'
import TraitConfigEditor, { METHODS } from '../components/TraitConfigEditor'
import { Empty, ErrorBox, Field, Modal, PageHead, useAsync } from '../components/ui'
import { useMe } from '../components/me'
import { askConfirm, FilterChips, matches, NoResults, Pager, SearchBox, SkeletonRows, sortBy, toast, usePaged, useUrlState } from '../components/kit'
import { CollectionLayout, Facts, Inspector, ListPane, ListRow, Section, StatTile } from '../components/collection'
import { TopValues } from '../components/viz'
import { BrandLogo } from '../components/logos'
import { Glyph, traitGlyph, useSelected } from '../ux/segment-kit'
import '../ux/segment.css'

type TraitRow = Trait & { updated_at?: string }
const TYPE_LABEL: Record<string, string> = { string: 'Text', number: 'Number', boolean: 'Yes / no', timestamp: 'Date & time', date: 'Date', other: 'Other' }
const OCCURRENCE: Record<string, string> = { first: 'First', last: 'Most recent', most_frequent: 'Most frequent', least_frequent: 'Least frequent' }

function windowWords(tw?: TimeWindow): string {
  if (!tw || tw.type === 'anytime') return ''
  const amount = (tw as { amount?: number | string }).amount
  const unit = (tw as { unit?: string }).unit ?? 'day'
  const span = `${amount ?? '…'} ${unit}${Number(amount) === 1 ? '' : 's'}`
  if (tw.type === 'within') return ` in the ${tw.direction === 'next' ? 'next' : 'last'} ${span}`
  if (tw.type === 'not_within') return ` outside the last ${span}`
  return ''
}

/** “Total Video Minutes from User Engagement in the last 90 days, 1 filter” */
export function describeTrait(t: Trait, s: Schema): string {
  const c = t.config ?? {}
  const model = s.models.find((m) => m.id === c.model_id)
  const from = model?.name ?? 'related records'
  const col = c.column ? (model ? filterColumns(model).find((x) => x.name === c.column)?.label : undefined) ?? c.column : 'value'
  const extra = `${windowWords(c.time_window)}${c.filter?.conditions?.length ? `, ${c.filter.conditions.length} filter${c.filter.conditions.length === 1 ? '' : 's'}` : ''}`
  switch (t.method) {
    case 'aggregation': return `${c.fn === 'avg' ? 'Average' : 'Total'} ${col} across ${from}${extra}`
    case 'count': return `Number of ${from} records${c.event_names?.length ? ` (${c.event_names.join(', ')})` : ''}${extra}`
    case 'occurrence': return `${OCCURRENCE[c.occurrence ?? 'last'] ?? 'Most recent'} ${col} from ${from}${extra}`
    case 'list': return `List of ${c.distinct ? 'distinct ' : ''}${col} from ${from}${c.limit ? ` (up to ${c.limit})` : ''}${extra}`
    case 'sql_aggregation': return `Custom SQL calculation over ${from}${extra}`
    case 'sql_formula': return 'Formula combining profile columns and other traits'
  }
  return ''
}

function TraitModal({ schema, existing, onClose, onSaved }: { schema: Schema; existing?: Trait; onClose: () => void; onSaved: (name: string) => void }) {
  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [method, setMethod] = useState<TraitMethod>(existing?.method ?? 'aggregation')
  const [config, setConfig] = useState<TraitConfig>(existing?.config ?? { model_id: schema.models[0]?.id, fn: 'sum' })
  const [preview, setPreview] = useState<{ columns: string[]; rows: unknown[][] } | null>(null)
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const runPreview = async () => {
    setBusy('preview'); setError(null)
    try { setPreview(await api.post('/traits/preview', { method, config, parent_id: schema.parent!.id })) }
    catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const save = async () => {
    setBusy('save'); setError(null)
    const body = { name: name.trim(), description, method, config, parent_id: schema.parent!.id }
    try {
      if (existing) await api.put(`/traits/${existing.id}`, body)
      else await api.post('/traits', body)
      onSaved(body.name)
    } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const draft = { id: existing?.id ?? 0, parent_id: schema.parent!.id, name, description, method, config }

  return (
    <Modal wide title={existing ? `Edit ${existing.name}` : 'New trait'} subtitle={`A calculated value for each ${schema.parent!.name.toLowerCase().replace(/s$/, '')} — usable in audience filters, profiles and syncs.`}
      onClose={onClose} footer={<>
        <button className="btn" onClick={runPreview} disabled={!!busy}>{busy === 'preview' ? 'Calculating…' : 'Preview results'}</button>
        <span className="grow" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={!!busy || !name.trim()}>{busy === 'save' ? 'Saving…' : existing ? 'Save changes' : 'Create trait'}</button>
      </>}>
      <div className="grid-2">
        <Field label="Name" help="Say what the value means, e.g. “Video minutes, last 30 days”."><input className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description (optional)" help="Units, exclusions, who asked for it…"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      </div>
      <Field label="Calculation">
        <TraitConfigEditor method={method} config={config} onChange={(m, c) => { setMethod(m); setConfig(c); setPreview(null) }} />
      </Field>
      <div className="seg-trait-summary"><span>In plain words</span><strong>{describeTrait(draft, schema)}</strong></div>
      <ErrorBox error={error} />
      {preview && (
        <div className="table-wrap sg-modal-preview" style={{ maxHeight: 260 }}>
          <table className="table compact">
            <thead><tr><th>{schema.parent!.name}</th><th>Value</th></tr></thead>
            <tbody>{preview.rows.map((r, i) => <tr key={i}><td>{String(r[0])}</td><td className="mono">{r[1] == null ? '—' : String(r[1])}</td></tr>)}</tbody>
          </table>
          {!preview.rows.length && <div className="empty"><p>Nobody has a value for this trait yet.</p></div>}
        </div>
      )}
    </Modal>
  )
}

type Preview = { columns: string[]; rows: unknown[][] }

/** A small sample of real values: a distribution for text, min / average / max for numbers. */
function SampleValues({ t, schema, type }: { t: Trait; schema: Schema; type: string }) {
  const [data, setData] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setData(null); setError(null) }, [t.id])
  const load = async () => {
    setBusy(true); setError(null)
    try { setData(await api.post<Preview>('/traits/preview', { method: t.method, config: t.config, parent_id: schema.parent!.id })) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const values = (data?.rows ?? []).map((r) => r[1])
  const nums = values.map((v) => Number(v)).filter((v) => Number.isFinite(v))
  const numeric = type === 'number' && nums.length > 0
  const counts = new Map<string, number>()
  if (!numeric) for (const v of values) { const k = Array.isArray(v) ? v.join(', ') : String(v); counts.set(k, (counts.get(k) ?? 0) + 1) }
  const fmtV = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 }))
  const who = schema.parent!.name.toLowerCase()
  return (
    <Section title="Sample values" aside={<button className={`btn sm ${data ? 'ghost' : ''}`} onClick={load} disabled={busy}>{busy ? 'Calculating…' : data ? 'Refresh' : 'Calculate sample'}</button>}>
      <ErrorBox error={error} />
      {!data ? <div className="sg-hint">Calculates this trait live for up to 20 {who} so you can check the values make sense.</div>
        : !values.length ? <div className="sg-hint">Nobody has a value for this trait yet.</div>
          : numeric ? (<>
            <div className="cx-stats">
              <StatTile label="Lowest" value={fmtV(Math.min(...nums))} />
              <StatTile label="Average" value={fmtV(nums.reduce((x, y) => x + y, 0) / nums.length)} />
              <StatTile label="Highest" value={fmtV(Math.max(...nums))} />
            </div>
            <div className="sg-sample">{(data.rows.slice(0, 6)).map((r, i) => <div key={i}><span>{String(r[0])}</span><strong>{r[1] == null ? '—' : fmtV(Number(r[1]))}</strong></div>)}</div>
            <div className="small faint">Based on {nums.length} {who} with a value.</div>
          </>) : (<>
            <TopValues items={[...counts.entries()].sort((x, y) => y[1] - x[1]).map(([label, value]) => ({ label, value }))} unit={who} max={6} />
            <div className="small faint">Based on {values.length} {who} with a value.</div>
          </>)}
    </Section>
  )
}

function TraitInspector({ t, schema, usage, type, canManage, onEdit, onDelete }: {
  t: Trait; schema: Schema; usage: { audiences: Audience[]; syncs: Sync[] }; type: string; canManage: boolean; onEdit: () => void; onDelete: () => void
}) {
  const g = traitGlyph(t.method === 'list' ? 'list' : (type as ColumnType))
  const c = t.config ?? {}
  const model = schema.models.find((m) => m.id === c.model_id)
  const tw = windowWords(c.time_window).trim()
  return (
    <Inspector
      icon={<Glyph kind={g.kind} tone={g.tone} size={40} />}
      kicker={<>Trait · {METHODS.find((m) => m.value === t.method)?.label}</>}
      title={t.name}
      actions={canManage ? <button className="btn sm" onClick={onEdit}>Edit</button> : undefined}
      sentence={<>{describeTrait(t, schema)} — one value for every {schema.parent!.name.toLowerCase().replace(/s$/, '')}.</>}>
      {t.description && <p className="sg-desc">{t.description}</p>}
      <div className="cx-stats">
        <StatTile label="Value" value={t.method === 'list' ? 'List' : TYPE_LABEL[type] ?? type} />
        <StatTile label="Audiences" value={usage.audiences.length} sub={usage.audiences.length ? 'filter on it' : 'none yet'} />
        <StatTile label="Syncs" value={usage.syncs.length} sub={usage.syncs.length ? 'send it' : 'none yet'} />
      </div>
      <SampleValues t={t} schema={schema} type={type} />
      <Section title="Where it's used">
        {usage.audiences.length + usage.syncs.length === 0 ? <div className="sg-hint">Not used yet — add it as a filter in an audience or map it as a field in a sync.</div> : (
          <div className="sg-uses">
            {usage.audiences.map((a) => <Link key={`a${a.id}`} to={`/audiences/${a.id}`} className="sg-use"><Glyph kind="audience" size={24} /><span>{a.name}</span><small>Audience filter</small></Link>)}
            {usage.syncs.map((x) => <Link key={`s${x.id}`} to={`/activations/${x.id}`} className="sg-use"><BrandLogo type={x.destination_type} size={24} /><span>{x.name}</span><small>Field sent</small></Link>)}
          </div>
        )}
      </Section>
      <Section title="How it's calculated">
        <Facts rows={[
          ['Method', METHODS.find((m) => m.value === t.method)?.label ?? t.method],
          ['From', model?.name ?? (t.method === 'sql_formula' ? 'Profile columns and traits' : '—')],
          ...(c.column ? [['Column', <code key="c">{c.column}</code>] as [string, ReactNode]] : []),
          ['Time window', tw || 'All time'],
          ...(c.filter?.conditions?.length ? [['Filters', `${c.filter.conditions.length} condition${c.filter.conditions.length === 1 ? '' : 's'}`] as [string, ReactNode]] : []),
        ]} />
      </Section>
      {canManage && <div className="sg-quiet-actions"><span className="grow" /><button className="btn ghost sm danger" onClick={onDelete}>Delete trait</button></div>}
    </Inspector>
  )
}

export default function Traits() {
  const [params, setParams] = useSearchParams()
  const pidParam = params.get('parent')
  const schema = useAsync(() => api.get<Schema>(`/schema${pidParam ? `?parent_id=${pidParam}` : ''}`), [pidParam])
  const audiences = useAsync(() => api.get<Audience[]>('/audiences'))
  const syncs = useAsync(() => api.get<Sync[]>('/syncs'))
  const [modal, setModal] = useState<{ existing?: Trait } | null>(null)
  const [q, setQ] = useUrlState('q')
  const [method, setMethod] = useUrlState('method', 'all')
  const [sortKey, setSortKey] = useUrlState('sort', 'name')
  const [selected, setSelected] = useSelected()
  const s = schema.data
  const me = useMe()

  // where each trait is referenced: audience filters ("trait_id": n / "trait.n") and sync mappings ("trait.n")
  const usage = (t: Trait) => {
    const inAud = (audiences.data ?? []).filter((a) => { const j = JSON.stringify(a.definition); return j.includes(`"trait_id":${t.id}`) || j.includes(`"trait.${t.id}"`) })
    const inSync = (syncs.data ?? []).filter((x) => JSON.stringify(x.config).includes(`"trait.${t.id}"`))
    return { audiences: inAud, syncs: inSync }
  }

  const remove = async (t: Trait) => {
    const u = usage(t)
    const where = [u.audiences.length && `${u.audiences.length} audience${u.audiences.length === 1 ? '' : 's'}`, u.syncs.length && `${u.syncs.length} sync${u.syncs.length === 1 ? '' : 's'}`].filter(Boolean).join(' and ')
    const ok = await askConfirm({
      title: `Delete trait “${t.name}”?`, danger: true, confirmLabel: 'Delete trait',
      body: where ? <>It’s used by <strong>{where}</strong>{u.audiences.length ? <> ({u.audiences.slice(0, 3).map((a) => a.name).join(', ')}{u.audiences.length > 3 ? '…' : ''})</> : null}. Those filters and fields will stop working.</>
        : 'Nothing uses it right now. This can’t be undone.',
    })
    if (!ok) return
    try { await api.del(`/traits/${t.id}`); setSelected(null); schema.reload(); toast(`“${t.name}” deleted`) } catch (e) { toast((e as Error).message, 'error') }
  }

  const canManage = !!s?.parent && me.can('traits.manage', s.parent.brand_id ?? null)
  const typeOf = (t: Trait) => s?.virtual_columns.find((v) => v.name === `trait.${t.id}`)?.type ?? 'string'
  const all = (s?.traits ?? []) as TraitRow[]
  const base = all.filter((t) => matches(q, t.name, t.description, s ? describeTrait(t, s) : ''))
  const sort = sortKey.startsWith('-') ? { key: sortKey.slice(1), dir: 'desc' as const } : { key: sortKey, dir: 'asc' as const }
  const rows = sortBy(base.filter((t) => method === 'all' || t.method === method), sort, {
    name: (t) => t.name.toLowerCase(), used: (t) => { const u = usage(t); return u.audiences.length + u.syncs.length }, updated: (t) => t.updated_at ?? null,
  })
  const paged = usePaged(rows, 14, `${q}|${method}|${sortKey}|${s?.parent?.id}`, 'page')
  const current = all.find((t) => String(t.id) === selected) ?? paged.slice[0] ?? rows[0]
  const methodsUsed = METHODS.filter((m) => all.some((t) => t.method === m.value))
  const clear = () => { setQ(''); setMethod('all') }

  if (schema.loading && !s) return <div className="page wide sg-page"><PageHead stage="modeling" title="Traits" /><SkeletonRows rows={5} /></div>
  if (!s?.parent) {
    return <div className="page"><Empty title="Set up your data first" action={<Link to="/schema" className="btn primary">Open data model</Link>}>Traits are calculated from your customer data. A Platform Admin sets up the data model first.</Empty></div>
  }
  const who = s.parent.name.toLowerCase().replace(/s$/, '')
  return (
    <BuilderProvider value={{ schema: s, audiences: [] }}>
      <div className="page wide sg-page">
        <PageHead stage="modeling" title="Traits"
          subtitle={`Values calculated once for every ${who} — total video minutes, favorite section, last seen — and reused in audiences, profiles and syncs.`}
          actions={canManage ? <button className="btn primary" onClick={() => setModal({})} disabled={!s.models.length} title={!s.models.length ? 'Add a related or event model first' : undefined}>+ New trait</button> : undefined} />
        <ErrorBox error={schema.error} />

        {!all.length ? (
          <div className="card sg-onboard">
            <Glyph kind="number" size={52} />
            <h2>Create your first trait</h2>
            <p className="muted">A trait turns raw activity into one meaningful value per {who} — then marketers filter on it like any profile field.</p>
            <div className="sg-ideas">
              <div className="sg-idea"><strong>Video minutes, last 30 days</strong><span>Total of a number across events.</span></div>
              <div className="sg-idea"><strong>Favorite section</strong><span>The most frequent value people engage with.</span></div>
              <div className="sg-idea"><strong>Last seen</strong><span>The most recent activity date.</span></div>
            </div>
            {canManage ? <button className="btn primary" onClick={() => setModal({})} disabled={!s.models.length}>+ New trait</button>
              : <div className="small faint">Brand Marketing Admins can create traits.</div>}
          </div>
        ) : (
          <CollectionLayout
            list={
              <ListPane title={s.parents.length > 1 ? `Traits for ${s.parent.name}` : 'All traits'} count={rows.length}
                toolbar={<>
                  <SearchBox value={q} onChange={setQ} placeholder="Search traits…" />
                  {methodsUsed.length > 1 && (
                    <FilterChips label="Calculation method" value={method} onChange={setMethod} options={[
                      { value: 'all', label: 'All', count: base.length },
                      ...methodsUsed.map((m) => ({ value: m.value as string, label: m.label, count: base.filter((t) => t.method === m.value).length })),
                    ]} />
                  )}
                  <select className="input sm" value={sortKey} onChange={(e) => setSortKey(e.target.value)} aria-label="Sort">
                    <option value="name">Name A–Z</option><option value="-used">Most used</option><option value="-updated">Recently changed</option>
                  </select>
                  {s.parents.length > 1 && (
                    <select className="input sm" value={s.parent.id} onChange={(e) => setParams({ parent: e.target.value }, { replace: true })} aria-label="Parent model">
                      {s.parents.map((p) => <option key={p.id} value={p.id}>{p.name} · {me.brandName(p.brand_id)}</option>)}
                    </select>
                  )}
                  {(q || method !== 'all') && <button className="btn ghost sm" onClick={clear}>Clear</button>}
                </>}
                footer={rows.length > 14 ? <Pager page={paged.page} pages={paged.pages} total={rows.length} pageSize={14} onPage={paged.setPage} noun="trait" /> : undefined}>
                {rows.length ? paged.slice.map((t) => {
                  const u = usage(t)
                  const n = u.audiences.length + u.syncs.length
                  const g = traitGlyph(t.method === 'list' ? 'list' : typeOf(t))
                  return (
                    <ListRow key={t.id} selected={current?.id === t.id} onSelect={() => setSelected(String(t.id))}
                      leading={<Glyph kind={g.kind} tone={g.tone} />}
                      title={t.name} subtitle={describeTrait(t, s)}
                      meta={<><strong>{n || '—'}</strong><span>{n ? `use${n === 1 ? '' : 's'}` : 'unused'}</span></>} />
                  )
                }) : <NoResults what="traits" onClear={clear} />}
              </ListPane>
            }
            inspector={current ? (
              <TraitInspector t={current} schema={s} usage={usage(current)} type={typeOf(current)} canManage={canManage}
                onEdit={() => setModal({ existing: current })} onDelete={() => remove(current)} />
            ) : <Inspector empty={<div>Select a trait to see its values.</div>} />}
          />
        )}
        {modal && <TraitModal schema={s} existing={modal.existing} onClose={() => setModal(null)}
          onSaved={(n) => { setModal(null); schema.reload(); toast(modal.existing ? `“${n}” saved` : `“${n}” created`) }} />}
      </div>
    </BuilderProvider>
  )
}
