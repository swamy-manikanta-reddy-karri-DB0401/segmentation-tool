import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import type { Model, Profile, ProfileSearch } from '../api'
import { Empty, ErrorBox, PageHead, Spinner, useAsync } from '../components/ui'

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

function EventTimeline({ ev }: { ev: Profile['events'][number] }) {
  const [expanded, setExpanded] = useState<number | null>(0)
  const tsIdx = ev.timestamp_column ? ev.columns.indexOf(ev.timestamp_column) : -1
  const keyCols = ev.columns.map((c, i) => ({ c, i })).filter(({ c, i }) => i !== tsIdx && !/(^|_)id$|_list$|^spine/.test(c))
  return (
    <div className="timeline">
      {ev.rows.length === 0 && <div className="small muted">No {ev.model_name.toLowerCase()} for this profile.</div>}
      {ev.rows.map((r, i) => (
        <div key={i} className={`tl-item ${expanded === i ? 'open' : ''}`}>
          <span className="tl-dot" />
          <button className="tl-head" onClick={() => setExpanded(expanded === i ? null : i)}>
            <span className="tl-time">{tsIdx >= 0 ? show(r[tsIdx], 'timestamp') : `Row ${i + 1}`}</span>
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
    </div>
  )
}

export default function Profiles() {
  const parents = useAsync(() => api.get<Model[]>('/parents'))
  const [parentId, setParentId] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t) }, [q])
  const pid = parentId ?? parents.data?.[0]?.id ?? null
  const search = useAsync(() => (pid ? api.get<ProfileSearch>(`/profiles/search?q=${encodeURIComponent(debounced)}&parent_id=${pid}`) : Promise.resolve(undefined)), [debounced, pid])
  const profile = useAsync(() => (selected && pid ? api.get<Profile>(`/profiles/${encodeURIComponent(selected)}?parent_id=${pid}`) : Promise.resolve(undefined)), [selected, pid])

  useEffect(() => {
    if (!selected && search.data?.results.length) setSelected(search.data.results[0].id)
  }, [search.data, selected])

  const p = profile.data
  const parentName = search.data?.parent.name ?? parents.data?.find((x) => x.id === pid)?.name ?? 'Profiles'

  return (
    <div className="page">
      <PageHead stage="modeling" title="Profiles" subtitle="A 360° view of each customer — attributes, computed traits, audience memberships and recent activity."
        actions={(parents.data?.length ?? 0) > 1 ? (
          <select className="input" value={pid ?? ''} onChange={(e) => { setParentId(Number(e.target.value)); setSelected(null) }}>
            {parents.data!.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        ) : undefined} />
      {parents.data && parents.data.length === 0 ? (
        <div className="card"><Empty title="No parent model yet" action={<Link to="/schema" className="btn primary">Set up schema</Link>}>Profiles come from your parent model.</Empty></div>
      ) : (
        <div className="profiles">
          <div className="card profile-list">
            <div className="profile-search">
              <input className="input" placeholder={`Search ${parentName.toLowerCase()} by name, email or ID…`} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <ErrorBox error={search.error} />
            <div className="profile-results">
              {search.loading && !search.data && <div style={{ padding: 16 }}><Spinner label="Searching…" /></div>}
              {search.data?.results.map((r) => (
                <button key={r.id} className={`profile-item ${selected === r.id ? 'on' : ''}`} onClick={() => setSelected(r.id)}>
                  <span className="avatar sm">{initials(r.label ?? r.secondary ?? r.id)}</span>
                  <span className="grow">
                    <strong>{r.label ?? r.id}</strong>
                    <span className="small muted">{r.secondary ?? r.id}</span>
                  </span>
                </button>
              ))}
              {search.data && !search.data.results.length && <div className="small muted" style={{ padding: 16 }}>No matches.</div>}
            </div>
          </div>

          <div className="profile-detail">
            {!selected ? <div className="card"><Empty title="Select a profile">Pick someone on the left to see their full profile.</Empty></div>
              : profile.loading && !p ? <div className="card card-pad"><Spinner label="Loading profile…" /></div>
                : profile.error ? <ErrorBox error={profile.error} />
                  : p && (<>
                    <div className="card profile-head">
                      <span className="avatar lg">{initials(p.label ?? p.secondary ?? p.id)}</span>
                      <div className="grow">
                        <h2>{p.label ?? p.id}</h2>
                        <div className="muted">{p.secondary}</div>
                        <div className="row wrap" style={{ marginTop: 8, gap: 6 }}>
                          <span className="badge brand">{p.parent.name}</span>
                          <span className="badge mono">ID {p.id}</span>
                          <span className="badge">{p.audiences.filter((a) => a.member).length} audience{p.audiences.filter((a) => a.member).length === 1 ? '' : 's'}</span>
                        </div>
                      </div>
                    </div>

                    {p.traits.length > 0 && (
                      <div className="card card-pad">
                        <div className="section-title">Traits</div>
                        <div className="trait-grid">
                          {p.traits.map((t) => (
                            <div key={t.id} className="trait-tile">
                              <span>{t.name}</span>
                              <strong>{show(t.value, t.type)}</strong>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {p.audiences.length > 0 && (
                      <div className="card card-pad">
                        <div className="section-title">Audience membership</div>
                        <div className="row wrap" style={{ gap: 8 }}>
                          {p.audiences.map((a) => (
                            <Link key={a.id} to={`/audiences/${a.id}`} className={`member-chip ${a.member ? 'in' : 'out'}`}>
                              <span>{a.member ? '✓' : '–'}</span>{a.name}
                            </Link>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="card card-pad">
                      <div className="section-title">Attributes</div>
                      <div className="attr-grid">
                        {p.attributes.map((a) => (
                          <div key={a.name} className="kv"><span>{a.label}</span><strong>{show(a.value, a.type)}</strong></div>
                        ))}
                      </div>
                    </div>

                    {p.events.map((ev) => (
                      <div key={ev.model_id} className="card card-pad">
                        <div className="spread"><div className="section-title">{ev.model_name}</div><span className="small faint">latest {ev.rows.length}</span></div>
                        <EventTimeline ev={ev} />
                      </div>
                    ))}
                  </>)}
          </div>
        </div>
      )}
    </div>
  )
}
