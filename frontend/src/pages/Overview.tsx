import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Audience, Destination, Overview as OverviewData, Sync, SyncRun } from '../api'
import { DestIcon, ErrorBox, StatusBadge, useAsync } from '../components/ui'
import { useMe } from '../components/me'
import { SkeletonRows } from '../components/kit'
import { RunsChart, Sparkline } from '../components/viz'
import type { RunBar } from '../components/viz'
import { since } from '../components/alerting'
import type { AlertRow } from '../components/alerting'
import '../ux/home.css'

type Status = 'ready' | 'attention' | 'idle'
interface Stage { key: string; step: string; title: string; to: string; value: string; caption: string; status: Status; icon: string; spark?: { x: string; y: number }[] }

const ICON = {
  source: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  schema: 'M6 3h4v4H6zM14 17h4v4h-4zM14 3h4v4h-4zM8 7v4a2 2 0 0 0 2 2h6v4M16 7v6',
  modeling: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  segmentation: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8',
  activation: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
}
const plural = (n: number, w: string) => `${fmt.num(n)} ${w}${n === 1 ? '' : 's'}`
const total = (r: SyncRun) => (r.added || 0) + (r.changed || 0) + (r.removed || 0)
const DAYS = 14

/** Records delivered per day for the last two weeks — real runs only. */
function dailySeries(runs: SyncRun[]) {
  const out: { x: string; y: number }[] = []
  const today = new Date(); today.setHours(0, 0, 0, 0)
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i)
    const next = new Date(d); next.setDate(next.getDate() + 1)
    const y = runs.filter((r) => { const t = new Date(r.started_at); return t >= d && t < next }).reduce((a, r) => a + total(r), 0)
    out.push({ x: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), y })
  }
  return out
}

function stages(o: OverviewData, syncs: Sync[] | undefined, spark: { x: string; y: number }[] | null): Stage[] {
  const a = o.activation
  const models = o.schema.parents + o.schema.related + o.schema.events
  const healthy = (syncs ?? []).filter((s) => s.approval_status === 'approved' && s.enabled && s.destination_configured !== false
    && !['failed', 'error'].includes(s.last_status ?? '') && !(s.alert_count ?? 0)).length
  return [
    { key: 'source', step: 'Source', title: 'Databricks', to: '/sources', icon: ICON.source, value: fmt.compact(o.source.rows),
      caption: `rows in ${plural(o.source.tables, 'table')}`, status: o.source.ok ? 'ready' : 'attention' },
    { key: 'schema', step: '1 · Schema', title: 'Data model', to: '/schema', icon: ICON.schema, value: String(models),
      caption: `models · ${plural(o.schema.events, 'event')}`, status: o.schema.parents ? 'ready' : 'idle' },
    { key: 'modeling', step: '2 · Modeling', title: 'Profiles', to: '/profiles', icon: ICON.modeling, value: fmt.compact(o.modeling.profiles),
      caption: `people · ${plural(o.modeling.traits, 'trait')}`, status: o.modeling.profiles ? 'ready' : 'idle' },
    { key: 'segmentation', step: '3 · Segmentation', title: 'Audiences', to: '/audiences', icon: ICON.segmentation, value: String(o.segmentation.audiences),
      caption: o.segmentation.largest ? `largest ${fmt.compact(o.segmentation.largest.size)} people` : 'none built yet', status: o.segmentation.audiences ? 'ready' : 'idle' },
    { key: 'activation', step: '4 · Activation', title: 'Delivered', to: '/activations', icon: ICON.activation, value: fmt.compact(a.records_synced),
      caption: a.syncs ? `records · ${healthy} of ${plural(a.syncs, 'sync')} healthy` : 'records · no syncs yet',
      status: a.unconfigured.length ? 'attention' : a.syncs ? 'ready' : 'idle', spark: spark && spark.some((p) => p.y > 0) ? spark : undefined },
  ]
}

type Tone = 'red' | 'amber' | 'blue' | 'gray'
interface Attention { key: string; tone: Tone; kind: string; title: string; detail: string; action: string; to: string }

/** Everything that needs a person, worded for the person looking at it. */
function attention(syncs: Sync[], dests: Destination[], me: ReturnType<typeof useMe>, alerts: AlertRow[]): Attention[] {
  const email = me.me?.email ?? ''
  const out: Attention[] = []
  for (const s of syncs) {
    if (s.approval_status === 'pending' && s.can?.approve && s.submitted_by !== email) {
      out.push({ key: `p${s.id}`, tone: 'amber', kind: 'Approval', title: `“${s.name}” is waiting for your approval`,
        detail: `Submitted by ${s.submitted_by || 'a builder'} · ${s.audience_name} → ${s.destination_name}`, action: 'Review', to: `/activations/${s.id}` })
    } else if (s.approval_status === 'rejected' && s.submitted_by === email) {
      out.push({ key: `r${s.id}`, tone: 'red', kind: 'Sent back', title: `Changes requested on “${s.name}”`,
        detail: s.review_note ? `“${s.review_note}” — ${s.approved_by}` : `Sent back by ${s.approved_by}`, action: 'Edit sync', to: `/activations/new?edit=${s.id}` })
    } else if (s.approval_status === 'pending' && s.submitted_by === email) {
      out.push({ key: `m${s.id}`, tone: 'blue', kind: 'Pending', title: `“${s.name}” is waiting for approval`,
        detail: 'A Brand Marketing Admin needs to approve it before it runs.', action: 'View', to: `/activations/${s.id}` })
    }
    if (s.last_status === 'failed' || s.last_status === 'error') {
      out.push({ key: `f${s.id}`, tone: 'red', kind: 'Failed', title: `The last run of “${s.name}” failed`,
        detail: `${s.audience_name} → ${s.destination_name}${s.last_run_at ? ` · ${fmt.ago(s.last_run_at)}` : ''}`, action: 'See what happened', to: `/activations/${s.id}` })
    } else if (s.last_status === 'completed_with_errors' || s.last_status === 'partial') {
      out.push({ key: `w${s.id}`, tone: 'amber', kind: 'Rejected', title: `Some records in “${s.name}” were rejected`,
        detail: `${s.destination_name} refused part of the last run; they'll be retried.`, action: 'See rejected records', to: `/activations/${s.id}` })
    }
    if (!s.enabled && s.approval_status === 'approved') {
      out.push({ key: `z${s.id}`, tone: 'gray', kind: 'Paused', title: `“${s.name}” is paused`, detail: 'It won’t run on its schedule until resumed.', action: 'Open', to: `/activations/${s.id}` })
    }
  }
  for (const d of dests) {
    if (d.configured !== false) continue
    const waiting = syncs.filter((s) => s.destination_id === d.id).length
    const can = me.can('destinations.manage', d.brand_id)
    out.push({ key: `d${d.id}`, tone: 'amber', kind: 'Setup', title: `${d.name} needs credentials`,
      detail: `${waiting ? `${plural(waiting, 'sync')} ready and waiting. ` : ''}Missing: ${(d.missing_fields ?? []).join(', ') || 'credentials'}.${can ? '' : ' Ask a Brand Marketing Admin to add them.'}`,
      action: can ? 'Add credentials' : 'View', to: `/destinations?dest=${d.id}` })
  }
  // active alerts (not muted) replace the plain "failed" / "rejected" items for the same sync
  for (const a of alerts) {
    if (a.muted) continue
    const dup = a.trigger === 'fatal' ? `f${a.sync_id}` : a.trigger === 'rejected' ? `w${a.sync_id}` : null
    const i = dup ? out.findIndex((x) => x.key === dup) : -1
    const item: Attention = { key: `a${a.id}`, tone: a.status === 'critical' ? 'red' : 'amber', kind: a.status === 'critical' ? 'Critical' : 'Alert',
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

function Icon({ d }: { d: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
}

/** Placeholder bars that show where deliveries will appear — clearly a placeholder, never fake numbers. */
function EmptyChart({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="hm-empty-chart">
      <div className="hm-ghost-bars" aria-hidden="true">{[38, 62, 45, 80, 55, 70, 40, 66, 52, 74].map((h, i) => <span key={i} style={{ height: `${h}%` }} />)}</div>
      <div className="hm-empty-text"><strong>{title}</strong><span>{children}</span></div>
    </div>
  )
}

export default function Overview() {
  const me = useMe()
  const overview = useAsync(() => api.get<OverviewData>('/overview'))
  const syncs = useAsync(() => api.get<Sync[]>('/syncs'))
  const dests = useAsync(() => api.get<Destination[]>('/destinations'))
  const audiences = useAsync(() => api.get<Audience[]>('/audiences'))
  const alerts = useAsync(() => api.get<AlertRow[]>('/alerts?status=active').catch(() => [] as AlertRow[]))
  // every sync's own run history (up to 50 each) — the real time series behind the chart and sparkline
  const runs = useAsync(async () => {
    const list = syncs.data
    if (!list) return undefined
    const all = await Promise.all(list.slice(0, 25).map((s) => api.get<SyncRun[]>(`/syncs/${s.id}/runs`).then((rs) => rs.map((r) => ({ ...r, sync_name: s.name }))).catch(() => [])))
    return all.flat().filter((r) => r.status !== 'running').sort((a, b) => a.started_at.localeCompare(b.started_at))
  }, [syncs.data])

  const o = overview.data
  const items = syncs.data && dests.data && alerts.data ? attention(syncs.data, dests.data, me, alerts.data) : null
  const first = (me.me?.name || '').split(/[\s.@]/)[0]
  const name = first && first.toLowerCase() !== 'you' ? first[0].toUpperCase() + first.slice(1) : ''
  const recentAud = [...(audiences.data ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5)
  const spark = useMemo(() => (runs.data ? dailySeries(runs.data) : null), [runs.data])
  const bars: RunBar[] = useMemo(() => (runs.data ?? []).slice(-24).map((r) => ({
    id: `${r.sync_id}-${r.id}`, label: (r as SyncRun & { sync_name: string }).sync_name, when: new Date(r.started_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    added: r.added || 0, changed: r.changed || 0, removed: r.removed || 0, failed: r.failed || 0, status: r.status,
  })), [runs.data])
  const latest = [...(runs.data ?? [])].reverse().slice(0, 5)
  const delivered14 = spark?.reduce((a, p) => a + p.y, 0) ?? 0

  const steps = o ? [
    { done: o.source.ok, label: 'Connect Databricks', to: '/sources' },
    { done: o.schema.parents > 0, label: 'Choose a parent model', to: '/schema' },
    { done: o.schema.events + o.schema.related > 0, label: 'Link behavior data', to: '/schema' },
    { done: o.segmentation.audiences > 0, label: 'Build an audience', to: '/audiences/new' },
    { done: o.activation.configured_destinations > 0, label: 'Connect a destination', to: '/destinations' },
    { done: o.activation.records_synced > 0, label: 'Deliver your first sync', to: '/activations' },
  ] : []
  const done = steps.filter((s) => s.done).length
  const brands = me.me && !me.me.platform_admin && me.me.brands.length ? me.me.brands.map((b) => b.name).join(', ') : ''

  return (
    <div className="page wide hm">
      <header className="hm-head">
        <div>
          <div className="hm-date">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
          <h1>{greeting()}{name ? `, ${name}` : ''}</h1>
          <p className="hm-role">
            {me.roleLabel && <span className="hm-role-chip">{me.roleLabel}</span>}
            {brands && <span className="muted">{brands}</span>}
            {items && <span className="muted">{items.length ? `${plural(items.length, 'thing')} need${items.length === 1 ? 's' : ''} attention` : 'Everything is running smoothly'}</span>}
          </p>
        </div>
        <div className="hm-actions">
          <button className="btn" onClick={() => window.dispatchEvent(new Event('quickfind:open'))} title="Find anything (Ctrl / ⌘ + K)">
            <svg className="hm-find" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            Find <kbd className="hm-kbd">Ctrl K</kbd>
          </button>
          {me.can('syncs.edit') && <Link to="/activations/new" className="btn">New sync</Link>}
          {me.can('audiences.edit') && <Link to="/audiences/new" className="btn primary">+ New audience</Link>}
        </div>
      </header>

      <ErrorBox error={overview.error && 'Overview data is not available yet. ' + overview.error} />

      <nav className="hm-pipe" aria-label="Pipeline: from your warehouse to every channel">
        {(o ? stages(o, syncs.data, spark) : Array.from({ length: 5 }, () => null)).map((s, i) => s ? (
          <Link key={s.key} to={s.to} className={`hm-stage ${s.status}`}>
            <div className="hm-stage-top">
              <span className="hm-stage-icon"><Icon d={s.icon} /></span>
              <span className="hm-stage-step">{s.step}</span>
              <i className={`hm-dot ${s.status}`} title={s.status === 'ready' ? 'Ready' : s.status === 'attention' ? 'Needs attention' : 'Not started'} />
            </div>
            <div className="hm-stage-title">{s.title}</div>
            <div className="hm-stage-val"><strong>{s.value}</strong></div>
            <div className="hm-stage-cap">{s.caption}</div>
            {s.spark && <div className="hm-stage-spark"><Sparkline points={s.spark} height={28} label="Records delivered per day, last 14 days" /></div>}
          </Link>
        ) : (
          <div key={i} className="hm-stage hm-skel" aria-busy="true" aria-label="Loading">
            <span className="hm-skel-bar w40" /><span className="hm-skel-bar w60" /><span className="hm-skel-bar big" /><span className="hm-skel-bar w70" />
          </div>
        ))}
      </nav>

      <div className="hm-grid">
        <div className="hm-col">
          <section className="card hm-card">
            <div className="hm-card-head">
              <div><h2>Needs your attention</h2><p>Alerts, approvals and setup gaps — most urgent first.</p></div>
              {items && items.length > 0 && <span className="hm-count">{items.length}</span>}
            </div>
            {!items ? <div className="hm-pad"><SkeletonRows rows={3} cols={2} /></div>
              : items.length === 0 ? (
                <div className="hm-clear">
                  <span className="hm-clear-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>
                  <div><strong>All clear</strong><div className="small muted">No active alerts, no approvals waiting and every destination is connected.</div></div>
                </div>
              ) : (
                <ul className="hm-att">
                  {items.slice(0, 7).map((a, i) => (
                    <li key={a.key} className={`hm-att-item ${a.tone}`}>
                      <span className={`hm-att-kind ${a.tone}`}>{a.kind}</span>
                      <div className="hm-att-main">
                        <div className="hm-att-title">{a.title}</div>
                        <div className="hm-att-detail">{a.detail}</div>
                      </div>
                      <Link to={a.to} className={`btn sm ${i === 0 && (a.tone === 'red' || a.tone === 'amber') ? 'primary' : ''}`}>{a.action}</Link>
                    </li>
                  ))}
                  {items.length > 7 && <li className="hm-att-more"><Link to="/activations">{items.length - 7} more in Syncs →</Link></li>}
                </ul>
              )}
          </section>

          <section className="card hm-card">
            <div className="hm-card-head">
              <div>
                <h2>Deliveries</h2>
                <p>{runs.data?.length ? `${fmt.num(delivered14)} records sent in the last ${DAYS} days · each bar is one run` : 'Records added, updated and removed in your marketing tools, run by run.'}</p>
              </div>
              <Link to="/activations" className="hm-link">All syncs →</Link>
            </div>
            <div className="hm-pad">
              {runs.loading && !runs.data ? <SkeletonRows rows={4} cols={4} />
                : bars.length ? <RunsChart runs={bars} height={190} />
                  : <EmptyChart title="No deliveries yet">Every sync run will appear here with how many people were added, updated and removed{o?.activation.unconfigured.length ? ' — connect a destination to send the first one.' : '.'}</EmptyChart>}
            </div>
            {latest.length > 0 && (
              <ul className="hm-runs" aria-label="Latest runs">
                {latest.map((r) => (
                  <li key={`${r.sync_id}-${r.id}`}>
                    <Link to={`/activations/${r.sync_id}`} className="hm-run">
                      <StatusBadge status={r.status} />
                      <span className="hm-run-name">{(r as SyncRun & { sync_name: string }).sync_name}</span>
                      <span className="hm-run-delta"><b className="s1">+{fmt.num(r.added)}</b><b className="s2">~{fmt.num(r.changed)}</b><b className="s3">−{fmt.num(r.removed)}</b></span>
                      <span className="hm-run-when">{fmt.ago(r.started_at)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="hm-col">
          {o && done < steps.length && (
            <section className="card hm-card hm-setup">
              <div className="hm-card-head">
                <div><h2>Getting set up</h2><p>{done} of {steps.length} steps done</p></div>
                <span className="hm-ring" style={{ ['--p' as string]: `${(done / steps.length) * 100}%` }} aria-hidden="true"><b>{done}/{steps.length}</b></span>
              </div>
              <ol>
                {steps.map((s) => (
                  <li key={s.label} className={s.done ? 'done' : ''}>
                    <span className="hm-check" aria-hidden="true">{s.done && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}</span>
                    {s.done ? <span>{s.label}</span> : <Link to={s.to}>{s.label} →</Link>}
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section className="card hm-card">
            <div className="hm-card-head"><div><h2>Recent audiences</h2></div><Link to="/audiences" className="hm-link">All →</Link></div>
            {audiences.loading && !audiences.data ? <div className="hm-pad"><SkeletonRows rows={3} cols={2} /></div>
              : recentAud.length ? (
                <ul className="hm-list">
                  {recentAud.map((a) => (
                    <li key={a.id}>
                      <Link to={`/audiences/${a.id}`} className="hm-row">
                        <span className="hm-row-icon" aria-hidden="true"><Icon d={ICON.segmentation} /></span>
                        <span className="hm-row-main">
                          <strong>{a.name}</strong>
                          <span>{a.sync_count ? `In ${plural(a.sync_count, 'sync')}` : 'Not sent anywhere yet'} · {fmt.ago(a.updated_at)}</span>
                        </span>
                        <span className="hm-row-num"><strong>{a.last_size != null ? fmt.compact(a.last_size) : '—'}</strong><span>people</span></span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="hm-quiet">
                  <strong>No audiences yet</strong>
                  {me.can('audiences.edit') ? <Link to="/audiences/new" className="btn sm primary">Build your first audience</Link>
                    : <span className="small muted">Builders on your brand will create them here.</span>}
                </div>
              )}
          </section>

          {dests.data && dests.data.length > 0 && (
            <section className="card hm-card">
              <div className="hm-card-head"><div><h2>Destinations</h2></div><Link to="/destinations" className="hm-link">Manage →</Link></div>
              <ul className="hm-list">
                {dests.data.slice(0, 6).map((d) => {
                  const n = (syncs.data ?? []).filter((s) => s.destination_id === d.id).length
                  return (
                    <li key={d.id}>
                      <Link to={`/destinations?dest=${d.id}`} className="hm-row">
                        <DestIcon type={d.type} size={32} />
                        <span className="hm-row-main"><strong>{d.name}</strong><span>{n ? plural(n, 'sync') : 'No syncs yet'}</span></span>
                        {d.configured === false
                          ? <span className="hm-pill amber"><i />Needs credentials</span>
                          : <span className="hm-pill green"><i />Connected</span>}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}
