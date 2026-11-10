import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Sync, SyncRun } from '../api'
import { scheduleLabel } from '../components/ScheduleEditor'
import { DestIcon, Empty, ErrorBox, PageHead, usePolling, useAsync } from '../components/ui'
import { useMe } from '../components/me'
import { FilterChips, matches, NoResults, Pager, SearchBox, SkeletonRows, sortBy, toast, usePaged, useSort, useUrlState } from '../components/kit'
import { CollectionLayout, Facts, Inspector, ListPane, ListRow, Section, StatTile } from '../components/collection'
import { RunsChart } from '../components/viz'
import { DELETE_LABEL, HEALTH_GROUPS, syncHealth, until } from '../ux/syncHealth'
import type { Health } from '../ux/syncHealth'
import { runBars, runTotals, splitInitialLoad } from '../ux/syncRuns'
import { ReviewModal } from './ActivationDetail'
import '../ux/activate.css'
import '../ux/alerts.css'

type Group = 'all' | keyof typeof HEALTH_GROUPS
const PAGE = 20
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const Bell = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /></svg>
)

/** "in 3h" / "Manual only" / "After approval" / "Paused". */
function nextText(s: Sync) {
  if (!s.schedule || s.schedule.type === 'manual') return 'Manual only'
  if (s.approval_status !== 'approved') return 'After approval'
  if (!s.enabled) return 'Paused'
  return until(s.next_run_at)
}

function SyncInspector({ s, health, onChanged }: { s: Sync; health: Health; onChanged: () => void }) {
  const runs = useAsync(() => api.get<SyncRun[]>(`/syncs/${s.id}/runs`), [s.id])
  const me = useMe()
  const nav = useNavigate()
  const [review, setReview] = useState<'approve' | 'reject' | null>(null)
  const [busy, setBusy] = useState(false)
  const can = s.can ?? { edit: false, approve: false, run: false }
  const approved = s.approval_status === 'approved'
  const waiting = s.destination_configured === false
  const last = runs.data?.find((r) => r.status !== 'running')
  const { bars, initial } = splitInitialLoad(runBars(runs.data, 24))
  const totals = runTotals(runs.data)
  const fields = s.config.mapping.map((m) => m.target).filter(Boolean)
  const runBlocked = !!s.running || waiting || !can.run || !approved
  const runTitle = !approved ? 'Waiting for approval' : !can.run ? "Your role can't run this sync" : waiting ? 'Add destination credentials first' : undefined

  const run = async () => {
    setBusy(true)
    try { await api.post(`/syncs/${s.id}/run`, { full_resync: false }); toast('Run started'); onChanged(); runs.reload() } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }
  const toggle = async () => {
    setBusy(true)
    try { await api.put(`/syncs/${s.id}`, { enabled: !s.enabled }); toast(s.enabled ? 'Schedule paused' : 'Schedule resumed'); onChanged() } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }

  return (
    <Inspector
      icon={<DestIcon type={s.destination_type} size={40} />}
      kicker={<span className={`sx-kicker ${health.tone}`}><span className={`kit-dot ${health.tone}`} />{health.label}</span>}
      title={s.name}
      actions={<Link className="btn sm" to={`/activations/${s.id}`}>Open</Link>}
      sentence={<>Sends <Link to={`/audiences/${s.audience_id}`}>{s.audience_name}</Link> to <strong>{s.destination_name}</strong>. {health.sentence}.</>}>

      {!approved && (
        <div className={`sx-callout ${s.approval_status === 'rejected' ? 'red' : 'amber'}`}>
          <div className="grow">
            <strong>{s.approval_status === 'pending' ? 'Waiting for approval' : 'Changes requested'}</strong>
            <div className="small muted">{s.approval_status === 'pending'
              ? <>Submitted by {s.submitted_by || 'a builder'}. Nothing is sent until a Brand Marketing Admin approves it.</>
              : <>Sent back by {s.approved_by || 'an admin'}{s.review_note ? <>: “{s.review_note}”</> : ''}</>}</div>
          </div>
          {s.approval_status === 'pending' && can.approve && (
            <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <button className="btn sm" onClick={() => setReview('reject')}>Send back</button>
              <button className="btn sm primary" onClick={() => setReview('approve')}>Approve</button>
            </div>
          )}
          {s.approval_status === 'rejected' && can.edit && <Link className="btn sm primary" to={`/activations/new?edit=${s.id}`}>Edit and resubmit</Link>}
        </div>
      )}
      {approved && waiting && (
        <div className="sx-callout amber">
          <div className="grow"><strong>Waiting for {s.destination_name} credentials</strong>
            <div className="small muted">Everything else is ready — it starts as soon as they're added.</div></div>
          {me.can('destinations.manage', s.brand_id ?? null) && <Link className="btn sm primary" to={`/destinations?id=${s.destination_id}`}>Add credentials</Link>}
        </div>
      )}

      <div className="cx-stats">
        <StatTile label="Last run" value={last ? fmt.ago(last.started_at) : '—'} sub={last ? (last.status === 'failed' ? 'Failed' : `${fmt.num(last.audience_rows)} people`) : 'Not run yet'}
          tone={last?.status === 'failed' ? 'bad' : last?.failed ? 'warn' : undefined} />
        <StatTile label="Next run" value={nextText(s)} sub={s.schedule && s.schedule.type !== 'manual' ? scheduleLabel(s.schedule) : 'Run it from here'} />
        <StatTile label="Records sent" value={fmt.num(totals.sent)} sub={`across ${totals.count} run${totals.count === 1 ? '' : 's'}`} />
      </div>

      <Section title="Recent runs" aside={runs.data?.length ? <Link className="small" to={`/activations/${s.id}`}>All runs →</Link> : undefined}>
        {runs.loading && !runs.data ? <SkeletonRows rows={3} cols={3} />
          : bars.length ? (<>
            <RunsChart runs={bars} height={150} onSelect={() => nav(`/activations/${s.id}`)} />
            {initial && <div className="sx-note">First run sent everyone — {fmt.num(initial.added + initial.changed + initial.removed)} records ({initial.when}). Not drawn so day-to-day changes stay readable.</div>}
          </>)
            : <div className="sx-quiet">{!approved ? 'Runs start once the sync is approved.' : waiting ? 'Runs start once credentials are added.' : 'No runs yet — the first one sends everyone in the audience.'}</div>}
      </Section>

      <Section title="Alerts" aside={<Link className="small" to={`/activations/${s.id}#alerts`}>Settings →</Link>}>
        {(s.alert_count ?? 0) > 0
          ? <Link to={`/alerts?q=${encodeURIComponent(s.name)}`} className={`sx-alert ${s.alert_level === 2 ? 'critical' : 'warning'}`}><Bell />{s.alert_count} active alert{s.alert_count === 1 ? '' : 's'} — review</Link>
          : <div className="sx-quiet"><span className="kit-dot green" /> No active alerts. Failures and rejected records notify the alert recipients.</div>}
      </Section>

      <Section title="What it sends">
        <Facts rows={[
          ['Sends', `${s.config.sync_type === 'default' ? 'Records' : cap(s.config.sync_type.replace('_', ' '))} · ${cap(s.config.mode)}`],
          ['Matched on', s.config.match ? <code>{s.config.match.source} → {s.config.match.field}</code> : 'Customer ID'],
          ['Fields', fields.length ? fields.slice(0, 6).map((f) => <code key={f}>{f}</code>).concat(fields.length > 6 ? [<span key="more" className="small muted">+{fields.length - 6}</span>] : []) : '—'],
          ['When people leave', DELETE_LABEL[s.config.delete_behavior] ?? s.config.delete_behavior],
        ]} />
      </Section>

      <div className="sx-actions">
        <Link className="btn primary" to={`/activations/${s.id}`}>Open sync</Link>
        {approved && <button className="btn" onClick={run} disabled={runBlocked || busy} title={runTitle}>{s.running ? 'Running…' : 'Run now'}</button>}
        {approved && (can.edit || can.run) && <button className="btn ghost" onClick={toggle} disabled={busy}>{s.enabled ? 'Pause schedule' : 'Resume schedule'}</button>}
      </div>
      {review && <ReviewModal sync={s} mode={review} onClose={() => setReview(null)}
        onDone={() => { setReview(null); onChanged(); toast(review === 'approve' ? 'Sync approved and published' : 'Sent back to the builder') }} />}
    </Inspector>
  )
}

export default function Activations() {
  const syncs = useAsync(() => api.get<Sync[]>('/syncs'))
  const recent = useAsync(() => api.get<SyncRun[]>('/runs/recent'))
  usePolling(() => { syncs.reload(); recent.reload() }, 4000, !!syncs.data?.some((s) => s.running))
  const me = useMe()
  const [q, setQ] = useUrlState('q')
  const [group, setGroup] = useUrlState('status', 'all')
  const [dest, setDest] = useUrlState('dest')
  const [brand, setBrand] = useUrlState('brand')
  const [sel, setSel] = useUrlState('id')
  const [sort] = useSort('name')
  const [rawSort, setRawSort] = useUrlState('sort', 'name')

  const lastRun = useMemo(() => {
    const m = new Map<number, SyncRun>()
    for (const r of recent.data ?? []) if (r.status !== 'running' && !m.has(r.sync_id)) m.set(r.sync_id, r)
    return m
  }, [recent.data])
  const rows = useMemo(() => (syncs.data ?? []).map((s) => ({ s, h: syncHealth(s, lastRun.get(s.id)) })), [syncs.data, lastRun])
  const inGroup = (h: Health, g: Group) => g === 'all' || (HEALTH_GROUPS[g] as readonly string[]).includes(h.key)
  const counts = Object.fromEntries((['all', ...Object.keys(HEALTH_GROUPS)] as Group[]).map((g) => [g, rows.filter((r) => inGroup(r.h, g)).length])) as Record<Group, number>

  const destOptions = useMemo(() => [...new Map((syncs.data ?? []).map((s) => [s.destination_id, s.destination_name])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [syncs.data])
  const brandOptions = useMemo(() => [...new Set((syncs.data ?? []).map((s) => s.brand_id ?? null))], [syncs.data])
  const filtered = sortBy(rows.filter(({ s, h }) => inGroup(h, group as Group)
    && (!dest || String(s.destination_id) === dest)
    && (!brand || String(s.brand_id ?? '') === brand)
    && matches(q, s.name, s.audience_name, s.destination_name)), sort, {
    name: (r) => r.s.name.toLowerCase(), last: (r) => r.s.last_run_at ?? '', next: (r) => r.s.next_run_at ?? '~', health: (r) => ['failing', 'warning', 'rejected', 'pending', 'waiting', 'paused', 'running', 'new', 'healthy'].indexOf(r.h.key),
  })
  const paged = usePaged(filtered, PAGE, `${q}|${group}|${dest}|${brand}|${sort.key}${sort.dir}`, 'page')
  const selected = rows.find((r) => String(r.s.id) === sel) ?? (filtered[0] ?? null)
  useEffect(() => { if (!sel && filtered[0]) setSel(String(filtered[0].s.id)) }, [sel, filtered]) // eslint-disable-line react-hooks/exhaustive-deps
  const toReview = rows.filter(({ s }) => s.approval_status === 'pending' && s.can?.approve)
  const canCreate = me.can('syncs.edit')
  const clear = () => { setQ(''); setGroup('all'); setDest(''); setBrand('') }

  return (
    <div className="page wide">
      <PageHead title="Syncs" subtitle="Each sync keeps an audience up to date in one marketing tool, sending only what changed."
        actions={canCreate ? <Link to="/activations/new" className="btn primary">+ New sync</Link> : undefined} />
      <ErrorBox error={syncs.error} />

      {toReview.length > 0 && group !== 'approval' && (
        <button className="sx-review" onClick={() => setGroup('approval')}>
          <span className="sx-review-n">{toReview.length}</span>
          <span className="grow"><strong>{toReview.length === 1 ? 'A sync is' : `${toReview.length} syncs are`} waiting for your approval</strong>
            <small>Nothing is sent until you approve. Review the audience, destination and fields.</small></span>
          <span className="btn sm primary">Review</span>
        </button>
      )}

      {syncs.loading && !syncs.data ? <SkeletonRows rows={6} cols={4} /> : !rows.length ? (
        <div className="card">
          <Empty title="Nothing activated yet" action={canCreate ? <Link to="/activations/new" className="btn primary">Activate an audience</Link> : undefined}>
            Pick an audience and a marketing tool — we keep it up to date automatically, sending only what changed.
          </Empty>
        </div>
      ) : (
        <CollectionLayout
          list={
            <ListPane title="All syncs" count={rows.length}
              actions={<select className="input sm" value={rawSort} aria-label="Sort" onChange={(e) => setRawSort(e.target.value)}>
                <option value="name">Name A–Z</option><option value="health">Needs attention first</option>
                <option value="-last">Recently run</option><option value="next">Next to run</option>
              </select>}
              toolbar={<>
                <SearchBox value={q} onChange={setQ} placeholder="Search syncs, audiences, destinations…" />
                {destOptions.length > 1 && (
                  <select className="input sm" value={dest} onChange={(e) => setDest(e.target.value)} aria-label="Destination">
                    <option value="">All destinations</option>
                    {destOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                  </select>
                )}
                {brandOptions.length > 1 && (
                  <select className="input sm" value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Brand">
                    <option value="">All brands</option>
                    {brandOptions.map((b) => <option key={b ?? 'none'} value={b ?? ''}>{me.brandName(b)}</option>)}
                  </select>
                )}
                <div className="sx-chips">
                  <FilterChips label="Sync health" value={group as Group} onChange={(v) => setGroup(v)} options={[
                    { value: 'all', label: 'All', count: counts.all },
                    { value: 'approval', label: 'Needs review', count: counts.approval, tone: 'amber' },
                    { value: 'failing', label: 'Failing', count: counts.failing, tone: 'red' },
                    { value: 'waiting', label: 'No credentials', count: counts.waiting, tone: 'amber' },
                    { value: 'paused', label: 'Paused', count: counts.paused, tone: 'gray' },
                    { value: 'healthy', label: 'Healthy', count: counts.healthy, tone: 'green' },
                  ]} />
                </div>
              </>}
              footer={<Pager page={paged.page} pages={paged.pages} total={filtered.length} pageSize={PAGE} onPage={paged.setPage} noun="sync" />}>
              {paged.slice.map(({ s, h }) => (
                <ListRow key={s.id} selected={selected?.s.id === s.id} onSelect={() => setSel(String(s.id))}
                  leading={<span className="sx-lead"><DestIcon type={s.destination_type} size={34} /><span className={`sx-lead-dot ${h.tone}`} aria-label={h.label} /></span>}
                  title={<span className="sx-title">{s.name}{(s.alert_count ?? 0) > 0 && <span className={`al-flag ${s.alert_level === 2 ? 'critical' : 'warning'}`} title={`${s.alert_count} active alert${s.alert_count === 1 ? '' : 's'}`}><Bell />{s.alert_count}</span>}</span>}
                  subtitle={<span className={`sx-sentence ${h.tone}`}>{h.sentence}</span>}
                  meta={<><strong>{nextText(s)}</strong><span>{s.last_run_at ? `ran ${fmt.ago(s.last_run_at)}` : 'never run'}</span></>} />
              ))}
              {!filtered.length && <NoResults what="syncs" onClear={clear} />}
            </ListPane>
          }
          inspector={selected
            ? <SyncInspector key={selected.s.id} s={selected.s} health={selected.h} onChanged={() => { syncs.reload(); recent.reload() }} />
            : <Inspector empty={<div><strong>No sync selected</strong><div className="small">Pick one on the left to see its health, runs and settings.</div></div>} />} />
      )}
    </div>
  )
}
