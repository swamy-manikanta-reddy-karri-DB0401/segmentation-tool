import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Dataset, SourceConnection, SourcesResponse, SourceStatus, SourceTable, Warehouse } from '../api'
import { ErrorBox, Field, Modal, PageHead, Toggle, useAsync } from '../components/ui'
import { BrandLogo } from '../components/logos'
import { askConfirm, matches, NoResults, Pager, SearchBox, SkeletonRows, toast, usePaged } from '../components/kit'
import '../ux/home.css'
import { useMe } from '../components/me'

const MASK = '••••••••'

function PreviewModal({ table, connectionId, onClose }: { table: SourceTable; connectionId: number; onClose: () => void }) {
  const data = useAsync(() => api.get<{ columns: string[]; rows: unknown[][] }>(`/catalog/preview?table=${encodeURIComponent(table.full_name)}&connection_id=${connectionId}`), [table.full_name])
  return (
    <Modal wide title={table.name} subtitle={table.full_name} onClose={onClose}>
      <div className="src-stats">
        <div><span>Rows</span><strong>{fmt.num(table.rows)}</strong></div>
        <div><span>Columns</span><strong>{fmt.num(table.columns)}</strong></div>
        <div><span>Size</span><strong>{fmt.bytes(table.size_bytes)}</strong></div>
        <div><span>Updated</span><strong>{table.last_modified ? fmt.ago(table.last_modified) : '—'}</strong></div>
      </div>
      {table.comment && <div className="small muted">{table.comment}</div>}
      {data.loading ? <SkeletonRows rows={6} cols={5} /> : data.error ? <ErrorBox error={data.error} /> : data.data && (<>
        <div className="small muted">First {data.data.rows.length} rows, read live from Databricks. Nothing is copied.</div>
        <div className="table-wrap src-preview">
          <table className="table compact">
            <thead><tr>{data.data.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{data.data.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} title={v == null ? 'null' : String(v)}>{v == null ? <span className="faint">null</span> : String(v)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </>)}
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

function DatasetCard({ d, connectionId, onOpen, canOpen }: { d: Dataset; connectionId: number; onOpen: (t: SourceTable, cid: number) => void; canOpen: boolean }) {
  const [q, setQ] = useState('')
  const rows = d.tables.filter((t) => matches(q, t.name, t.comment, ...t.used_by.map((u) => u.model_name)))
  const paged = usePaged(rows, 10, q)
  const maxRows = Math.max(1, ...d.tables.map((t) => t.rows ?? 0))
  const totalRows = d.tables.reduce((a, t) => a + (t.rows ?? 0), 0)
  const totalSize = d.tables.reduce((a, t) => a + (t.size_bytes ?? 0), 0)
  return (
    <section className="src-dataset">
      <header className="src-ds-head">
        <span className="src-ds-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18v14H3zM3 10h18M9 10v9" /></svg></span>
        <div className="src-ds-title">
          <h3 className="mono">{d.catalog}.{d.schema}</h3>
          <span>{d.tables.length} table{d.tables.length === 1 ? '' : 's'} · {fmt.num(totalRows)} rows · {fmt.bytes(totalSize)}</span>
        </div>
        {d.tables.length > 10 && <div className="src-ds-search"><SearchBox value={q} onChange={setQ} placeholder={`Search ${d.tables.length} tables…`} /></div>}
      </header>
      <div className="src-tables" role="table" aria-label={`Tables in ${d.catalog}.${d.schema}`}>
        <div className="src-trow src-thead" role="row">
          <span role="columnheader">Table</span><span role="columnheader">Rows</span><span role="columnheader" className="num">Columns</span>
          <span role="columnheader" className="num">Size</span><span role="columnheader">Updated</span><span role="columnheader">Used by</span>
        </div>
        {paged.slice.map((t) => {
          const cells = (<>
            <span role="cell" className="src-tname"><strong>{t.name}</strong>{t.comment && <small>{t.comment}</small>}</span>
            <span role="cell" className="src-trows">
              <span className="src-bar" aria-hidden="true"><span style={{ width: `${((t.rows ?? 0) / maxRows) * 100}%` }} /></span>
              <b>{fmt.compact(t.rows)}</b>
            </span>
            <span role="cell" className="num">{fmt.num(t.columns)}</span>
            <span role="cell" className="num muted">{fmt.bytes(t.size_bytes)}</span>
            <span role="cell" className="muted">{fmt.ago(t.last_modified)}</span>
            <span role="cell" className="src-used">
              {t.used_by.length ? t.used_by.map((u) => <span key={u.model_id} className={`src-chip ${u.kind}`} title={`${u.model_name} · ${u.kind === 'parent' ? 'parent' : u.kind === 'event' ? 'event' : 'related'} model`}>{u.model_name}</span>) : <span className="faint">Not used</span>}
            </span>
          </>)
          return canOpen
            ? <button key={t.full_name} role="row" className="src-trow clickable" onClick={() => onOpen(t, connectionId)} title="Preview the first rows">{cells}</button>
            : <div key={t.full_name} role="row" className="src-trow">{cells}</div>
        })}
        {!rows.length && <NoResults what="tables" onClear={() => setQ('')} />}
      </div>
      {d.tables.length > 10 && <div className="src-ds-foot"><Pager page={paged.page} pages={paged.pages} total={rows.length} pageSize={10} onPage={paged.setPage} noun="table" /></div>}
    </section>
  )
}

function CopyValue({ value }: { value: string }) {
  return (
    <span className="src-copy">
      <code title={value}>{value}</code>
      <button className="btn ghost icon sm" aria-label="Copy" title="Copy" onClick={() => { void navigator.clipboard?.writeText(value).then(() => toast('Copied')) }}>⧉</button>
    </span>
  )
}

export default function Sources() {
  const admin = useMe().canPlatform('source.manage')
  const sources = useAsync(() => api.get<SourcesResponse>('/sources'))
  const [open, setOpen] = useState<{ table: SourceTable; cid: number } | null>(null)
  const [editing, setEditing] = useState<{ existing?: SourceStatus } | null>(null)
  const conns = sources.data?.connections ?? []

  const remove = async (c: SourceStatus) => {
    if (!await askConfirm({ title: `Remove “${c.name}”?`, body: 'The connection is removed from this app only — nothing in Databricks is changed.', confirmLabel: 'Remove connection', danger: true })) return
    try { await api.del(`/connections/${c.id}`); sources.reload(); toast(`${c.name} removed`) } catch (e) { toast((e as Error).message, 'error') }
  }

  return (
    <div className="page wide src">
      <PageHead stage="source" title="Sources"
        subtitle="Databricks connections your data platform reads from. Each signs in as its own identity; data is queried in place — never copied."
        actions={admin ? <button className="btn primary" onClick={() => setEditing({})}>+ Add connection</button>
          : <span className="badge" title="Only Platform Admins can manage Databricks sources">View only</span>} />
      <ErrorBox error={sources.error} />

      {sources.loading && !sources.data ? <div className="card card-pad"><div className="small muted" style={{ marginBottom: 12 }}>Checking connections and reading Unity Catalog…</div><SkeletonRows rows={4} cols={5} /></div> : !conns.length ? (
        <div className="card src-empty">
          <BrandLogo type="databricks" size={56} />
          <h2>Connect your Databricks workspace</h2>
          <p className="muted">Audiences are computed where your data already lives. Connect with a service principal — nothing is copied out.</p>
          {admin ? <button className="btn primary" onClick={() => setEditing({})}>Add connection</button> : <span className="small faint">A Platform Admin needs to add the first connection.</span>}
        </div>
      ) : (
        <div className="src-list">
          {conns.map((c) => {
            const tables = c.datasets.reduce((a, d) => a + d.tables.length, 0)
            const rows = c.datasets.reduce((a, d) => a + d.tables.reduce((x, t) => x + (t.rows ?? 0), 0), 0)
            return (
              <article key={c.id} className="card src-conn">
                <header className="src-conn-head">
                  <BrandLogo type="databricks" size={48} />
                  <div className="src-conn-title">
                    <div className="row wrap" style={{ gap: 8 }}>
                      <h2>{c.name}</h2>
                      {c.ok ? <span className="src-status ok"><i />Connected</span> : <span className="src-status bad"><i />Can't connect</span>}
                    </div>
                    <span className="src-conn-sub">{c.auth_type === 'oauth' ? 'Signs in as a service principal' : 'Signs in with a personal access token'}{c.ok ? ` · ${tables ? `${tables} table${tables === 1 ? '' : 's'} in use · ${fmt.compact(rows)} rows` : 'no tables in use yet'}` : ''}</span>
                  </div>
                  {admin && (
                    <div className="row" style={{ gap: 6 }}>
                      {!c.parents?.length && <button className="btn ghost sm danger" onClick={() => remove(c)}>Remove</button>}
                      <button className="btn sm" onClick={() => setEditing({ existing: c })}>Edit</button>
                    </div>
                  )}
                </header>
                {c.auth_type === 'pat' && <div className="src-note">Personal tokens are tied to one person. Switch to a service principal before sharing this workspace with a team.</div>}
                {c.error && <div className="src-error"><strong>Databricks said:</strong> {c.error}</div>}
                <div className="src-facts">
                  <div><span>Workspace</span><CopyValue value={c.host.replace('https://', '')} /></div>
                  <div><span>SQL warehouse</span><strong title={c.warehouse ? `${c.warehouse.name} · ${c.warehouse.size} · ${c.warehouse.state.toLowerCase()}` : c.warehouse_id}>{c.warehouse ? <>{c.warehouse.name} <em>{c.warehouse.size} · {c.warehouse.state.toLowerCase()}</em></> : <code>{c.warehouse_id}</code>}</strong></div>
                  <div><span>Identity</span>{c.auth_type === 'oauth' ? <CopyValue value={c.client_id} /> : <strong>Token owner</strong>}</div>
                  <div><span>Sync state schema</span><CopyValue value={c.state_schema} /></div>
                </div>
                <div className="src-usedby">
                  <span>Parent models</span>
                  {c.parents?.length ? c.parents.map((p) => <Link key={p.id} to={`/schema?parent=${p.id}`} className="src-chip parent">{p.name}</Link>)
                    : <em className="faint">None yet — pick this connection when you add a parent model in Data model.</em>}
                </div>
                {c.datasets.map((d) => <DatasetCard key={`${d.catalog}.${d.schema}`} d={d} connectionId={c.id} canOpen={admin} onOpen={(table, cid) => setOpen({ table, cid })} />)}
              </article>
            )
          })}
        </div>
      )}
      {open && <PreviewModal table={open.table} connectionId={open.cid} onClose={() => setOpen(null)} />}
      {editing && <ConnectionModal existing={editing.existing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); sources.reload(); toast(editing.existing ? 'Connection updated' : 'Connection added') }} />}
    </div>
  )
}
