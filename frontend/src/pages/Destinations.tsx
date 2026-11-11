import { useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api'
import type { ConfigField, Destination, DestinationType, Sync } from '../api'
import { Link } from 'react-router-dom'
import { DestIcon, ErrorBox, Field, Modal, PageHead, Toggle, useAsync } from '../components/ui'
import { useMe } from '../components/me'
import { askConfirm, FilterChips, matches, NoResults, SearchBox, SkeletonRows, toast, Toolbar, useUrlState } from '../components/kit'
import { CollectionLayout, Facts, Inspector, ListPane, ListRow, Section, StatTile } from '../components/collection'
import { syncHealth } from '../ux/syncHealth'
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
      <div className="dx2-modal-id"><DestIcon type={type.type} size={40} /><div><strong>{type.label}</strong><small>{type.category}</small></div></div>
      <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      {!existing && (brands.length > 1 || me.me?.platform_admin) && (
        <Field label="Brand" help="Only this brand's syncs can send to this destination. “Shared” destinations can be used by every brand and are managed by Platform Admins.">
          <select className="input" value={brandId ?? ''} onChange={(e) => setBrandId(e.target.value ? Number(e.target.value) : null)}>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            {me.me?.platform_admin && <option value="">Shared across brands</option>}
          </select>
        </Field>
      )}
      {type.config_fields.filter((f) => !f.advanced).map(renderField)}
      {type.config_fields.some((f) => f.advanced) && (
        <details className="dx2-advanced" open={type.config_fields.some((f) => f.advanced && (f.required || config[f.name]))}>
          <summary>Advanced</summary>
          <div className="dx2-advanced-body">{type.config_fields.filter((f) => f.advanced).map(renderField)}</div>
        </details>
      )}
      {test && <div className={`alert ${test.ok ? 'success' : 'error'}`}>{test.message}</div>}
      <ErrorBox error={error} />
    </Modal>
  )

  function renderField(f: ConfigField) {
    return (
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
          ) : f.type === 'toggle' ? (
            <div><Toggle value={config[f.name] === 'true' ? 'true' : ''} options={[{ value: '', label: 'Off' }, { value: 'true', label: 'On' }]}
              onChange={(v) => setConfig({ ...config, [f.name]: v })} /></div>
          ) : f.type === 'select' && f.options.length ? (
            <select className="input" value={config[f.name] ?? String(f.default ?? '')} onChange={(e) => setConfig({ ...config, [f.name]: e.target.value })}>
              {!f.required && <option value="">—</option>}
              {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <input className="input" type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
              value={config[f.name] ?? ''} onChange={(e) => setConfig({ ...config, [f.name]: e.target.value })} />
          )}
          {type?.type === 'webhook' && f.name === 'url' && (
            <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setConfig({ ...config, url: INBOX_URL })}>Use built-in Test Inbox</button>
          )}
        </Field>
    )
  }
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
            <DestIcon type={t.type} size={44} />
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

type Trig = { key: string; label: string }
type TrigCfg = { enabled: boolean; severity: string; source: string; min_rows?: number; days?: number; minutes?: number }
type Pol = { triggers: Record<string, TrigCfg> }

const thresh = (key: string, t: TrigCfg) =>
  key === 'rejected' ? `≥ ${t.min_rows ?? 1} rejected` : key === 'throughput' ? `${t.days ?? 7} days` : key === 'audience' ? `< ${t.min_rows ?? 1} people` : key === 'duration' ? `> ${t.minutes ?? 60} min` : ''

type TargetingSummary = {
  clients: string[]; lookup_url: string; last_denied: { identity: string; at: string } | null
  values: { key: string; audience: string; members: number; updated_at: string }[]
}

/** Key-value targeting: how the website asks "which audiences is this visitor in?" and passes it to Ad Manager. */
function WebsiteSetup({ dkey }: { dkey: string }) {
  const me = useMe()
  const admin = me.canPlatform('settings.manage')
  const summary = useAsync(() => api.get<TargetingSummary>('/targeting/summary'))
  const [draft, setDraft] = useState('')
  const s = summary.data
  const values = (s?.values ?? []).filter((v) => v.key === dkey)
  const lookup = s?.lookup_url || `${window.location.origin}/api/targeting?user_id=VISITOR_ID`
  const saveClients = async (list: string[]) => {
    try { await api.put('/targeting/clients', { clients: list }); summary.reload(); setDraft(''); toast('Allowed callers updated') }
    catch (e) { toast((e as Error).message, 'error') }
  }
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast('Copied'))
  const snippet = `// 1) On your server: look the visitor up (service-principal OAuth token)
const r = await fetch('${lookup.replace('VISITOR_ID', "' + visitorId + '")}', { headers: { Authorization: 'Bearer ' + token } })
const { targeting } = await r.json()   // e.g. { "${dkey}": ["engaged_non_subs"] }

// 2) In the page, before ads load: pass it to Ad Manager
googletag.cmd.push(() => {
  googletag.pubads().setTargeting('${dkey}', targeting['${dkey}'] || [])
})`
  return (
    <Section title="Website setup" aside={<span className="small muted">key <code>{dkey}</code></span>}>
      <ol className="kv-steps">
        <li><strong>Your site's server looks up the visitor</strong> with their ID (the same ID you map in the sync).
          <div className="kv-url"><code>{lookup}</code><button className="btn ghost sm" onClick={() => copy(lookup)}>Copy</button></div></li>
        <li><strong>The page passes the result to Ad Manager</strong> as a key-value before ads load.
          <div className="kv-code"><pre className="code">{snippet}</pre><button className="btn ghost sm" onClick={() => copy(snippet)}>Copy code</button></div></li>
        <li><strong>Your ad team targets line items</strong> with <code>{dkey}</code> is <em>one of the values below</em> (Inventory → Key-values in Ad Manager).</li>
      </ol>
      <div className="kv-block">
        <div className="kv-block-head"><strong>Audiences available as values</strong><span className="small muted">visitors per value</span></div>
        {summary.loading ? <SkeletonRows rows={2} cols={3} /> : values.length ? values.map((v) => (
          <div key={v.audience} className="kv-row"><code>{dkey}={v.audience}</code><span className="grow" /><strong>{v.members.toLocaleString()}</strong></div>
        )) : <div className="small muted">Values appear after the first sync to this destination runs.</div>}
      </div>
      <div className="kv-block">
        <div className="kv-block-head"><strong>Who may call the lookup</strong><span className="small muted">Databricks identities with CAN USE on this app</span></div>
        {(s?.clients ?? []).map((c) => (
          <div key={c} className="kv-row"><code>{c}</code><span className="grow" />{admin && <button className="btn ghost sm danger" onClick={() => saveClients((s?.clients ?? []).filter((x) => x !== c))}>Remove</button>}</div>
        ))}
        {!s?.clients?.length && <div className="small muted">Only Platform Admins so far. Add the service principal your website's server uses.</div>}
        {admin && s?.last_denied && !(s.clients ?? []).includes(s.last_denied.identity.toLowerCase()) && (
          <div className="kv-denied">Refused <code>{s.last_denied.identity}</code><button className="btn sm primary" onClick={() => saveClients([...(s?.clients ?? []), s!.last_denied!.identity])}>Allow it</button></div>
        )}
        {admin && (
          <div className="row" style={{ marginTop: 6 }}>
            <input className="input sm grow" value={draft} placeholder="Service principal application ID or email" onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && draft.trim() && saveClients([...(s?.clients ?? []), draft.trim()])} />
            <button className="btn sm" disabled={!draft.trim()} onClick={() => saveClients([...(s?.clients ?? []), draft.trim()])}>Allow</button>
          </div>
        )}
      </div>
    </Section>
  )
}

function DestinationInspector({ d, type, canManage, onEdit, onRemove }: {
  d: Destination; type?: DestinationType; canManage: boolean; onEdit: () => void; onRemove: () => void
}) {
  const me = useMe()
  const syncs = useAsync(() => api.get<Sync[]>('/syncs'), [d.id])
  const policy = useAsync(() => api.get<Pol>(`/alert-policies/destination/${d.id}`), [d.id])
  const catalog = useAsync(() => api.get<{ triggers: Trig[] }>('/alerts/catalog'))
  const mine = (syncs.data ?? []).filter((x) => x.destination_id === d.id)
  const health = mine.map((x) => syncHealth(x))
  const failing = health.filter((h) => h.key === 'failing' || h.key === 'warning').length
  const configured = d.configured !== false
  const secretKeys = new Set((type?.config_fields ?? []).filter((f) => f.type === 'password' || f.secret).map((f) => f.name))
  const settings: [ReactNode, ReactNode][] = (type?.config_fields ?? []).map((f) => {
    const v = d.config?.[f.name]
    return [f.label, !v ? <span className="faint">{f.required ? 'Missing' : 'Not set'}</span>
      : secretKeys.has(f.name) ? <span className="badge green"><span className="dot" />Saved</span> : <code>{String(v)}</code>]
  })
  return (
    <Inspector icon={<DestIcon type={d.type} size={44} />} kicker={type?.label ?? d.type} title={d.name}
      actions={canManage && configured ? <button className="btn sm" onClick={onEdit}>Edit</button> : undefined}
      sentence={<>{type?.description ?? 'A marketing tool audiences are delivered to.'} <span className="muted">{d.brand_id == null ? 'Shared by every brand.' : `Used by ${me.brandName(d.brand_id)}.`}</span></>}>
      {!configured && (
        <div className="sx-callout amber">
          <div className="grow"><strong>Credentials needed</strong>
            <div className="small muted">Missing {(d.missing_fields ?? []).join(', ') || 'credentials'}. {mine.length ? `${mine.length} sync${mine.length === 1 ? ' is' : 's are'} ready and start` : 'Syncs start'} as soon as they're added.</div></div>
          {canManage && <button className="btn sm primary" onClick={onEdit}>Add credentials</button>}
        </div>
      )}
      <div className="cx-stats">
        <StatTile label="Connection" value={configured ? 'Connected' : 'Not yet'} tone={configured ? 'good' : 'warn'} sub={configured ? 'Credentials saved' : 'Waiting for credentials'} />
        <StatTile label="Syncs" value={mine.length} sub={mine.length ? (failing ? `${failing} failing` : 'none failing') : 'none yet'} tone={failing ? 'bad' : undefined} />
      </div>
      <Section title="Syncs to this destination" aside={mine.length ? <Link className="small" to={`/activations?dest=${d.id}`}>Open list →</Link> : undefined}>
        {syncs.loading && !syncs.data ? <SkeletonRows rows={2} cols={2} /> : mine.length ? (
          <div className="dx2-syncs">
            {mine.slice(0, 6).map((x, i) => (
              <Link key={x.id} to={`/activations?id=${x.id}`} className="dx2-sync">
                <span className={`kit-dot ${health[i].tone}`} />
                <span className="grow" style={{ minWidth: 0 }}><strong>{x.name}</strong><small>{health[i].sentence}</small></span>
                <span className="dx2-chev" aria-hidden="true">›</span>
              </Link>
            ))}
            {mine.length > 6 && <Link className="small" to={`/activations?dest=${d.id}`}>+{mine.length - 6} more</Link>}
          </div>
        ) : <div className="sx-quiet">No syncs send here yet. {me.can('syncs.edit', d.brand_id ?? null) && <Link to="/activations/new">Create one →</Link>}</div>}
      </Section>
      <Section title="Alert rules" aside={<Link className="small" to={`/alerts?tab=rules&dest=${d.id}`}>Edit rules →</Link>}>
        {policy.data && catalog.data ? (
          <div className="dx2-checks">
            {catalog.data.triggers.map((t) => {
              const cfg = policy.data!.triggers[t.key]
              return (
                <div key={t.key} className={`dx2-check ${cfg?.enabled ? '' : 'off'}`}>
                  <span className={`kit-dot ${cfg?.enabled ? (cfg.severity === 'critical' ? 'red' : 'amber') : 'gray'}`} />
                  <span className="grow">{t.label}</span>
                  <span className="small muted">{cfg?.enabled ? `${cfg.severity}${thresh(t.key, cfg) ? ` · ${thresh(t.key, cfg)}` : ''}` : 'off'}</span>
                </div>
              )
            })}
          </div>
        ) : <SkeletonRows rows={3} cols={2} />}
      </Section>
      {d.type === 'gam_kv' && <WebsiteSetup dkey={String(d.config.key || 'mm_aud')} />}
      {settings.length > 0 && <Section title="Settings"><Facts rows={settings} /></Section>}
      {canManage && (
        <div className="sx-actions">
          <span className="grow" />
          <button className="btn ghost danger" onClick={onRemove}>Remove destination</button>
        </div>
      )}
    </Inspector>
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
  const [sel, setSel] = useUrlState('id')

  const remove = async (d: Destination) => {
    if (!await askConfirm({ title: `Remove “${d.name}”?`, body: 'Its credentials are deleted. A destination used by syncs can’t be removed — delete those syncs first.', confirmLabel: 'Remove destination', danger: true })) return
    try { await api.del(`/destinations/${d.id}`); setSel(''); dests.reload(); toast(`${d.name} removed`) } catch (e) { toast((e as Error).message, 'error') }
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
  const selected = all.find((d) => String(d.id) === sel)

  return (
    <div className="page wide">
      <PageHead title="Destinations" subtitle="The marketing tools your audiences are delivered to. Credentials are stored securely and never shown again."
        actions={canAdd ? <button className="btn primary" onClick={() => setModal({})} disabled={!types.data}>+ Add destination</button> : undefined} />
      <ErrorBox error={dests.error || types.error} />
      {dests.loading && !dests.data ? <SkeletonRows rows={3} cols={3} /> : all.length ? (
        <CollectionLayout open={!!selected} onClose={() => setSel('')}
          list={
            <ListPane title="Connected tools" count={all.length}
              toolbar={<>
                {all.length > 4 && <SearchBox value={q} onChange={setQ} placeholder={`Search ${all.length} destinations…`} />}
                <FilterChips label="Credentials" value={status} onChange={setStatus} options={[
                  { value: 'all', label: 'All', count: all.length },
                  { value: 'ready', label: 'Connected', count: all.length - needs, tone: 'green' },
                  { value: 'needs', label: 'Needs credentials', count: needs, tone: 'amber' },
                ]} />
                {kinds.length > 1 && (
                  <select className="input sm" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type">
                    <option value="">All types</option>
                    {kinds.map((k) => <option key={k} value={k}>{typeOf(k)?.label ?? k}</option>)}
                  </select>
                )}
                {brands.length > 1 && (
                  <select className="input sm" value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Brand">
                    <option value="">All brands</option>
                    {brands.map((b) => <option key={b ?? 'shared'} value={b ?? 'shared'}>{b == null ? 'Shared' : me.brandName(b)}</option>)}
                  </select>
                )}
              </>}>
              {rows.map((d) => {
                const configured = d.configured !== false
                return (
                  <ListRow key={d.id} selected={selected?.id === d.id} onSelect={() => setSel(String(d.id))}
                    leading={<DestIcon type={d.type} size={38} />}
                    title={d.name}
                    subtitle={`${typeOf(d.type)?.label ?? d.type} · ${d.brand_id == null ? 'Shared' : me.brandName(d.brand_id)}`}
                    meta={<>
                      <span className={`dx2-state ${configured ? 'ok' : 'warn'}`}><span className={`kit-dot ${configured ? 'green' : 'amber'}`} />{configured ? 'Connected' : 'Needs credentials'}</span>
                      <span>{d.sync_count ? `${d.sync_count} sync${d.sync_count === 1 ? '' : 's'}` : 'no syncs'}</span>
                    </>} />
                )
              })}
              {!rows.length && <NoResults what="destinations" onClear={() => { setQ(''); setStatus('all'); setKind(''); setBrand('') }} />}
            </ListPane>
          }
          inspector={selected
            ? <DestinationInspector key={selected.id} d={selected} type={typeOf(selected.type)} canManage={canManage(selected)}
              onEdit={() => setModal({ existing: selected })} onRemove={() => remove(selected)} />
            : <Inspector empty={<div><strong>No destination selected</strong></div>} />} />
      ) : (
        <div className="card dx2-empty">
          <div className="dx2-empty-logos" aria-hidden="true">{['sailthru', 'brevo', 'gam', 'freewheel', 'meta_custom_audience', 'hubspot'].map((t) => <DestIcon key={t} type={t} size={46} />)}</div>
          <h2>Connect your first marketing tool</h2>
          <p className="muted">Sailthru, Google Ad Manager, Meta, HubSpot and more. You can add credentials now or later — syncs wait until they're in place.</p>
          {canAdd && <button className="btn primary" onClick={() => setModal({})} disabled={!types.data}>Add destination</button>}
        </div>
      )}
      {modal && types.data && (
        <DestinationModal types={types.data} existing={modal.existing} onClose={() => setModal(null)} onSaved={() => { setModal(null); dests.reload() }} />
      )}
    </div>
  )
}
