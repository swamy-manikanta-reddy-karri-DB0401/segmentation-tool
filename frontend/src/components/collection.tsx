/**
 * The list + inspector pattern used across modules (same feel as the Data model page):
 * a searchable list on the left, the selected item's details on the right — no navigating away to look.
 * Selection lives in the URL (?id=) so links are shareable and Back works.
 */
import type { ReactNode } from 'react'
import { createContext, useContext, useEffect, useRef } from 'react'

const CloseCtx = createContext<(() => void) | null>(null)

/**
 * `open` = something is selected. Until then the list uses the full width and there is no details panel;
 * once an item is picked the panel appears, with a close button (`onClose`) that goes back to the full-width list.
 */
export function CollectionLayout({ list, inspector, wideInspector, open = true, onClose }: {
  list: ReactNode; inspector: ReactNode; wideInspector?: boolean; open?: boolean; onClose?: () => void
}) {
  return (
    <div className={`cx-layout ${wideInspector ? 'wide' : ''} ${open ? '' : 'solo'}`}>
      {list}
      {open && <CloseCtx.Provider value={onClose ?? null}>{inspector}</CloseCtx.Provider>}
    </div>
  )
}

/** Left pane: header (title, count, actions), toolbar (search/filters), scrolling rows, footer (pager). */
export function ListPane({ title, count, actions, toolbar, children, footer }: {
  title: ReactNode; count?: number; actions?: ReactNode; toolbar?: ReactNode; children: ReactNode; footer?: ReactNode
}) {
  return (
    <section className="card cx-list">
      <header className="cx-list-head">
        <div className="row" style={{ gap: 8 }}><h2>{title}</h2>{count != null && <span className="cx-count">{count.toLocaleString()}</span>}</div>
        {actions && <div className="row" style={{ gap: 6 }}>{actions}</div>}
      </header>
      {toolbar && <div className="cx-list-tools">{toolbar}</div>}
      <div className="cx-rows" role="listbox">{children}</div>
      {footer && <div className="cx-list-foot">{footer}</div>}
    </section>
  )
}

/** One selectable row. Arrow keys move between rows; Enter selects. */
export function ListRow({ selected, onSelect, leading, title, subtitle, meta, trailing }: {
  selected: boolean; onSelect: () => void; leading?: ReactNode; title: ReactNode; subtitle?: ReactNode; meta?: ReactNode; trailing?: ReactNode
}) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (selected) ref.current?.scrollIntoView({ block: 'nearest' }) }, [selected])
  return (
    <button ref={ref} role="option" aria-selected={selected} className={`cx-row ${selected ? 'on' : ''}`} onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const sib = (e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling) as HTMLElement | null
          sib?.focus(); sib?.click()
        }
      }}>
      {leading && <span className="cx-row-lead">{leading}</span>}
      <span className="cx-row-main"><span className="cx-row-title">{title}</span>{subtitle && <span className="cx-row-sub">{subtitle}</span>}</span>
      {meta && <span className="cx-row-meta">{meta}</span>}
      {trailing && <span className="cx-row-trail">{trailing}</span>}
    </button>
  )
}

/** Right pane: identity header, one plain-English sentence, optional tabs, body. */
export function Inspector({ icon, kicker, title, sentence, actions, tabs, children, empty }: {
  icon?: ReactNode; kicker?: ReactNode; title?: ReactNode; sentence?: ReactNode; actions?: ReactNode
  tabs?: { key: string; label: ReactNode; active: boolean; onClick: () => void }[]; children?: ReactNode; empty?: ReactNode
}) {
  const close = useContext(CloseCtx)
  if (empty) return <aside className="card cx-inspector cx-inspector-empty">{empty}</aside>
  return (
    <aside className="card cx-inspector">
      <header className="cx-ins-head">
        {icon}
        <div style={{ minWidth: 0, flex: 1 }}>
          {kicker && <div className="cx-kicker">{kicker}</div>}
          <h2 className="cx-ins-title" title={typeof title === 'string' ? title : undefined}>{title}</h2>
        </div>
        {actions && <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>{actions}</div>}
        {close && <button className="btn ghost sm cx-ins-close" onClick={close} aria-label="Close details" title="Close details">✕</button>}
      </header>
      {sentence && <p className="cx-sentence">{sentence}</p>}
      {tabs && (
        <div className="tabs cx-tabs" role="tablist">
          {tabs.map((t) => <button key={t.key} role="tab" aria-selected={t.active} className={`tab ${t.active ? 'active' : ''}`} onClick={t.onClick}>{t.label}</button>)}
        </div>
      )}
      <div className="cx-ins-body">{children}</div>
    </aside>
  )
}

/** Labelled facts block (key → value rows) used inside inspectors. */
export function Facts({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return <div className="cx-facts">{rows.map(([k, v], i) => <div key={i} className="cx-fact"><span>{k}</span><div>{v}</div></div>)}</div>
}

/** A titled section inside an inspector. */
export function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return <section className="cx-section"><div className="cx-section-head"><h3>{title}</h3>{aside}</div>{children}</section>
}

/** Headline number tile (the right form for a single KPI — not a chart). */
export function StatTile({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  return <div className={`cx-stat ${tone ?? ''}`}><span className="cx-stat-label">{label}</span><strong className="cx-stat-value">{value}</strong>{sub && <span className="cx-stat-sub">{sub}</span>}</div>
}
