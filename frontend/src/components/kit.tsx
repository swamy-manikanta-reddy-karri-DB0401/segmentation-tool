/**
 * Shared building blocks so every page behaves the same:
 * list state in the URL (search / filters / sort / page), search box, filter chips, sortable headers,
 * pagination, "no results", skeletons, toasts, confirm dialogs and the ⌘K quick-find palette.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api'

// ---------------------------------------------------------------------------
// list state kept in the URL, so filters survive reloads and links can be shared

export function useUrlState(key: string, fallback = ''): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams()
  const value = params.get(key) ?? fallback
  const set = useCallback((v: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (v === fallback || v === '') next.delete(key)
      else next.set(key, v)
      if (key !== 'page') next.delete('page')
      return next
    }, { replace: true })
  }, [key, fallback, setParams])
  return [value, set]
}

export type Sort = { key: string; dir: 'asc' | 'desc' }

export function useSort(fallback: string): [Sort, (key: string) => void] {
  const [raw, set] = useUrlState('sort', fallback)
  const sort: Sort = raw.startsWith('-') ? { key: raw.slice(1), dir: 'desc' } : { key: raw, dir: 'asc' }
  const toggle = (key: string) => set(sort.key === key ? (sort.dir === 'asc' ? `-${key}` : key) : key)
  return [sort, toggle]
}

export function sortBy<T>(rows: T[], sort: Sort, get: Record<string, (r: T) => string | number | null | undefined>): T[] {
  const f = get[sort.key]
  if (!f) return rows
  const dir = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = f(a), y = f(b)
    if (x == null && y == null) return 0
    if (x == null) return 1
    if (y == null) return -1
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * dir
  })
}

export function matches(q: string, ...fields: (string | null | undefined)[]): boolean {
  const needle = q.trim().toLowerCase()
  return !needle || fields.some((f) => (f ?? '').toLowerCase().includes(needle))
}

/** Pagination over an in-memory list. With `urlKey` the page is kept in the URL. */
export function usePaged<T>(items: T[], pageSize: number, resetKey: unknown, urlKey?: string) {
  const [local, setLocal] = useState(0)
  const [urlPage, setUrlPage] = useUrlState(urlKey ?? '__none', '1')
  const page = urlKey ? Math.max(0, Number(urlPage) - 1 || 0) : local
  const setPage = (p: number) => (urlKey ? setUrlPage(String(p + 1)) : setLocal(p))
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    if (!urlKey) setLocal(0)
  }, [resetKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const pages = Math.max(1, Math.ceil(items.length / pageSize))
  const current = Math.min(page, pages - 1)
  return { page: current, pages, setPage, slice: items.slice(current * pageSize, current * pageSize + pageSize) }
}

// ---------------------------------------------------------------------------
// small UI pieces

export function SearchBox({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean }) {
  return (
    <label className="dm-search">
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      <input value={value} placeholder={placeholder} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && value && (e.stopPropagation(), onChange(''))} aria-label={placeholder} />
      {value && <button type="button" onClick={() => onChange('')} aria-label="Clear search">×</button>}
    </label>
  )
}

export function Pager({ page, pages, total, pageSize, onPage, noun }: { page: number; pages: number; total: number; pageSize: number; onPage: (p: number) => void; noun: string }) {
  if (total <= pageSize) return <div className="dm-pager"><span>{total.toLocaleString()} {noun}{total === 1 ? '' : 's'}</span></div>
  return (
    <div className="dm-pager">
      <span>{(page * pageSize + 1).toLocaleString()}–{Math.min(total, (page + 1) * pageSize).toLocaleString()} of {total.toLocaleString()} {noun}s</span>
      <div className="row" style={{ gap: 4 }}>
        <button className="btn ghost sm" disabled={page === 0} onClick={() => onPage(page - 1)}>‹ Prev</button>
        <span className="small muted">Page {page + 1} / {pages}</span>
        <button className="btn ghost sm" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Next ›</button>
      </div>
    </div>
  )
}

/** Segmented filter with optional counts: All 24 · Running 3 · Failing 1 */
export function FilterChips<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string; count?: number; tone?: string }[]; label: string
}) {
  return (
    <div className="seg kit-chips" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.tone && <span className={`kit-dot ${o.tone}`} aria-hidden="true" />}{o.label}{o.count != null && <span className="kit-chip-n">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function SortTh({ k, sort, onSort, children, className }: { k: string; sort: Sort; onSort: (k: string) => void; children: ReactNode; className?: string }) {
  const on = sort.key === k
  return (
    <th className={`kit-sort ${on ? 'on' : ''} ${className ?? ''}`} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button onClick={() => onSort(k)}>{children}<span aria-hidden="true">{on ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}</span></button>
    </th>
  )
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="dm-toolbar kit-toolbar">{children}</div>
}

export function NoResults({ what, onClear }: { what: string; onClear: () => void }) {
  return <div className="dm-none">No {what} match your filters. <button className="btn ghost sm" onClick={onClear}>Clear filters</button></div>
}

export function SkeletonRows({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="kit-skel" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="kit-skel-row">{Array.from({ length: cols }).map((__, j) => <span key={j} style={{ width: `${[38, 18, 14, 12][j % 4]}%` }} />)}</div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// toasts:  toast('Saved')  ·  toast('Couldn't save', 'error')

type Toast = { id: number; text: string; tone: 'success' | 'error' | 'info' }
let pushToast: (t: Omit<Toast, 'id'>) => void = () => undefined

export function toast(text: string, tone: Toast['tone'] = 'success') {
  pushToast({ text, tone })
}

export function ToastHost() {
  const [items, setItems] = useState<Toast[]>([])
  useEffect(() => {
    let n = 0
    pushToast = (t) => {
      const id = ++n
      setItems((xs) => [...xs.slice(-3), { ...t, id }])
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.tone === 'error' ? 7000 : 3500)
    }
  }, [])
  return createPortal(
    <div className="kit-toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`kit-toast ${t.tone}`}>
          <span className="kit-toast-icon" aria-hidden="true">{t.tone === 'success' ? '✓' : t.tone === 'error' ? '!' : 'i'}</span>
          <span>{t.text}</span>
          <button onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>, document.body)
}

// ---------------------------------------------------------------------------
// confirm dialog:  if (await askConfirm({ title, body, confirmLabel, danger: true })) …

type ConfirmReq = { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean; resolve: (ok: boolean) => void }
let openConfirm: (r: ConfirmReq) => void = (r) => r.resolve(window.confirm(r.title))

export function askConfirm(opts: Omit<ConfirmReq, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => openConfirm({ ...opts, resolve }))
}

export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmReq | null>(null)
  const ok = useRef<HTMLButtonElement>(null)
  useEffect(() => { openConfirm = setReq }, [])
  useEffect(() => { if (req) setTimeout(() => ok.current?.focus(), 0) }, [req])
  if (!req) return null
  const done = (v: boolean) => { req.resolve(v); setReq(null) }
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && done(false)} onKeyDown={(e) => e.key === 'Escape' && done(false)}>
      <div className="modal kit-confirm" role="alertdialog" aria-modal="true" aria-label={req.title}>
        <div className="kit-confirm-body">
          <span className={`kit-confirm-icon ${req.danger ? 'danger' : ''}`} aria-hidden="true">{req.danger ? '!' : '?'}</span>
          <div><h2>{req.title}</h2>{req.body && <div className="small muted" style={{ marginTop: 6 }}>{req.body}</div>}</div>
        </div>
        <div className="modal-foot">
          <span className="grow" />
          <button className="btn" onClick={() => done(false)}>Cancel</button>
          <button ref={ok} className={`btn ${req.danger ? 'danger-fill' : 'primary'}`} onClick={() => done(true)}>{req.confirmLabel ?? 'Confirm'}</button>
        </div>
      </div>
    </div>, document.body)
}

// ---------------------------------------------------------------------------
// ⌘K / Ctrl+K quick find

type Hit = { kind: string; label: string; hint?: string; to: string }
const PAGES: Hit[] = [
  { kind: 'Page', label: 'Home', to: '/' }, { kind: 'Page', label: 'Audiences', to: '/audiences' },
  { kind: 'Page', label: 'Syncs', to: '/activations' }, { kind: 'Page', label: 'Alerts', to: '/alerts' }, { kind: 'Page', label: 'Destinations', to: '/destinations' },
  { kind: 'Page', label: 'Profiles', to: '/profiles' }, { kind: 'Page', label: 'Traits', to: '/traits' },
  { kind: 'Page', label: 'Data model', to: '/schema' }, { kind: 'Page', label: 'Sources', to: '/sources' },
  { kind: 'Page', label: 'Priority lists', to: '/governance?tab=priority' }, { kind: 'Page', label: 'Destination rules', to: '/governance?tab=rules' },
  { kind: 'Page', label: 'Access & roles', to: '/access' },
  { kind: 'Action', label: 'New audience', to: '/audiences/new' }, { kind: 'Action', label: 'New sync', to: '/activations/new' },
]

export function QuickFind() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [data, setData] = useState<Hit[] | null>(null)
  const nav = useNavigate()
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o) }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('quickfind:open', onOpen)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('quickfind:open', onOpen) }
  }, [])
  useEffect(() => {
    if (!open) return
    setQ(''); setActive(0)
    const safe = <T,>(p: Promise<T[]>) => p.catch(() => [] as T[])
    Promise.all([
      safe(api.get<{ id: number; name: string; last_size: number | null }[]>('/audiences')),
      safe(api.get<{ id: number; name: string; destination_name: string }[]>('/syncs')),
      safe(api.get<{ id: number; name: string; type: string }[]>('/destinations')),
      safe(api.get<{ id: number; name: string; kind: string }[]>('/models')),
    ]).then(([aud, syncs, dests, models]) => setData([
      ...aud.map((a) => ({ kind: 'Audience', label: a.name, hint: a.last_size != null ? `${a.last_size.toLocaleString()} people` : undefined, to: `/audiences/${a.id}` })),
      ...syncs.map((s) => ({ kind: 'Sync', label: s.name, hint: s.destination_name, to: `/activations/${s.id}` })),
      ...dests.map((d) => ({ kind: 'Destination', label: d.name, to: '/destinations' })),
      ...models.filter((m) => m.kind === 'parent').map((m) => ({ kind: 'Parent model', label: m.name, to: `/schema?parent=${m.id}` })),
    ]))
  }, [open])

  const hits = useMemo(() => {
    const all = [...(data ?? []), ...PAGES]
    const needle = q.trim().toLowerCase()
    if (!needle) return [...(data ?? []).slice(0, 6), ...PAGES.slice(0, 6)]
    return all.filter((h) => h.label.toLowerCase().includes(needle) || h.kind.toLowerCase().includes(needle))
      .sort((a, b) => Number(!a.label.toLowerCase().startsWith(needle)) - Number(!b.label.toLowerCase().startsWith(needle))).slice(0, 30)
  }, [q, data])
  useEffect(() => { list.current?.querySelector('.qf-hit.on')?.scrollIntoView({ block: 'nearest' }) }, [active])

  if (!open) return null
  const go = (h: Hit) => { setOpen(false); nav(h.to) }
  return createPortal(
    <div className="overlay qf-overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="qf" role="dialog" aria-label="Quick find">
        <div className="qf-input">
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input autoFocus value={q} placeholder="Find audiences, syncs, destinations, pages…" onChange={(e) => { setQ(e.target.value); setActive(0) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
              else if (e.key === 'Enter' && hits[active]) go(hits[active])
              else if (e.key === 'Escape') setOpen(false)
            }} />
          <kbd>Esc</kbd>
        </div>
        <div className="qf-list" ref={list}>
          {data === null && <div className="dm-none">Loading…</div>}
          {data !== null && !hits.length && <div className="dm-none">Nothing matches “{q}”.</div>}
          {hits.map((h, i) => (
            <button key={`${h.kind}-${h.to}-${h.label}`} className={`qf-hit ${i === active ? 'on' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => go(h)}>
              <span className={`qf-kind k-${h.kind.toLowerCase().replace(/\s/g, '-')}`}>{h.kind}</span>
              <span className="qf-label">{h.label}</span>
              {h.hint && <span className="qf-hint">{h.hint}</span>}
              <span className="qf-enter" aria-hidden="true">↵</span>
            </button>
          ))}
        </div>
        <div className="qf-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>Ctrl</kbd>/<kbd>⌘</kbd> <kbd>K</kbd> anywhere</span></div>
      </div>
    </div>, document.body)
}
