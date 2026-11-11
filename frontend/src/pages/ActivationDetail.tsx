import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Sync, SyncRun } from '../api'
import { DestIcon, ErrorBox, Field, Modal, Spinner, StatusBadge, usePolling, useAsync } from '../components/ui'
import { scheduleLabel } from '../components/ScheduleEditor'
import { useMe } from '../components/me'
import { askConfirm, FilterChips, Pager, SkeletonRows, toast, usePaged } from '../components/kit'
import { muteLabel, MuteMenu, RoutingEditor, SeverityBadge, since, TriggerEditor } from '../components/alerting'
import { ErrorLine } from './Alerts'
import type { AlertRow, AlertStatus, Catalog, Policy, Recipient, TriggerCfg, TriggerKey } from '../components/alerting'
import { DELETE_LABEL, syncHealth, until } from '../ux/syncHealth'
import { runBars, runTotals, splitInitialLoad } from '../ux/syncRuns'
import { RunsChart } from '../components/viz'
import { Facts } from '../components/collection'
import '../ux/activate.css'
import '../ux/alerts.css'

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const TRIGGER: Record<string, string> = { manual: 'Manual', schedule: 'Scheduled', scheduled: 'Scheduled', api: 'API' }

function pretty(text: string) {
  try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text }
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className={`act-stat ${tone ?? ''}`}><span>{label}</span><strong>{value}</strong></div>
}

const fileName = (syncName: string, runId: number) => `${syncName.replace(/[^A-Za-z0-9]+/g, '_')}_run${runId}.csv`

/** Download the CSV a run wrote; the file holds personal data, so only people who may run the sync get the button. */
function DownloadFile({ run, syncName, canRun, sm = true }: { run: SyncRun; syncName: string; canRun: boolean; sm?: boolean }) {
  const [busy, setBusy] = useState(false)
  if (!run.file) return null
  const go = async (e: ReactMouseEvent) => {
    e.stopPropagation()
    setBusy(true)
    try {
      await api.download(`/runs/${run.id}/file`, fileName(syncName, run.id))
      toast('Download started')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not download the file', 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <button className={`btn ${sm ? 'ghost sm' : ''}`} onClick={go} disabled={busy || !canRun}
      title={canRun ? `Download the CSV of run #${run.id}` : 'Only people who can run this sync can download its files'}>
      {busy ? 'Downloading…' : '↓ Download CSV'}
    </button>
  )
}

function RunDetail({ runId, onClose, file, syncName, canRun }: { runId: number; onClose: () => void; file?: boolean; syncName: string; canRun: boolean }) {
  const run = useAsync(() => api.get<SyncRun>(`/runs/${runId}`), [runId])
  const r = run.data
  return (
    <Modal title={`Run #${runId}`} subtitle={r ? `${TRIGGER[r.trigger] ?? cap(r.trigger)} run · started ${new Date(r.started_at).toLocaleString()}` : undefined} onClose={onClose} wide>
      {!r ? <Spinner /> : (<>
        <div className="row" style={{ gap: 10 }}><StatusBadge status={r.status} /><span className="small muted">took {fmt.duration(r.started_at, r.finished_at)}</span>
          <span style={{ marginLeft: 'auto' }}><DownloadFile run={{ ...r, file }} syncName={syncName} canRun={canRun} sm={false} /></span></div>
        <div className="act-stats">
          <Stat label="In audience" value={fmt.num(r.audience_rows)} />
          <Stat label="Added" value={`+${fmt.num(r.added)}`} tone={r.added ? 'green' : ''} />
          <Stat label="Updated" value={fmt.num(r.changed)} />
          <Stat label="Removed" value={`−${fmt.num(r.removed)}`} />
          <Stat label="Rejected" value={fmt.num(r.failed)} tone={r.failed ? 'red' : ''} />
        </div>
        {r.error && <ErrorBox error={r.error} />}
        {r.details?.errors?.length ? (<>
          <h3>Rejected records <span className="small faint">retried automatically on the next run</span></h3>
          <div className="table-wrap" style={{ maxHeight: 260 }}>
            <table className="table compact"><thead><tr><th>ID</th><th>Change</th><th>Why the destination rejected it</th></tr></thead>
              <tbody>{r.details.errors.map((e, i) => <tr key={i}><td className="mono">{e.id}</td><td>{e.kind}</td><td style={{ whiteSpace: 'normal' }}>{e.error}</td></tr>)}</tbody>
            </table>
          </div>
        </>) : null}
        {r.details?.requests?.length ? (<>
          <h3>Requests sent <span className="small faint">first {r.details.requests.length}</span></h3>
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
export function ReviewModal({ sync, mode, onClose, onDone }: { sync: Sync; mode: 'approve' | 'reject'; onClose: () => void; onDone: () => void }) {
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
      <div className="act-review-sum">
        <div><span>Audience</span><strong>{sync.audience_name}</strong></div>
        <div><span>Destination</span><strong>{sync.destination_name}</strong></div>
        <div><span>Fields sent</span><strong>{sync.config.mapping.map((m) => m.target).filter(Boolean).join(', ') || '—'}</strong></div>
        <div><span>Schedule</span><strong>{scheduleLabel(sync.schedule)}</strong></div>
      </div>
      <Field label={approve ? 'Note (optional)' : 'What needs to change?'}>
        <textarea className="input" rows={3} value={note} autoFocus onChange={(e) => setNote(e.target.value)}
          placeholder={approve ? 'e.g. Checked mapping and list name' : 'e.g. Map first name too, and use the Video list'} />
      </Field>
      <ErrorBox error={error} />
    </Modal>
  )
}

/** Secondary actions tucked into a menu so the header keeps one obvious primary action. */
function MoreMenu({ items }: { items: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; title?: string }[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  if (!items.length) return null
  return (
    <div className="act-more" ref={ref}>
      <button className="btn" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>More ▾</button>
      {open && (
        <div className="act-menu" role="menu">
          {items.map((i) => (
            <button key={i.label} role="menuitem" className={i.danger ? 'danger' : ''} disabled={i.disabled} title={i.title}
              onClick={() => { setOpen(false); i.onClick() }}>{i.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Alerts for one sync: live status per check, mute, and overrides on top of the destination's rules. */
function SyncAlerts({ sync, canEdit, canMute }: { sync: Sync; canEdit: boolean; canMute: boolean }) {
  const catalog = useAsync(() => api.get<Catalog>('/alerts/catalog'))
  const policy = useAsync(() => api.get<Policy>(`/alert-policies/sync/${sync.id}`), [sync.id])
  const destPolicy = useAsync(() => api.get<Policy>(`/alert-policies/destination/${sync.destination_id}`), [sync.destination_id])
  const rows = useAsync(() => api.get<AlertRow[]>(`/alerts?status=all&sync_id=${sync.id}`), [sync.id])
  const recipients = useAsync(() => api.get<Recipient[]>('/alert-recipients'))
  const [editing, setEditing] = useState(false)
  const [showChecks, setShowChecks] = useState(false)
  const [own, setOwn] = useState<Partial<Record<TriggerKey, TriggerCfg>>>({})
  const [routing, setRouting] = useState<number[] | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (policy.data) { setOwn(policy.data.own.triggers ?? {}); setRouting(policy.data.own.recipient_ids ?? null) } }, [policy.data])
  useEffect(() => {
    const on = () => rows.reload()
    window.addEventListener('alerts:changed', on)
    return () => window.removeEventListener('alerts:changed', on)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  if (!catalog.data || !policy.data || !destPolicy.data) return <div className="card card-pad" id="alerts"><SkeletonRows rows={3} cols={2} /></div>

  const base: Record<string, TriggerCfg> = {}
  for (const [k, v] of Object.entries(destPolicy.data.triggers)) base[k] = { enabled: v.enabled, severity: v.severity, min_rows: v.min_rows, days: v.days, minutes: v.minutes }
  const byTrigger = new Map((rows.data ?? []).map((r) => [r.trigger, r]))
  const active = (rows.data ?? []).filter((r) => r.status !== 'healthy')
  const eff = policy.data.triggers
  const on = catalog.data.triggers.filter((t) => eff[t.key]?.enabled)
  const customized = Object.keys(policy.data.own.triggers ?? {}).length > 0 || policy.data.own.recipient_ids !== null
  const dirty = JSON.stringify(own) !== JSON.stringify(policy.data.own.triggers ?? {}) || JSON.stringify(routing) !== JSON.stringify(policy.data.own.recipient_ids ?? null)
  const relevant = (recipients.data ?? []).filter((r) => r.brand_id == null || r.brand_id === sync.brand_id)
  const statuses: Partial<Record<TriggerKey, { status: AlertStatus; muted: boolean; extra?: ReactNode }>> = {}
  for (const t of catalog.data.triggers) {
    const r = byTrigger.get(t.key)
    statuses[t.key] = {
      status: r?.status ?? 'healthy', muted: !!r?.muted,
      extra: canMute && eff[t.key]?.enabled
        ? <div className="al-rule-mute">{r?.muted && <span className="small faint">{muteLabel(r.muted_until)}</span>}<MuteMenu compact syncId={sync.id} trigger={t.key} muted={!!r?.muted} onDone={rows.reload} /></div>
        : undefined,
    }
  }
  const save = async (triggers = own, recipient_ids = routing) => {
    setSaving(true)
    try { await api.put(`/alert-policies/sync/${sync.id}`, { triggers, recipient_ids }); policy.reload(); toast('Alert settings saved for this sync'); setEditing(false); setShowChecks(false) }
    catch (e) { toast((e as Error).message, 'error') } finally { setSaving(false) }
  }
  const reset = async () => {
    if (!await askConfirm({ title: "Use the destination's alert rules?", body: `This sync goes back to ${sync.destination_name}'s default checks and recipients.`, confirmLabel: 'Reset' })) return
    setOwn({}); setRouting(null); save({}, null)
  }
  const anyCritical = active.some((a) => a.status === 'critical' && !a.muted)
  return (
    <div className="card al-sync" id="alerts">
      <div className="card-head">
        <div>
          <h2>Alerts</h2>
          <div className="small muted">
            {active.length ? <><strong style={{ color: anyCritical ? 'var(--red)' : 'var(--amber)' }}>{active.length} active</strong> · </> : 'All quiet · '}
            {on.length} of {catalog.data.triggers.length} checks on · {customized ? 'customized for this sync' : `using ${sync.destination_name}'s rules`}
          </div>
        </div>
        <div className="row">
          {customized && canEdit && <button className="btn ghost sm" onClick={reset} disabled={saving}>Reset to destination defaults</button>}
          {canEdit && !editing && <button className="btn sm" onClick={() => { setEditing(true); setShowChecks(true) }}>Customize</button>}
          <Link className="btn ghost sm" to={`/alerts?tab=history&sync=${sync.id}`}>History</Link>
        </div>
      </div>
      {active.length > 0 && (
        <div className="al-sync-active">
          {active.map((a) => (
            <div key={a.id} className={`al-item compact ${a.status} ${a.muted ? 'is-muted' : ''}`}>
              <div className="al-item-main">
                <div className="al-item-top"><SeverityBadge status={a.status} muted={a.muted} /><h3>{a.label}</h3><span className="al-item-age">open for {since(a.opened_at)}</span></div>
                <p className="al-item-msg">{a.message}</p>
                {a.error && <ErrorLine error={a.error} />}
                {a.muted && <div className="al-muted-note">{muteLabel(a.muted_until)} · nobody is notified</div>}
              </div>
              {canMute && <div className="al-item-actions"><MuteMenu syncId={sync.id} trigger={a.trigger} muted={a.muted} onDone={rows.reload} /></div>}
            </div>
          ))}
        </div>
      )}
      <div className="card-body stack" style={{ gap: 14 }}>
        {!editing && !showChecks ? (
          <div className="al-checks">
            {catalog.data.triggers.map((t) => {
              const st = statuses[t.key]
              const onNow = !!eff[t.key]?.enabled
              return (
                <span key={t.key} className={`al-check ${onNow ? '' : 'off'} ${st && st.status !== 'healthy' ? st.status : ''}`} title={onNow ? t.description : 'Not watched'}>
                  <span className="al-check-dot" aria-hidden="true" />{t.label}{!onNow && <small>off</small>}{st?.muted && <small>muted</small>}
                </span>
              )
            })}
            <button className="btn ghost sm" onClick={() => setShowChecks(true)}>Show details</button>
          </div>
        ) : (
          <TriggerEditor catalog={catalog.data.triggers} base={base} own={own} onChange={setOwn} readOnly={!editing} baseName={`${sync.destination_name} rules`}
            statuses={Object.fromEntries(Object.entries(statuses).map(([k, v]) => [k, v && v.status !== 'healthy' ? { ...v, status: v.status } : { ...v!, status: 'healthy' as AlertStatus, extra: v?.extra }]))} />
        )}
        {editing && (<>
          <h3 className="al-sub">Who is notified</h3>
          <RoutingEditor recipients={relevant} value={routing} onChange={setRouting}
            inheritedText={destPolicy.data.recipient_ids === null ? 'Same as the destination: everyone whose scope matches' : `Same as the destination: ${destPolicy.data.recipient_ids.length} picked recipient${destPolicy.data.recipient_ids.length === 1 ? '' : 's'}`} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => { setEditing(false); setShowChecks(false); setOwn(policy.data!.own.triggers ?? {}); setRouting(policy.data!.own.recipient_ids ?? null) }} disabled={saving}>Cancel</button>
            <button className="btn primary" onClick={() => save()} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save alert settings'}</button>
          </div>
        </>)}
      </div>
    </div>
  )
}

type RunFilter = 'all' | 'success' | 'errors' | 'failed'
const RUN_GROUP: Record<RunFilter, string[]> = { all: [], success: ['success'], errors: ['completed_with_errors', 'partial'], failed: ['failed'] }

export default function ActivationDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const sync = useAsync(() => api.get<Sync>(`/syncs/${id}`), [id])
  const runs = useAsync(() => api.get<SyncRun[]>(`/syncs/${id}/runs`), [id])
  const [openRun, setOpenRun] = useState<number | null>(null)
  const [review, setReview] = useState<'approve' | 'reject' | null>(null)
  const [runFilter, setRunFilter] = useState<RunFilter>('all')
  const [params] = useSearchParams()
  const me = useMe()
  const [error, setError] = useState<string | null>(null)
  const running = !!sync.data?.running || !!runs.data?.some((r) => r.status === 'running')
  usePolling(() => { sync.reload(); runs.reload() }, 2500, running)
  const filteredRuns = (runs.data ?? []).filter((r) => runFilter === 'all' || RUN_GROUP[runFilter].includes(r.status))
  const paged = usePaged(filteredRuns, 15, runFilter)

  const trigger = async (full = false) => {
    if (full && !await askConfirm({ title: 'Run a full resync?', body: 'Every member is sent again as if this were the first run. Use it after changing the destination or if records went missing there.', confirmLabel: 'Run full resync' })) return
    setError(null)
    try { await api.post(`/syncs/${id}/run`, { full_resync: full }); sync.reload(); runs.reload(); toast(full ? 'Full resync started' : 'Run started') } catch (e) { setError((e as Error).message) }
  }
  const toggle = async () => {
    try { await api.put(`/syncs/${id}`, { enabled: !sync.data!.enabled }); sync.reload(); toast(sync.data!.enabled ? 'Schedule paused' : 'Schedule resumed') } catch (e) { setError((e as Error).message) }
  }
  const remove = async () => {
    if (!await askConfirm({ title: `Delete “${sync.data!.name}”?`, body: 'The sync stops for good. Records already sent stay in the destination.', confirmLabel: 'Delete sync', danger: true })) return
    try { await api.del(`/syncs/${id}`); toast('Sync deleted'); nav('/activations') } catch (e) { setError((e as Error).message) }
  }

  const s = sync.data
  if (!s) return <div className="page">{sync.error ? <ErrorBox error={sync.error} /> : <Spinner label="Loading…" />}</div>
  const last = runs.data?.find((r) => r.status !== 'running')
  const health = syncHealth(s, last)
  const waiting = s.destination_configured === false
  const can = s.can ?? { edit: true, approve: true, run: true }
  const isCsv = s.destination_type === 'csv'
  const approved = s.approval_status === 'approved'
  const runBlocked = running || waiting || !can.run || !approved
  const runTitle = !approved ? 'Waiting for approval by a Brand Marketing Admin' : !can.run ? "Your role can't run this sync" : waiting ? 'Add destination credentials first' : undefined
  const fields = s.config.mapping.map((m) => m.target).filter(Boolean)
  const { bars, initial } = splitInitialLoad(runBars(runs.data, 30))
  const totals = runTotals(runs.data)

  // one obvious primary action
  const primary = !approved && can.approve
    ? <button className="btn primary" onClick={() => setReview('approve')}>Approve</button>
    : s.approval_status === 'rejected' && can.edit
      ? <Link className="btn primary" to={`/activations/new?edit=${s.id}`}>Edit and resubmit</Link>
      : <button className="btn primary" onClick={() => trigger(false)} disabled={runBlocked} title={runTitle}>{running ? 'Running…' : 'Run now'}</button>
  const more = [
    ...(approved && (can.edit || can.run) ? [{ label: s.enabled ? 'Pause schedule' : 'Resume schedule', onClick: toggle }] : []),
    ...(approved ? [{ label: 'Full resync…', onClick: () => trigger(true), disabled: runBlocked, title: runTitle }] : []),
    ...(can.edit ? [{ label: 'Delete sync…', onClick: remove, danger: true }] : []),
  ]

  return (
    <div className="page wide">
      <div className="act-crumbs"><Link to="/activations">Syncs</Link><span>/</span><span className="act-ellipsis">{s.name}</span></div>
      <div className="act-head">
        <div style={{ minWidth: 0 }}>
          <h1 className="act-ellipsis" title={s.name}>{s.name}</h1>
          <div className="act-route">
            <Link to={`/audiences/${s.audience_id}`} className="act-chip"><span className="act-chip-k">Audience</span>{s.audience_name}</Link>
            <span className="act-arrow" aria-hidden="true">→</span>
            <span className="act-chip"><DestIcon type={s.destination_type} size={18} />{s.destination_name}</span>
          </div>
          <div className="act-health">
            <span className={`act-pill ${health.tone}`}><span className={`kit-dot ${health.tone}`} />{health.label}</span>
            <span className="small muted">{health.sentence}</span>
            {(s.alert_count ?? 0) > 0 && (
              <a href="#alerts" className={`al-flag ${s.alert_level === 2 ? 'critical' : 'warning'}`}>
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /></svg>
                {s.alert_count} active alert{s.alert_count === 1 ? '' : 's'}
              </a>
            )}
          </div>
        </div>
        <div className="row act-actions">
          {can.edit && approved && <Link className="btn" to={`/activations/new?edit=${s.id}`}>Edit</Link>}
          {s.approval_status === 'pending' && can.approve && <button className="btn danger" onClick={() => setReview('reject')}>Send back</button>}
          <MoreMenu items={more} />
          {primary}
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
                ? <>Submitted by {s.submitted_by || 'a builder'}. Nothing is sent until a Brand Marketing Admin approves it.</>
                : <>Sent back by {s.approved_by || 'an admin'}{s.approved_at ? ` ${fmt.ago(s.approved_at)}` : ''}. Edit the sync to resubmit it.</>}
            </div>
            {s.review_note && <div className="review-note">“{s.review_note}”</div>}
          </div>
        </div>
      )}
      {waiting && (
        <div className="callout amber" style={{ marginBottom: 16 }}>
          <div className="callout-icon">!</div>
          <div className="grow">
            <strong>Waiting for {s.destination_name} credentials</strong>
            <div className="small muted">Everything else about this sync is ready — it starts as soon as the API key and secret are added.</div>
          </div>
          {me.can('destinations.manage', s.brand_id ?? null) && <Link to="/destinations" className="btn sm primary">Add credentials</Link>}
        </div>
      )}
      <ErrorBox error={error} />

      <div className="card sx-delivery">
        <div className="sx-delivery-head">
          <h2>Deliveries</h2>
          <div className="small muted">Records sent per run — click a bar to open that run.</div>
        </div>
        <div className="sx-delivery-body">
          <div className="sx-delivery-chart">
            {bars.length ? <RunsChart runs={bars} height={200} onSelect={(rid) => setOpenRun(Number(rid))} />
              : <div className="sx-quiet" style={{ padding: '22px 0' }}>{!approved ? 'Deliveries appear here once the sync is approved and runs.' : waiting ? 'Deliveries appear here once credentials are added and the first run completes.' : 'No runs yet — the first run sends everyone in the audience.'}</div>}
            {initial && <div className="sx-note">First run sent everyone — {fmt.num(initial.added + initial.changed + initial.removed)} records on {initial.when}, not drawn so day-to-day changes stay readable. <button className="btn ghost sm" onClick={() => setOpenRun(Number(initial.id))}>Open that run</button></div>}
          </div>
          <div className="sx-side">
            <div><span>Last run</span><strong>{last ? fmt.ago(last.started_at) : '—'}</strong><small>{last ? (last.status === 'failed' ? 'failed' : last.failed ? `${fmt.num(last.failed)} rejected` : 'delivered') : 'not run yet'}</small></div>
            <div><span>Next run</span><strong>{!approved ? 'After approval' : !s.enabled ? 'Paused' : s.next_run_at ? until(s.next_run_at) : 'Manual'}</strong><small>{scheduleLabel(s.schedule)}</small></div>
            <div><span>In audience</span><strong>{last ? fmt.num(last.audience_rows) : '—'}</strong><small>at the last run</small></div>
            <div><span>Sent so far</span><strong>{fmt.num(totals.sent)}</strong><small>across {totals.count} run{totals.count === 1 ? '' : 's'}</small></div>
          </div>
        </div>
      </div>

      {approved && (s.alert_count ?? 0) > 0 && <SyncAlerts sync={s} canEdit={can.edit || can.approve} canMute={can.run || can.approve} />}
      <div className="card">
        <div className="card-head">
          <div><h2>Run history</h2><div className="small muted">{isCsv
            ? 'Every run, newest first. Each run writes a CSV of what changed: the first run (or a full resync) has everyone, later runs only the people who joined, changed or left.'
            : 'Every run, newest first — the table view of the chart above.'}</div></div>
          {(runs.data?.length ?? 0) > 0 && (
            <FilterChips label="Run status" value={runFilter} onChange={setRunFilter} options={[
              { value: 'all', label: 'All', count: runs.data!.length },
              { value: 'success', label: 'Succeeded', count: runs.data!.filter((r) => RUN_GROUP.success.includes(r.status)).length, tone: 'green' },
              { value: 'errors', label: 'With errors', count: runs.data!.filter((r) => RUN_GROUP.errors.includes(r.status)).length, tone: 'amber' },
              { value: 'failed', label: 'Failed', count: runs.data!.filter((r) => r.status === 'failed').length, tone: 'red' },
            ]} />
          )}
        </div>
        {runs.data?.length ? (<>
          <table className="table">
            <thead><tr><th>Run</th><th>Status</th><th>Started</th><th className="num">In audience</th><th className="num">Added</th><th className="num">Updated</th><th className="num">Removed</th><th className="num">Rejected</th><th>Duration</th>{isCsv && <th>File</th>}</tr></thead>
            <tbody>
              {paged.slice.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => setOpenRun(r.id)}>
                  <td><span className="mono">#{r.id}</span><div className="faint small">{TRIGGER[r.trigger] ?? cap(r.trigger)}</div></td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="muted small" title={new Date(r.started_at).toLocaleString()}>{fmt.ago(r.started_at)}</td>
                  <td className="num">{fmt.num(r.audience_rows)}</td>
                  <td className="num" style={{ color: r.added ? 'var(--green)' : undefined }}>+{fmt.num(r.added)}</td>
                  <td className="num">{fmt.num(r.changed)}</td>
                  <td className="num">−{fmt.num(r.removed)}</td>
                  <td className="num" style={{ color: r.failed ? 'var(--red)' : undefined }}>{fmt.num(r.failed)}</td>
                  <td className="muted small">{fmt.duration(r.started_at, r.finished_at)}</td>
                  {isCsv && <td>{r.file ? <DownloadFile run={r} syncName={s.name} canRun={can.run} /> : <span className="faint small" title="Runs with no changes write no file">No file</span>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          {!filteredRuns.length && <div className="dm-none">No runs with this status. <button className="btn ghost sm" onClick={() => setRunFilter('all')}>Show all runs</button></div>}
          <div className="act-pager"><Pager page={paged.page} pages={paged.pages} total={filteredRuns.length} pageSize={15} onPage={paged.setPage} noun="run" /></div>
        </>) : <div className="empty"><p>{!approved ? 'No runs yet — this sync runs once it is approved.' : waiting ? 'No runs yet — this sync starts once credentials are added.' : can.run ? <>No runs yet. Click <strong>Run now</strong> to send the audience.</> : 'No runs yet.'}</p></div>}
      </div>
      {approved && !(s.alert_count ?? 0) && <SyncAlerts sync={s} canEdit={can.edit || can.approve} canMute={can.run || can.approve} />}
      <div className="card sx-config">
        <div className="card-head"><div><h2>Configuration</h2><div className="small muted">What this sync sends and when.</div></div>
          {can.edit && approved && <Link className="btn ghost sm" to={`/activations/new?edit=${s.id}`}>Edit</Link>}</div>
        <div className="card-body">
          <Facts rows={[
            ['Schedule', <span key="s">{scheduleLabel(s.schedule)}{approved && s.enabled && s.next_run_at ? <span className="muted"> · next {new Date(s.next_run_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span> : null}</span>],
            ['Sends', `${s.config.sync_type === 'default' ? 'Records' : cap(s.config.sync_type.replace('_', ' '))} · ${cap(s.config.mode)}`],
            ['Matched on', s.config.match ? <code key="m">{s.config.match.source} → {s.config.match.field}</code> : 'Customer ID'],
            ['Fields', fields.length ? fields.map((f) => <code key={f}>{f}</code>) : '—'],
            ['When people leave', <span key="d">{DELETE_LABEL[s.config.delete_behavior] ?? s.config.delete_behavior}<span className="muted"> · {s.config.delete_behavior === 'do_nothing' ? 'they stay in the destination' : 'applied on the next run'}</span></span>],
            ...(approved && s.approved_by ? [['Approved', `${s.approved_by}${s.approved_at ? ` · ${fmt.ago(s.approved_at)}` : ''}${s.review_note ? ` · “${s.review_note}”` : ''}`] as [string, string]] : []),
          ]} />
        </div>
      </div>
      {openRun && <RunDetail runId={openRun} onClose={() => setOpenRun(null)} syncName={s.name} canRun={can.run}
        file={runs.data?.find((r) => r.id === openRun)?.file} />}
      {review && <ReviewModal sync={s} mode={review} onClose={() => setReview(null)} onDone={() => { setReview(null); sync.reload(); toast(review === 'approve' ? 'Sync approved and published' : 'Sent back to the builder') }} />}
    </div>
  )
}
