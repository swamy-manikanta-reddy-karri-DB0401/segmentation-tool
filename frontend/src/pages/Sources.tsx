import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Dataset, SourceConnection, SourcesResponse, SourceStatus, SourceTable, Warehouse } from '../api'
import { Empty, ErrorBox, Field, Modal, PageHead, Spinner, Toggle, useAsync } from '../components/ui'

const MASK = '••••••••'
const AUTH_LABEL = { oauth: 'Service principal (OAuth)', pat: 'Personal access token' }

function PreviewModal({ table, connectionId, onClose }: { table: SourceTable; connectionId: number; onClose: () => void }) {
  const data = useAsync(() => api.get<{ columns: string[]; rows: unknown[][] }>(`/catalog/preview?table=${encodeURIComponent(table.full_name)}&connection_id=${connectionId}`), [table.full_name])
  return (
    <Modal wide title={table.name} subtitle={table.full_name} onClose={onClose}>
      <div className="row wrap small muted">
        <span className="badge">{fmt.num(table.rows)} rows</span>
        <span className="badge">{fmt.num(table.columns)} columns</span>
        {table.size_bytes != null && <span className="badge">{fmt.bytes(table.size_bytes)}</span>}
        {table.last_modified && <span>Updated {fmt.ago(table.last_modified)}</span>}
      </div>
      {table.comment && <div className="small muted">{table.comment}</div>}
      {data.loading ? <Spinner label="Reading the first rows from Databricks…" /> : data.error ? <ErrorBox error={data.error} /> : data.data && (
        <div className="table-wrap" style={{ maxHeight: 420 }}>
          <table className="table compact">
            <thead><tr>{data.data.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{data.data.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v == null ? <span className="faint">null</span> : String(v)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

/** Add or edit a Databricks connection. Saving signs in and runs a test query first. */
function ConnectionModal({ existing, onClose, onSaved }: { existing?: SourceStatus; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<SourceConnection>(existing
    ? { id: existing.id, name: existing.name, host: existing.host, auth_type: existing.auth_type, client_id: existing.client_id, secret: MASK, warehouse_id: existing.warehouse_id, state_schema: existing.state_schema }
    : { name: '', host: '', auth_type: 'oauth', client_id: '', secret: '', warehouse_id: '', state_schema: '' })
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null)
  const [busy, setBusy] = useState<'' | 'warehouses' | 'test' | 'save'>('')
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<SourceConnection>, resetWh = false) => { setF({ ...f, ...patch }); setResult(null); if (resetWh) setWarehouses(null) }
  const oauth = f.auth_type === 'oauth'

  const run = async <T,>(kind: typeof busy, fn: () => Promise<T>) => {
    setBusy(kind); setError(null)
    try { return await fn() } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  const loadWarehouses = () => run('warehouses', async () => {
    const list = await api.post<Warehouse[]>('/connections/warehouses', f)
    setWarehouses(list)
    if (!f.warehouse_id && list[0]) set({ warehouse_id: list[0].id })
  })
  const test = () => run('test', async () => setResult(await api.post('/connections/test', f)))
  const save = () => run('save', async () => {
    if (existing) await api.put(`/connections/${existing.id}`, f)
    else await api.post('/connections', f)
    onSaved()
  })

  return (
    <Modal title={existing ? `Edit ${existing.name}` : 'Add a Databricks connection'}
      subtitle="Each connection signs in as its own identity. Models built on it can only see what that identity is granted in Unity Catalog."
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={test} disabled={!!busy}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
        <span className="grow" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={!!busy}>{busy === 'save' ? 'Testing & saving…' : 'Save'}</button>
      </>}>
      <Field label="Name" help="Shown when choosing where a parent model lives, e.g. “Marketing (prod)”.">
        <input className="input" value={f.name} placeholder="Marketing (prod)" onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="Workspace URL" help="The address you use to open Databricks.">
        <input className="input mono" value={f.host} placeholder="https://adb-1234567890.12.azuredatabricks.net" onChange={(e) => set({ host: e.target.value }, true)} />
      </Field>
      <Field label="Authentication">
        <Toggle value={f.auth_type} onChange={(v) => set({ auth_type: v as 'oauth' | 'pat', secret: '' }, true)}
          options={[{ value: 'oauth', label: 'Service principal (recommended)' }, { value: 'pat', label: 'Personal access token' }]} />
      </Field>
      {oauth ? (
        <div className="grid-2">
          <Field label="Application (client) ID" help="Settings → Identity and access → Service principals.">
            <input className="input mono" value={f.client_id} placeholder="xxxxxxxx-xxxx-…" onChange={(e) => set({ client_id: e.target.value }, true)} />
          </Field>
          <Field label="OAuth secret" help="Generated on the service principal's Secrets tab. Never shown again.">
            <input className="input mono" type="password" value={f.secret} onFocus={() => f.secret === MASK && set({ secret: '' })}
              onChange={(e) => set({ secret: e.target.value }, true)} />
          </Field>
        </div>
      ) : (
        <Field label="Access token" help="Tied to a person — fine for trying things out; use a service principal for anything shared.">
          <input className="input mono" type="password" value={f.secret} placeholder="dapi…" onFocus={() => f.secret === MASK && set({ secret: '' })}
            onChange={(e) => set({ secret: e.target.value }, true)} />
        </Field>
      )}
      <Field label="SQL warehouse" help="The identity needs CAN USE on it.">
        <div className="row">
          {warehouses ? (
            <select className="input grow" value={f.warehouse_id} onChange={(e) => set({ warehouse_id: e.target.value })}>
              {!warehouses.some((w) => w.id === f.warehouse_id) && <option value={f.warehouse_id}>{f.warehouse_id || 'Choose…'}</option>}
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name} · {w.size}{w.serverless ? ' · serverless' : ''} · {w.state.toLowerCase()}</option>)}
            </select>
          ) : (
            <input className="input mono grow" value={f.warehouse_id} placeholder="Warehouse ID" onChange={(e) => set({ warehouse_id: e.target.value })} />
          )}
          <button className="btn" onClick={loadWarehouses} disabled={!f.host || !f.secret || !!busy}>{busy === 'warehouses' ? 'Loading…' : warehouses ? 'Refresh' : 'Browse'}</button>
        </div>
      </Field>
      <Field label="Sync state schema" help="catalog.schema where sync snapshots are kept so each run only sends changes. The identity needs to own it (or have CREATE TABLE + MODIFY).">
        <input className="input mono" value={f.state_schema} placeholder="main.cdp_state" onChange={(e) => set({ state_schema: e.target.value })} />
      </Field>
      {result && <div className={`alert ${result.ok ? 'success' : 'error'}`}>{result.message}</div>}
      <ErrorBox error={error} />
    </Modal>
  )
}

function DatasetCard({ d, connectionId, onOpen }: { d: Dataset; connectionId: number; onOpen: (t: SourceTable, cid: number) => void }) {
  return (
    <div className="dataset">
      <div className="row" style={{ gap: 12, padding: '14px 18px' }}>
        <span className="dataset-icon" aria-hidden="true">▦</span>
        <div className="grow">
          <h3 className="mono" style={{ fontSize: 13.5 }}>{d.catalog}.{d.schema}</h3>
          <div className="small muted">{d.tables.length} table{d.tables.length === 1 ? '' : 's'} · {fmt.num(d.tables.reduce((a, t) => a + (t.rows ?? 0), 0))} rows</div>
        </div>
        <span className="badge teal">Unity Catalog</span>
      </div>
      <table className="table">
        <thead><tr><th>Table</th><th>Rows</th><th>Columns</th><th>Size</th><th>Updated</th><th>Used by</th></tr></thead>
        <tbody>
          {d.tables.map((t) => (
            <tr key={t.full_name} className="clickable" onClick={() => onOpen(t, connectionId)}>
              <td><strong>{t.name}</strong>{t.comment && <div className="small faint">{t.comment}</div>}</td>
              <td>{fmt.num(t.rows)}</td>
              <td>{fmt.num(t.columns)}</td>
              <td className="muted">{fmt.bytes(t.size_bytes)}</td>
              <td className="muted">{fmt.ago(t.last_modified)}</td>
              <td>
                <div className="row wrap" style={{ gap: 4 }}>
                  {t.used_by.length ? t.used_by.map((u) => (
                    <span key={u.model_id} className={`badge ${u.kind === 'parent' ? 'brand' : u.kind === 'event' ? 'violet' : 'blue'}`}>{u.model_name}</span>
                  )) : <span className="faint">—</span>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function Sources() {
  const sources = useAsync(() => api.get<SourcesResponse>('/sources'))
  const [open, setOpen] = useState<{ table: SourceTable; cid: number } | null>(null)
  const [editing, setEditing] = useState<{ existing?: SourceStatus } | null>(null)
  const conns = sources.data?.connections ?? []

  const remove = async (c: SourceStatus) => {
    if (!confirm(`Remove the connection “${c.name}”? Nothing in Databricks is changed.`)) return
    try { await api.del(`/connections/${c.id}`); sources.reload() } catch (e) { alert((e as Error).message) }
  }

  return (
    <div className="page">
      <PageHead stage="source" title="Sources"
        subtitle="Databricks connections your data platform reads from. Each signs in as its own identity; data is queried in place — never copied."
        actions={<button className="btn primary" onClick={() => setEditing({})}>+ Add connection</button>} />
      <ErrorBox error={sources.error} />

      {sources.loading ? <Spinner label="Checking connections and reading Unity Catalog…" /> : !conns.length ? (
        <div className="card">
          <Empty title="No Databricks connection yet" action={<button className="btn primary" onClick={() => setEditing({})}>Add connection</button>}>
            Connect a workspace with a service principal to start modeling your data.
          </Empty>
        </div>
      ) : conns.map((c) => (
        <div key={c.id} className="card conn-card">
          <div className="source-hero">
            <div className="source-logo" aria-hidden="true">
              <svg viewBox="0 0 32 32"><path d="M16 3 3 10.5l13 7.5 13-7.5zM3 15.5 16 23l13-7.5M3 20.5 16 28l13-7.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" /></svg>
            </div>
            <div className="grow">
              <div className="row wrap">
                <h2 style={{ fontSize: 18 }}>{c.name}</h2>
                {c.ok ? <span className="badge green"><span className="dot" />Connected</span> : <span className="badge red"><span className="dot" />Not connected</span>}
                <span className={`badge ${c.auth_type === 'oauth' ? 'brand' : 'amber'}`}>{AUTH_LABEL[c.auth_type]}</span>
                <span className="grow" />
                {!c.parents?.length && <button className="btn ghost sm danger" onClick={() => remove(c)}>Remove</button>}
                <button className="btn sm" onClick={() => setEditing({ existing: c })}>Edit</button>
              </div>
              <div className="source-meta">
                <div><span>Workspace</span><strong className="mono">{c.host.replace('https://', '')}</strong></div>
                <div><span>SQL warehouse</span><strong>{c.warehouse ? `${c.warehouse.name} · ${c.warehouse.size}` : c.warehouse_id}</strong></div>
                <div><span>Signs in as</span><strong className="mono">{c.auth_type === 'oauth' ? c.client_id : 'Token owner'}</strong></div>
                <div><span>Sync state schema</span><strong className="mono">{c.state_schema}</strong></div>
              </div>
              <div className="small muted" style={{ marginTop: 10 }}>
                {c.parents?.length
                  ? <>Used by {c.parents.map((p, i) => <span key={p.id}>{i > 0 && ', '}<Link to="/schema">{p.name}</Link></span>)}</>
                  : 'Not used by any parent model yet — pick it when you add a parent model in Schema.'}
              </div>
              {c.error && <ErrorBox error={c.error} />}
            </div>
          </div>
          {c.datasets.map((d) => <DatasetCard key={`${d.catalog}.${d.schema}`} d={d} connectionId={c.id} onOpen={(table, cid) => setOpen({ table, cid })} />)}
        </div>
      ))}
      {open && <PreviewModal table={open.table} connectionId={open.cid} onClose={() => setOpen(null)} />}
      {editing && <ConnectionModal existing={editing.existing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); sources.reload() }} />}
    </div>
  )
}
