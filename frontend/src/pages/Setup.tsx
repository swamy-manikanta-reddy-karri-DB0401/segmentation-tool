import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Column, ColumnSettings, JoinKey, Model, Settings, SourceConnection } from '../api'
import { Link } from 'react-router-dom'
import { Empty, ErrorBox, Field, Modal, PageHead, Spinner, Toggle, useAsync } from '../components/ui'


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

function ColumnsTab({ columns, settings, onChange }: { columns: Column[]; settings: Record<string, ColumnSettings>; onChange: (s: Record<string, ColumnSettings>) => void }) {
  const set = (name: string, patch: Partial<ColumnSettings>) => onChange({ ...settings, [name]: { ...settings[name], ...patch } })
  return (
    <div className="table-wrap" style={{ maxHeight: 380 }}>
      <table className="table compact">
        <thead><tr><th>Column</th><th>Display name</th><th>Visible</th><th>Privacy</th><th>Suggestions</th><th>Case-sensitive</th></tr></thead>
        <tbody>
          {columns.map((c) => {
            const st = settings[c.name] ?? {}
            return (
              <tr key={c.name}>
                <td><span className="mono">{c.name}</span><div className="faint small">{c.data_type}</div></td>
                <td><input className="input sm" value={st.alias ?? ''} placeholder={c.name} onChange={(e) => set(c.name, { alias: e.target.value })} /></td>
                <td><input type="checkbox" checked={!st.hidden} onChange={(e) => set(c.name, { hidden: !e.target.checked })} /></td>
                <td>
                  <select className="input sm" value={st.privacy ?? 'unreviewed'} title={PRIVACY.find((p) => p.value === (st.privacy ?? 'unreviewed'))?.help}
                    onChange={(e) => set(c.name, { privacy: e.target.value as ColumnSettings['privacy'] })}>
                    {PRIVACY.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </td>
                <td><input type="checkbox" checked={st.suggestions !== false} disabled={c.type !== 'string'} onChange={(e) => set(c.name, { suggestions: e.target.checked })} /></td>
                <td><input type="checkbox" checked={!!st.case_sensitive} disabled={c.type !== 'string'} onChange={(e) => set(c.name, { case_sensitive: e.target.checked })} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ParentAsOf({ parentId, settings, onSave }: { parentId: number; settings?: Settings; onSave: (value: string | null) => void }) {
  const own = settings?.parent_as_of_date?.[String(parentId)]
  const mode = own === undefined ? 'inherit' : own === '' ? 'today' : 'date'
  return (
    <div className="row small" title="Relative time windows (e.g. “within previous 30 days”) count back from this date">
      <span className="muted">Analysis date</span>
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
      if (existing) await api.put(`/models/${existing.id}`, { ...m, connection_id: kind === 'parent' ? connectionId : undefined })
      else await api.post('/models', { ...m, kind, parent_id: parent?.id, connection_id: kind === 'parent' ? connectionId : undefined })
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
          <ColumnsTab columns={cols} settings={m.column_settings ?? {}} onChange={(s) => set({ column_settings: s })} />
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

function NodeCard({ m, parent }: { m: Model; parent?: boolean }) {
  const kind = parent ? 'parent' : m.kind
  return (
    <div className={`sd-node ${kind}`}>
      <div className="sd-node-head">
        <span className={`sd-kind ${kind}`}>{kind === 'parent' ? 'Parent model' : kind === 'event' ? 'Event' : 'Related'}</span>
        <span className="small faint">{m.columns.length} cols</span>
      </div>
      <div className="sd-name">{m.name}</div>
      <div className="sd-table mono">{m.query_type === 'sql' ? 'SQL query' : m.table_ref}</div>
      <div className="sd-facts">
        {m.primary_key && <span><b>PK</b> {m.primary_key}</span>}
        {m.timestamp_column && <span><b>Time</b> {m.timestamp_column}</span>}
        {parent && m.label_column && <span><b>Label</b> {m.label_column}</span>}
      </div>
      {m.merge_columns?.length > 0 && <div className="sd-merged">Merged: {m.merge_columns.join(', ')}</div>}
    </div>
  )
}

/** Visual diagram: parent model on the left, related & event models linked with their join keys. */
function SchemaDiagram({ parent, children }: { parent: Model; children: Model[] }) {
  return (
    <div className="schema-diagram">
      <div className="sd-parent"><NodeCard m={parent} parent /></div>
      <div className={`sd-children ${children.length ? '' : 'empty'}`}>
        {children.length ? children.map((m) => (
          <div key={m.id} className="sd-edge">
            <div className="sd-link">
              <span className="sd-line" />
              <span className="sd-label">
                <strong>{m.relationship ?? '1:many'}</strong>
                <span className="mono">{(m.join_keys ?? []).map((k) => `${k.parent} = ${k.model}`).join(' & ')}</span>
              </span>
            </div>
            <NodeCard m={m} />
          </div>
        )) : <div className="small muted sd-hint">Add related or event models to connect behavior to {parent.name.toLowerCase()}.</div>}
      </div>
    </div>
  )
}

export default function Setup() {
  const models = useAsync(() => api.get<Model[]>('/models'))
  const settings = useAsync(() => api.get<Settings>('/settings'))
  const [asOf, setAsOf] = useState('')
  const [savedAsOf, setSavedAsOf] = useState(false)
  const [modal, setModal] = useState<{ kind: Model['kind']; existing?: Model; parent: Model | null } | null>(null)
  useEffect(() => { if (settings.data) setAsOf(settings.data.as_of_date) }, [settings.data])

  const parents = models.data?.filter((m) => m.kind === 'parent') ?? []
  const saveSetting = async (patch: Partial<Settings>) => { await api.put('/settings', patch); settings.reload() }
  const saveAsOf = async (v: string) => { await saveSetting({ as_of_date: v }); setAsOf(v); setSavedAsOf(true); setTimeout(() => setSavedAsOf(false), 1500) }
  const remove = async (m: Model) => {
    if (!confirm(`Remove ${m.name}? Audiences and traits using it will stop working.`)) return
    try { await api.del(`/models/${m.id}`); models.reload() } catch (e) { alert((e as Error).message) }
  }

  return (
    <div className="page">
      <PageHead stage="schema" title="Data model"
        subtitle={<>Define what one audience member is and how behavior connects to it. Tables are read from <Link to="/sources">Sources</Link>.</>}
        actions={<button className="btn primary" onClick={() => setModal({ kind: 'parent', parent: null })}>+ Parent model</button>} />

      {parents.map((parent) => (
        <div key={'d' + parent.id} className="card diagram-card">
          <div className="card-head">
            <div><h2>{parent.name} schema</h2><div className="small muted">How audiences built on {parent.name.toLowerCase()} reach related records and events.</div></div>
            <div className="sd-legend"><span className="lg parent" />Parent<span className="lg related" />Related<span className="lg event" />Event</div>
          </div>
          <div className="card-body"><SchemaDiagram parent={parent} children={(models.data ?? []).filter((m) => m.parent_id === parent.id)} /></div>
        </div>
      ))}

      {models.loading ? <Spinner label="Loading schema…" /> : parents.length === 0 ? (
        <div className="card">
          <Empty title="No parent model yet" action={<button className="btn primary" onClick={() => setModal({ kind: 'parent', parent: null })}>Choose parent model</button>}>
            Start with the table that has one row per customer (or household, or account).
          </Empty>
        </div>
      ) : parents.map((parent) => {
        const children = models.data!.filter((m) => m.parent_id === parent.id)
        return (
          <div key={parent.id} className="card" style={{ marginBottom: 20 }}>
            <div className="card-head">
              <div className="row" style={{ gap: 12 }}>
                <span className="badge brand">Parent</span>
                <div><h2>{parent.name}</h2><div className="small muted mono">{parent.query_type === 'sql' ? 'SQL query' : parent.table_ref} · key {parent.primary_key} · {parent.columns.length} columns</div></div>
              </div>
              <div className="row">
                <ParentAsOf parentId={parent.id} settings={settings.data} onSave={(value) => saveSetting({ parent_as_of_date: { parent_id: parent.id, value } } as unknown as Partial<Settings>)} />
                <button className="btn sm" onClick={() => setModal({ kind: 'parent', existing: parent, parent: null })}>Edit</button>
                <button className="btn sm" onClick={() => setModal({ kind: 'related', parent })}>+ Related</button>
                <button className="btn sm" onClick={() => setModal({ kind: 'event', parent })}>+ Event</button>
              </div>
            </div>
            {children.length ? (
              <table className="table">
                <thead><tr><th>Model</th><th>Type</th><th>Relationship</th><th>Join keys</th><th>Merged</th><th>Timestamp</th><th /></tr></thead>
                <tbody>
                  {children.map((m) => (
                    <tr key={m.id}>
                      <td><strong>{m.name}</strong><div className="small faint mono">{m.query_type === 'sql' ? 'SQL query' : m.table_ref}</div></td>
                      <td><span className={`badge ${KIND_INFO[m.kind].badge}`}>{m.kind === 'event' ? 'Event' : 'Related'}</span></td>
                      <td className="mono">{m.relationship}</td>
                      <td className="mono small">{m.join_keys.map((k) => `${k.parent} = ${k.model}`).join(' AND ')}</td>
                      <td className="small">{m.merge_columns.length ? m.merge_columns.join(', ') : <span className="faint">—</span>}</td>
                      <td className="mono small">{m.timestamp_column ?? '—'}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="btn ghost sm" onClick={() => setModal({ kind: m.kind, existing: m, parent })}>Edit</button>
                        <button className="btn ghost sm danger" onClick={() => remove(m)}>Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="empty"><p>Add related and event models to unlock filters like “has 2+ bookings” or “clicked in the last 7 days”.</p></div>}
          </div>
        )
      })}

      <div className="settings-card">
        <div className="card card-pad stack">
          <h2>Workspace settings</h2>
          <Field label="Analysis date" help="Relative time windows count back from this date. Leave empty to use today (recommended for live data).">
            <div className="row">
              <input type="date" className="input" value={asOf} onChange={(e) => saveAsOf(e.target.value)} />
              {asOf && <button className="btn sm ghost" onClick={() => saveAsOf('')}>Use today</button>}
              {savedAsOf && <span className="small" style={{ color: 'var(--green)' }}>Saved</span>}
            </div>
          </Field>
          <Field label="Null values" help="Whether empty values match negative filters such as “Country does not equal USA”.">
            <select className="input" value={settings.data?.null_behavior ?? 'value'} onChange={(e) => saveSetting({ null_behavior: e.target.value as Settings['null_behavior'] })}>
              <option value="value">Treat null values like any other value (they qualify)</option>
              <option value="special">Use special behavior for null values (they don't qualify)</option>
            </select>
          </Field>
          <label className="row" style={{ alignItems: 'flex-start' }}>
            <input type="checkbox" checked={!!settings.data?.audience_snapshots} onChange={(e) => saveSetting({ audience_snapshots: e.target.checked })} />
            <span><strong>Audience snapshots</strong>
              <div className="small muted">After each sync, record who entered or exited the audience in <span className="mono">{settings.data?.snapshot_table}</span>.</div></span>
          </label>
        </div>
      </div>

      {modal && (
        <ModelModal kind={modal.kind} existing={modal.existing} parent={modal.parent} onClose={() => setModal(null)}
          onSaved={() => { setModal(null); models.reload() }} />
      )}
    </div>
  )
}
