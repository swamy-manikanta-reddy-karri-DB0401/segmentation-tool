import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Destination } from '../api'
import { DestIcon, ErrorBox, Field, Modal, PageHead, Spinner, useAsync } from '../components/ui'
import { useMe } from '../components/me'
import { askConfirm, FilterChips, matches, NoResults, Pager, SearchBox, SkeletonRows, toast, Toolbar, usePaged, useUrlState } from '../components/kit'
import {
  CHANNEL_LABEL, ChannelIcon, changeKind, muteLabel, MuteMenu, RoutingEditor, SeverityBadge, since, Switch, TriggerEditor,
} from '../components/alerting'
import type { AlertEvent, AlertRow, Catalog, Channel, Policy, Recipient, TriggerCfg, TriggerKey } from '../components/alerting'
import '../ux/alerts.css'

type Tab = 'active' | 'history' | 'recipients' | 'rules'
const MASK = '••••••••'

// ---------------------------------------------------------------------------------------------
// Active

/** The destination's own error, visible at a glance; long ones expand. */
export function ErrorLine({ error }: { error: string }) {
  const first = error.split('\n')[0]
  const long = error.length > 160 || error.includes('\n')
  return (
    <div className="al-errline">
      <span className="al-errline-k">Error</span>
      {long ? <details><summary>{first.slice(0, 160)}{first.length > 160 ? '…' : ''}</summary><pre className="code">{error}</pre></details> : <span>{error}</span>}
    </div>
  )
}

function ActiveAlerts({ catalog }: { catalog?: Catalog }) {
  const alerts = useAsync(() => api.get<AlertRow[]>('/alerts?status=active'))
  const [q, setQ] = useUrlState('q')
  const [sev, setSev] = useUrlState('sev', 'all')
  useEffect(() => {
    const t = setInterval(alerts.reload, 30000)
    const on = () => alerts.reload()
    window.addEventListener('alerts:changed', on)
    return () => { clearInterval(t); window.removeEventListener('alerts:changed', on) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const all = alerts.data ?? []
  const rank = (a: AlertRow) => (a.muted ? 0 : a.status === 'critical' ? 2 : 1)
  const rows = all
    .filter((a) => (sev === 'all' ? true : sev === 'muted' ? a.muted : a.status === sev && !a.muted))
    .filter((a) => matches(q, a.label, a.message, a.sync_name, a.destination_name, a.audience_name))
    .sort((a, b) => rank(b) - rank(a) || (b.opened_at ?? '').localeCompare(a.opened_at ?? ''))
  const paged = usePaged(rows, 20, `${q}|${sev}`, 'page')
  const count = (f: (a: AlertRow) => boolean) => all.filter(f).length

  if (alerts.loading && !alerts.data) return <SkeletonRows rows={4} cols={3} />
  if (alerts.error) return <ErrorBox error={alerts.error} />
  if (!all.length) {
    return (
      <div className="card al-clear">
        <div className="al-clear-icon" aria-hidden="true">✓</div>
        <div>
          <h2>All clear</h2>
          <p className="muted">No sync needs attention right now. Every approved sync is checked after each run and every five minutes for:</p>
          <ul className="al-clear-list">
            {(catalog?.triggers ?? []).map((t) => <li key={t.key}><strong>{t.label}</strong> — {t.description}</li>)}
          </ul>
          <p className="small muted" style={{ marginTop: 10 }}>You can change what's watched per destination under <Link to="/alerts?tab=rules">Rules</Link>, and who is told under <Link to="/alerts?tab=recipients">Recipients</Link>.</p>
        </div>
      </div>
    )
  }
  return (<>
    <Toolbar>
      <SearchBox value={q} onChange={setQ} placeholder="Search alerts, syncs or destinations…" />
      <FilterChips label="Severity" value={sev} onChange={setSev} options={[
        { value: 'all', label: 'All', count: all.length },
        { value: 'critical', label: 'Critical', count: count((a) => a.status === 'critical' && !a.muted), tone: 'red' },
        { value: 'warning', label: 'Warning', count: count((a) => a.status === 'warning' && !a.muted), tone: 'amber' },
        { value: 'muted', label: 'Muted', count: count((a) => a.muted), tone: 'gray' },
      ]} />
    </Toolbar>
    <div className="al-list" role="list">
      {paged.slice.map((a) => (
        <article key={a.id} role="listitem" className={`al-item ${a.status} ${a.muted ? 'is-muted' : ''}`}>
          <div className="al-item-main">
            <div className="al-item-top">
              <SeverityBadge status={a.status} muted={a.muted} />
              <h3>{a.label}</h3>
              <span className="al-item-age" title={a.opened_at ? new Date(a.opened_at).toLocaleString() : undefined}>open for {since(a.opened_at)}</span>
            </div>
            <p className="al-item-msg">{a.message || a.label}</p>
            {a.error && <ErrorLine error={a.error} />}
            <div className="al-item-meta">
              <Link to={`/activations/${a.sync_id}`} className="al-route"><strong>{a.sync_name}</strong></Link>
              <span className="al-route-arrow" aria-hidden="true">→</span>
              <span className="al-route"><DestIcon type={a.destination_type} size={22} />{a.destination_name}</span>
              {a.muted && <span className="al-muted-note">{muteLabel(a.muted_until)} · nobody is notified</span>}
            </div>
          </div>
          <div className="al-item-actions">
            <Link className="btn sm primary" to={`/activations/${a.sync_id}`}>Open sync</Link>
            {a.can_mute && <MuteMenu syncId={a.sync_id} trigger={a.trigger} muted={a.muted} onDone={alerts.reload} />}
          </div>
        </article>
      ))}
      {!rows.length && <NoResults what="alerts" onClear={() => { setQ(''); setSev('all') }} />}
    </div>
    <Pager page={paged.page} pages={paged.pages} total={rows.length} pageSize={20} onPage={paged.setPage} noun="alert" />
  </>)
}

// ---------------------------------------------------------------------------------------------
// History

function History({ catalog }: { catalog?: Catalog }) {
  const events = useAsync(() => api.get<AlertEvent[]>('/alert-events?limit=1000'))
  const [q, setQ] = useUrlState('q')
  const [kind, setKind] = useUrlState('change', 'all')
  const [trigger, setTrigger] = useUrlState('trigger')
  const [sync, setSync] = useUrlState('sync')
  const all = useMemo(() => [...(events.data ?? [])].sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id), [events.data])
  const syncs = useMemo(() => [...new Map(all.map((e) => [e.sync_id, e.sync_name])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [all])
  const kindOf = (e: AlertEvent) => changeKind(e).label.toLowerCase()
  const rows = all.filter((e) => (kind === 'all' || kindOf(e) === kind) && (!trigger || e.trigger === trigger)
    && (!sync || String(e.sync_id) === sync) && matches(q, e.label, e.message, e.sync_name, e.destination_name))
  const paged = usePaged(rows, 25, `${q}|${kind}|${trigger}|${sync}`, 'page')
  const n = (k: string) => all.filter((e) => kindOf(e) === k).length

  if (events.loading && !events.data) return <SkeletonRows rows={6} cols={4} />
  if (events.error) return <ErrorBox error={events.error} />
  if (!all.length) {
    return <div className="card al-empty"><h3>No alert history yet</h3><p className="muted small">Every time an alert opens, escalates or recovers it's recorded here — with who was notified and whether delivery worked.</p></div>
  }
  return (<div className="al-hist">
    <Toolbar>
      <SearchBox value={q} onChange={setQ} placeholder="Search history…" />
      <FilterChips label="Change" value={kind} onChange={setKind} options={[
        { value: 'all', label: 'All', count: all.length },
        { value: 'opened', label: 'Opened', count: n('opened'), tone: 'amber' },
        { value: 'escalated', label: 'Escalated', count: n('escalated'), tone: 'red' },
        { value: 'recovered', label: 'Recovered', count: n('recovered'), tone: 'green' },
      ]} />
      <select className="input sm" value={trigger} onChange={(e) => setTrigger(e.target.value)} aria-label="Trigger">
        <option value="">Every check</option>
        {(catalog?.triggers ?? []).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
      </select>
      {syncs.length > 1 && (
        <select className="input sm" value={sync} onChange={(e) => setSync(e.target.value)} aria-label="Sync">
          <option value="">Every sync</option>
          {syncs.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      )}
    </Toolbar>
    <ol className="al-timeline">
      {paged.slice.map((e) => {
        const k = changeKind(e)
        return (
          <li key={e.id} className={`al-tl ${k.tone}`}>
            <span className="al-tl-dot" aria-hidden="true" />
            <div className="al-tl-time" title={new Date(e.at).toLocaleString()}>
              <strong>{new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</strong>
              <small>{fmt.ago(e.at)}</small>
            </div>
            <div className="al-tl-body">
              <div className="al-tl-head">
                <span className={`al-change ${k.tone}`}>{k.label}</span>
                <strong>{e.label}</strong>
                {e.new_status !== 'healthy' && <SeverityBadge status={e.new_status} />}
                <span className="small muted">on</span>
                <Link to={`/activations/${e.sync_id}`} className="al-tl-sync">{e.sync_name}</Link>
              </div>
              {e.message && <p className="al-tl-msg">{e.message}</p>}
              <div className="al-deliveries">
                {e.muted ? <span className="al-dv muted">Muted — nobody notified</span>
                  : !e.deliveries.length ? <span className="al-dv none">No recipients matched</span>
                    : e.deliveries.map((d, i) => (
                      <span key={i} className={`al-dv ${d.ok ? 'ok' : 'fail'}`} title={d.ok ? `Delivered via ${CHANNEL_LABEL[d.channel]}` : d.error}>
                        {d.ok ? '✓' : '✕'} {d.name}<small>{CHANNEL_LABEL[d.channel]}</small>
                      </span>
                    ))}
              </div>
            </div>
          </li>
        )
      })}
      {!rows.length && <NoResults what="events" onClear={() => { setQ(''); setKind('all'); setTrigger(''); setSync('') }} />}
    </ol>
    <Pager page={paged.page} pages={paged.pages} total={rows.length} pageSize={25} onPage={paged.setPage} noun="event" />
  </div>)
}

// ---------------------------------------------------------------------------------------------
// Recipients

const CHANNEL_HELP: Record<Channel, string> = {
  email: 'Send to a person or a shared inbox.',
  slack: 'Post into a Slack channel.',
  pagerduty: 'Page the on-call person; recovers resolve the incident.',
  webhook: 'POST a JSON message to any URL (Teams, Opsgenie, your own service).',
}

function EmailSettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const cur = useAsync(() => api.get<Record<string, string | boolean>>('/alerts/email-settings'))
  const [f, setF] = useState<Record<string, string | boolean> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const v = f ?? cur.data
  const set = (k: string, val: string | boolean) => setF({ ...v!, [k]: val })
  const save = async () => {
    setBusy(true); setError(null)
    try { await api.put('/alerts/email-settings', v); toast('Email settings saved'); onSaved() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal title="Email settings" subtitle="The mail server used to send alert emails. Ask IT for an SMTP relay (e.g. Office 365 or SendGrid)." onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={busy || !v}>{busy ? 'Saving…' : 'Save'}</button></>}>
      {!v ? <Spinner /> : (<>
        <div className="grid-2">
          <Field label="SMTP server"><input className="input" value={String(v.host ?? '')} placeholder="smtp.office365.com" onChange={(e) => set('host', e.target.value)} /></Field>
          <Field label="Port"><input className="input" value={String(v.port ?? '')} placeholder="587" onChange={(e) => set('port', e.target.value)} /></Field>
        </div>
        <div className="grid-2">
          <Field label="Username"><input className="input" value={String(v.username ?? '')} onChange={(e) => set('username', e.target.value)} /></Field>
          <Field label="Password"><input className="input" type="password" value={String(v.password ?? '')} onFocus={() => v.password === MASK && set('password', '')} onChange={(e) => set('password', e.target.value)} /></Field>
        </div>
        <Field label="From address" help="Alerts are sent from this address."><input className="input" value={String(v.sender ?? '')} placeholder="cdp-alerts@company.com" onChange={(e) => set('sender', e.target.value)} /></Field>
        <label className="row small"><input type="checkbox" checked={v.starttls !== false} onChange={(e) => set('starttls', e.target.checked)} /> Use STARTTLS (recommended for port 587)</label>
        <ErrorBox error={error || cur.error} />
      </>)}
    </Modal>
  )
}

function RecipientModal({ existing, destinations, onClose, onSaved }: { existing?: Recipient; destinations: Destination[]; onClose: () => void; onSaved: () => void }) {
  const me = useMe()
  const brands = me.brandsWith('destinations.manage')
  const platform = me.canPlatform('settings.manage')
  const [f, setF] = useState<Omit<Recipient, 'id' | 'created_by' | 'created_at' | 'target'>>(existing
    ? { name: existing.name, channel: existing.channel, config: { ...existing.config }, severity: existing.severity, destination_ids: existing.destination_ids, brand_id: existing.brand_id, enabled: existing.enabled }
    : { name: '', channel: 'slack', config: {}, severity: 'all', destination_ids: [], brand_id: platform ? null : brands[0]?.id ?? null, enabled: true })
  const [scoped, setScoped] = useState((existing?.destination_ids.length ?? 0) > 0)
  const [busy, setBusy] = useState<'' | 'save' | 'test'>('')
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<typeof f>) => { setF({ ...f, ...patch }); setResult(null) }
  const cfg = (k: string, v: string) => set({ config: { ...f.config, [k]: v } })
  const body = { ...f, destination_ids: scoped ? f.destination_ids : [], id: existing?.id }
  const dests = destinations.filter((d) => f.brand_id == null || d.brand_id == null || d.brand_id === f.brand_id)
  const save = async () => {
    setBusy('save'); setError(null)
    try {
      if (existing) await api.put(`/alert-recipients/${existing.id}`, body)
      else await api.post('/alert-recipients', body)
      toast(existing ? 'Recipient updated' : 'Recipient added'); onSaved()
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  const test = async () => {
    setBusy('test'); setError(null)
    try { setResult(await api.post('/alert-recipients/test', body)) } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  const secret = (k: string, label: string, placeholder: string, help?: string) => (
    <Field label={label} help={help}>
      <input className="input mono" type={f.config[k] === MASK ? 'password' : 'text'} value={f.config[k] ?? ''} placeholder={placeholder}
        onFocus={() => f.config[k] === MASK && cfg(k, '')} onChange={(e) => cfg(k, e.target.value)} />
    </Field>
  )
  return (
    <Modal wide title={existing ? `Edit ${existing.name}` : 'Add a recipient'} subtitle="Who should be told when a sync needs attention, and how." onClose={onClose}
      footer={<>
        <button className="btn" onClick={test} disabled={!!busy}>{busy === 'test' ? 'Sending…' : 'Send test alert'}</button>
        {result && <span className={`small al-test ${result.ok ? 'ok' : 'fail'}`}>{result.ok ? '✓ ' : '✕ '}{result.message}</span>}
        <span className="grow" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={!!busy}>{busy === 'save' ? 'Saving…' : existing ? 'Save' : 'Add recipient'}</button>
      </>}>
      {!existing && (
        <div className="al-channel-pick" role="radiogroup" aria-label="Channel">
          {(['slack', 'email', 'pagerduty', 'webhook'] as Channel[]).map((c) => (
            <button key={c} type="button" role="radio" aria-checked={f.channel === c} className={`al-channel ${f.channel === c ? 'on' : ''}`}
              onClick={() => set({ channel: c, config: {} })}>
              <ChannelIcon channel={c} size={34} />
              <span><strong>{CHANNEL_LABEL[c]}</strong><small>{CHANNEL_HELP[c]}</small></span>
            </button>
          ))}
        </div>
      )}
      <Field label="Name" help="Shown in alert history — e.g. “CNBC marketing ops” or “#cdp-alerts”.">
        <input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="CNBC marketing ops" />
      </Field>
      {f.channel === 'email' && (<>
        <Field label="Email address"><input className="input" type="email" value={f.config.address ?? ''} placeholder="marketing-ops@company.com" onChange={(e) => cfg('address', e.target.value)} /></Field>
      </>)}
      {f.channel === 'slack' && secret('webhook_url', 'Slack incoming-webhook URL', 'https://hooks.slack.com/services/…', 'In Slack: Apps → Incoming Webhooks → Add to a channel, then paste the URL here.')}
      {f.channel === 'pagerduty' && secret('routing_key', 'PagerDuty integration key', '32-character routing key', 'In PagerDuty: Service → Integrations → Events API v2 → Integration key.')}
      {f.channel === 'webhook' && (<>
        <Field label="URL"><input className="input mono" value={f.config.url ?? ''} placeholder="https://…" onChange={(e) => cfg('url', e.target.value)} /></Field>
        <Field label="Headers (optional)" help="One per line, e.g. Authorization: Bearer abc123">
          <textarea className="input mono" rows={2} value={f.config.headers === MASK ? '' : f.config.headers ?? ''} placeholder={f.config.headers === MASK ? 'Saved headers are kept unless you type new ones' : 'Authorization: Bearer …'}
            onChange={(e) => cfg('headers', e.target.value)} />
        </Field>
      </>)}
      <div className="grid-2">
        <Field label="Which alerts">
          <div className="seg al-seg" role="radiogroup">
            <button role="radio" aria-checked={f.severity === 'all'} className={f.severity === 'all' ? 'on' : ''} onClick={() => set({ severity: 'all' })}>Warnings and critical</button>
            <button role="radio" aria-checked={f.severity === 'critical'} className={f.severity === 'critical' ? 'on' : ''} onClick={() => set({ severity: 'critical' })}>Critical only</button>
          </div>
        </Field>
        <Field label="Brand" help={platform ? 'All brands: told about every brand’s syncs.' : undefined}>
          <select className="input" value={f.brand_id ?? ''} onChange={(e) => set({ brand_id: e.target.value ? Number(e.target.value) : null, destination_ids: [] })}>
            {platform && <option value="">All brands</option>}
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Destinations">
        <div className="al-routing">
          <label className={`al-route-opt ${!scoped ? 'on' : ''}`}><input type="radio" checked={!scoped} onChange={() => setScoped(false)} />
            <div><strong>Every destination</strong><div className="small muted">{f.brand_id == null ? 'Across all brands.' : `Every destination of ${me.brandName(f.brand_id)}.`}</div></div></label>
          <label className={`al-route-opt ${scoped ? 'on' : ''}`}><input type="radio" checked={scoped} onChange={() => setScoped(true)} />
            <div><strong>Only some destinations</strong><div className="small muted">E.g. the Ad Ops team only for Google Ad Manager.</div></div></label>
          {scoped && (
            <div className="al-route-list">
              {dests.map((d) => (
                <label key={d.id} className="al-route-item">
                  <input type="checkbox" checked={f.destination_ids.includes(d.id)}
                    onChange={(e) => set({ destination_ids: e.target.checked ? [...f.destination_ids, d.id] : f.destination_ids.filter((x) => x !== d.id) })} />
                  <DestIcon type={d.type} size={22} /><span className="al-ellipsis">{d.name}</span>
                </label>
              ))}
              {!dests.length && <div className="small muted">No destinations for this brand yet.</div>}
            </div>
          )}
        </div>
      </Field>
      <ErrorBox error={error} />
    </Modal>
  )
}

function Recipients({ catalog, reloadCatalog }: { catalog?: Catalog; reloadCatalog: () => void }) {
  const me = useMe()
  const recipients = useAsync(() => api.get<Recipient[]>('/alert-recipients'))
  const destinations = useAsync(() => api.get<Destination[]>('/destinations'))
  const [q, setQ] = useUrlState('q')
  const [ch, setCh] = useUrlState('channel', 'all')
  const [modal, setModal] = useState<{ existing?: Recipient } | null>(null)
  const [emailModal, setEmailModal] = useState(false)
  const [tests, setTests] = useState<Record<number, { ok: boolean; message: string } | 'busy'>>({})
  const canManage = (r: { brand_id: number | null }) => (r.brand_id == null ? me.canPlatform('settings.manage') : me.can('destinations.manage', r.brand_id))
  const canAdd = me.canPlatform('settings.manage') || me.brandsWith('destinations.manage').length > 0
  const all = recipients.data ?? []
  const rows = all.filter((r) => (ch === 'all' || r.channel === ch) && matches(q, r.name, r.target, CHANNEL_LABEL[r.channel]))
  const destName = (id: number) => destinations.data?.find((d) => d.id === id)?.name ?? `#${id}`
  const emailOff = catalog && !catalog.email_configured

  const toggle = async (r: Recipient) => {
    try { await api.put(`/alert-recipients/${r.id}`, { enabled: !r.enabled }); recipients.reload(); toast(r.enabled ? `${r.name} paused` : `${r.name} resumed`) }
    catch (e) { toast((e as Error).message, 'error') }
  }
  const remove = async (r: Recipient) => {
    if (!await askConfirm({ title: `Remove ${r.name}?`, body: 'They stop receiving alerts straight away. Syncs that route only to this recipient will notify nobody.', confirmLabel: 'Remove recipient', danger: true })) return
    try { await api.del(`/alert-recipients/${r.id}`); recipients.reload(); toast(`${r.name} removed`) } catch (e) { toast((e as Error).message, 'error') }
  }
  const test = async (r: Recipient) => {
    setTests((t) => ({ ...t, [r.id]: 'busy' }))
    try { const res = await api.post<{ ok: boolean; message: string }>('/alert-recipients/test', { id: r.id }); setTests((t) => ({ ...t, [r.id]: res })) }
    catch (e) { setTests((t) => ({ ...t, [r.id]: { ok: false, message: (e as Error).message } })) }
  }

  return (<>
    {emailOff && (all.some((r) => r.channel === 'email') || me.canPlatform('settings.manage')) && (
      <div className="callout amber al-banner">
        <div className="callout-icon">@</div>
        <div className="grow"><strong>Email isn’t set up yet</strong>
          <div className="small muted">{all.some((r) => r.channel === 'email') ? 'Email recipients won’t receive anything until a mail server is configured.' : 'Slack, PagerDuty and webhooks work now; email needs a mail server first.'}</div></div>
        {me.canPlatform('settings.manage') ? <button className="btn sm" onClick={() => setEmailModal(true)}>Set up email</button> : <span className="small faint">Ask a Platform Admin</span>}
      </div>
    )}
    <Toolbar>
      <SearchBox value={q} onChange={setQ} placeholder="Search recipients…" />
      <FilterChips label="Channel" value={ch} onChange={setCh} options={[
        { value: 'all', label: 'All', count: all.length },
        ...(['slack', 'email', 'pagerduty', 'webhook'] as Channel[]).filter((c) => all.some((r) => r.channel === c)).map((c) => ({ value: c, label: CHANNEL_LABEL[c], count: all.filter((r) => r.channel === c).length })),
      ]} />
      <span className="grow" />
      {!emailOff && me.canPlatform('settings.manage') && <button className="btn ghost sm" onClick={() => setEmailModal(true)}>Email settings</button>}
      {canAdd && <button className="btn primary" onClick={() => setModal({})}>+ Add recipient</button>}
    </Toolbar>
    {recipients.loading && !recipients.data ? <SkeletonRows rows={3} cols={3} /> : recipients.error ? <ErrorBox error={recipients.error} /> : !all.length ? (
      <div className="card al-empty">
        <h3>Nobody is notified yet</h3>
        <p className="muted small">Alerts still appear here in the app. Add a Slack channel, an email list, PagerDuty or a webhook so the right people hear about problems straight away.</p>
        {canAdd && <button className="btn primary" onClick={() => setModal({})}>+ Add the first recipient</button>}
      </div>
    ) : (
      <div className="al-rcp-grid">
        {rows.map((r) => {
          const t = tests[r.id]
          const manage = canManage(r)
          return (
            <div key={r.id} className={`card al-rcp ${r.enabled ? '' : 'off'}`}>
              <div className="al-rcp-top">
                <ChannelIcon channel={r.channel} />
                <div className="al-rcp-name">
                  <strong className="al-ellipsis" title={r.name}>{r.name}</strong>
                  <small className="al-ellipsis" title={r.target}>{CHANNEL_LABEL[r.channel]} · {r.target}</small>
                </div>
                {manage && <Switch on={r.enabled} onChange={() => toggle(r)} label={`${r.name} ${r.enabled ? 'enabled' : 'paused'}`} />}
              </div>
              <dl className="al-rcp-facts">
                <div><dt>Gets</dt><dd>{r.severity === 'critical' ? <span className="al-tag crit">Critical only</span> : 'Warnings and critical'}</dd></div>
                <div><dt>For</dt><dd className="al-ellipsis" title={r.destination_ids.map(destName).join(', ')}>
                  {r.destination_ids.length ? r.destination_ids.map(destName).join(', ') : `Every destination${r.brand_id == null ? '' : ` of ${me.brandName(r.brand_id)}`}`}</dd></div>
                {(me.me?.brands.length ?? 0) > 1 && <div><dt>Brand</dt><dd>{me.brandName(r.brand_id)}</dd></div>}
              </dl>
              {t && t !== 'busy' && <div className={`al-test ${t.ok ? 'ok' : 'fail'}`}>{t.ok ? '✓ ' : '✕ '}{t.message}</div>}
              {!r.enabled && <div className="small faint">Paused — receives nothing until turned back on.</div>}
              {manage && (
                <div className="al-rcp-foot">
                  <button className="btn sm" onClick={() => test(r)} disabled={t === 'busy'}>{t === 'busy' ? 'Sending…' : 'Send test'}</button>
                  <span className="grow" />
                  <button className="btn ghost sm danger" onClick={() => remove(r)}>Remove</button>
                  <button className="btn ghost sm" onClick={() => setModal({ existing: r })}>Edit</button>
                </div>
              )}
            </div>
          )
        })}
        {!rows.length && <NoResults what="recipients" onClear={() => { setQ(''); setCh('all') }} />}
      </div>
    )}
    {modal && <RecipientModal existing={modal.existing} destinations={destinations.data ?? []} onClose={() => setModal(null)} onSaved={() => { setModal(null); recipients.reload() }} />}
    {emailModal && <EmailSettingsModal onClose={() => setEmailModal(false)} onSaved={() => { setEmailModal(false); reloadCatalog() }} />}
  </>)
}

// ---------------------------------------------------------------------------------------------
// Rules (destination defaults)

function DestinationRules({ catalog }: { catalog: Catalog }) {
  const me = useMe()
  const destinations = useAsync(() => api.get<Destination[]>('/destinations'))
  const recipients = useAsync(() => api.get<Recipient[]>('/alert-recipients'))
  const [destId, setDestId] = useUrlState('dest')
  const [q, setQ] = useState('')
  const dests = (destinations.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))
  const dest = dests.find((d) => String(d.id) === destId) ?? dests[0]
  const policy = useAsync(() => (dest ? api.get<Policy>(`/alert-policies/destination/${dest.id}`) : Promise.resolve(null)), [dest?.id])
  const [own, setOwn] = useState<Partial<Record<TriggerKey, TriggerCfg>>>({})
  const [routing, setRouting] = useState<number[] | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (policy.data) { setOwn(policy.data.own.triggers ?? {}); setRouting(policy.data.own.recipient_ids ?? null) } }, [policy.data])
  const base = Object.fromEntries(catalog.triggers.map((t) => [t.key, t.defaults]))
  const dirty = !!policy.data && (JSON.stringify(own) !== JSON.stringify(policy.data.own.triggers ?? {}) || JSON.stringify(routing) !== JSON.stringify(policy.data.own.recipient_ids ?? null))
  const readOnly = !dest || !me.can('destinations.manage', dest.brand_id ?? null)
  const relevant = (recipients.data ?? []).filter((r) => dest && (r.brand_id == null || r.brand_id === dest.brand_id))
  const save = async () => {
    setSaving(true)
    try { await api.put(`/alert-policies/destination/${dest!.id}`, { triggers: own, recipient_ids: routing }); policy.reload(); toast(`Alert rules saved for ${dest!.name}`) }
    catch (e) { toast((e as Error).message, 'error') } finally { setSaving(false) }
  }
  if (destinations.loading && !destinations.data) return <SkeletonRows rows={4} cols={3} />
  if (!dests.length) return <div className="card al-empty"><h3>No destinations yet</h3><p className="small muted">Alert rules are set per destination. <Link to="/destinations">Add a destination</Link> first.</p></div>
  const shown = dests.filter((d) => matches(q, d.name, d.type))
  return (
    <div className="al-rules-layout">
      <aside className="card al-dest-list" aria-label="Destinations">
        <div className="al-dest-head"><strong>Destinations</strong><small className="muted">Every sync to a destination uses its rules unless the sync overrides them.</small>
          {dests.length > 6 && <SearchBox value={q} onChange={setQ} placeholder="Search destinations…" />}</div>
        <div className="al-dest-items">
          {shown.map((d) => (
            <button key={d.id} className={`al-dest ${d.id === dest?.id ? 'on' : ''}`} aria-current={d.id === dest?.id}
              onClick={async () => { if (dirty && !await askConfirm({ title: 'Discard unsaved changes?', body: `Your changes to ${dest?.name} alert rules haven't been saved.`, confirmLabel: 'Discard', danger: true })) return; setDestId(String(d.id)) }}>
              <DestIcon type={d.type} size={28} />
              <span className="al-dest-text"><strong className="al-ellipsis">{d.name}</strong><small>{d.sync_count ? `${d.sync_count} sync${d.sync_count === 1 ? '' : 's'}` : 'No syncs yet'}</small></span>
            </button>
          ))}
          {!shown.length && <div className="dm-none">No destinations match.</div>}
        </div>
      </aside>
      <section className="card al-rules-main">
        {dest && (<>
          <header className="al-rules-head">
            <DestIcon type={dest.type} size={36} />
            <div className="grow">
              <h2>{dest.name}</h2>
              <div className="small muted">What to watch on syncs to {dest.name}, and who to tell. {readOnly && <span className="badge" style={{ marginLeft: 6 }}>View only</span>}</div>
            </div>
          </header>
          {policy.loading && !policy.data ? <SkeletonRows rows={5} cols={2} /> : (<>
            <h3 className="al-sub">Checks</h3>
            <TriggerEditor catalog={catalog.triggers} base={base} own={own} onChange={setOwn} readOnly={readOnly} baseName="the default" />
            <h3 className="al-sub">Who is notified</h3>
            <RoutingEditor recipients={relevant} value={routing} onChange={setRouting} readOnly={readOnly} inheritedText="Everyone whose scope includes this destination" />
          </>)}
        </>)}
        {dirty && !readOnly && (
          <div className="dm-savebar">
            <span>Unsaved changes to {dest?.name} alert rules</span><span className="grow" />
            <button className="btn ghost sm" onClick={() => { setOwn(policy.data!.own.triggers ?? {}); setRouting(policy.data!.own.recipient_ids ?? null) }} disabled={saving}>Discard</button>
            <button className="btn primary sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save rules'}</button>
          </div>
        )}
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

export default function Alerts() {
  const catalog = useAsync(() => api.get<Catalog>('/alerts/catalog'))
  const active = useAsync(() => api.get<AlertRow[]>('/alerts?status=active'))
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') ?? 'active') as Tab
  const setTab = (t: Tab) => setParams(t === 'active' ? {} : { tab: t }, { replace: true }) // each tab starts with clean filters
  useEffect(() => {
    const on = () => active.reload()
    window.addEventListener('alerts:changed', on)
    return () => window.removeEventListener('alerts:changed', on)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const live = (active.data ?? []).filter((a) => !a.muted)
  const crit = live.filter((a) => a.status === 'critical').length
  const TABS: { key: Tab; label: string; n?: number }[] = [
    { key: 'active', label: 'Active', n: live.length || undefined }, { key: 'history', label: 'History' },
    { key: 'recipients', label: 'Recipients' }, { key: 'rules', label: 'Rules' },
  ]
  return (
    <div className="page wide">
      <PageHead stage="activation" title="Alerts"
        subtitle={active.data ? (live.length ? <><strong className={crit ? 'al-hd-crit' : 'al-hd-warn'}>{crit ? `${crit} critical` : `${live.length} warning${live.length === 1 ? '' : 's'}`}</strong>{crit && live.length > crit ? ` and ${live.length - crit} warning${live.length - crit === 1 ? '' : 's'}` : ''} need attention. Fix the sync, or mute the alert while you work on it.</>
          : 'Nothing needs attention. Syncs are checked after every run and every five minutes.') : 'Problems with your syncs, who gets told, and what is watched.'} />
      <div className="tabs al-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}{t.n != null && <span className={`al-tab-n ${crit ? 'crit' : ''}`}>{t.n}</span>}
          </button>
        ))}
      </div>
      <ErrorBox error={catalog.error} />
      {tab === 'active' && <ActiveAlerts catalog={catalog.data ?? undefined} />}
      {tab === 'history' && <History catalog={catalog.data ?? undefined} />}
      {tab === 'recipients' && <Recipients catalog={catalog.data ?? undefined} reloadCatalog={catalog.reload} />}
      {tab === 'rules' && (catalog.data ? <DestinationRules catalog={catalog.data} /> : <SkeletonRows rows={4} cols={2} />)}
    </div>
  )
}
