import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import type { Model, Profile, ProfileSearch } from '../api'
import { Empty, ErrorBox, PageHead, useAsync } from '../components/ui'
import { SearchBox, SkeletonRows, useUrlState } from '../components/kit'
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

function show(v: unknown, type?: string): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 })
  const s = String(v)
  if ((type === 'timestamp' || type === 'date' || /^\d{4}-\d{2}-\d{2}T/.test(s)) && !Number.isNaN(Date.parse(s))) {
    return new Date(s).toLocaleString(undefined, { dateStyle: 'medium', ...(s.includes('T00:00:00') ? {} : { timeStyle: 'short' }) })
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    try { return (JSON.parse(s) as unknown[]).join(', ') || '—' } catch { /* not JSON */ }
  }
  return s
}

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
  const shown = attrs.filter((a) => !needle || a.label.toLowerCase().includes(needle) || show(a.value, a.type).toLowerCase().includes(needle))
  const groups = GROUP_ORDER.map((g) => ({ g, items: shown.filter((a) => groupOf(a) === g) })).filter((x) => x.items.length)
  return (
    <section className="card card-pad">
      <div className="spread pf-sec-head">
        <div className="section-title" style={{ margin: 0 }}>Attributes <span className="pf-n">{attrs.length}</span></div>
        {attrs.length > 10 && <SearchBox value={q} onChange={setQ} placeholder="Find an attribute or value…" />}
      </div>
      {groups.map(({ g, items }) => (
        <div key={g} className="pf-group">
          <div className="pf-group-label">{g}</div>
          <div className="attr-grid">
            {items.map((a) => (
              <div key={a.name} className="kv" title={a.name}><span>{a.label}</span><strong title={show(a.value, a.type)}>{show(a.value, a.type)}</strong></div>
            ))}
          </div>
        </div>
      ))}
      {!groups.length && <div className="dm-none">No attribute matches “{q}”.</div>}
    </section>
  )
}

function EventTimeline({ ev }: { ev: Profile['events'][number] }) {
  const [expanded, setExpanded] = useState<number | null>(0)
  const [all, setAll] = useState(false)
  const tsIdx = ev.timestamp_column ? ev.columns.indexOf(ev.timestamp_column) : -1
  const keyCols = ev.columns.map((c, i) => ({ c, i })).filter(({ c, i }) => i !== tsIdx && !/(^|_)id$|_list$|^spine/.test(c))
  const rows = all ? ev.rows : ev.rows.slice(0, 5)
  return (
    <div className="timeline">
      {ev.rows.length === 0 && <div className="small muted">No {ev.model_name.toLowerCase()} recorded for this person.</div>}
      {rows.map((r, i) => (
        <div key={i} className={`tl-item ${expanded === i ? 'open' : ''}`}>
          <span className="tl-dot" />
          <button className="tl-head" onClick={() => setExpanded(expanded === i ? null : i)} aria-expanded={expanded === i}>
            <span className="tl-time">{tsIdx >= 0 ? show(r[tsIdx], 'timestamp') : `Record ${i + 1}`}</span>
            <span className="tl-summary">{keyCols.slice(0, 3).map(({ c, i: k }) => `${c.replace(/_/g, ' ')}: ${show(r[k])}`).join(' · ')}</span>
            <span className="tl-caret">{expanded === i ? '−' : '+'}</span>
          </button>
          {expanded === i && (
            <div className="tl-body">
              {keyCols.map(({ c, i: k }) => (
                <div key={c} className="kv"><span>{c.replace(/_/g, ' ')}</span><strong>{show(r[k])}</strong></div>
              ))}
            </div>
          )}
        </div>
      ))}
      {ev.rows.length > 5 && (
        <button className="btn ghost sm pf-more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${ev.rows.length}`}</button>
      )}
    </div>
  )
}

export default function Profiles() {
  const parents = useAsync(() => api.get<Model[]>('/parents'))
  const [parentParam, setParentParam] = useUrlState('parent')
  const [q, setQ] = useUrlState('q')
  const [selected, setSelected] = useUrlState('id')
  const [debounced, setDebounced] = useState(q)
  const [cursor, setCursor] = useState(0)
  const [recent, setRecent] = useState<Recent[]>(readRecent)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t) }, [q])

  const pid = Number(parentParam) || parents.data?.[0]?.id || null
  const search = useAsync(() => (pid ? api.get<ProfileSearch>(`/profiles/search?q=${encodeURIComponent(debounced)}&parent_id=${pid}`) : Promise.resolve(undefined)), [debounced, pid])
  const profile = useAsync(() => (selected && pid ? api.get<Profile>(`/profiles/${encodeURIComponent(selected)}?parent_id=${pid}`) : Promise.resolve(undefined)), [selected, pid])
  const results = useMemo(() => search.data?.results ?? [], [search.data])
  useEffect(() => setCursor(0), [results])

  // open the first match automatically, so the page is never blank
  useEffect(() => { if (!selected && results.length) setSelected(results[0].id) }, [results, selected, setSelected])
  useEffect(() => {
    const p = profile.data
    if (p && pid) { rememberRecent({ id: p.id, label: p.label ?? p.id, parent: pid }); setRecent(readRecent()) }
  }, [profile.data, pid])
  useEffect(() => { listRef.current?.querySelector('.profile-item.cursor')?.scrollIntoView({ block: 'nearest' }) }, [cursor])

  const p = profile.data
  const parentName = search.data?.parent.name ?? parents.data?.find((x) => x.id === pid)?.name ?? 'people'
  const recents = recent.filter((r) => r.parent === pid)
  const members = p?.audiences.filter((a) => a.member) ?? []
  const nonMembers = p?.audiences.filter((a) => !a.member) ?? []

  const onKey = (e: React.KeyboardEvent) => {
    if (!results.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); setSelected(results[cursor].id) }
  }

  return (
    <div className="page wide">
      <PageHead stage="modeling" title="Profiles" subtitle="Look up one person and see everything the platform knows: who they are, their computed traits, which audiences they're in and what they did recently."
        actions={(parents.data?.length ?? 0) > 1 ? (
          <select className="input" value={pid ?? ''} onChange={(e) => { setParentParam(e.target.value); setSelected('') }} aria-label="Parent model">
            {parents.data!.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        ) : undefined} />
      {parents.data && parents.data.length === 0 ? (
        <div className="card"><Empty title="No parent model yet" action={<Link to="/schema" className="btn primary">Set up the data model</Link>}>Profiles come from your parent model — the table with one row per customer.</Empty></div>
      ) : (
        <div className="profiles">
          <div className="card profile-list" onKeyDown={onKey}>
            <div className="profile-search">
              <SearchBox value={q} onChange={(v) => setQ(v)} placeholder={`Name, email or ID of ${parentName.toLowerCase()}…`} autoFocus />
              <div className="small faint pf-hint">↑ ↓ to move · Enter to open</div>
            </div>
            <ErrorBox error={search.error} />
            {!q && recents.length > 0 && (
              <div className="pf-recent">
                <div className="pf-group-label">Recently viewed</div>
                <div className="row wrap" style={{ gap: 6 }}>
                  {recents.map((r) => <button key={r.id} className={`pf-chip ${selected === r.id ? 'on' : ''}`} onClick={() => setSelected(r.id)} title={`${r.label} · ${r.id}`}>{r.label}</button>)}
                </div>
              </div>
            )}
            <div className="profile-results" ref={listRef}>
              {search.loading && !search.data && <SkeletonRows rows={6} cols={1} />}
              {results.length > 0 && <div className="pf-group-label" style={{ padding: '8px 10px 4px' }}>{q ? `${results.length}${results.length >= 20 ? '+' : ''} matches` : `${parentName}`}</div>}
              {results.map((r, i) => (
                <button key={r.id} className={`profile-item ${selected === r.id ? 'on' : ''} ${cursor === i ? 'cursor' : ''}`} onClick={() => setSelected(r.id)} onMouseEnter={() => setCursor(i)}>
                  <span className="avatar sm">{initials(r.label ?? r.secondary ?? r.id)}</span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <strong className="hm-ellipsis">{r.label ?? r.id}</strong>
                    <span className="small muted">{r.secondary ?? r.id}</span>
                  </span>
                </button>
              ))}
              {results.length >= 20 && <div className="small faint pf-cap">Showing the first 20 — type more to narrow it down.</div>}
              {search.data && !results.length && (
                <div className="dm-none">No one matches “{q}”.<br /><span className="small">Try part of a name, an email address or an exact ID.</span></div>
              )}
            </div>
          </div>

          <div className="profile-detail">
            {!selected ? <div className="card"><Empty title="Find a person">Search on the left by name, email or ID.</Empty></div>
              : profile.loading && !p ? <div className="card card-pad"><SkeletonRows rows={6} cols={3} /></div>
                : profile.error ? <ErrorBox error={profile.error} />
                  : p && (<>
                    <div className="card profile-head">
                      <span className="avatar lg">{initials(p.label ?? p.secondary ?? p.id)}</span>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <h2 className="hm-ellipsis">{p.label ?? p.id}</h2>
                        <div className="muted">{p.secondary}</div>
                        <div className="row wrap" style={{ marginTop: 8, gap: 6 }}>
                          <span className="badge brand">{p.parent.name}</span>
                          <span className="badge mono" title="Primary key">ID {p.id}</span>
                          <span className={`badge ${members.length ? 'green' : ''}`}>In {members.length} of {p.audiences.length} audience{p.audiences.length === 1 ? '' : 's'}</span>
                        </div>
                      </div>
                      <button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(window.location.href) }} title="Copy a link to this profile">Copy link</button>
                    </div>

                    {p.traits.length > 0 && (
                      <section className="card card-pad">
                        <div className="section-title">Traits <span className="pf-n">{p.traits.length}</span></div>
                        <div className="trait-grid">
                          {p.traits.map((t) => (
                            <div key={t.id} className="trait-tile"><span>{t.name}</span><strong title={show(t.value, t.type)}>{show(t.value, t.type)}</strong></div>
                          ))}
                        </div>
                      </section>
                    )}

                    {p.audiences.length > 0 && (
                      <section className="card card-pad">
                        <div className="section-title">Audiences</div>
                        {members.length ? (
                          <div className="row wrap" style={{ gap: 8 }}>
                            {members.map((a) => <Link key={a.id} to={`/audiences/${a.id}`} className="member-chip in"><span>✓</span>{a.name}</Link>)}
                          </div>
                        ) : <div className="small muted">Not in any audience right now.</div>}
                        {nonMembers.length > 0 && (
                          <details className="pf-details">
                            <summary className="small muted">Not in {nonMembers.length} other audience{nonMembers.length === 1 ? '' : 's'}</summary>
                            <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
                              {nonMembers.map((a) => <Link key={a.id} to={`/audiences/${a.id}`} className="member-chip out"><span>–</span>{a.name}</Link>)}
                            </div>
                          </details>
                        )}
                      </section>
                    )}

                    {p.events.map((ev) => (
                      <section key={ev.model_id} className="card card-pad">
                        <div className="spread"><div className="section-title">{ev.model_name}</div><span className="small faint">latest {ev.rows.length} · newest first</span></div>
                        <EventTimeline ev={ev} />
                      </section>
                    ))}

                    <Attributes attrs={p.attributes} />
                  </>)}
          </div>
        </div>
      )}
    </div>
  )
}
