import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Audience, Calculation, Overview, Schema, Sync } from '../api'
import { ErrorBox, PageHead, useAsync } from '../components/ui'
import { useMe } from '../components/me'
import { askConfirm, matches, NoResults, Pager, SearchBox, SkeletonRows, sortBy, toast, usePaged, useUrlState } from '../components/kit'
import { CollectionLayout, Facts, Inspector, ListPane, ListRow, Section, StatTile } from '../components/collection'
import { Funnel } from '../components/viz'
import { BrandLogo } from '../components/logos'
import { DefinitionLines, filterLines, Glyph, LogoStack, ownerName, Pill, SizeRing, sizeState, syncState, useSelected } from '../ux/segment-kit'
import '../ux/segment.css'

export { ownerName, sizeState } from '../ux/segment-kit'

const PAGE_SIZE = 12
const SORTS = [
  { value: '-updated', label: 'Recently updated' },
  { value: '-size', label: 'Largest first' },
  { value: 'size', label: 'Smallest first' },
  { value: 'name', label: 'Name A–Z' },
]

/** The selected audience: who's in it, how the filters narrow it, where it goes. */
function AudienceInspector({ a, schema, audiences, syncs, totalHint, canEdit, canSync, onDeleted, onCounted }: {
  a: Audience; schema?: Schema; audiences: Audience[]; syncs: Sync[]; totalHint: number; canEdit: boolean; canSync: boolean; onDeleted: () => void; onCounted?: () => void
}) {
  const nav = useNavigate()
  const [calc, setCalc] = useState<Calculation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setCalc(null); setError(null) }, [a.id])

  const lines = filterLines(a.definition, schema, audiences)
  const st = sizeState(a)
  const size = calc?.size ?? a.last_size
  const total = calc?.total || totalHint
  const pct = total && size != null ? (size / total) * 100 : null
  const parentLabel = (a.parent_name ?? schema?.parent?.name ?? 'people').toLowerCase()
  const count = async () => {
    setBusy(true); setError(null)
    try {
      const r = await api.post<Calculation>('/audiences/calculate', { definition: a.definition, parent_id: a.parent_id })
      setCalc(r)
      if (canEdit && r.size !== a.last_size) {  // keep the list's stored size in step with what was just counted
        await api.put(`/audiences/${a.id}`, { last_size: r.size }).then(() => onCounted?.()).catch(() => undefined)
      }
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const copy = async () => {
    try {
      const c = await api.post<Audience>('/audiences', { name: `${a.name} (copy)`, description: a.description, definition: a.definition, splits: a.splits, parent_id: a.parent_id })
      toast(`Copied as “${c.name}”`); nav(`/audiences/${c.id}`)
    } catch (e) { toast((e as Error).message, 'error') }
  }
  const remove = async () => {
    if (syncs.length) { toast(`“${a.name}” is used by ${syncs.length} sync${syncs.length === 1 ? '' : 's'} — remove ${syncs.length === 1 ? 'it' : 'them'} first`, 'error'); return }
    if (!await askConfirm({ title: `Delete “${a.name}”?`, body: 'The audience definition is removed for everyone. This can’t be undone.', confirmLabel: 'Delete audience', danger: true })) return
    try { await api.del(`/audiences/${a.id}`); toast(`“${a.name}” deleted`); onDeleted() } catch (e) { toast((e as Error).message, 'error') }
  }
  const steps = calc && calc.steps.length === lines.length && a.definition.op === 'and'
    ? lines.map((l, i) => ({ label: l.text, value: calc.steps[i] })) : null

  return (
    <Inspector
      icon={<Glyph kind="audience" size={40} />}
      kicker={<>Audience · {a.parent_name ?? schema?.parent?.name}</>}
      title={a.name}
      actions={<Link className="btn primary sm" to={`/audiences/${a.id}`}>{canEdit ? 'Open builder' : 'Open'}</Link>}
      sentence={lines.length === 1
        ? <>Everyone in <strong>{parentLabel}</strong> who matches this filter.</>
        : lines.length
        ? <>Everyone in <strong>{parentLabel}</strong> who matches <strong>{a.definition.op === 'or' ? 'any' : 'all'}</strong> of {lines.length} filters.</>
        : <>Everyone in <strong>{parentLabel}</strong> — no filters yet.</>}>
      {a.description && <p className="sg-desc">{a.description}</p>}

      <div className="cx-stats">
        <StatTile label="People" value={size == null ? '—' : fmt.num(size)} sub={calc ? 'Counted just now' : st.text} tone={!calc && st.tone === 'amber' ? 'warn' : undefined} />
        <StatTile label={`Share of ${parentLabel}`} value={pct == null ? '—' : `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`} sub={total ? `of ${fmt.num(total)}` : 'Count to see'} />
        <StatTile label="Destinations" value={syncs.length} sub={syncs.length ? 'syncs' : 'Not sent yet'} />
      </div>

      <Section title="Who's in it">
        <DefinitionLines lines={lines} op={a.definition.op} />
      </Section>

      <Section title="How the filters narrow it down" aside={<button className={`btn sm ${calc ? 'ghost' : ''}`} onClick={count} disabled={busy}>{busy ? 'Counting…' : calc ? 'Count again' : 'Count now'}</button>}>
        <ErrorBox error={error} />
        {steps ? <Funnel steps={steps} total={calc!.total} />
          : calc ? <div className="small muted">{fmt.num(calc.size)} of {fmt.num(calc.total)} {parentLabel} qualify{a.definition.op === 'or' ? ' (filters are combined with “any”, so they don’t narrow step by step)' : ''}.</div>
            : <div className="sg-hint">Counts run live in Databricks. Count to see how many people each filter keeps.</div>}
      </Section>

      <Section title="Where it's sent" aside={canSync ? <Link className="small" to={`/activations/new?audience=${a.id}`}>+ Send to a destination</Link> : undefined}>
        {syncs.length ? (
          <div className="sg-sendlist">
            {syncs.slice(0, 5).map((s) => {
              const ss = syncState(s)
              return (
                <Link key={s.id} to={`/activations/${s.id}`} className="sg-send" title={`${s.name} → ${s.destination_name}`}>
                  <BrandLogo type={s.destination_type} size={30} />
                  <span className="sg-send-main"><strong>{s.destination_name}</strong><small>{s.name}{s.config.split_group ? ` · ${s.config.split_group}` : ''}</small></span>
                  <Pill tone={ss.tone}>{ss.text}</Pill>
                </Link>
              )
            })}
            {syncs.length > 5 && <Link className="small sg-more-link" to={`/activations?q=${encodeURIComponent(a.name)}`}>+{syncs.length - 5} more syncs</Link>}
          </div>
        ) : <div className="sg-hint">Not sent anywhere yet.{canSync ? ' Send it to Sailthru, Google Ad Manager or another tool to start reaching these people.' : ''}</div>}
      </Section>

      <Section title="Details">
        <Facts rows={[
          ['Built on', a.parent_name ?? schema?.parent?.name ?? '—'],
          ['Owner', ownerName(a.created_by) || '—'],
          ['Last changed', <span title={new Date(a.updated_at).toLocaleString()}>{fmt.ago(a.updated_at)}</span>],
          ['A/B split', a.splits?.enabled ? a.splits.groups.map((g) => `${g.name} ${g.percent}%`).join(' · ') : 'Off'],
        ]} />
      </Section>

      {canEdit && (
        <div className="sg-quiet-actions">
          <button className="btn ghost sm" onClick={copy}>Duplicate</button>
          <span className="grow" />
          <button className="btn ghost sm danger" onClick={remove}>Delete audience</button>
        </div>
      )}
    </Inspector>
  )
}

function Onboarding({ canBuild }: { canBuild: boolean }) {
  const ideas = [
    ['Engaged non-subscribers', 'Watched 3+ videos in 30 days but never subscribed — perfect for a subscription offer.'],
    ['Lapsing readers', 'Visited weekly last quarter, nothing in the last 21 days — a winback journey.'],
    ['High-value newsletter fans', 'Open most newsletters and read 10+ articles a month — invite to premium.'],
  ]
  return (
    <div className="card sg-onboard">
      <Glyph kind="audience" size={52} />
      <h2>Build your first audience</h2>
      <p className="muted">Combine who people are, what they did and computed traits — no SQL. Sizes are counted live in Databricks, then you send the audience to your marketing tools.</p>
      <div className="sg-ideas">
        {ideas.map(([t, d]) => <div key={t} className="sg-idea"><strong>{t}</strong><span>{d}</span></div>)}
      </div>
      {canBuild ? <Link to="/audiences/new" className="btn primary">+ New audience</Link>
        : <div className="small faint">Your role can view audiences. Ask a Brand Marketing Admin or Audience Builder to create one.</div>}
    </div>
  )
}

export default function Audiences() {
  const me = useMe()
  const canBuild = me.can('audiences.edit')
  const audiences = useAsync(() => api.get<Audience[]>('/audiences'))
  const syncs = useAsync(() => api.get<Sync[]>('/syncs'))
  const overview = useAsync(() => api.get<Overview>('/overview'))
  const [q, setQ] = useUrlState('q')
  const [parent, setParent] = useUrlState('parent', 'all')
  const [brand, setBrand] = useUrlState('brand', 'all')
  const [sortKey, setSortKey] = useUrlState('sort', '-updated')
  const [selected, setSelected] = useSelected()

  const all = audiences.data ?? []
  const parents = [...new Map(all.map((a) => [a.parent_id, a.parent_name ?? `Model ${a.parent_id}`])).entries()]
  const brands = [...new Set(all.map((a) => a.brand_id ?? null))]
  // a share-of-everyone figure is only honest when everything is built on one parent model
  const oneParentTotal = parents.length === 1 && (overview.data?.schema.parents ?? 0) === 1 ? overview.data?.modeling.profiles ?? 0 : 0
  const syncsBy = useMemo(() => {
    const m = new Map<number, Sync[]>()
    for (const s of syncs.data ?? []) m.set(s.audience_id, [...(m.get(s.audience_id) ?? []), s])
    return m
  }, [syncs.data])

  const base = all.filter((a) => (brand === 'all' || String(a.brand_id ?? 'none') === brand)
    && (parent === 'all' || String(a.parent_id) === parent) && matches(q, a.name, a.description, a.parent_name, a.created_by))
  const sort = sortKey.startsWith('-') ? { key: sortKey.slice(1), dir: 'desc' as const } : { key: sortKey, dir: 'asc' as const }
  const rows = sortBy(base, sort, {
    name: (a) => a.name.toLowerCase(), size: (a) => a.last_size, updated: (a) => a.updated_at,
  })
  const paged = usePaged(rows, PAGE_SIZE, `${q}|${brand}|${parent}|${sortKey}`, 'page')
  const current = all.find((a) => String(a.id) === selected)
  const schema = useAsync(() => (current ? api.get<Schema>(`/schema?parent_id=${current.parent_id}`) : Promise.resolve(undefined)), [current?.parent_id])
  const filtered = !!q || parent !== 'all' || brand !== 'all'
  const clear = () => { setQ(''); setParent('all'); setBrand('all') }

  return (
    <div className="page wide sg-page">
      <PageHead stage="segmentation" title="Audiences"
        subtitle="Groups of people you want to reach — built from who they are and what they do, counted live in Databricks."
        actions={canBuild && all.length ? <Link to="/audiences/new" className="btn primary">+ New audience</Link> : undefined} />
      <ErrorBox error={audiences.error} />

      {audiences.loading && !audiences.data ? <SkeletonRows rows={6} /> : !all.length ? <Onboarding canBuild={canBuild} /> : (
        <CollectionLayout open={!!current} onClose={() => setSelected(null)}
          list={
            <ListPane title="All audiences" count={rows.length}
              toolbar={<>
                <SearchBox value={q} onChange={setQ} placeholder="Search by name, description or owner…" />
                <select className="input sm" value={sortKey} onChange={(e) => setSortKey(e.target.value)} aria-label="Sort">
                  {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
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
                {filtered && <button className="btn ghost sm" onClick={clear}>Clear</button>}
              </>}
              footer={rows.length > PAGE_SIZE ? <Pager page={paged.page} pages={paged.pages} total={rows.length} pageSize={PAGE_SIZE} onPage={paged.setPage} noun="audience" /> : undefined}>
              {rows.length ? paged.slice.map((a) => {
                const st = sizeState(a)
                const sent = syncsBy.get(a.id) ?? []
                const pct = oneParentTotal && a.last_size != null ? (a.last_size / oneParentTotal) * 100 : null
                return (
                  <ListRow key={a.id} selected={current?.id === a.id} onSelect={() => setSelected(String(a.id))}
                    leading={pct != null ? <SizeRing pct={pct} /> : <Glyph kind="audience" />}
                    title={a.name}
                    subtitle={a.description || (parents.length > 1 ? `Built on ${a.parent_name}` : `Updated ${fmt.ago(a.updated_at)}`)}
                    meta={<><strong>{a.last_size == null ? '—' : fmt.num(a.last_size)}</strong><span className={`sg-fresh ${st.tone}`}>{a.last_size == null ? 'not counted' : st.tone === 'amber' ? 'may be stale' : 'people'}</span></>}
                    trailing={sent.length ? <LogoStack>{[...new Map(sent.map((s) => [s.destination_type + s.destination_id, s])).values()].slice(0, 3).map((s) => <BrandLogo key={s.id} type={s.destination_type} size={22} title={s.destination_name} />)}</LogoStack>
                      : <span className="sg-notsent">Not sent</span>} />
                )
              }) : <NoResults what="audiences" onClear={clear} />}
            </ListPane>
          }
          inspector={current ? (
            <AudienceInspector a={current} schema={schema.data} audiences={all} syncs={syncsBy.get(current.id) ?? []} totalHint={oneParentTotal}
              canEdit={me.can('audiences.edit', current.brand_id ?? null)} canSync={me.can('syncs.edit', current.brand_id ?? null)}
              onDeleted={() => { setSelected(null); audiences.reload() }} onCounted={audiences.reload} />
          ) : <Inspector empty={<div>Select an audience to see who's in it.</div>} />}
        />
      )}
    </div>
  )
}
