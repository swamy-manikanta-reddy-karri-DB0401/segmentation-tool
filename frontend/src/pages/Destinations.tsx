import { useState } from 'react'
import { api } from '../api'
import type { Destination, DestinationType } from '../api'
import { Link } from 'react-router-dom'
import { DestIcon, Empty, ErrorBox, Field, Modal, PageHead, useAsync } from '../components/ui'
import { useMe } from '../components/me'
import { askConfirm, FilterChips, matches, NoResults, SearchBox, SkeletonRows, toast, Toolbar, useUrlState } from '../components/kit'
import '../ux/activate.css'

const MASK = '••••••••'
const INBOX_URL = `${window.location.protocol}//${window.location.hostname}:8100/api/inbox`

function DestinationModal({ types, existing, onClose, onSaved }: {
  types: DestinationType[]; existing?: Destination; onClose: () => void; onSaved: () => void
}) {
  const [type, setType] = useState<DestinationType | undefined>(existing && types.find((t) => t.type === existing.type))
  const [name, setName] = useState(existing?.name ?? '')
  const [config, setConfig] = useState<Record<string, string>>(existing?.config ?? {})
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const me = useMe()
  const brands = me.brandsWith('destinations.manage')
  const [brandId, setBrandId] = useState<number | null>(existing ? existing.brand_id ?? null : brands[0]?.id ?? null)

  const choose = (t: DestinationType) => {
    setType(t)
    setName(t.label)
    setConfig(Object.fromEntries(t.config_fields.filter((f) => f.default != null).map((f) => [f.name, String(f.default)])))
  }
  const runTest = async () => {
    setTesting(true); setTest(null)
    try { setTest(await api.post('/destinations/test', { type: type!.type, config, id: existing?.id, brand_id: brandId })) } finally { setTesting(false) }
  }
  const save = async () => {
    setSaving(true); setError(null)
    try {
      if (existing) await api.put(`/destinations/${existing.id}`, { name, config })
      else await api.post('/destinations', { name, type: type!.type, config, brand_id: brandId })
      toast(existing ? `${name} saved` : `${name} added`)
      onSaved()
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }

  if (!type) return <Catalog types={types} onChoose={choose} onClose={onClose} />
  const missing = type.config_fields.some((f) => f.required && !config[f.name])
  return (
    <Modal title={existing ? `Edit ${existing.name}` : `Connect ${type.label}`} subtitle={type.description} onClose={onClose}
      footer={<>
        <button className="btn" onClick={runTest} disabled={testing || missing}>{testing ? 'Testing…' : 'Test connection'}</button>
        <span className="grow" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={saving || missing || !name}>{saving ? 'Saving…' : 'Save'}</button>
      </>}>
      <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      {!existing && (brands.length > 1 || me.me?.platform_admin) && (
        <Field label="Brand" help="Only this brand's syncs can send to this destination. “Shared” destinations can be used by every brand and are managed by Platform Admins.">
          <select className="input" value={brandId ?? ''} onChange={(e) => setBrandId(e.target.value ? Number(e.target.value) : null)}>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            {me.me?.platform_admin && <option value="">Shared across brands</option>}
          </select>
        </Field>
      )}
      {type.config_fields.map((f) => (
        <Field key={f.name} label={`${f.label}${f.required ? '' : ' (optional)'}`} help={f.help}>
          {f.type === 'textarea' && f.secret && config[f.name] === MASK ? (
            <div className="secret-saved">
              <span className="badge green"><span className="dot" />Saved</span>
              <span className="small muted">Stored securely and never shown again.</span>
              <button className="btn ghost sm" onClick={() => setConfig({ ...config, [f.name]: '' })}>Replace</button>
            </div>
          ) : f.type === 'textarea' ? (
            <textarea className={`input ${f.secret ? 'mono' : ''}`} rows={f.secret ? 6 : 3} value={config[f.name] ?? ''}
              placeholder={f.secret ? '{ "type": "service_account", "client_email": "…", "private_key": "…" }' : undefined}
              spellCheck={false} onChange={(e) => setConfig({ ...config, [f.name]: e.target.value })} />
          ) : f.type === 'select' && f.options.length ? (
            <select className="input" value={config[f.name] ?? String(f.default ?? '')} onChange={(e) => setConfig({ ...config, [f.name]: e.target.value })}>
              {!f.required && <option value="">—</option>}
              {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <input className="input" type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
              value={config[f.name] ?? ''} onChange={(e) => setConfig({ ...config, [f.name]: e.target.value })} />
          )}
          {type.type === 'webhook' && f.name === 'url' && (
            <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setConfig({ ...config, url: INBOX_URL })}>Use built-in Test Inbox</button>
          )}
        </Field>
      ))}
      {test && <div className={`alert ${test.ok ? 'success' : 'error'}`}>{test.message}</div>}
      <ErrorBox error={error} />
    </Modal>
  )
}

/** Searchable catalog of destination types, grouped by category. */
function Catalog({ types, onChoose, onClose }: { types: DestinationType[]; onChoose: (t: DestinationType) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('all')
  const cats = [...new Set(types.map((t) => t.category || 'Other'))].sort()
  const shown = types.filter((t) => (cat === 'all' || (t.category || 'Other') === cat) && matches(q, t.label, t.description, t.category))
    .sort((a, b) => Number(b.type === 'sailthru') - Number(a.type === 'sailthru') || a.label.localeCompare(b.label))
  return (
    <Modal title="Add a destination" subtitle="Where should audiences be sent? You can add credentials now or later." onClose={onClose} wide>
      <Toolbar>
        <SearchBox value={q} onChange={setQ} placeholder={`Search ${types.length} destinations…`} autoFocus />
        <FilterChips label="Category" value={cat} onChange={setCat} options={[{ value: 'all', label: 'All' }, ...cats.map((c) => ({ value: c, label: c, count: types.filter((t) => (t.category || 'Other') === c).length }))]} />
      </Toolbar>
      <div className="dst-catalog">
        {shown.map((t) => (
          <button key={t.type} className={`dst-type ${t.type === 'sailthru' ? 'featured' : ''}`} onClick={() => onChoose(t)}>
            <DestIcon type={t.type} size={40} />
            <span className="wz-opt-main">
              <strong>{t.label}{t.type === 'sailthru' && <span className="badge brand">Recommended</span>}{t.beta && <span className="badge amber">Beta</span>}</strong>
              <small>{t.description}</small>
              <span className="dst-tags">{t.sync_types.slice(0, 4).map((st) => <span key={st.name} className="badge">{st.label}</span>)}</span>
            </span>
          </button>
        ))}
        {!shown.length && <div className="dm-none">No destinations match “{q}”.</div>}
      </div>
    </Modal>
  )
}

export default function Destinations() {
  const types = useAsync(() => api.get<DestinationType[]>('/destination-types'))
  const dests = useAsync(() => api.get<Destination[]>('/destinations'))
  const [modal, setModal] = useState<{ existing?: Destination } | null>(null)
  const typeOf = (t: string) => types.data?.find((x) => x.type === t)
  const me = useMe()
  const canAdd = me.brandsWith('destinations.manage').length > 0 || !!me.me?.platform_admin
  const [q, setQ] = useUrlState('q')
  const [status, setStatus] = useUrlState('status', 'all')
  const [kind, setKind] = useUrlState('type')
  const [brand, setBrand] = useUrlState('brand')

  const remove = async (d: Destination) => {
    if (!await askConfirm({ title: `Remove “${d.name}”?`, body: 'Its credentials are deleted. A destination used by syncs can’t be removed — delete those syncs first.', confirmLabel: 'Remove destination', danger: true })) return
    try { await api.del(`/destinations/${d.id}`); dests.reload(); toast(`${d.name} removed`) } catch (e) { toast((e as Error).message, 'error') }
  }
  const all = dests.data ?? []
  const canManage = (d: Destination) => (me.can('destinations.manage', d.brand_id ?? null) && d.brand_id != null) || !!me.me?.platform_admin
  const rows = all.filter((d) => (status === 'all' || (status === 'ready' ? d.configured !== false : d.configured === false))
    && (!kind || d.type === kind) && (!brand || String(d.brand_id ?? 'shared') === brand)
    && matches(q, d.name, typeOf(d.type)?.label))
    .sort((a, b) => Number(a.configured !== false) - Number(b.configured !== false) || a.name.localeCompare(b.name))
  const kinds = [...new Set(all.map((d) => d.type))]
  const brands = [...new Set(all.map((d) => d.brand_id ?? null))]
  const needs = all.filter((d) => d.configured === false).length

  return (
    <div className="page wide">
      <PageHead stage="activation" title="Destinations" subtitle="The marketing tools your audiences are delivered to. Credentials are stored securely and never shown again."
        actions={canAdd ? <button className="btn primary" onClick={() => setModal({})} disabled={!types.data}>+ Add destination</button> : undefined} />
      <ErrorBox error={dests.error || types.error} />
      {dests.loading && !dests.data ? <SkeletonRows rows={3} cols={3} /> : all.length ? (<>
        {all.length > 1 && (
          <Toolbar>
            {all.length > 4 && <SearchBox value={q} onChange={setQ} placeholder={`Search ${all.length} destinations…`} />}
            <FilterChips label="Credentials" value={status} onChange={setStatus} options={[
              { value: 'all', label: 'All', count: all.length },
              { value: 'ready', label: 'Connected', count: all.length - needs, tone: 'green' },
              { value: 'needs', label: 'Needs credentials', count: needs, tone: 'amber' },
            ]} />
            {kinds.length > 1 && (
              <select className="input sm act-select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type">
                <option value="">All types</option>
                {kinds.map((k) => <option key={k} value={k}>{typeOf(k)?.label ?? k}</option>)}
              </select>
            )}
            {brands.length > 1 && (
              <select className="input sm act-select" value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Brand">
                <option value="">All brands</option>
                {brands.map((b) => <option key={b ?? 'shared'} value={b ?? 'shared'}>{b == null ? 'Shared' : me.brandName(b)}</option>)}
              </select>
            )}
          </Toolbar>
        )}
        <div className="dest-grid">
          {rows.map((d) => {
            const t = typeOf(d.type)
            const configured = d.configured !== false
            return (
              <div key={d.id} className={`card dest-card ${configured ? '' : 'needs'}`}>
                <div className="dest-top">
                  <DestIcon type={d.type} size={48} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <h2 className="act-ellipsis" title={d.name}>{d.name}</h2>
                    <div className="small muted act-ellipsis">{t?.label ?? d.type} · {d.brand_id == null ? 'Shared' : me.brandName(d.brand_id)}</div>
                    <div style={{ marginTop: 6 }}>{configured ? <span className="badge green"><span className="dot" />Connected</span>
                      : <span className="badge amber"><span className="dot" />Credentials needed</span>}</div>
                  </div>
                </div>
                <p className="small muted dest-desc">{t?.description}</p>
                {!configured && (
                  <div className="dest-missing small">
                    Missing: {(d.missing_fields ?? []).join(', ') || 'credentials'}. Its syncs are ready and start as soon as these are added.
                  </div>
                )}
                <div className="dest-foot">
                  <Link to={`/activations?dest=${d.id}`} className="small">{d.sync_count ? `${d.sync_count} sync${d.sync_count === 1 ? '' : 's'} →` : 'No syncs yet'}</Link>
                  <span className="grow" />
                  {canManage(d) ? (<>
                    <button className="btn ghost sm danger" onClick={() => remove(d)}>Remove</button>
                    <button className={`btn sm ${configured ? '' : 'primary'}`} onClick={() => setModal({ existing: d })}>{configured ? 'Edit' : 'Add credentials'}</button>
                  </>) : <span className="small faint">View only</span>}
                </div>
              </div>
            )
          })}
        </div>
        {!rows.length && <div className="card"><NoResults what="destinations" onClear={() => { setQ(''); setStatus('all'); setKind(''); setBrand('') }} /></div>}
      </>) : (
        <div className="card">
          <Empty title="No destinations yet" action={canAdd ? <button className="btn primary" onClick={() => setModal({})}>Add destination</button> : undefined}>
            Connect the tools you market with — Sailthru, Google Ad Manager, Meta and more.
          </Empty>
        </div>
      )}
      {modal && types.data && (
        <DestinationModal types={types.data} existing={modal.existing} onClose={() => setModal(null)} onSaved={() => { setModal(null); dests.reload() }} />
      )}
    </div>
  )
}
