import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Sync, SyncRun } from '../api'
import { DestIcon, ErrorBox, Modal, Spinner, StatusBadge, usePolling, useAsync } from '../components/ui'
import { scheduleLabel } from '../components/ScheduleEditor'

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function pretty(text: string) {
  try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text }
}

function RunDetail({ runId, onClose }: { runId: number; onClose: () => void }) {
  const run = useAsync(() => api.get<SyncRun>(`/runs/${runId}`), [runId])
  const r = run.data
  return (
    <Modal title={`Run #${runId}`} onClose={onClose} wide>
      {!r ? <Spinner /> : (<>
        <div className="row wrap" style={{ gap: 24 }}>
          <div><div className="small muted">Status</div><StatusBadge status={r.status} /></div>
          <div><div className="small muted">Audience size</div><strong>{fmt.num(r.audience_rows)}</strong></div>
          <div><div className="small muted">Added</div><strong style={{ color: 'var(--green)' }}>+{fmt.num(r.added)}</strong></div>
          <div><div className="small muted">Updated</div><strong>{fmt.num(r.changed)}</strong></div>
          <div><div className="small muted">Removed</div><strong>−{fmt.num(r.removed)}</strong></div>
          <div><div className="small muted">Failed</div><strong style={{ color: r.failed ? 'var(--red)' : undefined }}>{fmt.num(r.failed)}</strong></div>
          <div><div className="small muted">Duration</div><strong>{fmt.duration(r.started_at, r.finished_at)}</strong></div>
        </div>
        {r.error && <ErrorBox error={r.error} />}
        {r.details?.errors?.length ? (<>
          <h3>Rejected records</h3>
          <div className="small muted">These records will be retried automatically on the next run.</div>
          <div className="table-wrap" style={{ maxHeight: 260 }}>
            <table className="table compact"><thead><tr><th>ID</th><th>Change</th><th>Error</th></tr></thead>
              <tbody>{r.details.errors.map((e, i) => <tr key={i}><td className="mono">{e.id}</td><td>{e.kind}</td><td style={{ whiteSpace: 'normal' }}>{e.error}</td></tr>)}</tbody>
            </table>
          </div>
        </>) : null}
        {r.details?.requests?.length ? (<>
          <h3>Debugger <span className="small faint">first {r.details.requests.length} requests</span></h3>
          <div className="stack" style={{ gap: 6, maxHeight: 320, overflow: 'auto' }}>
            {r.details.requests.map((q, i) => (
              <details key={i} className="debug-row">
                <summary>
                  <span className={'badge ' + (q.status && q.status < 300 ? 'green' : 'red')}>{q.status ?? '—'}</span>
                  <span className="mono small">{q.method} {q.url}</span>
                </summary>
                <div className="grid-2" style={{ marginTop: 8 }}>
                  <div><div className="small muted">Request</div><pre className="code" style={{ maxHeight: 200 }}>{pretty(q.request)}</pre></div>
                  <div><div className="small muted">Response</div><pre className="code" style={{ maxHeight: 200 }}>{pretty(q.response)}</pre></div>
                </div>
              </details>
            ))}
          </div>
        </>) : null}
        {r.details?.snapshot && <div className="small muted">Audience snapshot written to <span className="mono">{r.details.snapshot.table}</span>.</div>}
        {r.details?.query && (<details><summary className="small muted" style={{ cursor: 'pointer' }}>Audience query used</summary><pre className="code" style={{ marginTop: 8 }}>{r.details.query}</pre></details>)}
        {r.details?.traceback && (<details><summary className="small muted" style={{ cursor: 'pointer' }}>Technical details</summary><pre className="code" style={{ marginTop: 8 }}>{r.details.traceback}</pre></details>)}
      </>)}
    </Modal>
  )
}

export default function ActivationDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const sync = useAsync(() => api.get<Sync>(`/syncs/${id}`), [id])
  const runs = useAsync(() => api.get<SyncRun[]>(`/syncs/${id}/runs`), [id])
  const [openRun, setOpenRun] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const running = !!sync.data?.running || !!runs.data?.some((r) => r.status === 'running')
  usePolling(() => { sync.reload(); runs.reload() }, 2500, running)

  const trigger = async (full = false) => {
    if (full && !confirm('Full resync sends every member again as if this were the first run. Continue?')) return
    setError(null)
    try { await api.post(`/syncs/${id}/run`, { full_resync: full }); sync.reload(); runs.reload() } catch (e) { setError((e as Error).message) }
  }
  const toggle = async () => {
    try { await api.put(`/syncs/${id}`, { enabled: !sync.data!.enabled }); sync.reload() } catch (e) { setError((e as Error).message) }
  }
  const remove = async () => {
    if (!confirm('Delete this sync? Records already sent stay in the destination.')) return
    try { await api.del(`/syncs/${id}`); nav('/activations') } catch (e) { setError((e as Error).message) }
  }

  const s = sync.data
  if (!s) return <div className="page">{sync.error ? <ErrorBox error={sync.error} /> : <Spinner label="Loading…" />}</div>
  const last = runs.data?.find((r) => r.status !== 'running')
  const waiting = s.destination_configured === false

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><span className="eyebrow-n">4</span>Step 4 · Activation · <Link to="/activations">Syncs</Link></div>
          <h1 className="row" style={{ gap: 10 }}>{s.name} <StatusBadge status={s.last_status} running={running} /></h1>
          <p className="row" style={{ gap: 6 }}>
            <Link to={`/audiences/${s.audience_id}`}>{s.audience_name}</Link> → <DestIcon type={s.destination_type} size={20} /> {s.destination_name}
          </p>
        </div>
        <div className="row">
          <button className="btn ghost danger" onClick={remove}>Delete</button>
          <Link className="btn" to={`/activations/new?edit=${s.id}`}>Edit</Link>
          <button className="btn" onClick={() => trigger(true)} disabled={running || waiting}>Full resync</button>
          <button className="btn primary" onClick={() => trigger(false)} disabled={running || waiting}>{running ? 'Running…' : 'Run now'}</button>
        </div>
      </div>
      {waiting && (
        <div className="callout amber" style={{ marginBottom: 16 }}>
          <div className="callout-icon">!</div>
          <div className="grow">
            <strong>Waiting for {s.destination_name} credentials</strong>
            <div className="small muted">Add your API key and secret to start syncing. Everything else about this sync is ready.</div>
          </div>
          <Link to="/destinations" className="btn sm primary">Add credentials</Link>
        </div>
      )}
      <ErrorBox error={error} />

      <div className="grid-4" style={{ marginBottom: 20 }}>
        <div className="card stat"><div className="label">Schedule</div><div className="value" style={{ fontSize: 16 }}>{scheduleLabel(s.schedule)}</div>
          <div className="small muted">{s.enabled ? (s.next_run_at ? `Next run ${new Date(s.next_run_at).toLocaleString()}` : 'No upcoming run') : 'Paused'}</div>
          <button className="btn ghost sm" style={{ marginLeft: -10 }} onClick={toggle}>{s.enabled ? 'Pause schedule' : 'Resume schedule'}</button></div>
        <div className="card stat"><div className="label">Rows in last run</div><div className="value">{fmt.num(last?.audience_rows)}</div></div>
        <div className="card stat"><div className="label">Sync type &amp; mode</div>
          <div className="value" style={{ fontSize: 16 }}>{s.config.sync_type === 'default' ? 'Records' : cap(s.config.sync_type.replace('_', ' '))} · {cap(s.config.mode)}</div>
          <div className="small muted">{s.config.match ? `Matched on ${s.config.match.source} → ${s.config.match.field}` : 'Matched on customer ID'}</div></div>
        <div className="card stat"><div className="label">Delete behavior</div>
          <div className="value" style={{ fontSize: 16 }}>{({ do_nothing: 'Do nothing', clear: 'Clear', delete: 'Delete', remove: 'Remove' } as Record<string, string>)[s.config.delete_behavior] ?? s.config.delete_behavior}</div>
          <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Fields: {s.config.mapping.map((m) => m.target).join(', ') || '—'}</div></div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Run history</h2><span className="small muted">Click a run for details</span></div>
        {runs.data?.length ? (
          <table className="table">
            <thead><tr><th>Run</th><th>Status</th><th>Trigger</th><th>Audience</th><th>Added</th><th>Updated</th><th>Removed</th><th>Failed</th><th>Started</th><th>Duration</th></tr></thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => setOpenRun(r.id)}>
                  <td className="mono">#{r.id}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="muted">{r.trigger}</td>
                  <td>{fmt.num(r.audience_rows)}</td>
                  <td style={{ color: r.added ? 'var(--green)' : undefined }}>+{fmt.num(r.added)}</td>
                  <td>{fmt.num(r.changed)}</td>
                  <td>−{fmt.num(r.removed)}</td>
                  <td style={{ color: r.failed ? 'var(--red)' : undefined }}>{fmt.num(r.failed)}</td>
                  <td className="muted">{fmt.ago(r.started_at)}</td>
                  <td className="muted">{fmt.duration(r.started_at, r.finished_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="empty"><p>{waiting ? 'No runs yet — this sync starts once credentials are added.' : <>No runs yet. Click <strong>Run now</strong> to send the audience.</>}</p></div>}
      </div>
      {openRun && <RunDetail runId={openRun} onClose={() => setOpenRun(null)} />}
    </div>
  )
}
