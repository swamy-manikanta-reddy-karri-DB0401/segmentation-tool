import { Link, useNavigate } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Sync } from '../api'
import { scheduleLabel } from '../components/ScheduleEditor'
import { ApprovalBadge, DestIcon, Empty, ErrorBox, PageHead, Spinner, StatusBadge, usePolling, useAsync, WaitingBadge } from '../components/ui'
import { useMe } from '../components/me'

export default function Activations() {
  const nav = useNavigate()
  const syncs = useAsync(() => api.get<Sync[]>('/syncs'))
  usePolling(syncs.reload, 4000, !!syncs.data?.some((s) => s.running))
  const { can } = useMe()
  const waiting = syncs.data?.filter((s) => s.destination_configured === false) ?? []
  const toReview = syncs.data?.filter((s) => s.approval_status === 'pending' && s.can?.approve) ?? []
  const canCreate = can('syncs.edit')
  return (
    <div className="page">
      <PageHead stage="activation" title="Syncs" subtitle="Audiences kept up to date in your destinations. Each run sends only what changed."
        actions={canCreate ? <Link to="/activations/new" className="btn primary">+ New sync</Link> : undefined} />
      <ErrorBox error={syncs.error} />
      {toReview.length > 0 && (
        <div className="callout amber" style={{ marginBottom: 16 }}>
          <div className="callout-icon">✓</div>
          <div className="grow">
            <strong>{toReview.length} sync{toReview.length === 1 ? ' is' : 's are'} waiting for your approval</strong>
            <div className="small muted">Nothing is sent until an admin approves it. Open a sync to review and approve or send it back.</div>
          </div>
          <Link to={`/activations/${toReview[0].id}`} className="btn sm primary">Review</Link>
        </div>
      )}
      {waiting.length > 0 && (
        <div className="callout amber" style={{ marginBottom: 16 }}>
          <div className="callout-icon">!</div>
          <div className="grow">
            <strong>{waiting.length} sync{waiting.length === 1 ? ' is' : 's are'} waiting for destination credentials</strong>
            <div className="small muted">They're fully configured and will start as soon as you add the API key and secret.</div>
          </div>
          {can('destinations.manage') && <Link to="/destinations" className="btn sm">Add credentials</Link>}
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
                  <td>
                    <div className="row wrap" style={{ gap: 4 }}>
                      {s.approval_status !== 'approved' ? <ApprovalBadge status={s.approval_status} />
                        : s.destination_configured === false ? <WaitingBadge /> : <StatusBadge status={s.last_status} running={s.running} />}
                    </div>
                  </td>
                  <td className="muted">{fmt.ago(s.last_run_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="Nothing activated yet" action={canCreate ? <Link to="/activations/new" className="btn primary">Activate an audience</Link> : undefined}>
            Pick an audience and a destination. We'll keep the destination in sync automatically.
          </Empty>
        )}
      </div>
    </div>
  )
}
