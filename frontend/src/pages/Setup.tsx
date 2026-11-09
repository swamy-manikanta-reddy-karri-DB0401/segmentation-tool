import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import type { Edge, Node as FlowNode, NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api } from '../api'
import type { Column, ColumnSettings, ColumnType, JoinKey, Model, Settings, SourceConnection } from '../api'
import { Link, useSearchParams } from 'react-router-dom'
import { ErrorBox, Field, Modal, PageHead, Spinner, Toggle, useAsync } from '../components/ui'
import { useMe } from '../components/me'
import { TypeIcon } from '../components/builder/ConditionEditor'
import { askConfirm, matches, Pager, SearchBox, SkeletonRows, SortTh, sortBy, toast, usePaged, useSort, useUrlState } from '../components/kit'
import '../ux/datamodel.css'


const KIND_INFO = {
  parent: { label: 'Parent model', badge: 'brand', help: 'What one audience member represents — e.g. one row per customer, household or account.' },
  related: { label: 'Related model', badge: 'teal', help: 'Records connected to the parent, like bookings, subscriptions or a lookup table.' },
  event: { label: 'Event model', badge: 'violet', help: 'Timestamped behavior, like page views, clicks or app events.' },
} as const
const PRIVACY: { value: NonNullable<ColumnSettings['privacy']>; label: string; help: string }[] = [
  { value: 'unreviewed', label: 'Unreviewed', help: 'Default. Usable everywhere.' },
  { value: 'approved', label: 'Approved', help: 'Reviewed and usable everywhere.' },
  { value: 'redacted', label: 'Redacted', help: 'Filterable, values hidden in previews and suggestions.' },
  { value: 'sync_only', label: 'Sync-only', help: 'Can be synced, not used in filters or previews.' },
  { value: 'sync_blocked', label: 'Sync-blocked', help: 'Can be filtered on, never synced.' },
  { value: 'blocked', label: 'Blocked', help: 'Not usable anywhere.' },
]

function TablePicker({ value, onChange, connectionId }: { value: string; onChange: (t: string) => void; connectionId?: number | null }) {
  const [cat, sch] = value ? value.split('.') : ['', '']
  const [catalog, setCatalog] = useState(cat)
  const [schema, setSchema] = useState(sch)
  const cq = connectionId ? `&connection_id=${connectionId}` : ''
  const catalogs = useAsync(() => api.get<string[]>(`/catalog/catalogs?${cq.slice(1)}`), [connectionId])
  const schemas = useAsync(() => (catalog ? api.get<string[]>(`/catalog/schemas?catalog_name=${catalog}${cq}`) : Promise.resolve([])), [catalog, connectionId])
  const tables = useAsync(() => (catalog && schema ? api.get<string[]>(`/catalog/tables?catalog_name=${catalog}&schema=${schema}${cq}`) : Promise.resolve([])), [catalog, schema, connectionId])
  const tableName = value.split('.')[2] ?? ''
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="grid-2" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        <select className="input" value={catalog} onChange={(e) => { setCatalog(e.target.value); setSchema(''); onChange('') }}>
          <option value="">Catalog…</option>
          {catalogs.data?.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select className="input" value={schema} disabled={!catalog} onChange={(e) => { setSchema(e.target.value); onChange('') }}>
          <option value="">Schema…</option>
          {schemas.data?.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className="input" value={tableName} disabled={!schema} onChange={(e) => onChange(e.target.value ? `${catalog}.${schema}.${e.target.value}` : '')}>
          <option value="">Table…</option>
          {tables.data?.map((t) => <option key={t}>{t}</option>)}
        </select>
      </div>
      {(catalogs.loading || schemas.loading || tables.loading) && <Spinner label="Loading from Unity Catalog…" />}
      <ErrorBox error={catalogs.error || schemas.error || tables.error} />
    </div>
  )
}

function ColumnPick({ columns, value, onChange, filter, optional }: {
  columns: Column[]; value: string | null | undefined; onChange: (v: string) => void; filter?: (c: Column) => boolean; optional?: boolean
}) {
  return (
    <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{optional ? '— none —' : 'Choose column…'}</option>
      {columns.filter(filter ?? (() => true)).map((c) => <option key={c.name} value={c.name}>{c.name} ({c.data_type})</option>)}
    </select>
  )
}

// ---------------------------------------------------------------------------
// shared: search, paging, column table

const TYPE_FILTERS: { value: string; label: string; types: ColumnType[] }[] = [
  { value: 'all', label: 'All types', types: [] },
  { value: 'string', label: 'Text', types: ['string'] },
  { value: 'number', label: 'Number', types: ['number'] },
  { value: 'boolean', label: 'Yes / no', types: ['boolean'] },
  { value: 'time', label: 'Date & time', types: ['date', 'timestamp'] },
]
const PRIVACY_TONE: Record<string, string> = { approved: 'green', redacted: 'amber', sync_only: 'blue', sync_blocked: 'violet', blocked: 'red' }

/** Searchable, filterable, paginated column list; editable (display name, visibility, privacy, suggestions) when allowed. */
function ColumnsTable({ columns, settings, onChange, editable, pageSize = 20, keyColumns = {} }: {
  columns: Column[]; settings: Record<string, ColumnSettings>; onChange?: (s: Record<string, ColumnSettings>) => void
  editable?: boolean; pageSize?: number; keyColumns?: Record<string, string>
}) {
  const [q, setQ] = useState('')
  const [type, setType] = useState('all')
  const [privacy, setPrivacy] = useState('all')
  const set = (name: string, patch: Partial<ColumnSettings>) => onChange?.({ ...settings, [name]: { ...settings[name], ...patch } })
  const needle = q.trim().toLowerCase()
  const types = TYPE_FILTERS.find((t) => t.value === type)!.types
  const rows = columns.filter((c) => {
    const st = settings[c.name] ?? {}
    return (!needle || c.name.toLowerCase().includes(needle) || (st.alias ?? '').toLowerCase().includes(needle))
      && (!types.length || types.includes(c.type))
      && (privacy === 'all' || (privacy === 'hidden' ? st.hidden : (st.privacy ?? 'unreviewed') === privacy))
  })
  const paged = usePaged(rows, pageSize, `${needle}|${type}|${privacy}`)
  const counts = { hidden: columns.filter((c) => settings[c.name]?.hidden).length, restricted: columns.filter((c) => ['redacted', 'blocked', 'sync_only', 'sync_blocked'].includes(settings[c.name]?.privacy ?? '')).length }
  return (
    <div className="dm-cols">
      <div className="dm-toolbar">
        <SearchBox value={q} onChange={setQ} placeholder={`Search ${columns.length} columns…`} />
        <select className="input sm" value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by type">
          {TYPE_FILTERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <select className="input sm" value={privacy} onChange={(e) => setPrivacy(e.target.value)} aria-label="Filter by privacy">
          <option value="all">Any privacy</option>
          {PRIVACY.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          <option value="hidden">Hidden columns</option>
        </select>
        <span className="grow" />
        <span className="small faint">{counts.hidden} hidden · {counts.restricted} restricted</span>
      </div>
      <div className="table-wrap dm-table">
        <table className="table compact">
          <thead><tr><th>Column</th><th>Display name</th><th>Privacy</th>{editable && <><th className="c">Visible</th><th className="c" title="Suggest values while filtering (text columns)">Suggestions</th></>}</tr></thead>
          <tbody>
            {paged.slice.map((c) => {
              const st = settings[c.name] ?? {}
              const priv = st.privacy ?? 'unreviewed'
              return (
                <tr key={c.name} className={st.hidden ? 'dm-muted' : ''}>
                  <td>
                    <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                      <TypeIcon type={c.type} />
                      <div style={{ minWidth: 0 }}>
                        <div className="mono dm-ellipsis" title={c.name}>{c.name}{keyColumns[c.name] && <span className="dm-key">{keyColumns[c.name]}</span>}</div>
                        <div className="faint small dm-ellipsis" title={c.data_type}>{c.data_type}</div>
                      </div>
                    </div>
                  </td>
                  <td>{editable
                    ? <input className="input sm" value={st.alias ?? ''} placeholder={label(c.name)} onChange={(e) => set(c.name, { alias: e.target.value })} />
                    : <span className={`dm-ellipsis ${st.alias ? '' : 'faint'}`} style={{ maxWidth: 200 }} title={st.alias || label(c.name)}>{st.alias || label(c.name)}</span>}</td>
                  <td>{editable ? (
                    <select className="input sm" value={priv} title={PRIVACY.find((p) => p.value === priv)?.help}
                      onChange={(e) => set(c.name, { privacy: e.target.value as ColumnSettings['privacy'] })}>
                      {PRIVACY.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  ) : <span className="row" style={{ gap: 4 }}>
                      <span className={`badge ${PRIVACY_TONE[priv] ?? ''}`} title={PRIVACY.find((p) => p.value === priv)?.help}>{PRIVACY.find((p) => p.value === priv)?.label}</span>
                      {st.hidden && <span className="badge" title="Not shown to marketers">Hidden</span>}
                    </span>}</td>
                  {editable && <>
                    <td className="c"><input type="checkbox" checked={!st.hidden} onChange={(e) => set(c.name, { hidden: !e.target.checked })} aria-label={`Show ${c.name}`} /></td>
                    <td className="c"><input type="checkbox" checked={c.type === 'string' && st.suggestions !== false} disabled={c.type !== 'string'} onChange={(e) => set(c.name, { suggestions: e.target.checked })} aria-label={`Suggestions for ${c.name}`} /></td>
                  </>}
                </tr>
              )
            })}
            {!rows.length && <tr><td colSpan={editable ? 5 : 3}><div className="dm-none">No columns match. <button className="btn ghost sm" onClick={() => { setQ(''); setType('all'); setPrivacy('all') }}>Clear filters</button></div></td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={paged.page} pages={paged.pages} total={rows.length} pageSize={pageSize} onPage={paged.setPage} noun="column" />
    </div>
  )
}

const label = (c: string) => c.replace(/[._]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())


function ParentAsOf({ parentId, settings, onSave }: { parentId: number; settings?: Settings; onSave: (value: string | null) => void }) {
  const own = settings?.parent_as_of_date?.[String(parentId)]
  const mode = own === undefined ? 'inherit' : own === '' ? 'today' : 'date'
  return (
    <div className="row small" title="Relative time windows (e.g. “within previous 30 days”) count back from this date">
      <select className="input sm" value={mode} onChange={(e) => onSave(e.target.value === 'inherit' ? null : e.target.value === 'today' ? '' : (settings?.as_of_date || new Date().toISOString().slice(0, 10)))}>
        <option value="inherit">{settings?.as_of_date ? `Workspace (${settings.as_of_date})` : 'Workspace (today)'}</option>
        <option value="today">Today</option>
        <option value="date">Specific date</option>
      </select>
      {mode === 'date' && <input type="date" className="input sm" value={own} onChange={(e) => onSave(e.target.value)} />}
    </div>
  )
}

function ModelModal({ kind, existing, parent, onClose, onSaved }: {
  kind: Model['kind']; existing?: Model; parent: Model | null; onClose: () => void; onSaved: () => void
}) {
  const [m, setM] = useState<Partial<Model>>(existing ?? { kind, query_type: 'table', table_ref: '', relationship: '1:many', join_keys: [], merge_columns: [], column_settings: {} })
  const [cols, setCols] = useState<Column[]>(existing?.columns ?? [])
  const [loadingCols, setLoadingCols] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<'configuration' | 'columns'>('configuration')
  const set = (patch: Partial<Model>) => setM((x) => ({ ...x, ...patch }))
  const isSql = m.query_type === 'sql'
  const connections = useAsync(() => api.get<SourceConnection[]>('/connections'))
  const me = useMe()
  const brandChoices = me.me?.brands ?? []
  const defaultConn = connections.data?.find((c) => c.is_default)?.id ?? connections.data?.[0]?.id
  // Parents choose a connection; related and event models always use their parent's.
  const connectionId = kind === 'parent' ? (m.connection_id ?? defaultConn) : parent?.connection_id
  const cq = connectionId ? `&connection_id=${connectionId}` : ''

  const guess = (c: Column[]) => {
    if (existing) return
    const g = (re: RegExp, f?: (c: Column) => boolean) => c.find((x) => re.test(x.name) && (!f || f(x)))?.name ?? null
    const pk = parent?.primary_key ?? 'id'
    const fk = c.some((x) => x.name === pk) ? pk : g(/(user|customer).?id/i)
    set({
      name: m.name || (isSql ? 'Query' : (m.table_ref ?? '').split('.')[2]?.replace(/_/g, ' ').replace(/\b\w/g, (s) => s.toUpperCase())),
      primary_key: kind === 'parent' ? g(/(^id$|_id$|^customer.?id$)/i) : m.primary_key ?? null,
      label_column: kind === 'parent' ? g(/^(name|full_?name|email)$/i) : null,
      join_keys: kind !== 'parent' && fk ? [{ parent: pk, model: fk }] : m.join_keys ?? [],
      timestamp_column: kind !== 'parent' ? g(/time|date|created/i, (x) => x.type === 'timestamp' || x.type === 'date') : null,
      event_name_column: kind === 'event' ? g(/^(event|event_name|type|action)$/i, (x) => x.type === 'string') : null,
    })
  }

  useEffect(() => {
    if (isSql || !m.table_ref) return
    setLoadingCols(true)
    api.get<Column[]>(`/catalog/columns?table=${m.table_ref}${cq}`).then((c) => { setCols(c); guess(c) })
      .catch((e) => setError(e.message)).finally(() => setLoadingCols(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.table_ref, isSql, connectionId])

  const describeSql = async () => {
    setLoadingCols(true); setError(null)
    try { const c = await api.post<Column[]>('/catalog/describe-sql', { sql: m.sql, connection_id: connectionId }); setCols(c); guess(c) }
    catch (e) { setError((e as Error).message) } finally { setLoadingCols(false) }
  }
  const save = async () => {
    setSaving(true); setError(null)
    try {
      const brand = kind === 'parent' ? (m.brand_id ?? brandChoices[0]?.id ?? null) : undefined
      if (existing) await api.put(`/models/${existing.id}`, { ...m, connection_id: kind === 'parent' ? connectionId : undefined, brand_id: brand })
      else await api.post('/models', { ...m, kind, parent_id: parent?.id, connection_id: kind === 'parent' ? connectionId : undefined, brand_id: brand })
      onSaved()
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  const info = KIND_INFO[kind]
  const timeCols = (c: Column) => c.type === 'timestamp' || c.type === 'date'
  const keys: JoinKey[] = m.join_keys ?? []
  const setKey = (i: number, patch: Partial<JoinKey>) => set({ join_keys: keys.map((k, j) => (j === i ? { ...k, ...patch } : k)) })

  return (
    <Modal wide title={`${existing ? 'Edit' : 'Add'} ${info.label.toLowerCase()}`} subtitle={info.help} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={saving || !cols.length} onClick={save}>{saving ? 'Saving…' : 'Save'}</button></>}>
      {kind === 'parent' && (connections.data?.length ?? 0) > 0 && (
        <Field label="Databricks connection" help="Where this parent and all its related and event models are queried. Manage connections on the Sources page.">
          <select className="input" value={connectionId ?? ''} onChange={(e) => { set({ connection_id: Number(e.target.value) }); if (!existing) { set({ table_ref: '' }); setCols([]) } }}>
            {connections.data!.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.auth_type === 'oauth' ? 'service principal' : 'personal token'}</option>)}
          </select>
        </Field>
      )}
      {kind === 'parent' && (
        <Field label="Brand" help="Only people with a role on this brand can see this parent model and build audiences on it.">
          <select className="input" value={m.brand_id ?? brandChoices[0]?.id ?? ''} onChange={(e) => set({ brand_id: e.target.value ? Number(e.target.value) : null })}>
            {brandChoices.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            <option value="">No brand (Platform Admins only)</option>
          </select>
        </Field>
      )}
      {kind !== 'parent' && parent && (
        <div className="small muted">Queried through the same Databricks connection as {parent.name}.</div>
      )}
      {!existing && (
        <Field label="Modeling method">
          <Toggle value={isSql ? 'sql' : 'table'} onChange={(v) => { set({ query_type: v as 'table' | 'sql' }); setCols([]) }}
            options={[{ value: 'table', label: 'Table selector' }, { value: 'sql', label: 'SQL query' }]} />
        </Field>
      )}
      {isSql ? (
        <Field label="SQL query" help="A SELECT statement against your Databricks catalogs. It runs inside every audience query.">
          <textarea className="input mono" rows={5} value={m.sql ?? ''} onChange={(e) => set({ sql: e.target.value })} placeholder="SELECT * FROM catalog.schema.table WHERE …" />
          <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={describeSql} disabled={!m.sql || loadingCols}>{loadingCols ? 'Reading…' : 'Preview columns'}</button>
        </Field>
      ) : (
        <Field label="Databricks table">
          {existing ? <div className="mono">{m.table_ref}</div> : <TablePicker key={connectionId ?? 0} connectionId={connectionId} value={m.table_ref ?? ''} onChange={(t) => set({ table_ref: t })} />}
        </Field>
      )}
      {loadingCols && !isSql && <Spinner label="Reading columns…" />}
      {cols.length > 0 && (<>
        <div className="tabs" style={{ marginBottom: 0 }}>
          <button className={`tab ${tab === 'configuration' ? 'active' : ''}`} onClick={() => setTab('configuration')}>Configuration</button>
          <button className={`tab ${tab === 'columns' ? 'active' : ''}`} onClick={() => setTab('columns')}>Columns ({cols.length})</button>
        </div>
        {tab === 'columns' ? (
          <ColumnsTable columns={cols} settings={m.column_settings ?? {}} editable onChange={(s) => set({ column_settings: s })} pageSize={12} />
        ) : (<>
          <div className="grid-2">
            <Field label="Name"><input className="input" value={m.name ?? ''} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Description"><input className="input" value={m.description ?? ''} onChange={(e) => set({ description: e.target.value })} /></Field>
          </div>
          {kind === 'parent' ? (<>
            <Field label="Primary key" help="Unique per row. Used to track who enters and leaves audiences.">
              <ColumnPick columns={cols} value={m.primary_key} onChange={(v) => set({ primary_key: v })} />
            </Field>
            <div className="grid-2">
              <Field label="Primary label" help="Main value shown in previews (e.g. name)."><ColumnPick optional columns={cols} value={m.label_column} onChange={(v) => set({ label_column: v })} /></Field>
              <Field label="Secondary label" help="Extra context in previews (e.g. email)."><ColumnPick optional columns={cols} value={m.secondary_label} onChange={(v) => set({ secondary_label: v })} /></Field>
            </div>
          </>) : (<>
            <div className="grid-2">
              <Field label="Relationship to the parent">
                <select className="input" value={m.relationship ?? '1:many'} onChange={(e) => set({ relationship: e.target.value as Model['relationship'], merge_columns: e.target.value === '1:many' ? [] : m.merge_columns })}>
                  <option value="1:many">One-to-many — each {parent?.name.toLowerCase()} has many</option>
                  <option value="1:1">One-to-one</option>
                  <option value="many:1">Many-to-one — e.g. a lookup table</option>
                </select>
              </Field>
              <Field label="Timestamp" help={kind === 'event' ? 'When the event happened.' : 'Optional. Enables time windows.'}>
                <ColumnPick optional={kind !== 'event'} columns={cols} filter={timeCols} value={m.timestamp_column} onChange={(v) => set({ timestamp_column: v })} />
              </Field>
            </div>
            <Field label="Join keys" help={keys.length > 1 ? 'Every key pair must match.' : `How rows link to ${parent?.name}. Add more keys if one column isn't enough.`}>
              <div className="stack" style={{ gap: 6 }}>
                {keys.map((k, i) => (
                  <div key={i} className="map-row">
                    <ColumnPick columns={parent?.columns ?? []} value={k.parent} onChange={(v) => setKey(i, { parent: v })} />
                    <span className="faint" style={{ textAlign: 'center' }}>=</span>
                    <ColumnPick columns={cols} value={k.model} onChange={(v) => setKey(i, { model: v })} />
                    <button className="btn ghost icon sm" onClick={() => set({ join_keys: keys.filter((_, j) => j !== i) })} aria-label="Remove key">✕</button>
                  </div>
                ))}
                <div><button className="btn ghost sm" onClick={() => set({ join_keys: [...keys, { parent: '', model: '' }] })}>+ Add join key</button></div>
              </div>
            </Field>
            {m.relationship !== '1:many' && (
              <Field label="Merge columns" help={`Selected columns appear on ${parent?.name} as if they were its own — filterable and syncable.`}>
                <div className="row wrap">
                  {cols.map((c) => (
                    <label key={c.name} className="row small" style={{ gap: 4 }}>
                      <input type="checkbox" checked={(m.merge_columns ?? []).includes(c.name)}
                        onChange={(e) => set({ merge_columns: e.target.checked ? [...(m.merge_columns ?? []), c.name] : (m.merge_columns ?? []).filter((x) => x !== c.name) })} />
                      {c.name}
                    </label>
                  ))}
                </div>
              </Field>
            )}
            <div className="grid-2">
              <Field label="Primary key" help="Unique per row. Needed to send these rows as events.">
                <ColumnPick optional columns={cols} value={m.primary_key} onChange={(v) => set({ primary_key: v })} />
              </Field>
              {kind === 'event' && (
                <Field label="Event type column" help="Optional. Lets marketers pick events like “click”.">
                  <ColumnPick optional columns={cols} filter={(c) => c.type === 'string'} value={m.event_name_column} onChange={(v) => set({ event_name_column: v })} />
                </Field>
              )}
            </div>
          </>)}
        </>)}
      </>)}
      <ErrorBox error={error} />
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// explorer: parent switcher · model/column search · interactive diagram (or table) · inspector

const KIND_LABEL = { parent: 'Parent model', related: 'Related model', event: 'Event model' } as const
const KIND_ICON: Record<Model['kind'], string> = {
  parent: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  related: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18',
  event: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
}

function KindIcon({ kind, size = 18 }: { kind: Model['kind']; size?: number }) {
  return (
    <span className={`dx-icon ${kind}`} style={{ width: size + 14, height: size + 14 }} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={KIND_ICON[kind]} /></svg>
    </span>
  )
}

const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`
const noun = (m: Model) => m.name.toLowerCase()
const joinText = (m: Model) => (m.join_keys ?? []).map((k) => (k.parent === k.model ? k.parent : `${k.parent} = ${k.model}`)).join(' + ')

/** One plain-English sentence about what a model is. */
function describe(m: Model, parent: Model): string {
  if (m.kind === 'parent') return `Every audience is a group of ${noun(m)}. There is one row per ${noun(m).replace(/s$/, '')}, identified by ${m.primary_key}.`
  const many = m.relationship === '1:many'
  const who = noun(parent).replace(/s$/, '')
  const rel = many ? `Each ${who} can have many ${m.name} records` : m.relationship === 'many:1' ? `Many ${noun(parent)} share one ${m.name} record` : `Each ${who} has at most one ${m.name} record`
  return `${rel}, matched on ${joinText(m)}.${m.timestamp_column ? ` Each record is time-stamped by ${m.timestamp_column}.` : ''}`
}

/** What a marketer can build with a model — the reason it exists. */
function uses(m: Model, parent: Model): string[] {
  const cols = m.columns.filter((c) => !m.column_settings?.[c.name]?.hidden && !['blocked', 'sync_only'].includes(m.column_settings?.[c.name]?.privacy ?? ''))
  const pick = (t: ColumnType[]) => cols.find((c) => t.includes(c.type) && c.name !== m.primary_key && !(m.join_keys ?? []).some((k) => k.model === c.name))
  const s = pick(['string']), n = pick(['number']), b = pick(['boolean'])
  const nice = (c?: Column) => c ? (m.column_settings?.[c.name]?.alias || label(c.name)) : ''
  if (m.kind === 'parent') {
    return [s && `${noun(m)} whose ${nice(s)} is a certain value`, b && `${noun(m)} where ${nice(b)} is true or false`,
      n && `${noun(m)} with ${nice(n)} above or below a number`].filter(Boolean) as string[]
  }
  const who = noun(parent)
  if (m.kind === 'event') {
    return [`${who} who did ${m.name} in the last 7, 30 or 90 days`, `${who} who did it at least N times`,
      n ? `${who} by the total or average ${nice(n)}` : `${who} who did not do it at all`].filter(Boolean)
  }
  return [`${who} with at least one ${m.name} record`, s && `${who} whose ${m.name} ${nice(s)} matches a value`,
    n && `${who} by the total ${nice(n)} across their ${m.name} records`].filter(Boolean) as string[]
}

// ---- parent switcher --------------------------------------------------------------------

function ParentSwitcher({ parents, selected, onSelect, brandName, linkedCount }: {
  parents: Model[]; selected: Model; onSelect: (id: number) => void; brandName: (id: number | null | undefined) => string; linkedCount: (id: number) => number
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  const many = parents.length > 1
  const shown = parents.filter((p) => matches(q, p.name, p.table_ref, brandName(p.brand_id)))
  const groups = [...new Set(shown.map((p) => brandName(p.brand_id)))]
  return (
    <div className="dx-switch" ref={box}>
      <button className="dx-switch-btn" onClick={() => many && setOpen(!open)} aria-haspopup={many ? 'listbox' : undefined} aria-expanded={open} disabled={!many}>
        <KindIcon kind="parent" size={16} />
        <span className="dx-switch-text"><small>{brandName(selected.brand_id)}</small><strong>{selected.name}</strong></span>
        {many && <svg className="dx-caret" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </button>
      {open && (
        <div className="dx-switch-pop" role="listbox">
          {parents.length > 6 && <div style={{ padding: 8 }}><SearchBox value={q} onChange={setQ} placeholder="Search parent models…" autoFocus /></div>}
          <div className="dx-switch-list">
            {groups.map((g) => (
              <div key={g}>
                <div className="cp-group">{g}</div>
                {shown.filter((p) => brandName(p.brand_id) === g).map((p) => (
                  <button key={p.id} role="option" aria-selected={p.id === selected.id} className={`dx-switch-item ${p.id === selected.id ? 'on' : ''}`}
                    onClick={() => { onSelect(p.id); setOpen(false); setQ('') }}>
                    <strong>{p.name}</strong><small>{plural(linkedCount(p.id), 'linked model')} · {plural(p.columns.length, 'column')}</small>
                  </button>
                ))}
              </div>
            ))}
            {!shown.length && <div className="dm-none">No parent models match.</div>}
          </div>
        </div>
      )}
    </div>
  )
}

// ---- diagram ------------------------------------------------------------------------------

type NodeData = { model: Model; selected: boolean; dim: boolean; hits: string[]; parentName: string; compact: boolean }
type ModelNodeType = FlowNode<NodeData, 'model'>
type GhostNodeType = FlowNode<{ onAdd?: () => void; admin: boolean }, 'ghost'>

function ModelNode({ data }: NodeProps<ModelNodeType>) {
  const m = data.model
  const keyFacts = m.kind === 'parent'
    ? [['key', m.primary_key], ['label', m.label_column]]
    : [['join', joinText(m)], ['time', m.timestamp_column]]
  return (
    <div className={`dx-node ${m.kind} ${data.selected ? 'on' : ''} ${data.dim ? 'dim' : ''} ${data.compact && m.kind !== 'parent' ? 'compact' : ''}`}>
      {m.kind !== 'parent' && <Handle type="target" position={Position.Left} className="dx-handle" />}
      <div className="dx-node-head">
        <KindIcon kind={m.kind} size={15} />
        <div className="dx-node-title">
          <strong title={m.name}>{m.name}</strong>
          <small>{KIND_LABEL[m.kind]} · {plural(m.columns.length, 'column')}</small>
        </div>
      </div>
      {!(data.compact && m.kind !== 'parent') && <div className="dx-node-facts">
        {keyFacts.filter(([, v]) => v).map(([k, v]) => <div key={k}><span>{k}</span><code title={v ?? ''}>{v}</code></div>)}
      </div>}
      {data.hits.length > 0 && <div className="dx-node-hits" title={data.hits.join(', ')}>Matches: {data.hits.slice(0, 3).join(', ')}{data.hits.length > 3 ? ` +${data.hits.length - 3}` : ''}</div>}
      {m.kind === 'parent' && <Handle type="source" position={Position.Right} className="dx-handle" />}
    </div>
  )
}

function GhostNode({ data }: NodeProps<GhostNodeType>) {
  return (
    <div className="dx-ghost">
      <Handle type="target" position={Position.Left} className="dx-handle" />
      <strong>Link behavior data</strong>
      <small>Subscriptions, devices, page views, clicks — anything joined to this parent.</small>
      {data.admin ? <button className="btn sm primary nodrag" onClick={data.onAdd}>+ Add a linked model</button> : <small className="faint">A Platform Admin can add them.</small>}
    </div>
  )
}

const NODE_TYPES = { model: ModelNode, ghost: GhostNode }
const COMPACT_AFTER = 10

function layout(kids: Model[], compact: boolean) {
  const COL_W = compact ? 310 : 330, ROW_H = compact ? 74 : 132, PER_COL = compact ? 10 : 7
  const ordered = [...kids.filter((k) => k.kind === 'related'), ...kids.filter((k) => k.kind === 'event')]
  const cols = Math.max(1, Math.ceil(ordered.length / PER_COL))
  const rows = Math.min(ordered.length, PER_COL)
  const pos = new Map<number, { x: number; y: number }>()
  ordered.forEach((m, i) => pos.set(m.id, { x: 420 + Math.floor(i / PER_COL) * COL_W, y: (i % PER_COL) * ROW_H }))
  return { pos, parentY: Math.max(0, ((rows - 1) * ROW_H) / 2), cols }
}

function Diagram({ parent, kids, selectedId, hits, searching, admin, onSelect, onAdd, focusId }: {
  parent: Model; kids: Model[]; selectedId: number; hits: Map<number, string[]>; searching: boolean; admin: boolean
  onSelect: (id: number) => void; onAdd: () => void; focusId: number | null
}) {
  const flow = useReactFlow()
  const compact = kids.length > COMPACT_AFTER
  const { pos, parentY } = useMemo(() => layout(kids, compact), [kids, compact])
  const nodes = useMemo<(ModelNodeType | GhostNodeType)[]>(() => {
    const mk = (m: Model, p: { x: number; y: number }): ModelNodeType => ({
      id: String(m.id), type: 'model', position: p,
      data: { model: m, selected: m.id === selectedId, dim: searching && !hits.has(m.id), hits: hits.get(m.id) ?? [], parentName: parent.name, compact },
    })
    const out: (ModelNodeType | GhostNodeType)[] = [mk(parent, { x: 0, y: parentY }), ...kids.map((k) => mk(k, pos.get(k.id)!))]
    if (!kids.length) out.push({ id: 'ghost', type: 'ghost', position: { x: 420, y: 0 }, data: { onAdd, admin }, selectable: false })
    return out
  }, [parent, kids, pos, parentY, selectedId, hits, searching, admin, onAdd, compact])
  const edges = useMemo<Edge[]>(() => (kids.length ? kids : [{ id: 'ghost' } as unknown as Model]).map((k) => {
    const ghost = !kids.length
    const dim = searching && !ghost && !hits.has(k.id) && !hits.has(parent.id)
    return {
      id: `e-${k.id}`, source: String(parent.id), target: ghost ? 'ghost' : String(k.id), type: 'smoothstep',
      animated: !ghost && k.id === selectedId,
      className: `dx-edge ${ghost ? 'ghost' : k.kind} ${dim ? 'dim' : ''} ${k.id === selectedId ? 'on' : ''}`,
      label: ghost || (compact && k.id !== selectedId) ? undefined : `${k.relationship === '1:many' ? '1 → many' : k.relationship === 'many:1' ? 'many → 1' : '1 → 1'} · ${joinText(k)}`,
      labelBgPadding: [8, 4] as [number, number], labelBgBorderRadius: 999,
    }
  }), [kids, parent.id, selectedId, hits, searching, compact])

  // keep the diagram framed when the model set changes, and fly to a model found by search
  // busy diagrams open framed on the parent and its first column, at a readable zoom; the minimap covers the rest
  useEffect(() => {
    const first = compact ? [parent.id, ...kids.filter((k) => (pos.get(k.id)?.x ?? 0) < 600).map((k) => k.id)] : null
    const t = setTimeout(() => flow.fitView({ padding: 0.18, duration: 300, maxZoom: 1.05, ...(first ? { nodes: first.map((id) => ({ id: String(id) })), minZoom: 0.7 } : {}) }), 30)
    return () => clearTimeout(t)
  }, [parent.id, kids, compact, pos, flow])
  useEffect(() => { if (focusId != null) flow.fitView({ nodes: [{ id: String(focusId) }], padding: 1.2, duration: 400, maxZoom: 1.1 }) }, [focusId, flow])

  return (
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} fitView minZoom={0.2} maxZoom={1.6}
      nodesConnectable={false} proOptions={{ hideAttribution: true }} onNodeClick={(_, n) => n.type === 'model' && onSelect(Number(n.id))}
      onPaneClick={() => onSelect(parent.id)}>
      <Background gap={18} size={1.2} />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  )
}

// ---- table view (large models, keyboard users) ----------------------------------------------

function ModelTable({ models, parent, selectedId, hits, onSelect }: { models: Model[]; parent: Model; selectedId: number; hits: Map<number, string[]> | null; onSelect: (id: number) => void }) {
  const [sort, setSort] = useSort('kind')
  const rows = sortBy(models, sort, { name: (m) => m.name, kind: (m) => ({ parent: 0, related: 1, event: 2 })[m.kind] * 1000 + 0, columns: (m) => m.columns.length })
  const paged = usePaged(rows, 15, `${sort.key}${sort.dir}${models.length}`)
  return (
    <div className="dx-table">
      <div className="table-wrap">
        <table className="table">
          <thead><tr><SortTh k="name" sort={sort} onSort={setSort}>Model</SortTh><SortTh k="kind" sort={sort} onSort={setSort}>Type</SortTh><th>Linked to {parent.name} by</th><th>Time column</th><SortTh k="columns" sort={sort} onSort={setSort} className="num">Columns</SortTh></tr></thead>
          <tbody>
            {paged.slice.map((m) => (
              <tr key={m.id} className={`clickable ${m.id === selectedId ? 'dx-row-on' : ''}`} onClick={() => onSelect(m.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect(m.id)}>
                <td><div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}><KindIcon kind={m.kind} size={14} /><div style={{ minWidth: 0 }}><strong className="dm-ellipsis">{m.name}</strong><small className="mono faint dm-ellipsis">{m.query_type === 'sql' ? 'SQL query' : m.table_ref}</small>
                  {hits?.get(m.id)?.length ? <small className="dx-hitline">Matches: {hits.get(m.id)!.slice(0, 4).join(', ')}</small> : null}</div></div></td>
                <td>{KIND_LABEL[m.kind]}</td>
                <td className="mono small">{m.kind === 'parent' ? '—' : `${m.relationship} · ${joinText(m)}`}</td>
                <td className="mono small">{m.timestamp_column ?? '—'}</td>
                <td className="num">{m.columns.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={paged.page} pages={paged.pages} total={rows.length} pageSize={15} onPage={paged.setPage} noun="model" />
    </div>
  )
}

// ---- inspector -------------------------------------------------------------------------------

function Fact({ k, children }: { k: string; children: ReactNode }) {
  return <div className="dx-fact"><span>{k}</span><div>{children}</div></div>
}

function CopyText({ text }: { text: string }) {
  return (
    <span className="dx-copy">
      <code title={text}>{text}</code>
      <button className="btn ghost icon sm" title="Copy" aria-label="Copy" onClick={() => { navigator.clipboard?.writeText(text).then(() => toast('Copied')) }}>⧉</button>
    </span>
  )
}

function ModelColumns({ m, admin, onSaved }: { m: Model; admin: boolean; onSaved: () => void }) {
  const [draft, setDraft] = useState(m.column_settings ?? {})
  const [saving, setSaving] = useState(false)
  useEffect(() => setDraft(m.column_settings ?? {}), [m])
  const dirty = JSON.stringify(draft) !== JSON.stringify(m.column_settings ?? {})
  const save = async () => {
    setSaving(true)
    try { await api.put(`/models/${m.id}`, { column_settings: draft }); onSaved(); toast('Column settings saved') }
    catch (e) { toast((e as Error).message, 'error') } finally { setSaving(false) }
  }
  const keys = Object.fromEntries([[m.primary_key ?? '', 'KEY'], [m.label_column ?? '', 'LABEL'], [m.timestamp_column ?? '', 'TIME'],
    ...(m.join_keys ?? []).map((k) => [k.model, 'JOIN'])].filter(([k]) => k))
  return (
    <div className="stack" style={{ gap: 10 }}>
      <ColumnsTable columns={m.columns} settings={draft} editable={admin} onChange={setDraft} pageSize={12} keyColumns={keys} />
      {admin && dirty && (
        <div className="dm-savebar">
          <span>Unsaved column changes</span><span className="grow" />
          <button className="btn ghost sm" onClick={() => setDraft(m.column_settings ?? {})} disabled={saving}>Discard</button>
          <button className="btn primary sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      )}
    </div>
  )
}

function SamplePreview({ m, connectionId }: { m: Model; connectionId?: number | null }) {
  const data = useAsync(() => api.get<{ columns: string[]; rows: unknown[][] }>(`/catalog/preview?table=${encodeURIComponent(m.table_ref)}${connectionId ? `&connection_id=${connectionId}` : ''}`), [m.id])
  if (data.loading) return <SkeletonRows rows={6} cols={4} />
  if (data.error) return <ErrorBox error={data.error} />
  const d = data.data!
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="small muted">First {Math.min(20, d.rows.length)} rows, read live from Databricks.</div>
      <div className="table-wrap dx-sample">
        <table className="table compact">
          <thead><tr>{d.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{d.rows.slice(0, 20).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} title={v == null ? 'null' : String(v)}>{v == null ? <span className="faint">null</span> : String(v)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </div>
  )
}

function Inspector({ m, parent, admin, conn, brand, settings, onEdit, onRemove, onAddLinked, onSaved, onSaveAsOf }: {
  m: Model; parent: Model; admin: boolean; conn?: SourceConnection; brand: string; settings?: Settings
  onEdit: () => void; onRemove: () => void; onAddLinked: () => void; onSaved: () => void; onSaveAsOf: (v: string | null) => void
}) {
  const [tab, setTab] = useState<'details' | 'columns' | 'sample'>('details')
  useEffect(() => setTab('details'), [m.id])
  const isParent = m.kind === 'parent'
  const canSample = admin && m.query_type !== 'sql'
  return (
    <aside className="card dx-inspector" aria-label={`${m.name} details`}>
      <header className="dx-ins-head">
        <KindIcon kind={m.kind} size={18} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <span className={`dx-kind ${m.kind}`}>{KIND_LABEL[m.kind]}</span>
          <h2 className="dm-ellipsis" title={m.name}>{m.name}</h2>
        </div>
        {admin && <button className="btn sm" onClick={onEdit}>Edit</button>}
      </header>
      <p className="dx-sentence">{describe(m, parent)}</p>
      {m.description && <p className="small muted dx-desc">{m.description}</p>}

      <div className="tabs dx-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'details'} className={`tab ${tab === 'details' ? 'active' : ''}`} onClick={() => setTab('details')}>Overview</button>
        <button role="tab" aria-selected={tab === 'columns'} className={`tab ${tab === 'columns' ? 'active' : ''}`} onClick={() => setTab('columns')}>Columns <span className="dm-count">{m.columns.length}</span></button>
        {canSample && <button role="tab" aria-selected={tab === 'sample'} className={`tab ${tab === 'sample' ? 'active' : ''}`} onClick={() => setTab('sample')}>Sample data</button>}
      </div>

      <div className="dx-ins-body">
        {tab === 'details' && (<>
          <div className="dx-uses">
            <div className="dx-uses-title">Marketers can find…</div>
            <ul>{uses(m, parent).map((u) => <li key={u}>{u.charAt(0).toUpperCase() + u.slice(1)}</li>)}</ul>
          </div>
          <div className="dx-facts">
            <Fact k="Source">{m.query_type === 'sql' ? <span>SQL query</span> : <CopyText text={m.table_ref} />}</Fact>
            {isParent ? (<>
              <Fact k="Identified by"><code>{m.primary_key}</code></Fact>
              <Fact k="Shown as">{[m.label_column, m.secondary_label].filter(Boolean).map((c) => <code key={c}>{c}</code>)}{!m.label_column && <span className="faint">—</span>}</Fact>
              <Fact k="Brand"><span>{brand}</span></Fact>
              <Fact k="Databricks connection"><span>{conn?.name ?? '—'}</span></Fact>
            </>) : (<>
              <Fact k="Relationship"><span>{m.relationship === '1:many' ? `One ${noun(parent).replace(/s$/, '')} → many records` : m.relationship === 'many:1' ? 'Many → one (lookup)' : 'One → one'}</span></Fact>
              <Fact k="Joined on">{(m.join_keys ?? []).map((k) => <code key={k.model}>{parent.name}.{k.parent} = {k.model}</code>)}</Fact>
              <Fact k="Time column">{m.timestamp_column ? <code>{m.timestamp_column}</code> : <span className="faint">None — time filters unavailable</span>}</Fact>
              {m.kind === 'event' && <Fact k="Event type column">{m.event_name_column ? <code>{m.event_name_column}</code> : <span className="faint">None</span>}</Fact>}
              {m.merge_columns.length > 0 && <Fact k="Merged onto parent">{m.merge_columns.map((c) => <code key={c}>{c}</code>)}</Fact>}
            </>)}
          </div>
          {m.query_type === 'sql' && m.sql && <pre className="code" style={{ maxHeight: 180 }}>{m.sql}</pre>}
          {isParent && (
            <div className="dx-asof">
              <div><strong>Analysis date</strong><div className="small muted">Relative windows (“last 30 days”) count back from this date.</div></div>
              <fieldset disabled={!admin} style={{ border: 0, padding: 0, margin: 0 }}><ParentAsOf parentId={m.id} settings={settings} onSave={onSaveAsOf} /></fieldset>
            </div>
          )}
          {admin && (
            <div className="dx-ins-actions">
              {isParent ? <button className="btn sm primary" onClick={onAddLinked}>+ Link a related or event model</button>
                : <button className="btn ghost sm danger" onClick={onRemove}>Remove {m.name}</button>}
            </div>
          )}
        </>)}
        {tab === 'columns' && <ModelColumns m={m} admin={admin} onSaved={onSaved} />}
        {tab === 'sample' && canSample && <SamplePreview m={m} connectionId={isParent ? m.connection_id : parent.connection_id} />}
      </div>
    </aside>
  )
}

// ---- page ------------------------------------------------------------------------------------

function WorkspaceSettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useAsync(() => api.get<Settings>('/settings'))
  const me = useMe()
  const can = me.canPlatform('settings.manage')
  const [saved, setSaved] = useState(false)
  const save = async (patch: Partial<Settings>) => { await api.put('/settings', patch); settings.reload(); setSaved(true); setTimeout(() => setSaved(false), 1500) }
  const s = settings.data
  return (
    <Modal title="Workspace settings" subtitle="Apply to every parent model unless a parent overrides them." onClose={onClose}
      footer={<>{saved && <span className="small" style={{ color: 'var(--green)' }}>Saved</span>}<span className="grow" /><button className="btn" onClick={onClose}>Done</button></>}>
      {!s ? <Spinner /> : (
        <fieldset disabled={!can} className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 14 }}>
          {!can && <div className="small muted">View only — Platform Admins can change these.</div>}
          <Field label="Analysis date" help="Relative time windows (“in the last 30 days”) count back from this date. Leave empty to use today — recommended for live data.">
            <div className="row">
              <input type="date" className="input" value={s.as_of_date} onChange={(e) => save({ as_of_date: e.target.value })} />
              {s.as_of_date && <button className="btn sm ghost" onClick={() => save({ as_of_date: '' })}>Use today</button>}
            </div>
          </Field>
          <Field label="Empty (null) values" help="Whether empty values match negative filters such as “Country is not USA”.">
            <select className="input" value={s.null_behavior} onChange={(e) => save({ null_behavior: e.target.value as Settings['null_behavior'] })}>
              <option value="value">Treat them like any other value (they qualify)</option>
              <option value="special">Exclude them from negative filters (they don't qualify)</option>
            </select>
          </Field>
          <label className="row" style={{ alignItems: 'flex-start' }}>
            <input type="checkbox" checked={!!s.audience_snapshots} onChange={(e) => save({ audience_snapshots: e.target.checked })} />
            <span><strong>Audience snapshots</strong>
              <div className="small muted">After each sync, record who entered or left the audience in <span className="mono">{s.snapshot_table}</span>.</div></span>
          </label>
        </fieldset>
      )}
    </Modal>
  )
}


function AddLinkedMenu({ onPick }: { onPick: (kind: 'related' | 'event') => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  return (
    <div className="add-menu" ref={box}>
      <button className="btn" onClick={() => setOpen(!open)} aria-expanded={open}>+ Link model ▾</button>
      {open && (
        <div className="menu" style={{ right: 0, left: 'auto' }}>
          <button onClick={() => { setOpen(false); onPick('event') }}><span className="swatch" style={{ background: 'var(--violet)' }} />
            <div><strong>Event model</strong><span>Time-stamped behavior: page views, video plays, email opens.</span></div></button>
          <button onClick={() => { setOpen(false); onPick('related') }}><span className="swatch" style={{ background: 'var(--blue)' }} />
            <div><strong>Related model</strong><span>Records about the person: subscriptions, devices, orders.</span></div></button>
        </div>
      )}
    </div>
  )
}

export default function Setup() {
  const models = useAsync(() => api.get<Model[]>('/models'))
  const settings = useAsync(() => api.get<Settings>('/settings'))
  const connections = useAsync(() => api.get<SourceConnection[]>('/connections'))
  const me = useMe()
  const admin = me.canPlatform('schema.manage')
  const [params, setParams] = useSearchParams()
  const [modal, setModal] = useState<{ kind: Model['kind']; existing?: Model; parent: Model | null } | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [q, setQ] = useUrlState('q')
  const [view, setView] = useUrlState('view', 'diagram')
  const [focusId, setFocusId] = useState<number | null>(null)

  const all = models.data ?? []
  const parents = all.filter((m) => m.kind === 'parent')
    .sort((a, b) => me.brandName(a.brand_id).localeCompare(me.brandName(b.brand_id)) || a.name.localeCompare(b.name))
  const children = all.filter((m) => m.kind !== 'parent')
  const parent = parents.find((p) => p.id === Number(params.get('parent'))) ?? parents[0]
  const kids = useMemo(() => (parent ? children.filter((c) => c.parent_id === parent.id).sort((a, b) => a.name.localeCompare(b.name)) : []), [children, parent])
  const selected = [parent, ...kids].find((m) => m && m.id === Number(params.get('model'))) ?? parent
  const set = (patch: Record<string, string | null>) => setParams((prev) => {
    const next = new URLSearchParams(prev)
    Object.entries(patch).forEach(([k, v]) => (v == null ? next.delete(k) : next.set(k, v)))
    return next
  }, { replace: true })

  // search across model names, tables and column names
  const hits = useMemo(() => {
    const out = new Map<number, string[]>()
    if (!parent || !q.trim()) return out
    for (const m of [parent, ...kids]) {
      const cols = m.columns.filter((c) => matches(q, c.name, m.column_settings?.[c.name]?.alias)).map((c) => c.name)
      if (cols.length || matches(q, m.name, m.table_ref)) out.set(m.id, cols)
    }
    return out
  }, [q, parent, kids])
  const colHits = [...hits.values()].reduce((a, c) => a + c.length, 0)

  const remove = async (m: Model) => {
    if (!await askConfirm({ title: `Remove ${m.name}?`, body: 'Audiences and traits that use it will stop working. The Databricks table itself is not touched.', confirmLabel: 'Remove model', danger: true })) return
    try { await api.del(`/models/${m.id}`); set({ model: null }); models.reload(); toast(`${m.name} removed`) } catch (e) { toast((e as Error).message, 'error') }
  }
  const saveAsOf = async (value: string | null) => {
    await api.put('/settings', { parent_as_of_date: { parent_id: parent!.id, value } }); settings.reload(); toast('Analysis date updated')
  }

  return (
    <div className="page wide dx-page">
      <PageHead stage="schema" title="Data model"
        subtitle={<>Who your audience members are, and what data about them marketers can filter on. Tables come from <Link to="/sources">Sources</Link>.</>}
        actions={<>
          <button className="btn" onClick={() => setShowSettings(true)} title="Analysis date, empty values, audience snapshots">⚙ Settings</button>
          {admin ? <button className="btn primary" onClick={() => setModal({ kind: 'parent', parent: null })}>+ Parent model</button>
            : <span className="badge" title="Only Platform Admins can change the data model">View only</span>}
        </>} />

      <ErrorBox error={models.error} />
      {models.loading && !models.data ? (
        <div className="dx-layout"><div className="card dm-skel" style={{ minHeight: 560 }} /><div className="card dm-skel" style={{ minHeight: 560 }} /></div>
      ) : !parent ? (
        <div className="card dm-onboard">
          <h2>Set up your data model</h2>
          <p className="muted">Three steps, then marketers can build audiences without SQL.</p>
          <ol>
            <li><strong>Pick the parent model</strong> — the table with one row per customer (or household, or account).</li>
            <li><strong>Link related models</strong> — subscriptions, devices, orders.</li>
            <li><strong>Link event models</strong> — page views, video plays, email engagement.</li>
          </ol>
          {admin ? <button className="btn primary" onClick={() => setModal({ kind: 'parent', parent: null })}>Choose parent model</button>
            : <span className="small faint">A Platform Admin needs to set this up for your brand.</span>}
        </div>
      ) : (<>
        <div className="dx-bar">
          <ParentSwitcher parents={parents} selected={parent} brandName={me.brandName} linkedCount={(id) => children.filter((c) => c.parent_id === id).length}
            onSelect={(id) => set({ parent: String(id), model: null, q: null })} />
          <div className="dx-search">
            <SearchBox value={q} onChange={setQ} placeholder="Find a model or column… (e.g. email)" />
            {q.trim() && <span className="dx-search-n">{hits.size ? `${plural(hits.size, 'model')} · ${plural(colHits, 'column')}` : 'No matches'}</span>}
            {q.trim() && hits.size > 0 && view === 'diagram' && (
              <button className="btn ghost sm" onClick={() => { const id = [...hits.keys()][0]; set({ model: String(id) }); setFocusId(null); setTimeout(() => setFocusId(id), 0) }}>Show first ↵</button>
            )}
          </div>
          <span className="grow" />
          <div className="seg" role="radiogroup" aria-label="View">
            {(['diagram', 'table'] as const).map((v) => <button key={v} role="radio" aria-checked={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{v === 'diagram' ? 'Diagram' : 'Table'}</button>)}
          </div>
          {admin && <AddLinkedMenu onPick={(kind) => setModal({ kind, parent })} />}
        </div>

        <div className="dx-layout">
          <div className="card dx-canvas">
            {view === 'diagram' ? (
              <ReactFlowProvider>
                <Diagram parent={parent} kids={kids} selectedId={selected!.id} hits={hits} searching={!!q.trim()} admin={admin} focusId={focusId}
                  onSelect={(id) => set({ model: id === parent.id ? null : String(id) })} onAdd={() => setModal({ kind: 'event', parent })} />
              </ReactFlowProvider>
            ) : (
              <ModelTable models={[parent, ...kids].filter((m) => !q.trim() || hits.has(m.id))} parent={parent} selectedId={selected!.id}
                hits={q.trim() ? hits : null} onSelect={(id) => set({ model: id === parent.id ? null : String(id) })} />
            )}
            {view === 'diagram' && (
              <div className="dx-legend" aria-hidden="true">
                <span><i className="parent" />Parent</span><span><i className="related" />Related</span><span><i className="event" />Event</span>
                {kids.length <= COMPACT_AFTER && <span className="faint">Scroll to zoom · drag to move · click a box for details</span>}
                {kids.length > COMPACT_AFTER && <button className="btn ghost sm dx-legend-btn" onClick={() => setView('table')}>{kids.length} linked models — view as table</button>}
              </div>
            )}
          </div>
          <Inspector m={selected!} parent={parent} admin={admin} brand={me.brandName(parent.brand_id)} settings={settings.data}
            conn={connections.data?.find((c) => c.id === parent.connection_id)}
            onEdit={() => setModal(selected!.kind === 'parent' ? { kind: 'parent', existing: parent, parent: null } : { kind: selected!.kind, existing: selected!, parent })}
            onRemove={() => remove(selected!)} onAddLinked={() => setModal({ kind: 'event', parent })} onSaved={models.reload} onSaveAsOf={saveAsOf} />
        </div>
      </>)}

      {showSettings && <WorkspaceSettingsModal onClose={() => setShowSettings(false)} />}
      {modal && (
        <ModelModal kind={modal.kind} existing={modal.existing} parent={modal.parent} onClose={() => setModal(null)}
          onSaved={() => { setModal(null); models.reload(); toast(modal.existing ? 'Model updated' : 'Model added') }} />
      )}
    </div>
  )
}
