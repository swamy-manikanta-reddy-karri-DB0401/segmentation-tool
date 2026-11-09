import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Sync, SyncRun } from '../api'
import { ApprovalBadge, DestIcon, ErrorBox, Field, Modal, Spinner, StatusBadge, usePolling, useAsync } from '../components/ui'
import { scheduleLabel } from '../components/ScheduleEditor'
import { useMe } from '../components/me'

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

/** Approve, or send back with a reason (maker-checker). */
function ReviewModal({ sync, mode, onClose, onDone }: { sync: Sync; mode: 'approve' | 'reject'; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true); setError(null)
    try { await api.post(`/syncs/${sync.id}/${mode}`, { note }); onDone() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const approve = mode === 'approve'
  return (
    <Modal title={approve ? `Approve “${sync.name}”` : `Send “${sync.name}” back`}
      subtitle={approve ? 'Once approved, the sync runs on its schedule and can be run manually.' : 'The builder sees your reason and can change the sync and resubmit it.'}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className={`btn ${approve ? 'primary' : 'danger'}`} onClick={submit} disabled={busy || (!approve && !note.trim())}>
          {busy ? 'Saving…' : approve ? 'Approve and publish' : 'Send back'}</button></>}>
      <Field label={approve ? 'Note (optional)' : 'What needs to change?'}>
        <textarea className="input" rows={3} value={note} autoFocus onChange={(e) => setNote(e.target.value)}
          placeholder={approve ? 'e.g. Checked mapping and list name' : 'e.g. Map first name too, and use the Video list'} />
      </Field>
      <ErrorBox error={error} />
    </Modal>
  )
}

export default function ActivationDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const sync = useAsync(() => api.get<Sync>(`/syncs/${id}`), [id])
  const runs = useAsync(() => api.get<SyncRun[]>(`/syncs/${id}/runs`), [id])
  const [openRun, setOpenRun] = useState<number | null>(null)
  const [review, setReview] = useState<'approve' | 'reject' | null>(null)
  const [params] = useSearchParams()
  const me = useMe()
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
  const can = s.can ?? { edit: true, approve: true, run: true }
  const approved = s.approval_status === 'approved'
  const runBlocked = running || waiting || !can.run || !approved
  const runTitle = !approved ? 'Waiting for approval by a Brand Marketing Admin' : !can.run ? "Your role can't run this sync" : waiting ? 'Add destination credentials first' : undefined

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><span className="eyebrow-n">4</span>Step 4 · Activation · <Link to="/activations">Syncs</Link></div>
          <h1 className="row" style={{ gap: 10 }}>{s.name} {approved ? <StatusBadge status={s.last_status} running={running} /> : <ApprovalBadge status={s.approval_status} />}</h1>
          <p className="row" style={{ gap: 6 }}>
            <Link to={`/audiences/${s.audience_id}`}>{s.audience_name}</Link> → <DestIcon type={s.destination_type} size={20} /> {s.destination_name}
          </p>
        </div>
        <div className="row">
          {can.edit && <button className="btn ghost danger" onClick={remove}>Delete</button>}
          {can.edit && <Link className="btn" to={`/activations/new?edit=${s.id}`}>Edit</Link>}
          <button className="btn" onClick={() => trigger(true)} disabled={runBlocked} title={runTitle}>Full resync</button>
          <button className="btn primary" onClick={() => trigger(false)} disabled={runBlocked} title={runTitle}>{running ? 'Running…' : 'Run now'}</button>
        </div>
      </div>
      {params.get('submitted') && s.approval_status === 'pending' && (
        <div className="alert success" style={{ marginBottom: 12 }}>Submitted for approval. A Brand Marketing Admin will review it before anything is sent.</div>
      )}
      {!approved && (
        <div className={`approval-banner ${s.approval_status}`}>
          <div className="callout-icon">{s.approval_status === 'pending' ? '…' : '!'}</div>
          <div className="grow">
            <strong>{s.approval_status === 'pending' ? 'Waiting for approval' : 'Changes requested'}</strong>
            <div className="small muted">
              {s.approval_status === 'pending'
                ? <>Submitted by {s.submitted_by || 'a builder'}. It won't run until a Brand Marketing Admin approves it.</>
                : <>Sent back by {s.approved_by || 'an admin'}{s.approved_at ? ` ${fmt.ago(s.approved_at)}` : ''}. Edit the sync to resubmit it.</>}
            </div>
            {s.review_note && <div className="review-note">“{s.review_note}”</div>}
          </div>
          {can.approve && (
            <div className="row">
              {s.approval_status === 'pending' && <button className="btn sm danger" onClick={() => setReview('reject')}>Send back</button>}
              <button className="btn sm primary" onClick={() => setReview('approve')}>Approve</button>
            </div>
          )}
          {!can.approve && can.edit && s.approval_status === 'rejected' && <Link to={`/activations/new?edit=${s.id}`} className="btn sm">Edit and resubmit</Link>}
        </div>
      )}
      {approved && s.approved_by && (
        <div className="small muted" style={{ marginTop: -10, marginBottom: 14 }}>
          Approved by {s.approved_by}{s.approved_at ? ` ${fmt.ago(s.approved_at)}` : ''}{s.review_note ? ` · “${s.review_note}”` : ''}
        </div>
      )}
      {waiting && (
        <div className="callout amber" style={{ marginBottom: 16 }}>
          <div className="callout-icon">!</div>
          <div className="grow">
            <strong>Waiting for {s.destination_name} credentials</strong>
            <div className="small muted">Add your API key and secret to start syncing. Everything else about this sync is ready.</div>
          </div>
          {me.can('destinations.manage', s.brand_id ?? null) && <Link to="/destinations" className="btn sm primary">Add credentials</Link>}
        </div>
      )}
      <ErrorBox error={error} />

      <div className="grid-4" style={{ marginBottom: 20 }}>
        <div className="card stat"><div className="label">Schedule</div><div className="value" style={{ fontSize: 16 }}>{scheduleLabel(s.schedule)}</div>
          <div className="small muted">{s.enabled ? (s.next_run_at ? `Next run ${new Date(s.next_run_at).toLocaleString()}` : 'No upcoming run') : 'Paused'}</div>
          {(can.edit || can.run) && <button className="btn ghost sm" style={{ marginLeft: -10 }} onClick={toggle}>{s.enabled ? 'Pause schedule' : 'Resume schedule'}</button>}</div>
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
        ) : <div className="empty"><p>{!approved ? 'No runs yet — this sync runs once it is approved.' : waiting ? 'No runs yet — this sync starts once credentials are added.' : can.run ? <>No runs yet. Click <strong>Run now</strong> to send the audience.</> : 'No runs yet.'}</p></div>}
      </div>
      {openRun && <RunDetail runId={openRun} onClose={() => setOpenRun(null)} />}
      {review && <ReviewModal sync={s} mode={review} onClose={() => setReview(null)} onDone={() => { setReview(null); sync.reload() }} />}
    </div>
  )
}
