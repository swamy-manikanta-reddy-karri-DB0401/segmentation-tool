import { Link, useNavigate } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Sync } from '../api'
import { scheduleLabel } from '../components/ScheduleEditor'
import { DestIcon, Empty, ErrorBox, PageHead, Spinner, StatusBadge, usePolling, useAsync, WaitingBadge } from '../components/ui'

export default function Activations() {
  const nav = useNavigate()
  const syncs = useAsync(() => api.get<Sync[]>('/syncs'))
  usePolling(syncs.reload, 4000, !!syncs.data?.some((s) => s.running))
  const waiting = syncs.data?.filter((s) => s.destination_configured === false) ?? []
  return (
    <div className="page">
      <PageHead stage="activation" title="Syncs" subtitle="Audiences kept up to date in your destinations. Each run sends only what changed."
        actions={<Link to="/activations/new" className="btn primary">+ New sync</Link>} />
      <ErrorBox error={syncs.error} />
      {waiting.length > 0 && (
        <div className="callout amber" style={{ marginBottom: 16 }}>
          <div className="callout-icon">!</div>
          <div className="grow">
            <strong>{waiting.length} sync{waiting.length === 1 ? ' is' : 's are'} waiting for destination credentials</strong>
            <div className="small muted">They're fully configured and will start as soon as you add the API key and secret.</div>
          </div>
          <Link to="/destinations" className="btn sm">Add credentials</Link>
        </div>
      )}
      <div className="card">
        {syncs.loading && !syncs.data ? <div className="card-body"><Spinner /></div> : syncs.data?.length ? (
          <table className="table">
            <thead><tr><th>Sync</th><th>Audience</th><th>Destination</th><th>Schedule</th><th>Status</th><th>Last run</th></tr></thead>
            <tbody>
              {syncs.data.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => nav(`/activations/${s.id}`)}>
                  <td><strong>{s.name}</strong>{!s.enabled && <span className="badge" style={{ marginLeft: 6 }}>Paused</span>}</td>
                  <td>{s.audience_name}</td>
                  <td><div className="row"><DestIcon type={s.destination_type} size={24} />{s.destination_name}</div></td>
                  <td className="muted">{scheduleLabel(s.schedule)}</td>
                  <td>{s.destination_configured === false ? <WaitingBadge /> : <StatusBadge status={s.last_status} running={s.running} />}</td>
                  <td className="muted">{fmt.ago(s.last_run_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="Nothing activated yet" action={<Link to="/activations/new" className="btn primary">Activate an audience</Link>}>
            Pick an audience and a destination. We'll keep the destination in sync automatically.
          </Empty>
        )}
      </div>
    </div>
  )
}
