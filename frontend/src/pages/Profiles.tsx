import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import type { Model, Profile, ProfileSearch } from '../api'
import { Empty, ErrorBox, PageHead, useAsync } from '../components/ui'
import { SearchBox, SkeletonRows, toast, useUrlState } from '../components/kit'
import '../ux/home.css'

const RECENT_KEY = 'mm-cdp-recent-profiles'
type Recent = { id: string; label: string; parent: number }

function readRecent(): Recent[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') as Recent[] } catch { return [] }
}
function rememberRecent(r: Recent) {
  try {
    const next = [r, ...readRecent().filter((x) => !(x.id === r.id && x.parent === r.parent))].slice(0, 6)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch { /* storage unavailable — recents just won't be remembered */ }
}

function initials(s: string | null | undefined) {
  const parts = (s ?? '').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase()
}

/** Stable, pleasant avatar hue per person (teal / blue / violet / green / amber family). */
function hue(s: string) {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360
  return [176, 205, 255, 150, 32][h % 5]
}

const isDate = (v: unknown, type?: string) => typeof v === 'string' && (type === 'timestamp' || type === 'date' || /^\d{4}-\d{2}-\d{2}[T ]/.test(v)) && !Number.isNaN(Date.parse(v))

function show(v: unknown, type?: string): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 })
  const s = String(v)
  if (isDate(s, type)) return new Date(s).toLocaleString(undefined, { dateStyle: 'medium', ...(/T00:00:00/.test(s) ? {} : { timeStyle: 'short' }) })
  if (s.startsWith('[') && s.endsWith(']')) {
    try { return (JSON.parse(s) as unknown[]).join(', ') || '—' } catch { /* not JSON */ }
  }
  return s
}
const nice = (c: string) => c.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())

/** Attributes grouped the way a marketer reads them. */
function groupOf(a: Profile['attributes'][number]): string {
  const n = a.name.toLowerCase()
  if (/(^|_)(id|uid|key)$|_id_|_list$|^spine/.test(n)) return 'Identifiers'
  if (a.type === 'boolean' || /status|engagement|has_|is_|opt|consent|subscri/.test(n)) return 'Status & preferences'
  if (/name|email|phone|address|city|country|zip|postal/.test(n)) return 'Contact'
  if (a.type === 'timestamp' || a.type === 'date' || /date|_at$|_on$/.test(n)) return 'Dates'
  return 'Other details'
}
const GROUP_ORDER = ['Contact', 'Status & preferences', 'Dates', 'Other details', 'Identifiers']

function Attributes({ attrs }: { attrs: Profile['attributes'] }) {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const shown = attrs.filter((a) => !needle || a.label.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle) || show(a.value, a.type).toLowerCase().includes(needle))
  const groups = GROUP_ORDER.map((g) => ({ g, items: shown.filter((a) => groupOf(a) === g) })).filter((x) => x.items.length)
  return (
    <section className="card pf-card">
      <div className="pf-card-head">
        <h3>Attributes <span className="pf-n">{attrs.length}</span></h3>
      </div>
      {attrs.length > 8 && <div className="pf-attr-search"><SearchBox value={q} onChange={setQ} placeholder="Find an attribute or value…" /></div>}
      <div className="pf-attrs">
        {groups.map(({ g, items }) => (
          <div key={g} className="pf-group">
            <div className="pf-group-label">{g}</div>
            <dl>
              {items.map((a) => (
                <div key={a.name} className="pf-kv" title={a.name}>
                  <dt>{a.label}</dt>
                  <dd className={a.value == null || a.value === '' ? 'blank' : ''} title={show(a.value, a.type)}>{show(a.value, a.type)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
        {!groups.length && <div className="dm-none">No attribute matches “{q}”.</div>}
      </div>
    </section>
  )
}

type Ev = { model: string; ts: string | null; key: string; summary: { k: string; v: string }[]; all: { k: string; v: string }[] }

/** All event models merged into one story, newest first, grouped by day. */
function Activity({ events }: { events: Profile['events'] }) {
  const [open, setOpen] = useState<string | null>(null)
  const [limit, setLimit] = useState(8)
  const items: Ev[] = useMemo(() => events.flatMap((ev) => {
    const tsIdx = ev.timestamp_column ? ev.columns.indexOf(ev.timestamp_column) : -1
    const cols = ev.columns.map((c, i) => ({ c, i })).filter(({ c, i }) => i !== tsIdx && !/(^|_)id$|_list$|^spine|_uid$/.test(c))
    const informative = cols.filter(({ i }) => ev.rows.some((r) => r[i] != null && r[i] !== '' && r[i] !== 0))
    return ev.rows.map((r, n) => {
      const pairs = cols.map(({ c, i }) => ({ k: nice(c), v: show(r[i]) }))
      // lead with the numbers a marketer cares about (page views, visits…), then descriptive fields
      const ranked = [...informative].sort((x, y) => Number(typeof r[y.i] === 'number') - Number(typeof r[x.i] === 'number'))
      const summary = ranked.map(({ c, i }) => ({ k: nice(c), v: show(r[i]) })).filter((p) => p.v !== '—' && p.v !== '0' && !/^\d{1,2} \w{3} \d{4}/.test(p.v)).slice(0, 4)
      return { model: ev.model_name, ts: tsIdx >= 0 && r[tsIdx] != null ? String(r[tsIdx]) : null, key: `${ev.model_id}-${n}`, summary, all: pairs }
    })
  }).sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? '')), [events])
  if (!items.length) return <div className="pf-quiet">No activity recorded for this person yet.</div>
  const shown = items.slice(0, limit)
  const days: { day: string; list: Ev[] }[] = []
  for (const it of shown) {
    const day = it.ts ? new Date(it.ts).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : 'Undated'
    const last = days[days.length - 1]
    if (last && last.day === day) last.list.push(it)
    else days.push({ day, list: [it] })
  }
  return (
    <div className="pf-story">
      {days.map((d) => (
        <div key={d.day} className="pf-day">
          <div className="pf-day-label">{d.day}</div>
          {d.list.map((it) => (
            <div key={it.key} className={`pf-ev ${open === it.key ? 'open' : ''}`}>
              <span className="pf-ev-dot" aria-hidden="true" />
              <button className="pf-ev-head" onClick={() => setOpen(open === it.key ? null : it.key)} aria-expanded={open === it.key}>
                <span className="pf-ev-title"><strong>{it.model}</strong>{it.ts && <time>{new Date(it.ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>}</span>
                <span className="pf-ev-facts">{it.summary.map((p) => <span key={p.k}><em>{p.k}</em> {p.v}</span>)}</span>
                <span className="pf-ev-caret" aria-hidden="true">{open === it.key ? '−' : '+'}</span>
              </button>
              {open === it.key && (
                <dl className="pf-ev-body">
                  {it.all.map((p) => <div key={p.k} className="pf-kv"><dt>{p.k}</dt><dd className={p.v === '—' ? 'blank' : ''}>{p.v}</dd></div>)}
                </dl>
              )}
            </div>
          ))}
        </div>
      ))}
      {items.length > limit && <button className="btn ghost sm pf-more" onClick={() => setLimit(limit + 20)}>Show more ({items.length - limit} earlier)</button>}
    </div>
  )
}

export default function Profiles() {
  const parents = useAsync(() => api.get<Model[]>('/parents'))
  const [parentParam, setParentParam] = useUrlState('parent')
  const [q, setQ] = useUrlState('q')
  const [selected, setSelected] = useUrlState('id')
  const [debounced, setDebounced] = useState(q)
  const [recent, setRecent] = useState<Recent[]>(readRecent)
  const [showOut, setShowOut] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t) }, [q])

  const pid = Number(parentParam) || parents.data?.[0]?.id || null
  const search = useAsync(() => (pid ? api.get<ProfileSearch>(`/profiles/search?q=${encodeURIComponent(debounced)}&parent_id=${pid}`) : Promise.resolve(undefined)), [debounced, pid])
  const profile = useAsync(() => (selected && pid ? api.get<Profile>(`/profiles/${encodeURIComponent(selected)}?parent_id=${pid}`) : Promise.resolve(undefined)), [selected, pid])
  const results = useMemo(() => search.data?.results ?? [], [search.data])

  // open the first match automatically, so the page is never blank
  useEffect(() => { if (!selected && results.length) setSelected(results[0].id) }, [results, selected, setSelected])
  useEffect(() => {
    const p = profile.data
    if (p && pid) { rememberRecent({ id: p.id, label: p.label ?? p.id, parent: pid }); setRecent(readRecent()) }
  }, [profile.data, pid])
  useEffect(() => setShowOut(false), [selected])

  const p = profile.data
  const parentName = search.data?.parent.name ?? parents.data?.find((x) => x.id === pid)?.name ?? 'people'
  const recents = recent.filter((r) => r.parent === pid && r.id !== selected)
  const members = p?.audiences.filter((a) => a.member) ?? []
  const nonMembers = p?.audiences.filter((a) => !a.member) ?? []
  const lastSeen = useMemo(() => {
    if (!p) return null
    const ts = p.events.flatMap((ev) => { const i = ev.timestamp_column ? ev.columns.indexOf(ev.timestamp_column) : -1; return i >= 0 ? ev.rows.map((r) => r[i]) : [] })
      .filter((v): v is string => typeof v === 'string').sort().pop()
    return ts ?? null
  }, [p])
  const eventCount = p?.events.reduce((a, e) => a + e.rows.length, 0) ?? 0

  const onKey = (e: React.KeyboardEvent) => {
    if (!results.length || !(e.key === 'ArrowDown' || e.key === 'ArrowUp')) return
    e.preventDefault()
    const i = Math.max(0, results.findIndex((r) => r.id === selected))
    const next = results[e.key === 'ArrowDown' ? Math.min(i + 1, results.length - 1) : Math.max(i - 1, 0)]
    setSelected(next.id)
  }
  useEffect(() => { listRef.current?.querySelector('.pf-result.on')?.scrollIntoView({ block: 'nearest' }) }, [selected])

  const copy = () => { void navigator.clipboard?.writeText(window.location.href).then(() => toast('Link to this profile copied')) }

  return (
    <div className="page wide pf">
      <PageHead stage="modeling" title="Profiles"
        subtitle="Everything the platform knows about one person — who they are, what they did, and which audiences they're in."
        actions={(parents.data?.length ?? 0) > 1 ? (
          <label className="pf-parent">
            <span>Showing</span>
            <select className="input" value={pid ?? ''} onChange={(e) => { setParentParam(e.target.value); setSelected('') }} aria-label="Parent model">
              {parents.data!.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
        ) : undefined} />

      {parents.data && parents.data.length === 0 ? (
        <div className="card"><Empty title="No parent model yet" action={<Link to="/schema" className="btn primary">Set up the data model</Link>}>Profiles come from your parent model — the table with one row per customer.</Empty></div>
      ) : (
        <div className="pf-layout">
          <aside className="card pf-list" onKeyDown={onKey}>
            <div className="pf-list-search">
              <SearchBox value={q} onChange={setQ} placeholder={`Search ${parentName.toLowerCase()} by name, email or ID`} autoFocus />
            </div>
            {!q && recents.length > 0 && (
              <div className="pf-recent">
                <div className="pf-group-label">Recently viewed</div>
                <div className="pf-chips">
                  {recents.map((r) => <button key={r.id} className="pf-chip" onClick={() => setSelected(r.id)} title={`${r.label} · ${r.id}`}>{r.label}</button>)}
                </div>
              </div>
            )}
            <ErrorBox error={search.error} />
            <div className="pf-results" ref={listRef} role="listbox" aria-label="People">
              {search.loading && !search.data && <div style={{ padding: 8 }}><SkeletonRows rows={7} cols={1} /></div>}
              {results.length > 0 && <div className="pf-results-label">{q ? `${results.length}${results.length >= 20 ? '+' : ''} matches` : parentName}</div>}
              {results.map((r) => {
                const label = r.label ?? r.id
                return (
                  <button key={r.id} role="option" aria-selected={selected === r.id} className={`pf-result ${selected === r.id ? 'on' : ''}`} onClick={() => setSelected(r.id)}>
                    <span className="pf-avatar sm" style={{ ['--h' as string]: hue(r.id) }}>{initials(label)}</span>
                    <span className="pf-result-main"><strong>{label}</strong><span>{r.secondary ?? r.id}</span></span>
                  </button>
                )
              })}
              {results.length >= 20 && <div className="pf-cap">Showing the first 20 — type more to narrow it down.</div>}
              {search.data && !results.length && (
                <div className="pf-noresult"><strong>No one matches “{q}”</strong><span>Try part of a name, an email address or an exact ID.</span></div>
              )}
            </div>
            {results.length > 1 && <div className="pf-list-foot">↑ ↓ to move between people</div>}
          </aside>

          <main className="pf-detail">
            {!selected ? <div className="card"><Empty title="Find a person">Search on the left by name, email or ID.</Empty></div>
              : profile.loading && !p ? <div className="card pf-card"><SkeletonRows rows={8} cols={3} /></div>
                : profile.error ? <ErrorBox error={profile.error} />
                  : p && (<>
                    <section className="card pf-hero">
                      <span className="pf-avatar lg" style={{ ['--h' as string]: hue(p.id) }}>{initials(p.label ?? p.secondary ?? p.id)}</span>
                      <div className="pf-hero-main">
                        <h2>{p.label ?? p.id}</h2>
                        {p.secondary && <div className="pf-hero-sub">{p.secondary}</div>}
                        <div className="pf-hero-meta">
                          <span><em>{p.parent.name.replace(/s$/, '')} ID</em><code>{p.id}</code></span>
                          {lastSeen && <span><em>Last activity</em>{new Date(lastSeen).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span>}
                          <span><em>Audiences</em>{members.length} of {p.audiences.length}</span>
                        </div>
                      </div>
                      <button className="btn sm" onClick={copy} title="Copy a link to this profile">Copy link</button>
                    </section>

                    <div className="pf-body">
                      <div className="pf-col">
                        {p.traits.length > 0 && (
                          <section className="card pf-card">
                            <div className="pf-card-head"><h3>Traits</h3><Link to="/traits" className="pf-link">Manage →</Link></div>
                            <div className="pf-traits">
                              {p.traits.map((t) => (
                                <div key={t.id} className="pf-trait"><span>{t.name}</span>
                                  {isDate(t.value, t.type) ? (<>
                                    <strong>{new Date(String(t.value)).toLocaleDateString(undefined, { dateStyle: 'medium' })}</strong>
                                    <small>{new Date(String(t.value)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · {Math.max(0, Math.round((Date.now() - Date.parse(String(t.value))) / 86400000))} days ago</small>
                                  </>) : <strong title={show(t.value, t.type)}>{show(t.value, t.type)}</strong>}
                                </div>
                              ))}
                            </div>
                          </section>
                        )}
                        <section className="card pf-card">
                          <div className="pf-card-head"><h3>Activity <span className="pf-n">{eventCount}</span></h3><span className="pf-hint">Newest first</span></div>
                          <Activity events={p.events} />
                        </section>
                      </div>

                      <div className="pf-col">
                        <section className="card pf-card">
                          <div className="pf-card-head"><h3>Audiences</h3><span className="pf-hint">Right now</span></div>
                          {!p.audiences.length ? <div className="pf-quiet">No audiences built on {p.parent.name} yet.</div> : (<>
                            {members.length ? (
                              <div className="pf-aud">
                                {members.map((a) => <Link key={a.id} to={`/audiences/${a.id}`} className="pf-aud-chip in"><i aria-hidden="true">✓</i>{a.name}</Link>)}
                              </div>
                            ) : <div className="pf-quiet">Not in any audience right now.</div>}
                            {nonMembers.length > 0 && (<>
                              <button className="pf-toggle" onClick={() => setShowOut(!showOut)} aria-expanded={showOut}>
                                {showOut ? 'Hide' : 'Show'} the {nonMembers.length} audience{nonMembers.length === 1 ? '' : 's'} they're not in
                              </button>
                              {showOut && <div className="pf-aud">{nonMembers.map((a) => <Link key={a.id} to={`/audiences/${a.id}`} className="pf-aud-chip out">{a.name}</Link>)}</div>}
                            </>)}
                          </>)}
                        </section>
                        <Attributes attrs={p.attributes} />
                      </div>
                    </div>
                  </>)}
          </main>
        </div>
      )}
    </div>
  )
}
