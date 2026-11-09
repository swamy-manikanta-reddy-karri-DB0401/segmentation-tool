import { Link, useNavigate } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Audience, Overview } from '../api'
import { Empty, ErrorBox, PageHead, Spinner, useAsync } from '../components/ui'

export default function Audiences() {
  const nav = useNavigate()
  const { data, error, loading } = useAsync(() => api.get<Audience[]>('/audiences'))
  const overview = useAsync(() => api.get<Overview>('/overview'))
  const total = overview.data?.modeling.profiles ?? 0

  return (
    <div className="page">
      <PageHead stage="segmentation" title="Audiences" subtitle="Groups of people defined by who they are and what they do — built visually, counted live in Databricks."
        actions={<Link to="/audiences/new" className="btn primary">+ New audience</Link>} />
      <ErrorBox error={error} />
      <div className="card">
        {loading ? <div className="card-body"><Spinner label="Loading…" /></div> : data?.length ? (
          <table className="table aud-table">
            <thead><tr><th>Audience</th><th style={{ width: '30%' }}>Size</th><th>Syncs</th><th>Updated</th></tr></thead>
            <tbody>
              {data.map((a) => {
                const pct = total && a.last_size != null ? Math.min(100, (a.last_size / total) * 100) : null
                return (
                  <tr key={a.id} className="clickable" onClick={() => nav(`/audiences/${a.id}`)}>
                    <td>
                      <div className="row" style={{ gap: 12 }}>
                        <span className="aud-icon" aria-hidden="true">{a.name.slice(0, 1).toUpperCase()}</span>
                        <div className="grow">
                          <strong>{a.name}</strong>
                          {a.description && <div className="small muted">{a.description}</div>}
                          {a.parent_name && <div className="small faint">Built on {a.parent_name}</div>}
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="aud-size">
                        <span className="aud-n">{fmt.num(a.last_size)}</span>
                        {pct != null && <span className="small faint">{pct.toFixed(pct < 10 ? 1 : 0)}%</span>}
                      </div>
                      {pct != null && <div className="meter thin"><div style={{ width: `${Math.max(pct, 1.5)}%` }} /></div>}
                      {a.size_updated_at && <div className="small faint" style={{ marginTop: 4 }}>calculated {fmt.ago(a.size_updated_at)}</div>}
                    </td>
                    <td>{a.sync_count ? <span className="badge brand">{a.sync_count} sync{a.sync_count === 1 ? '' : 's'}</span> : <span className="faint">—</span>}</td>
                    <td className="muted">{fmt.ago(a.updated_at)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <Empty title="No audiences yet" action={<Link to="/audiences/new" className="btn primary">Build your first audience</Link>}>
            Combine attributes, traits and engagement events to find exactly the people you want to reach.
          </Empty>
        )}
      </div>
    </div>
  )
}
