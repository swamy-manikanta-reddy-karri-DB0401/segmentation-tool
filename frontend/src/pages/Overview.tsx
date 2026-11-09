import { Link } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Overview as OverviewData, SyncRun } from '../api'
import { ErrorBox, StatusBadge, useAsync } from '../components/ui'

type Status = 'ready' | 'attention' | 'empty'
interface StageCard {
  n: number | null; key: string; title: string; to: string; value: string; caption: string; status: Status; note: string; icon: string
}

const ICON = {
  source: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  schema: 'M6 3h4v4H6zM14 17h4v4h-4zM14 3h4v4h-4zM8 7v4a2 2 0 0 0 2 2h6v4M16 7v6',
  modeling: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  segmentation: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8',
  activation: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
}

function stages(o: OverviewData): StageCard[] {
  const a = o.activation
  const models = o.schema.parents + o.schema.related + o.schema.events
  return [
    {
      n: null, key: 'source', title: 'Source', to: '/sources', icon: ICON.source,
      value: fmt.compact(o.source.rows), caption: `rows in ${o.source.tables} table${o.source.tables === 1 ? '' : 's'}`,
      status: o.source.ok ? 'ready' : 'attention', note: o.source.ok ? `${o.source.connections} Databricks connection${o.source.connections === 1 ? '' : 's'}` : o.source.connections ? `${o.source.connections - o.source.connections_ok} connection(s) not reachable` : 'Add a connection',
    },
    {
      n: 1, key: 'schema', title: 'Schema', to: '/schema', icon: ICON.schema,
      value: String(models), caption: `model${models === 1 ? '' : 's'} · ${o.schema.events} event`,
      status: o.schema.parents ? 'ready' : 'empty', note: o.schema.parent_names.length ? `Parent: ${o.schema.parent_names.join(', ')}` : 'Choose a parent model',
    },
    {
      n: 2, key: 'modeling', title: 'Modeling', to: '/traits', icon: ICON.modeling,
      value: fmt.compact(o.modeling.profiles), caption: 'unified profiles',
      status: o.modeling.profiles ? 'ready' : 'empty', note: `${o.modeling.traits} computed trait${o.modeling.traits === 1 ? '' : 's'}`,
    },
    {
      n: 3, key: 'segmentation', title: 'Segmentation', to: '/audiences', icon: ICON.segmentation,
      value: String(o.segmentation.audiences), caption: `audience${o.segmentation.audiences === 1 ? '' : 's'}`,
      status: o.segmentation.audiences ? 'ready' : 'empty',
      note: o.segmentation.largest ? `Largest: ${o.segmentation.largest.name}` : 'Build your first audience',
    },
    {
      n: 4, key: 'activation', title: 'Activation', to: a.unconfigured.length ? '/destinations' : '/activations', icon: ICON.activation,
      value: String(a.syncs), caption: `sync${a.syncs === 1 ? '' : 's'} → ${a.destinations} destination${a.destinations === 1 ? '' : 's'}`,
      status: a.unconfigured.length ? 'attention' : a.syncs ? 'ready' : 'empty',
      note: a.unconfigured.length ? `${a.unconfigured.map((d) => d.name).join(', ')} needs credentials` : `${fmt.num(a.records_synced)} records delivered`,
    },
  ]
}

const STATUS_LABEL: Record<Status, string> = { ready: 'Ready', attention: 'Needs attention', empty: 'Not started' }

export default function Overview() {
  const overview = useAsync(() => api.get<OverviewData>('/overview'))
  const runs = useAsync(() => api.get<SyncRun[]>('/runs/recent'))
  const o = overview.data

  return (
    <div className="page overview">
      <section className="hero">
        <div className="hero-glow" aria-hidden="true" />
        <div className="hero-top">
          <div>
            <div className="hero-eyebrow">MediaMint · Customer Data Platform</div>
            <h1 className="hero-title">From your warehouse to every channel.</h1>
            <p className="hero-sub">Model customers directly in Databricks, build audiences without SQL, and keep every destination in sync — no data copied.</p>
          </div>
          <div className="hero-actions">
            <Link to="/audiences/new" className="btn primary">+ New audience</Link>
            <Link to="/profiles" className="btn hero-btn">Explore profiles</Link>
          </div>
        </div>
        <div className="pipeline">
          {o ? stages(o).map((s, i, all) => (
            <div key={s.key} className="pipe-cell">
              <Link to={s.to} className={`pipe-card ${s.status}`}>
                <div className="pipe-head">
                  <span className="pipe-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={s.icon} /></svg></span>
                  <span className="pipe-step">{s.n ? `Step ${s.n}` : 'Databricks'}</span>
                  <span className={`pipe-status ${s.status}`} title={STATUS_LABEL[s.status]} />
                </div>
                <div className="pipe-title">{s.title}</div>
                <div className="pipe-value">{s.value}</div>
                <div className="pipe-caption">{s.caption}</div>
                <div className="pipe-note">{s.note}</div>
              </Link>
              {i < all.length - 1 && <div className="pipe-arrow" aria-hidden="true"><span /></div>}
            </div>
          )) : Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="pipe-cell"><div className="pipe-card skeleton" />{i < 4 && <div className="pipe-arrow"><span /></div>}</div>
          ))}
        </div>
      </section>

      <ErrorBox error={overview.error && 'Overview data is not available yet. ' + overview.error} />

      {o && o.activation.unconfigured.length > 0 && (
        <div className="callout amber">
          <div className="callout-icon">!</div>
          <div className="grow">
            <strong>{o.activation.unconfigured.map((d) => d.name).join(', ')} {o.activation.unconfigured.length === 1 ? 'is' : 'are'} waiting for credentials</strong>
            <div className="small muted">Syncs are configured and ready. Add the API key and secret to start delivering audiences.</div>
          </div>
          <Link to="/destinations" className="btn sm">Add credentials</Link>
        </div>
      )}

      {o && (
        <div className="kpis">
          {[
            { label: 'Profiles', value: fmt.num(o.modeling.profiles), sub: o.schema.parent_names[0] ?? 'parent model', to: '/profiles' },
            { label: 'Computed traits', value: fmt.num(o.modeling.traits), sub: 'reusable values', to: '/traits' },
            { label: 'Audiences', value: fmt.num(o.segmentation.audiences), sub: o.segmentation.largest ? `largest ${fmt.num(o.segmentation.largest.size)}` : '—', to: '/audiences' },
            { label: 'Records delivered', value: fmt.num(o.activation.records_synced), sub: o.activation.last_run ? `last run ${fmt.ago(o.activation.last_run.started_at)}` : 'no runs yet', to: '/activations' },
          ].map((k) => (
            <Link key={k.label} to={k.to} className="card kpi">
              <div className="kpi-label">{k.label}</div>
              <div className="kpi-value">{k.value}</div>
              <div className="kpi-sub">{k.sub}</div>
            </Link>
          ))}
        </div>
      )}

      <div className="overview-grid">
        <div className="card">
          <div className="card-head"><h2>Recent activity</h2><Link to="/activations" className="small">All syncs →</Link></div>
          {runs.data?.length ? (
            <table className="table">
              <thead><tr><th>Sync</th><th>Status</th><th>Added</th><th>Updated</th><th>Removed</th><th>When</th></tr></thead>
              <tbody>
                {runs.data.slice(0, 6).map((r) => (
                  <tr key={r.id}>
                    <td><Link to={`/activations/${r.sync_id}`}>{r.sync_name}</Link></td>
                    <td><StatusBadge status={r.status} /></td>
                    <td>{fmt.num(r.added)}</td><td>{fmt.num(r.changed)}</td><td>{fmt.num(r.removed)}</td>
                    <td className="muted">{fmt.ago(r.started_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="empty"><h3>No sync runs yet</h3><p>Runs appear here once a destination is connected and a sync starts.</p></div>}
        </div>
        <div className="card card-pad stack">
          <h2>How it works</h2>
          {[
            ['Source', 'Your customer tables stay in Databricks. Nothing is copied.'],
            ['1 · Schema', 'Pick a parent model and connect related & event tables.'],
            ['2 · Modeling', 'Compute traits like lifetime engagement and see 360° profiles.'],
            ['3 · Segmentation', 'Build audiences visually with live counts.'],
            ['4 · Activation', 'Sync only the changes to Sailthru and other tools.'],
          ].map(([t, d]) => (
            <div key={t} className="how-row"><span className="how-dot" /><div><strong>{t}</strong><div className="small muted">{d}</div></div></div>
          ))}
        </div>
      </div>
    </div>
  )
}
