import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Sync, SyncRun } from '../api'
import { scheduleLabel } from '../components/ScheduleEditor'
import { DestIcon, Empty, ErrorBox, PageHead, usePolling, useAsync } from '../components/ui'
import { useMe } from '../components/me'
import { FilterChips, matches, NoResults, Pager, SearchBox, SkeletonRows, SortTh, sortBy, Toolbar, usePaged, useSort, useUrlState } from '../components/kit'
import { HEALTH_GROUPS, syncHealth, until } from '../ux/syncHealth'
import type { Health } from '../ux/syncHealth'
import '../ux/activate.css'
import '../ux/alerts.css'

type Group = 'all' | keyof typeof HEALTH_GROUPS
const PAGE = 25

export default function Activations() {
  const nav = useNavigate()
  const syncs = useAsync(() => api.get<Sync[]>('/syncs'))
  const recent = useAsync(() => api.get<SyncRun[]>('/runs/recent'))
  usePolling(() => { syncs.reload(); recent.reload() }, 4000, !!syncs.data?.some((s) => s.running))
  const me = useMe()
  const [q, setQ] = useUrlState('q')
  const [group, setGroup] = useUrlState('status', 'all')
  const [dest, setDest] = useUrlState('dest')
  const [brand, setBrand] = useUrlState('brand')
  const [sort, toggleSort] = useSort('name')

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
    name: (r) => r.s.name.toLowerCase(), last: (r) => r.s.last_run_at ?? '', next: (r) => r.s.next_run_at ?? '~', dest: (r) => r.s.destination_name,
  })
  const paged = usePaged(filtered, PAGE, `${q}|${group}|${dest}|${brand}|${sort.key}${sort.dir}`, 'page')
  const toReview = rows.filter(({ s }) => s.approval_status === 'pending' && s.can?.approve)
  const canCreate = me.can('syncs.edit')
  const clear = () => { setQ(''); setGroup('all'); setDest(''); setBrand('') }

  return (
    <div className="page wide">
      <PageHead stage="activation" title="Syncs" subtitle="Audiences kept up to date in your marketing tools. Each run sends only what changed since the last one."
        actions={canCreate ? <Link to="/activations/new" className="btn primary">+ New sync</Link> : undefined} />
      <ErrorBox error={syncs.error} />

      {toReview.length > 0 && group !== 'approval' && (
        <div className="callout amber act-banner">
          <div className="callout-icon">✓</div>
          <div className="grow">
            <strong>{toReview.length} sync{toReview.length === 1 ? ' is' : 's are'} waiting for your approval</strong>
            <div className="small muted">Nothing is sent until you approve. Review the audience, destination and fields, then approve or send back with a note.</div>
          </div>
          {toReview.length === 1
            ? <Link to={`/activations/${toReview[0].s.id}`} className="btn sm primary">Review</Link>
            : <button className="btn sm primary" onClick={() => setGroup('approval')}>Review {toReview.length}</button>}
        </div>
      )}

      {syncs.loading && !syncs.data ? <SkeletonRows rows={6} cols={5} /> : !rows.length ? (
        <div className="card">
          <Empty title="Nothing activated yet" action={canCreate ? <Link to="/activations/new" className="btn primary">Activate an audience</Link> : undefined}>
            Pick an audience and a destination — we keep the destination up to date automatically, sending only what changed.
          </Empty>
        </div>
      ) : (<>
        <Toolbar>
          <SearchBox value={q} onChange={setQ} placeholder={`Search ${rows.length} syncs, audiences or destinations…`} />
          {destOptions.length > 1 && (
            <select className="input sm act-select" value={dest} onChange={(e) => setDest(e.target.value)} aria-label="Destination">
              <option value="">All destinations</option>
              {destOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          )}
          {brandOptions.length > 1 && (
            <select className="input sm act-select" value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Brand">
              <option value="">All brands</option>
              {brandOptions.map((b) => <option key={b ?? 'none'} value={b ?? ''}>{me.brandName(b)}</option>)}
            </select>
          )}
        </Toolbar>
        <div className="act-chips">
          <FilterChips label="Sync health" value={group as Group} onChange={(v) => setGroup(v)} options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'approval', label: 'Needs review', count: counts.approval, tone: 'amber' },
            { value: 'failing', label: 'Failing', count: counts.failing, tone: 'red' },
            { value: 'waiting', label: 'Waiting for credentials', count: counts.waiting, tone: 'amber' },
            { value: 'paused', label: 'Paused', count: counts.paused, tone: 'gray' },
            { value: 'healthy', label: 'Healthy', count: counts.healthy, tone: 'green' },
          ]} />
        </div>

        <div className="card act-table">
          <table className="table">
            <thead><tr>
              <SortTh k="name" sort={sort} onSort={toggleSort}>Sync</SortTh>
              <SortTh k="dest" sort={sort} onSort={toggleSort}>Destination</SortTh>
              <th>Status</th>
              <SortTh k="last" sort={sort} onSort={toggleSort}>Last run</SortTh>
              <SortTh k="next" sort={sort} onSort={toggleSort}>Next run</SortTh>
            </tr></thead>
            <tbody>
              {paged.slice.map(({ s, h }) => (
                <tr key={s.id} className="clickable" onClick={() => nav(`/activations/${s.id}`)}>
                  <td className="act-name">
                    <div className="row" style={{ gap: 8, flexWrap: 'nowrap', minWidth: 0 }}>
                      <Link to={`/activations/${s.id}`} onClick={(e) => e.stopPropagation()} className="act-title act-ellipsis">{s.name}</Link>
                      {(s.alert_count ?? 0) > 0 && (
                        <Link to={`/activations/${s.id}#alerts`} onClick={(e) => e.stopPropagation()} className={`al-flag ${s.alert_level === 2 ? 'critical' : 'warning'}`}
                          title={`${s.alert_count} active alert${s.alert_count === 1 ? '' : 's'}`} aria-label={`${s.alert_count} active alerts`}>
                          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /></svg>
                          {s.alert_count}
                        </Link>
                      )}
                    </div>
                    <div className="small muted act-ellipsis" title={`${s.audience_name} → ${s.destination_name}`}>Audience · {s.audience_name}<span className="act-narrow"> → {s.destination_name}</span></div>
                  </td>
                  <td><div className="row act-dest"><DestIcon type={s.destination_type} size={26} /><span className="act-ellipsis">{s.destination_name}</span></div></td>
                  <td className="act-status">
                    <span className={`act-pill ${h.tone}`}><span className={`kit-dot ${h.tone}`} />{h.label}</span>
                    <div className="small muted act-ellipsis" title={h.sentence}>{h.sentence}</div>
                  </td>
                  <td className="muted small" title={s.last_run_at ? new Date(s.last_run_at).toLocaleString() : undefined}>{fmt.ago(s.last_run_at)}</td>
                  <td className="small">
                    {s.schedule?.type === 'manual' || !s.schedule ? <span className="faint">Manual only</span>
                      : !s.enabled ? <span className="faint">Paused</span>
                        : s.approval_status !== 'approved' ? <span className="faint">After approval</span>
                          : <span title={s.next_run_at ? new Date(s.next_run_at).toLocaleString() : undefined}>{until(s.next_run_at)}</span>}
                    {s.schedule && s.schedule.type !== 'manual' && <div className="faint act-ellipsis" title={scheduleLabel(s.schedule)}>{scheduleLabel(s.schedule)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && <NoResults what="syncs" onClear={clear} />}
        </div>
        <Pager page={paged.page} pages={paged.pages} total={filtered.length} pageSize={PAGE} onPage={paged.setPage} noun="sync" />
      </>)}
    </div>
  )
}
