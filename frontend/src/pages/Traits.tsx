import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Audience, Schema, Sync, TimeWindow, Trait, TraitConfig, TraitMethod } from '../api'
import { BuilderProvider, filterColumns } from '../components/builder/ConditionEditor'
import TraitConfigEditor, { METHODS } from '../components/TraitConfigEditor'
import { Empty, ErrorBox, Field, Modal, PageHead, useAsync } from '../components/ui'
import { useMe } from '../components/me'
import { askConfirm, FilterChips, matches, NoResults, Pager, SearchBox, SkeletonRows, SortTh, Toolbar, sortBy, toast, usePaged, useSort, useUrlState } from '../components/kit'
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
        <div className="table-wrap" style={{ maxHeight: 260 }}>
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

export default function Traits() {
  const [params, setParams] = useSearchParams()
  const pidParam = params.get('parent')
  const schema = useAsync(() => api.get<Schema>(`/schema${pidParam ? `?parent_id=${pidParam}` : ''}`), [pidParam])
  const audiences = useAsync(() => api.get<Audience[]>('/audiences'))
  const syncs = useAsync(() => api.get<Sync[]>('/syncs'))
  const [modal, setModal] = useState<{ existing?: Trait } | null>(null)
  const [q, setQ] = useUrlState('q')
  const [method, setMethod] = useUrlState('method', 'all')
  const [sort, toggleSort] = useSort('name')
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
    try { await api.del(`/traits/${t.id}`); schema.reload(); toast(`“${t.name}” deleted`) } catch (e) { toast((e as Error).message, 'error') }
  }

  const canManage = !!s?.parent && me.can('traits.manage', s.parent.brand_id ?? null)
  const typeOf = (t: Trait) => s?.virtual_columns.find((v) => v.name === `trait.${t.id}`)?.type ?? 'string'
  const all = (s?.traits ?? []) as TraitRow[]
  const base = all.filter((t) => matches(q, t.name, t.description, s ? describeTrait(t, s) : ''))
  const rows = sortBy(base.filter((t) => method === 'all' || t.method === method), sort, {
    name: (t) => t.name.toLowerCase(), method: (t) => t.method, type: (t) => typeOf(t), updated: (t) => t.updated_at ?? null,
    used: (t) => { const u = usage(t); return u.audiences.length + u.syncs.length },
  })
  const paged = usePaged(rows, 20, `${q}|${method}|${sort.key}${sort.dir}|${s?.parent?.id}`, 'page')
  const methodsUsed = METHODS.filter((m) => all.some((t) => t.method === m.value))
  const clear = () => { setQ(''); setMethod('all') }

  if (schema.loading && !s) return <div className="page wide"><PageHead stage="modeling" title="Traits" /><SkeletonRows rows={5} /></div>
  if (!s?.parent) {
    return <div className="page"><Empty title="Set up your data first" action={<Link to="/schema" className="btn primary">Open data model</Link>}>Traits are calculated from your customer data. A Platform Admin sets up the data model first.</Empty></div>
  }
  return (
    <BuilderProvider value={{ schema: s, audiences: [] }}>
      <div className="page wide">
        <PageHead stage="modeling" title="Traits"
          subtitle="Reusable calculated values — total page views, video minutes, favorite section — usable in audience filters, profiles and syncs."
          actions={canManage ? <button className="btn primary" onClick={() => setModal({})} disabled={!s.models.length} title={!s.models.length ? 'Add a related or event model first' : undefined}>+ New trait</button> : undefined} />
        <ErrorBox error={schema.error} />

        {s.parents.length > 1 && (
          <div className="seg-parent-switch">
            <span className="small muted">Traits for</span>
            <select className="input sm" value={s.parent.id} onChange={(e) => setParams({ parent: e.target.value }, { replace: true })} aria-label="Parent model">
              {s.parents.map((p) => <option key={p.id} value={p.id}>{p.name} · {me.brandName(p.brand_id)}</option>)}
            </select>
          </div>
        )}

        {!all.length ? (
          <div className="card">
            <Empty title="No traits yet" action={canManage ? <button className="btn primary" onClick={() => setModal({})} disabled={!s.models.length}>Create a trait</button> : undefined}>
              Build a value once — like total video minutes over 30 days — and reuse it in every audience, profile and sync.
            </Empty>
          </div>
        ) : (<>
          <Toolbar>
            <SearchBox value={q} onChange={setQ} placeholder={`Search ${all.length} traits…`} />
            {methodsUsed.length > 1 && (
              <FilterChips label="Calculation method" value={method} onChange={setMethod} options={[
                { value: 'all', label: 'All', count: base.length },
                ...methodsUsed.map((m) => ({ value: m.value as string, label: m.label, count: base.filter((t) => t.method === m.value).length })),
              ]} />
            )}
            <span className="grow" />
            {(q || method !== 'all') && <button className="btn ghost sm" onClick={clear}>Clear filters</button>}
          </Toolbar>
          <div className="card seg-card">
            {rows.length ? (
              <table className="table seg-table">
                <thead><tr>
                  <SortTh k="name" sort={sort} onSort={toggleSort}>Trait</SortTh>
                  <SortTh k="type" sort={sort} onSort={toggleSort}>Value</SortTh>
                  <SortTh k="used" sort={sort} onSort={toggleSort}>Used in</SortTh>
                  <SortTh k="updated" sort={sort} onSort={toggleSort} className="seg-hide-sm">Updated</SortTh>
                  {canManage && <th aria-label="Actions" />}
                </tr></thead>
                <tbody>
                  {paged.slice.map((t) => {
                    const u = usage(t)
                    return (
                      <tr key={t.id}>
                        <td>
                          <div className="seg-trait">
                            <strong>{t.name}</strong>
                            <div className="small muted">{describeTrait(t, s)}</div>
                            {t.description && <div className="small faint seg-desc" title={t.description}>{t.description}</div>}
                          </div>
                        </td>
                        <td><span className="badge">{t.method === 'list' ? 'List of values' : TYPE_LABEL[typeOf(t)] ?? typeOf(t)}</span><div className="small faint" style={{ marginTop: 4 }}>{METHODS.find((m) => m.value === t.method)?.label}</div></td>
                        <td className="small">
                          {u.audiences.length + u.syncs.length === 0 ? <span className="faint">Not used yet</span> : (
                            <div className="stack" style={{ gap: 2 }}>
                              {u.audiences.length > 0 && <span title={u.audiences.map((a) => a.name).join(', ')}>{u.audiences.length} audience{u.audiences.length === 1 ? '' : 's'}</span>}
                              {u.syncs.length > 0 && <span title={u.syncs.map((x) => x.name).join(', ')}>{u.syncs.length} sync{u.syncs.length === 1 ? '' : 's'}</span>}
                            </div>
                          )}
                        </td>
                        <td className="muted seg-hide-sm">{fmt.ago(t.updated_at)}</td>
                        {canManage && (
                          <td className="seg-actions">
                            <button className="btn ghost sm" onClick={() => setModal({ existing: t })}>Edit</button>
                            <button className="btn ghost sm danger" onClick={() => remove(t)}>Delete</button>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ) : <NoResults what="traits" onClear={clear} />}
          </div>
          <Pager page={paged.page} pages={paged.pages} total={rows.length} pageSize={20} onPage={paged.setPage} noun="trait" />
        </>)}
        {modal && <TraitModal schema={s} existing={modal.existing} onClose={() => setModal(null)}
          onSaved={(n) => { setModal(null); schema.reload(); toast(modal.existing ? `“${n}” saved` : `“${n}” created`) }} />}
      </div>
    </BuilderProvider>
  )
}
