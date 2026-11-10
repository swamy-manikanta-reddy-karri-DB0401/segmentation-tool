/**
 * Small pieces shared by the segmentation pages (Audiences, Audience builder, Traits, Governance).
 */
import { useCallback } from 'react'
import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Audience, ColumnType, ConditionNode, GroupNode, Schema, Sync } from '../api'
import { fmt } from '../api'
import { conditionText } from '../components/builder/ConditionEditor'

const DAY = 86_400_000

/** Selected item kept in the URL (?id=) without resetting the list's page. */
export function useSelected(key = 'id'): [string, (v: string | null) => void] {
  const [params, setParams] = useSearchParams()
  const set = useCallback((v: string | null) => setParams((prev) => {
    const next = new URLSearchParams(prev)
    if (v == null || v === '') next.delete(key)
    else next.set(key, v)
    return next
  }, { replace: true }), [key, setParams])
  return [params.get(key) ?? '', set]
}

/** How trustworthy the stored size is: never counted, filters changed since, or simply old. */
export function sizeState(a: Pick<Audience, 'last_size' | 'size_updated_at' | 'updated_at'>): { tone: '' | 'amber' | 'faint'; text: string } {
  if (a.last_size == null || !a.size_updated_at) return { tone: 'faint', text: 'Not counted yet' }
  if (a.updated_at && new Date(a.updated_at).getTime() - new Date(a.size_updated_at).getTime() > 60_000) {
    return { tone: 'amber', text: 'Filters changed since the last count' }
  }
  const age = Date.now() - new Date(a.size_updated_at).getTime()
  if (age > 7 * DAY) return { tone: 'amber', text: `Counted ${fmt.ago(a.size_updated_at)} · may be stale` }
  return { tone: '', text: `Counted ${fmt.ago(a.size_updated_at)}` }
}

export const ownerName = (email?: string) => (email ? email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()) : '')

const ICON = {
  audience: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  number: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  string: 'M4 7V5h16v2M9 19h6M12 5v14',
  boolean: 'M9 12l2 2 4-4M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  timestamp: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  rule: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  priority: 'M3 6h12M3 12h9M3 18h6M17 8l3-3 3 3M20 5v14',
}

/** Rounded gradient tile with a line glyph — the identity mark of a segmentation object. */
export function Glyph({ kind, size = 34, tone = 'teal' }: { kind: keyof typeof ICON; size?: number; tone?: 'teal' | 'blue' | 'violet' | 'amber' | 'green' }) {
  const s = Math.round(size * 0.5)
  return (
    <span className={`sg-glyph ${tone}`} style={{ width: size, height: size, borderRadius: Math.max(8, Math.round(size * 0.3)) }} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={ICON[kind]} /></svg>
    </span>
  )
}

export function traitGlyph(type: ColumnType | 'list'): { kind: keyof typeof ICON; tone: 'teal' | 'blue' | 'violet' | 'amber' | 'green' } {
  if (type === 'list') return { kind: 'list', tone: 'violet' }
  if (type === 'number') return { kind: 'number', tone: 'teal' }
  if (type === 'boolean') return { kind: 'boolean', tone: 'green' }
  if (type === 'timestamp' || type === 'date') return { kind: 'timestamp', tone: 'amber' }
  return { kind: 'string', tone: 'blue' }
}

/** Share of the parent as a small ring — only shown when the share is known and honest. */
export function SizeRing({ pct, size = 34 }: { pct: number; size?: number }) {
  const r = (size - 5) / 2, c = 2 * Math.PI * r
  return (
    <svg className="sg-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${pct.toFixed(0)}% of everyone`}>
      <circle cx={size / 2} cy={size / 2} r={r} className="sg-ring-track" />
      <circle cx={size / 2} cy={size / 2} r={r} className="sg-ring-fill" strokeDasharray={`${(Math.max(pct, 1.5) / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="53%" dominantBaseline="middle" textAnchor="middle" className="sg-ring-text">{pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%</text>
    </svg>
  )
}

/** Each top-level filter as a readable line, e.g. “Has Subscription is false”. */
export function filterLines(def: GroupNode | undefined, schema: Schema | undefined, audiences: Audience[]): { kind: ConditionNode['type']; text: string }[] {
  if (!def || !schema?.parent) return []
  const ctx = { schema, audiences }
  return def.conditions.map((c) => ({ kind: c.type, text: conditionText(c, ctx) || 'Custom filter' }))
}

const KIND_TAG: Record<string, string> = { property: 'Property', event: 'Event', relation: 'Related', trait: 'Trait', audience: 'Audience', group: 'Group', split: 'Split' }

/** The definition read out as a stacked list joined by “and” / “or”. */
export function DefinitionLines({ lines, op }: { lines: { kind: string; text: string }[]; op: 'and' | 'or' }) {
  if (!lines.length) return <div className="sg-def-empty">No filters — everyone qualifies.</div>
  return (
    <ol className="sg-def">
      {lines.map((l, i) => (
        <li key={i}>
          {i > 0 && <span className={`sg-def-join ${op}`}>{op}</span>}
          <span className="sg-def-line"><span className={`sg-def-kind k-${l.kind}`}>{KIND_TAG[l.kind] ?? l.kind}</span><span>{l.text}</span></span>
        </li>
      ))}
    </ol>
  )
}

/** Sync status in plain words, for "where it's sent" lists. */
export function syncState(s: Sync): { tone: string; text: string } {
  if (s.approval_status === 'pending') return { tone: 'amber', text: 'Waiting for approval' }
  if (s.approval_status === 'rejected') return { tone: 'red', text: 'Changes requested' }
  if (s.destination_configured === false) return { tone: 'amber', text: 'Waiting for credentials' }
  if (!s.enabled) return { tone: 'gray', text: 'Paused' }
  if (s.running) return { tone: 'blue', text: 'Running now' }
  if (s.last_status === 'failed') return { tone: 'red', text: 'Last run failed' }
  if (s.last_status === 'completed_with_errors') return { tone: 'amber', text: 'Some records rejected' }
  if (s.last_status === 'success') return { tone: 'green', text: s.last_run_at ? `Delivered ${fmt.ago(s.last_run_at)}` : 'Delivered' }
  return { tone: 'gray', text: 'Not run yet' }
}

export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`sg-pill ${tone}`}><span className="sg-pill-dot" aria-hidden="true" />{children}</span>
}

/** Small overlapping logos of the destinations an audience is sent to. */
export function LogoStack({ children }: { children: ReactNode }) {
  return <span className="sg-logostack">{children}</span>
}
