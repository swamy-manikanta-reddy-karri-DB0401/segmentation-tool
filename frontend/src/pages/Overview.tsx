import { Link } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Audience, Destination, Overview as OverviewData, Sync, SyncRun } from '../api'
import { DestIcon, ErrorBox, StatusBadge, useAsync } from '../components/ui'
import { useMe } from '../components/me'
import { SkeletonRows } from '../components/kit'
import { since } from '../components/alerting'
import type { AlertRow } from '../components/alerting'
import '../ux/home.css'

type Status = 'ready' | 'attention' | 'empty'
interface Stage { key: string; step: string; title: string; to: string; value: string; caption: string; status: Status; icon: string }

const ICON = {
  source: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  schema: 'M6 3h4v4H6zM14 17h4v4h-4zM14 3h4v4h-4zM8 7v4a2 2 0 0 0 2 2h6v4M16 7v6',
  modeling: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  segmentation: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8',
  activation: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
}
const plural = (n: number, w: string) => `${fmt.num(n)} ${w}${n === 1 ? '' : 's'}`

function stages(o: OverviewData): Stage[] {
  const a = o.activation
  const models = o.schema.parents + o.schema.related + o.schema.events
  return [
    { key: 'source', step: '', title: 'Source', to: '/sources', icon: ICON.source, value: fmt.compact(o.source.rows),
      caption: `rows · ${plural(o.source.tables, 'table')}`, status: o.source.ok ? 'ready' : 'attention' },
    { key: 'schema', step: '1', title: 'Schema', to: '/schema', icon: ICON.schema, value: String(models),
      caption: `models · ${o.schema.events} event`, status: o.schema.parents ? 'ready' : 'empty' },
    { key: 'modeling', step: '2', title: 'Modeling', to: '/profiles', icon: ICON.modeling, value: fmt.compact(o.modeling.profiles),
      caption: `profiles · ${plural(o.modeling.traits, 'trait')}`, status: o.modeling.profiles ? 'ready' : 'empty' },
    { key: 'segmentation', step: '3', title: 'Segmentation', to: '/audiences', icon: ICON.segmentation, value: String(o.segmentation.audiences),
      caption: o.segmentation.audiences === 1 ? 'audience' : 'audiences', status: o.segmentation.audiences ? 'ready' : 'empty' },
    { key: 'activation', step: '4', title: 'Activation', to: '/activations', icon: ICON.activation, value: fmt.compact(a.records_synced),
      caption: `records sent · ${plural(a.syncs, 'sync')}`, status: a.unconfigured.length ? 'attention' : a.syncs ? 'ready' : 'empty' },
  ]
}

type Tone = 'red' | 'amber' | 'blue' | 'gray'
interface Attention { key: string; tone: Tone; title: string; detail: string; action: string; to: string }

/** Everything that needs a person, worded for the person looking at it. */
function attention(syncs: Sync[], dests: Destination[], me: ReturnType<typeof useMe>, alerts: AlertRow[]): Attention[] {
  const email = me.me?.email ?? ''
  const out: Attention[] = []
  for (const s of syncs) {
    if (s.approval_status === 'pending' && s.can?.approve && s.submitted_by !== email) {
      out.push({ key: `p${s.id}`, tone: 'amber', title: `“${s.name}” is waiting for your approval`,
        detail: `Submitted by ${s.submitted_by || 'a builder'} · ${s.audience_name} → ${s.destination_name}`, action: 'Review', to: `/activations/${s.id}` })
    } else if (s.approval_status === 'rejected' && s.submitted_by === email) {
      out.push({ key: `r${s.id}`, tone: 'red', title: `Changes requested on “${s.name}”`,
        detail: s.review_note ? `“${s.review_note}” — ${s.approved_by}` : `Sent back by ${s.approved_by}`, action: 'Edit sync', to: `/activations/new?edit=${s.id}` })
    } else if (s.approval_status === 'pending' && s.submitted_by === email) {
      out.push({ key: `m${s.id}`, tone: 'blue', title: `“${s.name}” is waiting for approval`,
        detail: 'A Brand Marketing Admin needs to approve it before it runs.', action: 'View', to: `/activations/${s.id}` })
    }
    if (s.last_status === 'failed' || s.last_status === 'error') {
      out.push({ key: `f${s.id}`, tone: 'red', title: `The last run of “${s.name}” failed`,
        detail: `${s.audience_name} → ${s.destination_name}${s.last_run_at ? ` · ${fmt.ago(s.last_run_at)}` : ''}`, action: 'See what happened', to: `/activations/${s.id}` })
    } else if (s.last_status === 'completed_with_errors' || s.last_status === 'partial') {
      out.push({ key: `w${s.id}`, tone: 'amber', title: `Some records in “${s.name}” were rejected`,
        detail: `${s.destination_name} refused part of the last run; they'll be retried.`, action: 'See rejected records', to: `/activations/${s.id}` })
    }
    if (!s.enabled && s.approval_status === 'approved') {
      out.push({ key: `z${s.id}`, tone: 'gray', title: `“${s.name}” is paused`, detail: 'It won’t run on its schedule until resumed.', action: 'Open', to: `/activations/${s.id}` })
    }
  }
  for (const d of dests) {
    if (d.configured !== false) continue
    const waiting = syncs.filter((s) => s.destination_id === d.id).length
    const can = me.can('destinations.manage', d.brand_id)
    out.push({ key: `d${d.id}`, tone: 'amber', title: `${d.name} needs credentials`,
      detail: `${waiting ? `${plural(waiting, 'sync')} ready and waiting. ` : ''}Missing: ${(d.missing_fields ?? []).join(', ') || 'credentials'}.${can ? '' : ' Ask a Brand Marketing Admin to add them.'}`,
      action: can ? 'Add credentials' : 'View', to: '/destinations' })
  }
  // active alerts (not muted); they replace the plain "failed" / "rejected" items for the same sync
  for (const a of alerts) {
    if (a.muted) continue
    const dup = a.trigger === 'fatal' ? `f${a.sync_id}` : a.trigger === 'rejected' ? `w${a.sync_id}` : null
    const i = dup ? out.findIndex((x) => x.key === dup) : -1
    const item: Attention = { key: `a${a.id}`, tone: a.status === 'critical' ? 'red' : 'amber',
      title: `${a.label} on “${a.sync_name}”`, detail: `${a.message || a.label} · open for ${since(a.opened_at)}`, action: 'Open alert', to: `/activations/${a.sync_id}#alerts` }
    if (i >= 0) out[i] = item
    else out.push(item)
  }
  const rank: Record<Tone, number> = { red: 0, amber: 1, blue: 2, gray: 3 }
  return out.sort((a, b) => rank[a.tone] - rank[b.tone])
}

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export default function Overview() {
  const me = useMe()
  const overview = useAsync(() => api.get<OverviewData>('/overview'))
  const syncs = useAsync(() => api.get<Sync[]>('/syncs'))
  const dests = useAsync(() => api.get<Destination[]>('/destinations'))
  const audiences = useAsync(() => api.get<Audience[]>('/audiences'))
  const runs = useAsync(() => api.get<SyncRun[]>('/runs/recent'))
  const alerts = useAsync(() => api.get<AlertRow[]>('/alerts?status=active').catch(() => [] as AlertRow[]))
  const o = overview.data
  const items = syncs.data && dests.data && alerts.data ? attention(syncs.data, dests.data, me, alerts.data) : null
  const first = (me.me?.name || '').split(/[\s.@]/)[0]
  const name = first && first.toLowerCase() !== 'you' ? first[0].toUpperCase() + first.slice(1) : ''
  const recentAud = [...(audiences.data ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5)

  const steps = o ? [
    { done: o.source.ok, label: 'Connect Databricks', to: '/sources' },
    { done: o.schema.parents > 0, label: 'Choose a parent model', to: '/schema' },
    { done: o.schema.events + o.schema.related > 0, label: 'Link behavior (events or related data)', to: '/schema' },
    { done: o.segmentation.audiences > 0, label: 'Build an audience', to: '/audiences/new' },
    { done: o.activation.configured_destinations > 0, label: 'Connect a destination', to: '/destinations' },
    { done: o.activation.records_synced > 0, label: 'Deliver your first sync', to: '/activations' },
  ] : []
  const done = steps.filter((s) => s.done).length

  return (
    <div className="page hm">
      <header className="hm-head">
        <div>
          <div className="hm-date">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
          <h1>{greeting()}{name ? `, ${name}` : ''}</h1>
          <p className="muted">{me.roleLabel}{me.me && !me.me.platform_admin && me.me.brands.length ? ` · ${me.me.brands.map((b) => b.name).join(', ')}` : ''}</p>
        </div>
        <div className="hm-actions">
          <button className="btn" onClick={() => window.dispatchEvent(new Event('quickfind:open'))} title="Find anything (Ctrl / ⌘ + K)">
            Find <kbd className="hm-kbd">Ctrl K</kbd>
          </button>
          {me.can('syncs.edit') && <Link to="/activations/new" className="btn">+ New sync</Link>}
          {me.can('audiences.edit') && <Link to="/audiences/new" className="btn primary">+ New audience</Link>}
        </div>
      </header>

      <ErrorBox error={overview.error && 'Overview data is not available yet. ' + overview.error} />

      <nav className="hm-pipe" aria-label="Pipeline">
        {(o ? stages(o) : Array.from({ length: 5 }, () => null)).map((s, i) => s ? (
          <Link key={s.key} to={s.to} className={`hm-stage ${s.status}`}>
            <span className="hm-stage-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={s.icon} /></svg></span>
            <span className="hm-stage-text">
              <span className="hm-stage-step">{s.step ? `${s.step} · ` : ''}{s.title}<i className={`hm-dot ${s.status}`} title={s.status === 'ready' ? 'Ready' : s.status === 'attention' ? 'Needs attention' : 'Not started'} /></span>
              <span className="hm-stage-val"><strong>{s.value}</strong> {s.caption}</span>
            </span>
          </Link>
        ) : <div key={i} className="hm-stage hm-skel" />)}
      </nav>

      <div className="hm-grid">
        <div className="hm-col">
          <section className="card">
            <div className="card-head">
              <div><h2>Needs your attention</h2><div className="small muted">Alerts, approvals and setup gaps — most urgent first.</div></div>
              {items && items.length > 0 && <span className="badge amber">{items.length}</span>}
            </div>
            {!items ? <div className="card-body"><SkeletonRows rows={3} cols={2} /></div>
              : items.length === 0 ? (
                <div className="hm-clear">
                  <span className="hm-clear-icon" aria-hidden="true">✓</span>
                  <div><strong>All clear</strong><div className="small muted">No active alerts, no approvals waiting, every destination is connected.</div></div>
                </div>
              ) : (
                <ul className="hm-att">
                  {items.slice(0, 8).map((a, i) => (
                    <li key={a.key} className={`hm-att-item ${a.tone}`}>
                      <span className="hm-att-bar" aria-hidden="true" />
                      <div className="grow">
                        <div className="hm-att-title">{a.title}</div>
                        <div className="small muted hm-att-detail">{a.detail}</div>
                      </div>
                      <Link to={a.to} className={`btn sm ${i === 0 && (a.tone === 'red' || a.tone === 'amber') ? 'primary' : ''}`}>{a.action}</Link>
                    </li>
                  ))}
                  {items.length > 8 && <li className="hm-att-more"><Link to="/activations">{items.length - 8} more in Syncs →</Link></li>}
                </ul>
              )}
          </section>

          <section className="card">
            <div className="card-head"><h2>Recent activity</h2><Link to="/activations" className="small">All syncs →</Link></div>
            {runs.loading && !runs.data ? <div className="card-body"><SkeletonRows rows={4} cols={4} /></div>
              : runs.data?.length ? (
                <ul className="hm-runs">
                  {runs.data.slice(0, 7).map((r) => (
                    <li key={r.id}>
                      <Link to={`/activations/${r.sync_id}`} className="hm-run">
                        <StatusBadge status={r.status} />
                        <span className="grow hm-run-name">{r.sync_name}</span>
                        <span className="hm-run-delta"><b className="add">+{fmt.num(r.added)}</b><b>~{fmt.num(r.changed)}</b><b className="rem">−{fmt.num(r.removed)}</b></span>
                        <span className="small muted hm-run-when">{fmt.ago(r.started_at)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="hm-quiet">
                  <strong>No deliveries yet</strong>
                  <span className="small muted">Each sync run appears here with who was added, updated and removed.</span>
                </div>
              )}
          </section>
        </div>

        <aside className="hm-col">
          {o && done < steps.length && (
            <section className="card card-pad hm-setup">
              <div className="spread"><h2>Getting set up</h2><span className="small muted">{done} of {steps.length}</span></div>
              <div className="meter" aria-hidden="true"><div style={{ width: `${(done / steps.length) * 100}%` }} /></div>
              <ol>
                {steps.map((s) => (
                  <li key={s.label} className={s.done ? 'done' : ''}>
                    <span className="hm-check" aria-hidden="true">{s.done ? '✓' : ''}</span>
                    {s.done ? <span>{s.label}</span> : <Link to={s.to}>{s.label}</Link>}
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section className="card">
            <div className="card-head"><h2>Recently updated audiences</h2><Link to="/audiences" className="small">All →</Link></div>
            {audiences.loading && !audiences.data ? <div className="card-body"><SkeletonRows rows={3} cols={2} /></div>
              : recentAud.length ? (
                <ul className="hm-aud">
                  {recentAud.map((a) => (
                    <li key={a.id}>
                      <Link to={`/audiences/${a.id}`} className="hm-aud-row">
                        <span className="hm-aud-icon" aria-hidden="true">{a.name.slice(0, 1).toUpperCase()}</span>
                        <span className="grow" style={{ minWidth: 0 }}>
                          <strong className="hm-ellipsis">{a.name}</strong>
                          <span className="small muted hm-ellipsis">{a.parent_name ?? 'Audience'}{a.sync_count ? ` · ${plural(a.sync_count, 'sync')}` : ' · not synced yet'}</span>
                        </span>
                        <span className="hm-aud-size">
                          <strong>{a.last_size != null ? fmt.compact(a.last_size) : '—'}</strong>
                          <span className="small muted">{fmt.ago(a.updated_at)}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="hm-quiet">
                  <strong>No audiences yet</strong>
                  {me.can('audiences.edit') ? <Link to="/audiences/new" className="btn sm primary" style={{ alignSelf: 'flex-start' }}>Build your first audience</Link>
                    : <span className="small muted">Builders on your brand will create them here.</span>}
                </div>
              )}
          </section>

          {dests.data && dests.data.length > 0 && (
            <section className="card">
              <div className="card-head"><h2>Destinations</h2><Link to="/destinations" className="small">Manage →</Link></div>
              <ul className="hm-dests">
                {dests.data.slice(0, 5).map((d) => (
                  <li key={d.id}>
                    <DestIcon type={d.type} size={28} />
                    <span className="grow hm-ellipsis">{d.name}</span>
                    {d.configured === false ? <span className="badge amber">Needs credentials</span> : <span className="badge green"><span className="dot" />Connected</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}
