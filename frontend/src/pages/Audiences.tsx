import { Link, useNavigate } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Audience, Overview } from '../api'
import { Empty, ErrorBox, PageHead, useAsync } from '../components/ui'
import { useMe } from '../components/me'
import { FilterChips, matches, NoResults, Pager, SearchBox, SkeletonRows, SortTh, Toolbar, sortBy, usePaged, useSort, useUrlState } from '../components/kit'
import '../ux/segment.css'

const PAGE_SIZE = 25
const DAY = 86_400_000

/** How trustworthy the stored size is: never counted, filters changed since, or simply old. */
export function sizeState(a: Pick<Audience, 'last_size' | 'size_updated_at' | 'updated_at'>): { tone: '' | 'amber' | 'faint'; text: string } {
  if (a.last_size == null || !a.size_updated_at) return { tone: 'faint', text: 'Not counted yet' }
  if (a.updated_at && new Date(a.updated_at).getTime() - new Date(a.size_updated_at).getTime() > 60_000) {
    return { tone: 'amber', text: 'Filters changed since this count' }
  }
  const age = Date.now() - new Date(a.size_updated_at).getTime()
  if (age > 7 * DAY) return { tone: 'amber', text: `Counted ${fmt.ago(a.size_updated_at)} · may be stale` }
  return { tone: '', text: `Counted ${fmt.ago(a.size_updated_at)}` }
}

export const ownerName = (email?: string) => (email ? email.split('@')[0].replace(/[._]/g, ' ') : '')

export default function Audiences() {
  const me = useMe()
  const canBuild = me.can('audiences.edit')
  const nav = useNavigate()
  const { data, error, loading } = useAsync(() => api.get<Audience[]>('/audiences'))
  const overview = useAsync(() => api.get<Overview>('/overview'))
  const [q, setQ] = useUrlState('q')
  const [brand, setBrand] = useUrlState('brand', 'all')
  const [parent, setParent] = useUrlState('parent', 'all')
  const [synced, setSynced] = useUrlState('synced', 'all')
  const [sort, toggleSort] = useSort('-updated')

  const all = data ?? []
  const brands = [...new Set(all.map((a) => a.brand_id ?? null))]
  const parents = [...new Map(all.map((a) => [a.parent_id, a.parent_name ?? `Model ${a.parent_id}`])).entries()]
  // a share-of-total bar is only honest when everything is built on one parent model
  const total = parents.length === 1 && (overview.data?.schema.parents ?? 0) === 1 ? overview.data?.modeling.profiles ?? 0 : 0

  const base = all.filter((a) => (brand === 'all' || String(a.brand_id ?? 'none') === brand)
    && (parent === 'all' || String(a.parent_id) === parent) && matches(q, a.name, a.description, a.parent_name, a.created_by))
  const rows = sortBy(base.filter((a) => synced === 'all' || (synced === 'yes' ? (a.sync_count ?? 0) > 0 : !a.sync_count)), sort, {
    name: (a) => a.name.toLowerCase(), size: (a) => a.last_size, updated: (a) => a.updated_at, owner: (a) => a.created_by || null,
  })
  const paged = usePaged(rows, PAGE_SIZE, `${q}|${brand}|${parent}|${synced}|${sort.key}${sort.dir}`, 'page')
  const filtered = q || brand !== 'all' || parent !== 'all' || synced !== 'all'
  const clear = () => { setQ(''); setBrand('all'); setParent('all'); setSynced('all') }
  const syncedCount = base.filter((a) => (a.sync_count ?? 0) > 0).length

  return (
    <div className="page wide">
      <PageHead stage="segmentation" title="Audiences"
        subtitle="Groups of people defined by who they are and what they do — built visually, counted live in Databricks."
        actions={canBuild ? <Link to="/audiences/new" className="btn primary">+ New audience</Link> : undefined} />
      <ErrorBox error={error} />

      {loading && !data ? <SkeletonRows rows={6} /> : !all.length ? (
        <div className="card">
          <Empty title="No audiences yet" action={canBuild ? <Link to="/audiences/new" className="btn primary">Build your first audience</Link> : undefined}>
            Combine profile attributes, traits and engagement events to find exactly the people you want to reach — no SQL needed.
            {!canBuild && <div className="small faint" style={{ marginTop: 8 }}>Your role can view audiences; ask a Brand Marketing Admin or Audience Builder to create one.</div>}
          </Empty>
        </div>
      ) : (<>
        <Toolbar>
          <SearchBox value={q} onChange={setQ} placeholder={`Search ${all.length} audiences…`} />
          <FilterChips label="Synced" value={synced as 'all' | 'yes' | 'no'} onChange={setSynced} options={[
            { value: 'all', label: 'All', count: base.length },
            { value: 'yes', label: 'Synced', count: syncedCount, tone: 'green' },
            { value: 'no', label: 'Not synced', count: base.length - syncedCount, tone: 'gray' },
          ]} />
          {parents.length > 1 && (
            <select className="input sm" value={parent} onChange={(e) => setParent(e.target.value)} aria-label="Parent model">
              <option value="all">All parent models</option>
              {parents.map(([id, name]) => <option key={id} value={String(id)}>{name}</option>)}
            </select>
          )}
          {brands.length > 1 && (
            <select className="input sm" value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Brand">
              <option value="all">All brands</option>
              {brands.map((b) => <option key={b ?? 'none'} value={String(b ?? 'none')}>{me.brandName(b)}</option>)}
            </select>
          )}
          <span className="grow" />
          {filtered && <button className="btn ghost sm" onClick={clear}>Clear filters</button>}
        </Toolbar>

        <div className="card seg-card">
          {rows.length ? (
            <table className="table seg-table">
              <thead><tr>
                <SortTh k="name" sort={sort} onSort={toggleSort}>Audience</SortTh>
                <SortTh k="size" sort={sort} onSort={toggleSort} className="seg-size-col">Size</SortTh>
                <th>Syncs</th>
                <SortTh k="owner" sort={sort} onSort={toggleSort} className="seg-hide-sm">Owner</SortTh>
                <SortTh k="updated" sort={sort} onSort={toggleSort} className="seg-hide-sm">Updated</SortTh>
              </tr></thead>
              <tbody>
                {paged.slice.map((a) => {
                  const pct = total && a.last_size != null ? Math.min(100, (a.last_size / total) * 100) : null
                  const st = sizeState(a)
                  return (
                    <tr key={a.id} className="clickable" tabIndex={0} onClick={() => nav(`/audiences/${a.id}`)}
                      onKeyDown={(e) => e.key === 'Enter' && nav(`/audiences/${a.id}`)}>
                      <td>
                        <div className="seg-name">
                          <span className="aud-icon" aria-hidden="true">{a.name.slice(0, 1).toUpperCase()}</span>
                          <div style={{ minWidth: 0 }}>
                            <Link to={`/audiences/${a.id}`} className="seg-title" title={a.name} onClick={(e) => e.stopPropagation()}>{a.name}</Link>
                            {a.description && <div className="small muted seg-desc" title={a.description}>{a.description}</div>}
                            {(parents.length > 1 || brands.length > 1) && <div className="seg-meta">
                              {parents.length > 1 && a.parent_name && <span>Built on {a.parent_name}</span>}
                              {brands.length > 1 && <span className="badge">{me.brandName(a.brand_id)}</span>}
                            </div>}
                          </div>
                        </div>
                      </td>
                      <td className="seg-size-col">
                        <div className="aud-size">
                          <span className={`aud-n ${a.last_size == null ? 'faint' : ''}`}>{a.last_size == null ? '—' : fmt.num(a.last_size)}</span>
                          {pct != null && <span className="small faint">{pct.toFixed(pct < 10 ? 1 : 0)}%</span>}
                        </div>
                        {pct != null && <div className="meter thin"><div style={{ width: `${Math.max(pct, 1.5)}%` }} /></div>}
                        <div className={`small seg-size-note ${st.tone}`} title={a.size_updated_at ? new Date(a.size_updated_at).toLocaleString() : undefined}>
                          {st.tone === 'amber' && <span aria-hidden="true">● </span>}{st.text}
                        </div>
                      </td>
                      <td>{a.sync_count
                        ? <span className="badge brand">{a.sync_count} sync{a.sync_count === 1 ? '' : 's'}</span>
                        : <span className="faint small">Not synced</span>}</td>
                      <td className="seg-hide-sm"><span className="seg-owner" title={a.created_by || undefined}>{ownerName(a.created_by) || <span className="faint">—</span>}</span></td>
                      <td className="muted seg-hide-sm" title={new Date(a.updated_at).toLocaleString()}>{fmt.ago(a.updated_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : <NoResults what="audiences" onClear={clear} />}
        </div>
        <Pager page={paged.page} pages={paged.pages} total={rows.length} pageSize={PAGE_SIZE} onPage={paged.setPage} noun="audience" />
      </>)}
    </div>
  )
}
