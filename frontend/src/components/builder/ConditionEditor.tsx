import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import type {
  Audience, AudienceRefNode, Column, ColumnType, ConditionNode, EventNode, EventThen, GroupNode, Model, PropertyNode,
  RelationNode, Schema, SequenceNode, TimeWindow, TraitNode,
} from '../../api'
import TraitConfigEditor from '../TraitConfigEditor'

// ---------------------------------------------------------------------------
// context

interface BuilderCtx {
  schema: Schema
  audiences: Audience[]
  currentAudienceId?: number
  /** Cumulative audience size after each top-level condition (from Calculate size). */
  steps?: number[]
}
const Ctx = createContext<BuilderCtx | null>(null)
export const BuilderProvider = Ctx.Provider
export const useBuilder = () => useContext(Ctx)!

// ---------------------------------------------------------------------------
// operator catalog (Hightouch audience-filter reference)

// Labels read as a sentence after the column name: "Country  is  US", "Signup date  is within the  last 30 days".
const OPS: Record<ColumnType, { value: string; label: string }[]> = {
  string: [
    { value: 'equals', label: 'is' }, { value: 'not_equals', label: 'is not' },
    { value: 'contains', label: 'contains' }, { value: 'not_contains', label: 'does not contain' },
    { value: 'starts_with', label: 'starts with' }, { value: 'not_starts_with', label: 'does not start with' },
    { value: 'ends_with', label: 'ends with' }, { value: 'not_ends_with', label: 'does not end with' },
    { value: 'exists', label: 'has any value' }, { value: 'exists_not_empty', label: 'is not blank' },
    { value: 'not_exists', label: 'is missing' },
  ],
  number: [
    { value: 'equals', label: 'is' }, { value: 'not_equals', label: 'is not' },
    { value: 'gt', label: 'is more than' }, { value: 'lt', label: 'is less than' },
    { value: 'gte', label: 'is at least' }, { value: 'lte', label: 'is at most' },
    { value: 'between', label: 'is between' }, { value: 'exists', label: 'has any value' }, { value: 'not_exists', label: 'is missing' },
  ],
  boolean: [
    { value: 'equals', label: 'is' }, { value: 'not_equals', label: 'is not' },
    { value: 'exists', label: 'has any value' }, { value: 'not_exists', label: 'is missing' },
  ],
  timestamp: [
    { value: 'within', label: 'is within the' }, { value: 'not_within', label: 'is not within the' },
    { value: 'equals', label: 'is on' }, { value: 'before', label: 'is before' }, { value: 'after', label: 'is after' },
    { value: 'between', label: 'is between' }, { value: 'anniversary', label: 'has an anniversary' },
    { value: 'exists', label: 'has any value' }, { value: 'not_exists', label: 'is missing' },
  ],
  date: [],
  other: [{ value: 'exists', label: 'has any value' }, { value: 'not_exists', label: 'is missing' }],
}
OPS.date = OPS.timestamp

const FREQUENCY = [{ value: 'gte', label: 'at least' }, { value: 'lte', label: 'at most' }, { value: 'equals', label: 'exactly' }]
const COMPARE = [
  { value: 'gte', label: 'at least' }, { value: 'equals', label: 'exactly' }, { value: 'lte', label: 'at most' },
  { value: 'gt', label: 'more than' }, { value: 'lt', label: 'fewer than' }, { value: 'between', label: 'between' },
]
const UNITS = ['minute', 'hour', 'day', 'week', 'month', 'year']
const AGG_FNS = [
  { value: 'count', label: 'number of records' }, { value: 'sum', label: 'total' }, { value: 'avg', label: 'average' },
  { value: 'min', label: 'minimum' }, { value: 'max', label: 'maximum' }, { value: 'count_distinct', label: 'distinct count of' },
]

const emptyGroup = (): GroupNode => ({ type: 'group', op: 'and', conditions: [] })
const label = (c: string) => c.replace(/[._]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
const TYPE_ICON: Record<ColumnType, string> = { string: 'Abc', number: '123', boolean: 'Y/N', date: 'Date', timestamp: 'Time', other: '{ }' }
const TYPE_NAME: Record<ColumnType, string> = { string: 'Text', number: 'Number', boolean: 'Yes / no', date: 'Date', timestamp: 'Date & time', other: 'Other' }
const fmtN = (n: number) => n.toLocaleString()

/** Columns usable for filtering: hides hidden / blocked / sync-only columns and applies aliases. */
export function filterColumns(model: Model): (Column & { label: string })[] {
  return model.columns
    .filter((c) => {
      const st = model.column_settings?.[c.name]
      return !st?.hidden && st?.privacy !== 'blocked' && st?.privacy !== 'sync_only'
    })
    .map((c) => ({ ...c, label: model.column_settings?.[c.name]?.alias || label(c.name) }))
}

function defaultProperty(model: Model): PropertyNode {
  const cols = filterColumns(model)
  const col = cols.find((c) => c.type === 'string') ?? cols[0] ?? model.columns[0]
  return { type: 'property', column: col.name, operator: OPS[col.type][0]?.value ?? 'exists', values: [] }
}

// ---------------------------------------------------------------------------
// convert definitions saved by earlier versions of the builder

const LEGACY_OPS: Record<string, Partial<PropertyNode>> = {
  in: { operator: 'equals' }, not_in: { operator: 'not_equals' }, is_null: { operator: 'not_exists' },
  is_not_null: { operator: 'exists' }, on: { operator: 'equals' },
  within_last: { operator: 'within', direction: 'previous' }, within_next: { operator: 'within', direction: 'next' },
  not_within_last: { operator: 'not_within', direction: 'previous' },
  is_true: { operator: 'equals', values: ['true'] }, is_false: { operator: 'equals', values: ['false'] },
}
const LEGACY_TW: Record<string, Partial<TimeWindow>> = {
  within_last: { type: 'within', direction: 'previous' }, within_next: { type: 'within', direction: 'next' },
  not_within_last: { type: 'not_within', direction: 'previous' },
}

function migrateTw(tw: TimeWindow | undefined): TimeWindow {
  if (!tw) return { type: 'anytime' }
  const legacy = LEGACY_TW[tw.type as string]
  return legacy ? { ...tw, ...legacy } as TimeWindow : tw
}

export function migrateDefinition(n: ConditionNode): ConditionNode {
  switch (n.type) {
    case 'group': return { ...n, conditions: n.conditions.map(migrateDefinition) }
    case 'property': {
      const legacy = LEGACY_OPS[n.operator]
      const out: PropertyNode = legacy ? { ...n, ...legacy } : { ...n }
      if ((out.operator === 'equals' || out.operator === 'not_equals') && !out.values?.length && out.value != null && out.value !== '') {
        out.values = [String(out.value)]
      }
      return out
    }
    case 'relation': return { ...n, time_window: migrateTw(n.time_window), filter: migrateDefinition(n.filter) as GroupNode }
    case 'event': return { ...n, time_window: migrateTw(n.time_window), filter: migrateDefinition(n.filter) as GroupNode }
    case 'sequence': {
      const s = n as SequenceNode
      return {
        type: 'event', model_id: s.first.model_id, did: true, event_names: s.first.event_names,
        filter: migrateDefinition(s.first.filter) as GroupNode, time_window: migrateTw(s.time_window),
        frequency: { operator: 'gte', value: 1 },
        then: { did: s.did_then, model_id: s.then.model_id, event_names: s.then.event_names,
          filter: migrateDefinition(s.then.filter) as GroupNode, within: s.within },
      }
    }
    default: return n
  }
}

// ---------------------------------------------------------------------------
// small inputs

function Select({ value, onChange, options, className = '' }: {
  value: string | number; onChange: (v: string) => void; options: { value: string | number; label: string }[]; className?: string
}) {
  return (
    <select className={`input sm ${className}`} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

function Num({ value, onChange, width = 84 }: { value: unknown; onChange: (v: string) => void; width?: number }) {
  return (
    <input className="input sm num" style={{ width }} type="number" value={(value as string | number) ?? ''}
      onChange={(e) => onChange(e.target.value)} />
  )
}

function DateInput({ value, onChange }: { value: unknown; onChange: (v: string) => void }) {
  return <input className="input sm" type="date" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
}

/** Small type badge: Text / Number / Yes-no / Date. */
export function TypeIcon({ type }: { type: ColumnType }) {
  return <span className={`type-ic t-${type}`} title={TYPE_NAME[type]} aria-label={TYPE_NAME[type]}>{TYPE_ICON[type]}</span>
}

type PickItem = Column & { label: string; group: string }

/** Searchable column picker with grouped, typed options (replaces the native <select>). */
export function ColumnSelect({ model, value, onChange, types, withVirtual }: {
  model: Model; value: string | undefined; onChange: (c: Column) => void; types?: ColumnType[]; withVirtual?: boolean
}) {
  const ctx = useContext(Ctx)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)

  const cols = filterColumns(model).filter((c) => !types || types.includes(c.type))
  const virtual = (withVirtual && model.kind === 'parent' ? ctx?.schema.virtual_columns ?? [] : []).filter((c) => !types || types.includes(c.type))
  const items: PickItem[] = [
    ...cols.map((c) => ({ ...c, group: model.name })),
    ...virtual.map((v) => ({ name: v.name, type: v.type, data_type: v.type, description: v.description, label: v.label, group: v.group })),
  ]
  const needle = q.trim().toLowerCase()
  const shown = needle ? items.filter((i) => i.label.toLowerCase().includes(needle) || i.name.toLowerCase().includes(needle)) : items
  const groups = [...new Set(shown.map((i) => i.group))]
  const selected = items.find((i) => i.name === value)

  const place = () => {
    const r = btn.current!.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - 12
    const above = r.top - 12
    const width = Math.max(r.width, 300)
    const left = Math.min(r.left, window.innerWidth - width - 12)
    setPos(below >= 260 || below >= above
      ? { left, top: r.bottom + 4, width, maxHeight: Math.min(380, below) }
      : { left, bottom: window.innerHeight - r.top + 4, width, maxHeight: Math.min(380, above) })
  }
  const show = () => { place(); setQ(''); setActive(Math.max(0, shown.findIndex((i) => i.name === value))); setOpen(true) }
  const choose = (i: PickItem) => { onChange(i); setOpen(false); btn.current?.focus() }

  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => !pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node) && setOpen(false)
    const scroll = (e: Event) => !pop.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', outside)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', place)
    return () => { document.removeEventListener('mousedown', outside); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', place) }
  }, [open])
  useEffect(() => { pop.current?.querySelector('.cp-item.active')?.scrollIntoView({ block: 'nearest' }) }, [active, open])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) choose(shown[active]) }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); btn.current?.focus() }
  }

  return (
    <>
      <button ref={btn} type="button" className={`input sm col-pick ${open ? 'open' : ''}`} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); show() } }}>
        {selected ? (<><TypeIcon type={selected.type} /><span className="cp-label">{selected.label}</span></>)
          : <span className="cp-label faint">{value ? label(value) : 'Choose a field…'}</span>}
        <svg className="cp-caret" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && pos && (
        <div ref={pop} className="col-pop" role="listbox" style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight }}>
          <div className="cp-search">
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            <input autoFocus value={q} placeholder={`Search ${items.length} fields…`} onKeyDown={onKey}
              onChange={(e) => { setQ(e.target.value); setActive(0) }} />
          </div>
          <div className="cp-list">
            {!shown.length && <div className="cp-empty">No fields match “{q}”</div>}
            {groups.map((g) => (
              <div key={g}>
                <div className="cp-group">{g}</div>
                {shown.filter((i) => i.group === g).map((i) => {
                  const idx = shown.indexOf(i)
                  return (
                    <button key={i.name} type="button" role="option" aria-selected={i.name === value}
                      className={`cp-item ${idx === active ? 'active' : ''} ${i.name === value ? 'selected' : ''}`}
                      onMouseEnter={() => setActive(idx)} onClick={() => choose(i)}>
                      <TypeIcon type={i.type} />
                      <span className="cp-text"><span>{i.label}</span>{i.description && <small>{i.description}</small>}</span>
                      {i.name === value && <svg className="cp-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

/** Multi-value chips with live suggestions from the warehouse; paste or drop a .csv/.txt list. */
export function ValuePicker({ modelId, column, values, onChange, suggest = true }: {
  modelId: number; column: string; values: string[]; onChange: (v: string[]) => void; suggest?: boolean
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<{ value: string; count: number }[]>([])
  const [loading, setLoading] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || !suggest) return
    let stale = false
    setLoading(true)
    const t = setTimeout(() => {
      api.get<{ value: string; count: number }[]>(`/models/${modelId}/values?column=${encodeURIComponent(column)}&q=${encodeURIComponent(q)}`)
        .then((r) => !stale && setItems(r))
        .catch(() => !stale && setItems([]))
        .finally(() => !stale && setLoading(false))
    }, 250)
    return () => { stale = true; clearTimeout(t) }
  }, [open, q, modelId, column, suggest])

  useEffect(() => {
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const addMany = (list: string[]) => {
    const next = [...values]
    for (const v of list.map((x) => x.trim()).filter(Boolean)) if (!next.includes(v)) next.push(v)
    onChange(next)
    setQ('')
  }
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) addMany((await file.text()).split(/[,\n\r]+/))
  }

  return (
    <div className="chips" ref={box} onClick={() => setOpen(true)} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}
      title="Type values, paste a comma-separated list, or drop a .csv / .txt file">
      {values.map((v) => (
        <span key={v} className="chip">{v}<button onClick={(e) => { e.stopPropagation(); onChange(values.filter((x) => x !== v)) }}>×</button></span>
      ))}
      <input value={q} placeholder={values.length ? '' : 'Type, paste or drop values…'}
        onChange={(e) => { setQ(e.target.value); setOpen(true) }}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text')
          if (/[,\n]/.test(text)) { e.preventDefault(); addMany(text.split(/[,\n\r]+/)) }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); addMany([q]) }
          if (e.key === 'Backspace' && !q && values.length) onChange(values.slice(0, -1))
        }} />
      {open && suggest && (
        <div className="suggest">
          {loading && <div className="small faint" style={{ padding: 8 }}>Loading values…</div>}
          {!loading && q && !items.some((i) => i.value === q) && (
            <button onMouseDown={(e) => { e.preventDefault(); addMany([q]) }}>Use “{q}”</button>
          )}
          {!loading && items.map((i) => (
            <button key={i.value} className={values.includes(i.value) ? 'active' : ''}
              onMouseDown={(e) => { e.preventDefault(); addMany([i.value]) }}>
              <span>{i.value}</span><span className="count">{i.count.toLocaleString()}</span>
            </button>
          ))}
          {!loading && !items.length && !q && <div className="small faint" style={{ padding: 8 }}>No values found</div>}
        </div>
      )}
    </div>
  )
}

/** "30 days" + a calendar checkbox (whole calendar periods instead of a rolling window from now). */
function AmountUnit({ amount, unit, calendar, onChange }: {
  amount?: number | string; unit?: string; calendar?: boolean
  onChange: (p: { amount?: number | string; unit?: string; calendar?: boolean }) => void
}) {
  return (<>
    <Num value={amount ?? 30} onChange={(v) => onChange({ amount: v })} width={70} />
    <Select value={unit ?? 'day'} options={UNITS.filter((u) => !calendar || !['minute', 'hour'].includes(u)).map((u) => ({ value: u, label: `${u}s` }))}
      onChange={(u) => onChange({ unit: u })} />
    <label className="check-inline" title="Use whole calendar periods (e.g. the last 2 calendar weeks) instead of counting back from right now">
      <input type="checkbox" checked={!!calendar}
        onChange={(e) => onChange({ calendar: e.target.checked, unit: e.target.checked && ['minute', 'hour'].includes(unit ?? '') ? 'day' : unit })} />
      calendar {unit ?? 'day'}s
    </label>
  </>)
}

/** within / not within on a property: last|next N units. */
function RelativeWindow({ direction, amount, unit, calendar, allowNext, onChange }: {
  direction?: string; amount?: number | string; unit?: string; calendar?: boolean; allowNext?: boolean
  onChange: (p: { direction?: 'previous' | 'next'; amount?: number | string; unit?: string; calendar?: boolean }) => void
}) {
  return (<>
    {allowNext ? (
      <Select value={direction ?? 'previous'} options={[{ value: 'previous', label: 'last' }, { value: 'next', label: 'next' }]}
        onChange={(d) => onChange({ direction: d as 'previous' | 'next' })} />
    ) : <span className="word">last</span>}
    <AmountUnit amount={amount} unit={unit} calendar={calendar} onChange={onChange} />
  </>)
}

/** One dropdown for "when": at any time / in the last / not in the last / in the next / before / after / between. */
export function TimeWindowPicker({ value, onChange, allowNext }: { value: TimeWindow; onChange: (tw: TimeWindow) => void; allowNext?: boolean }) {
  const options = [
    { value: 'anytime', label: 'at any time' },
    { value: 'within:previous', label: 'in the last' },
    { value: 'not_within:previous', label: 'not in the last' },
    ...(allowNext ? [{ value: 'within:next', label: 'in the next' }, { value: 'not_within:next', label: 'not in the next' }] : []),
    { value: 'before', label: 'before' }, { value: 'after', label: 'after' }, { value: 'between', label: 'between' },
  ]
  const relative = value.type === 'within' || value.type === 'not_within'
  const current = relative ? `${value.type}:${value.direction ?? 'previous'}` : value.type
  const set = (patch: Partial<TimeWindow>) => onChange({ ...value, ...patch })
  return (
    <div className="cond-line">
      <Select value={current} options={options} onChange={(v) => {
        const [type, direction] = v.split(':')
        set({ type: type as TimeWindow['type'], amount: value.amount ?? 30, unit: value.unit ?? 'day', direction: (direction ?? value.direction ?? 'previous') as 'previous' | 'next' })
      }} />
      {relative && <AmountUnit amount={value.amount} unit={value.unit} calendar={value.calendar} onChange={(p) => set(p)} />}
      {(value.type === 'before' || value.type === 'after') && <DateInput value={value.date} onChange={(d) => set({ date: d })} />}
      {value.type === 'between' && (<>
        <DateInput value={value.from} onChange={(d) => set({ from: d })} /><span className="word">and</span>
        <DateInput value={value.to} onChange={(d) => set({ to: d })} />
      </>)}
    </div>
  )
}

// ---------------------------------------------------------------------------
// plain-English summaries shown on each filter card

const plural = (n: unknown, word: string) => `${n ?? '…'} ${word}${Number(n) === 1 ? '' : 's'}`
const quoted = (vals: unknown[] | undefined, joiner = 'or') => (vals?.length ? vals.map((v) => `“${v}”`).join(` ${joiner} `) : '…')

function windowText(tw: TimeWindow | undefined): string {
  if (!tw || tw.type === 'anytime') return 'at any time'
  if (tw.type === 'within' || tw.type === 'not_within') {
    const span = `${tw.direction === 'next' ? 'next' : 'last'} ${plural(tw.amount, tw.calendar ? `calendar ${tw.unit ?? 'day'}` : tw.unit ?? 'day')}`
    return `${tw.type === 'not_within' ? 'not in the' : 'in the'} ${span}`
  }
  if (tw.type === 'between') return `between ${tw.from || '…'} and ${tw.to || '…'}`
  return `${tw.type} ${tw.date || '…'}`
}

function columnLabel(model: Model, name: string, ctx: BuilderCtx | null) {
  const v = ctx?.schema.virtual_columns.find((c) => c.name === name)
  return v?.label ?? model.column_settings?.[name]?.alias ?? label(name)
}

function propertyText(n: PropertyNode, model: Model, ctx: BuilderCtx | null): string {
  const v = ctx?.schema.virtual_columns.find((c) => c.name === n.column)
  const type: ColumnType = v?.type ?? model.columns.find((c) => c.name === n.column)?.type ?? 'string'
  const col = columnLabel(model, n.column, ctx)
  const op = OPS[type].find((o) => o.value === n.operator)?.label ?? n.operator
  if (['exists', 'not_exists', 'exists_not_empty'].includes(n.operator)) return `${col} ${op}`
  if (n.compare) return `${col} ${op} ${n.compare.column ? columnLabel(model, n.compare.column, ctx) : '…'}`
  if (n.operator === 'within' || n.operator === 'not_within') {
    return `${col} ${op} ${n.direction === 'next' ? 'next' : 'last'} ${plural(n.amount ?? 30, n.calendar ? `calendar ${n.unit ?? 'day'}` : n.unit ?? 'day')}`
  }
  if (n.operator === 'anniversary') return `${col} anniversary is ${Number(n.amount ?? 0) === 0 ? 'today' : `in the ${n.direction ?? 'next'} ${plural(n.amount, 'day')}`}`
  if (n.operator === 'between') return `${col} ${op} ${n.value ?? '…'} and ${n.value2 ?? '…'}`
  if (n.values?.length || type === 'string') return `${col} ${op} ${quoted(n.values)}`
  return `${col} ${op} ${n.value ?? '…'}`
}

function groupText(g: GroupNode, model: Model, ctx: BuilderCtx | null): string {
  const parts = g.conditions.map((c) => (c.type === 'property' ? propertyText(c, model, ctx) : c.type === 'group' ? `(${groupText(c, model, ctx)})` : ''))
  return parts.filter(Boolean).join(g.op === 'and' ? ' and ' : ' or ')
}

const FREQ_WORD: Record<string, string> = { gte: 'at least', lte: 'at most', equals: 'exactly', gt: 'more than', lt: 'fewer than', between: 'between' }
const AGG_WORD: Record<string, string> = { count: 'number of records', sum: 'total', avg: 'average', min: 'minimum', max: 'maximum', count_distinct: 'distinct count of' }

export function conditionText(c: ConditionNode, ctx: BuilderCtx | null): string {
  const models = ctx?.schema.models ?? []
  switch (c.type) {
    case 'property': return ctx?.schema.parent ? propertyText(c, ctx.schema.parent, ctx) : ''
    case 'event': {
      const m = models.find((x) => x.id === c.model_id)
      if (!m) return 'Event'
      const names = c.event_names?.length ? ` (${c.event_names.join(', ')})` : ''
      const f = c.frequency
      const freq = c.did ? ` ${FREQ_WORD[f.operator] ?? ''} ${f.operator === 'between' ? `${f.value} and ${plural(f.value2, 'time')}` : plural(f.value, 'time')}` : ''
      const where = c.filter.conditions.length ? `, counting only events where ${groupText(c.filter, m, ctx)}` : ''
      const then = c.then ? `, then ${c.then.did ? 'did' : 'did not do'} ${models.find((x) => x.id === c.then!.model_id)?.name ?? 'another event'} within ${plural(c.then.within.amount, c.then.within.unit)}` : ''
      return `${c.did ? 'Did' : 'Did not do'} ${m.name}${names}${freq} ${windowText(c.time_window)}${where}${then}`
    }
    case 'relation': {
      const m = models.find((x) => x.id === c.model_id)
      if (!m) return 'Related records'
      const a = c.aggregate
      const what = a.fn === 'count' ? `number of ${m.name} records` : `${AGG_WORD[a.fn]} ${a.column ? columnLabel(m, a.column, ctx) : '…'}`
      const cmp = `${FREQ_WORD[a.operator] ?? a.operator} ${a.value ?? '…'}${a.operator === 'between' ? ` and ${a.value2 ?? '…'}` : ''}`
      const tw = m.timestamp_column && c.time_window.type !== 'anytime' ? ` ${windowText(c.time_window)}` : ''
      const where = c.filter.conditions.length ? `, counting only records where ${groupText(c.filter, m, ctx)}` : ''
      return `${what[0].toUpperCase()}${what.slice(1)} is ${cmp}${tw}${where}`
    }
    case 'trait': {
      const t = c.trait_id ? ctx?.schema.traits.find((x) => x.id === c.trait_id) : undefined
      const type = c.trait_id ? ctx?.schema.virtual_columns.find((v) => v.name === 'trait.' + c.trait_id)?.type ?? 'string' : 'number'
      const op = OPS[type].find((o) => o.value === c.operator)?.label ?? c.operator
      const val = ['exists', 'not_exists'].includes(c.operator) ? ''
        : c.operator === 'between' ? ` ${c.value ?? '…'} and ${c.value2 ?? '…'}`
          : c.values?.length ? ` ${quoted(c.values)}` : ` ${c.value ?? '…'}`
      return `${t?.name ?? 'Custom trait'} ${op}${val}`
    }
    case 'audience': {
      const a = ctx?.audiences.find((x) => x.id === c.audience_id)
      return `${c.included ? 'Is a member of' : 'Is not a member of'} ${a ? `“${a.name}”` : '…'}`
    }
    case 'group': return `${c.op === 'and' ? 'All' : 'Any'} of ${plural(c.conditions.length, 'filter')}`
  }
  return ''
}

function CompareInput({ value, onChange, noun, options = COMPARE }: {
  value: { operator: string; value: number | string; value2?: number | string }
  onChange: (v: { operator: string; value: number | string; value2?: number | string }) => void
  noun?: string; options?: { value: string; label: string }[]
}) {
  return (
    <div className="cond-line">
      <Select value={value.operator} options={options} onChange={(o) => onChange({ ...value, operator: o })} />
      <Num value={value.value} onChange={(v) => onChange({ ...value, value: v })} />
      {value.operator === 'between' && (<><span className="word">and</span><Num value={value.value2} onChange={(v) => onChange({ ...value, value2: v })} /></>)}
      {noun && <span className="word">{noun}</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// condition editors

function PropertyEditor({ node, model, onChange }: { node: PropertyNode; model: Model; onChange: (n: PropertyNode) => void }) {
  const ctx = useContext(Ctx)
  const virtual = model.kind === 'parent' ? ctx?.schema.virtual_columns.find((v) => v.name === node.column) : undefined
  const col = virtual ? { name: virtual.name, type: virtual.type } : model.columns.find((c) => c.name === node.column)
  const type: ColumnType = col?.type ?? 'string'
  const op = node.operator
  const set = (patch: Partial<PropertyNode>) => onChange({ ...node, ...patch })
  const isTime = type === 'date' || type === 'timestamp'
  const canCompare = (type === 'number' || isTime) && ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte'].includes(op)
  return (
    <div className="cond-line">
      <ColumnSelect model={model} value={node.column} withVirtual
        onChange={(c) => onChange({ type: 'property', column: c.name, operator: OPS[c.type][0]?.value ?? 'exists', values: [], amount: 30, unit: 'day', direction: 'previous' })} />
      <Select value={op} options={OPS[type]} onChange={(o) => set({ operator: o, amount: node.amount ?? 30, unit: node.unit ?? 'day', direction: node.direction ?? (o === 'anniversary' ? 'next' : 'previous') })} />
      {node.compare ? (<>
        <ColumnSelect model={model} value={node.compare.column || undefined} types={[type]} withVirtual onChange={(c) => set({ compare: { column: c.name } })} />
        <button className="btn ghost sm link-btn" onClick={() => set({ compare: undefined })}>use a value instead</button>
      </>) : (<>
      {type === 'string' && ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'not_starts_with', 'ends_with', 'not_ends_with'].includes(op) && (
        <ValuePicker modelId={model.id} column={node.column} values={node.values ?? []} onChange={(v) => set({ values: v })}
          suggest={!virtual && (op === 'equals' || op === 'not_equals')} />
      )}
      {type === 'number' && (op === 'equals' || op === 'not_equals') && (
        <ValuePicker modelId={model.id} column={node.column} values={node.values ?? []} onChange={(v) => set({ values: v })} suggest={!virtual} />
      )}
      {type === 'number' && ['gt', 'gte', 'lt', 'lte', 'between'].includes(op) && (<>
        <Num value={node.value} onChange={(v) => set({ value: v })} width={110} />
        {op === 'between' && (<><span className="word">and</span><Num value={node.value2} onChange={(v) => set({ value2: v })} width={110} /></>)}
      </>)}
      {type === 'boolean' && (op === 'equals' || op === 'not_equals') && (
        <Select value={String(node.values?.[0] ?? 'true')} options={[{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }]}
          onChange={(v) => set({ values: [v] })} />
      )}
      {isTime && (op === 'within' || op === 'not_within') && (
        <RelativeWindow direction={node.direction} amount={node.amount} unit={node.unit} calendar={node.calendar} allowNext
          onChange={(p) => set(p)} />
      )}
      {isTime && op === 'anniversary' && (<>
        <span className="word">is within the</span>
        <Select value={node.direction ?? 'next'} options={[{ value: 'next', label: 'next' }, { value: 'previous', label: 'previous' }]}
          onChange={(d) => set({ direction: d as 'previous' | 'next' })} />
        <Num value={node.amount ?? 0} onChange={(v) => set({ amount: v })} width={70} />
        <span className="word">days (0 = today)</span>
      </>)}
      {isTime && ['equals', 'before', 'after', 'between'].includes(op) && <DateInput value={node.value} onChange={(d) => set({ value: d })} />}
      {isTime && op === 'between' && (<><span className="word">and</span><DateInput value={node.value2} onChange={(d) => set({ value2: d })} /></>)}
      {canCompare && (
        <button className="btn ghost sm link-btn compare-link" title="Compare against another column on the same record, e.g. last order date is after signup date"
          onClick={() => set({ compare: { column: '' } })}>compare to a column</button>
      )}
      </>)}
    </div>
  )
}

function ModelSelect({ models, value, onChange }: { models: Model[]; value: number; onChange: (m: Model) => void }) {
  return (
    <select className="input sm" value={value} onChange={(e) => onChange(models.find((m) => m.id === Number(e.target.value))!)}>
      {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
    </select>
  )
}

/** A labelled row inside a filter card: "When   [in the last] [90] [days]". */
function Field({ label: text, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="cond-field">
      <span className="cond-label" title={hint}>{text}</span>
      <div className="cond-line">{children}</div>
    </div>
  )
}

function FilterBlock({ model, group, onChange, noun }: { model: Model; group: GroupNode; onChange: (g: GroupNode) => void; noun: string }) {
  const [open, setOpen] = useState(group.conditions.length > 0)
  if (!open) {
    return (
      <Field label="Only count" hint={`Optional: narrow which ${noun} count towards this filter`}>
        <button className="btn ghost sm link-btn" onClick={() => { setOpen(true); onChange({ ...group, conditions: [defaultProperty(model)] }) }}>
          + all {noun} (click to narrow down)
        </button>
      </Field>
    )
  }
  return (
    <div className="cond-field top">
      <span className="cond-label">Only count<br /><span className="faint">{noun} where</span></span>
      <div className="cond-where">
        <GroupEditor group={group} model={model} onChange={(g) => { onChange(g); if (!g.conditions.length) setOpen(false) }} nested />
      </div>
    </div>
  )
}

function RelationEditor({ node, onChange }: { node: RelationNode; onChange: (n: RelationNode) => void }) {
  const { schema } = useBuilder()
  const models = schema.models
  const model = models.find((m) => m.id === node.model_id) ?? models[0]
  const agg = node.aggregate
  const set = (patch: Partial<RelationNode>) => onChange({ ...node, ...patch })
  const numCols = model.columns.filter((c) => c.type === 'number')
  return (
    <>
      <Field label="Records">
        <ModelSelect models={models} value={model.id}
          onChange={(m) => onChange({ ...node, model_id: m.id, filter: emptyGroup(), aggregate: { fn: 'count', operator: 'gte', value: 1 } })} />
      </Field>
      <Field label="Measure">
        <span className="word">the</span>
        <Select value={agg.fn} options={AGG_FNS.filter((f) => f.value === 'count' || numCols.length || f.value === 'count_distinct')}
          onChange={(fn) => set({ aggregate: { ...agg, fn: fn as RelationNode['aggregate']['fn'], column: fn === 'count' ? undefined : agg.column ?? (fn === 'count_distinct' ? model.columns[0] : numCols[0])?.name } })} />
        {agg.fn !== 'count' && (
          <ColumnSelect model={model} value={agg.column} types={agg.fn === 'count_distinct' ? undefined : ['number']}
            onChange={(c) => set({ aggregate: { ...agg, column: c.name } })} />
        )}
        <span className="word">is</span>
        <CompareInput value={agg} onChange={(v) => set({ aggregate: { ...agg, ...v } })} />
      </Field>
      {model.timestamp_column && (
        <Field label="When" hint={`Based on ${label(model.timestamp_column)}`}>
          <TimeWindowPicker value={node.time_window} allowNext onChange={(tw) => set({ time_window: tw })} />
        </Field>
      )}
      <FilterBlock model={model} group={node.filter} onChange={(g) => set({ filter: g })} noun="records" />
    </>
  )
}

function EventNames({ model, value, onChange }: { model: Model; value: string[]; onChange: (v: string[]) => void }) {
  if (!model.event_name_column) return null
  return <ValuePicker modelId={model.id} column={model.event_name_column} values={value} onChange={onChange} />
}

function ThenEditor({ then, onChange, onRemove }: { then: EventThen; onChange: (t: EventThen) => void; onRemove: () => void }) {
  const { schema } = useBuilder()
  const models = schema.models.filter((m) => m.timestamp_column)
  const model = models.find((m) => m.id === then.model_id) ?? models[0]
  return (
    <div className="then-step">
      <div className="then-head">
        <span>Follow-up step</span>
        <button className="btn ghost icon sm" onClick={onRemove} aria-label="Remove follow-up step">✕</button>
      </div>
      <Field label="Then">
        <Select value={then.did ? 'did' : 'did_not'}
          options={[{ value: 'did', label: 'did' }, { value: 'did_not', label: 'did not do' }]}
          onChange={(v) => onChange({ ...then, did: v === 'did' })} />
        <ModelSelect models={models} value={model.id} onChange={(m) => onChange({ ...then, model_id: m.id, event_names: [], filter: emptyGroup() })} />
        <EventNames model={model} value={then.event_names} onChange={(v) => onChange({ ...then, event_names: v })} />
      </Field>
      <Field label="Within">
        <Num value={then.within.amount} onChange={(v) => onChange({ ...then, within: { ...then.within, amount: v } })} width={70} />
        <Select value={then.within.unit} options={UNITS.map((u) => ({ value: u, label: `${u}s` }))}
          onChange={(u) => onChange({ ...then, within: { ...then.within, unit: u } })} />
        <span className="word">after the first event</span>
      </Field>
      <FilterBlock model={model} group={then.filter} onChange={(g) => onChange({ ...then, filter: g })} noun="events" />
    </div>
  )
}

function EventEditor({ node, onChange }: { node: EventNode; onChange: (n: EventNode) => void }) {
  const { schema } = useBuilder()
  const events = schema.models.filter((m) => m.kind === 'event')
  const model = events.find((m) => m.id === node.model_id) ?? events[0]
  const set = (patch: Partial<EventNode>) => onChange({ ...node, ...patch })
  const timed = schema.models.filter((m) => m.timestamp_column)
  return (
    <>
      <Field label="Activity">
        <Select value={node.did ? 'did' : 'did_not'} options={[{ value: 'did', label: 'did' }, { value: 'did_not', label: 'did not do' }]}
          onChange={(v) => set({ did: v === 'did', then: v === 'did' ? node.then : undefined })} />
        <ModelSelect models={events} value={model.id} onChange={(m) => onChange({ ...node, model_id: m.id, event_names: [], filter: emptyGroup() })} />
        <EventNames model={model} value={node.event_names} onChange={(v) => set({ event_names: v })} />
      </Field>
      {node.did && (
        <Field label="How often" hint="How many matching events each person needs">
          <CompareInput value={node.frequency} options={FREQUENCY} onChange={(f) => set({ frequency: f })} noun={Number(node.frequency.value) === 1 ? 'time' : 'times'} />
        </Field>
      )}
      <Field label="When" hint={model.timestamp_column ? `Based on ${label(model.timestamp_column)}` : undefined}>
        <TimeWindowPicker value={node.time_window} onChange={(tw) => set({ time_window: tw })} />
      </Field>
      <FilterBlock model={model} group={node.filter} onChange={(g) => set({ filter: g })} noun="events" />
      {node.did && (node.then ? (
        <ThenEditor then={node.then} onChange={(t) => set({ then: t })} onRemove={() => set({ then: undefined })} />
      ) : timed.length > 0 && (
        <Field label="Sequence" hint="Optional: require (or exclude) another event after this one">
          <button className="btn ghost sm link-btn" onClick={() => set({ then: { did: true, model_id: (timed.find((m) => m.id !== model.id) ?? model).id, event_names: [], filter: emptyGroup(), within: { amount: 1, unit: 'day' } } })}>
            + add a follow-up step (then did / did not…)
          </button>
        </Field>
      ))}
    </>
  )
}

function TraitConditionEditor({ node, onChange }: { node: TraitNode; onChange: (n: TraitNode) => void }) {
  const { schema } = useBuilder()
  const traits = schema.traits
  const isInline = !node.trait_id
  const typeOf = (id: number | string) => schema.virtual_columns.find((v) => v.name === 'trait.' + id)?.type ?? 'string'
  const vtype: ColumnType = !isInline ? typeOf(node.trait_id!)
    : ['aggregation', 'count'].includes(node.inline?.method ?? 'count') ? 'number' : (node.inline?.result_type ?? 'string')
  return (<>
    <div className="cond-line">
      <Select value={isInline ? 'custom' : String(node.trait_id)}
        options={[...traits.map((t) => ({ value: String(t.id), label: t.name })), { value: 'custom', label: '+ Custom trait for this audience' }]}
        onChange={(v) => onChange(v === 'custom'
          ? { type: 'trait', inline: { method: 'count', model_id: schema.models[0]?.id }, operator: 'gte', value: 1 }
          : { type: 'trait', trait_id: Number(v), operator: OPS[typeOf(v)][0].value, values: [] })} />
      <Select value={node.operator} options={OPS[vtype]} onChange={(o) => onChange({ ...node, operator: o })} />
      {vtype === 'number' && ['gt', 'gte', 'lt', 'lte', 'between'].includes(node.operator) && (<>
        <Num value={node.value} onChange={(v) => onChange({ ...node, value: v })} width={110} />
        {node.operator === 'between' && (<><span className="word">and</span><Num value={node.value2} onChange={(v) => onChange({ ...node, value2: v })} width={110} /></>)}
      </>)}
      {['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'not_starts_with', 'ends_with', 'not_ends_with'].includes(node.operator) && vtype !== 'boolean' && (
        <ValuePicker modelId={0} column="" suggest={false} values={(node.values ?? []).map(String)} onChange={(v) => onChange({ ...node, values: v })} />
      )}
    </div>
    {isInline && node.inline && (
      <div className="cond-sub">
        <div className="label">Calculated as</div>
        <TraitConfigEditor method={node.inline.method} config={node.inline} allowFormula={false}
          onChange={(method, config) => onChange({ ...node, inline: { ...config, method } })} />
      </div>
    )}
  </>)
}

function AudienceRefEditor({ node, onChange }: { node: AudienceRefNode; onChange: (n: AudienceRefNode) => void }) {
  const { audiences, currentAudienceId } = useBuilder()
  const options = audiences.filter((a) => a.id !== currentAudienceId)
  return (
    <div className="cond-line">
      <Select value={node.included ? 'in' : 'out'} options={[{ value: 'in', label: 'is a member of' }, { value: 'out', label: 'is not a member of' }]}
        onChange={(v) => onChange({ ...node, included: v === 'in' })} />
      <Select value={node.audience_id} options={options.map((a) => ({ value: a.id, label: a.name }))}
        onChange={(v) => onChange({ ...node, audience_id: Number(v) })} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// add menu + group

const KINDS = [
  { type: 'property', title: 'Profile property', desc: 'Something about the person, e.g. country is “US”', color: 'var(--blue)' },
  { type: 'event', title: 'Event / activity', desc: 'What they did and when, e.g. engaged 3+ times in the last 30 days', color: 'var(--violet)' },
  { type: 'trait', title: 'Trait', desc: 'A calculated value, e.g. total page views is at least 50', color: 'var(--amber)' },
  { type: 'audience', title: 'Another audience', desc: 'Is (or is not) a member of an existing audience', color: 'var(--green)' },
  { type: 'relation', title: 'Totals across records', desc: 'Sum, average or count over related rows, e.g. total video minutes ≥ 60', color: 'var(--teal)' },
  { type: 'group', title: 'Either / or group', desc: 'Combine a few filters where meeting any one is enough', color: 'var(--text-3)' },
] as const

function newNode(type: string, ctx: BuilderCtx, model: Model): ConditionNode | null {
  const events = ctx.schema.models.filter((m) => m.kind === 'event')
  switch (type) {
    case 'property': return defaultProperty(model)
    case 'group': return { ...emptyGroup(), conditions: [defaultProperty(model)] }
    case 'relation': {
      const m = ctx.schema.models.find((x) => x.kind === 'related') ?? ctx.schema.models[0]
      return m ? { type: 'relation', model_id: m.id, filter: emptyGroup(), time_window: { type: 'anytime' }, aggregate: { fn: 'count', operator: 'gte', value: 1 } } : null
    }
    case 'event': {
      const m = events[0]
      return m ? { type: 'event', model_id: m.id, did: true, event_names: [], filter: emptyGroup(), time_window: { type: 'within', direction: 'previous', amount: 30, unit: 'day' }, frequency: { operator: 'gte', value: 1 } } : null
    }
    case 'trait': {
      const t = ctx.schema.traits[0]
      if (t) return { type: 'trait', trait_id: t.id, operator: OPS[ctx.schema.virtual_columns.find((v) => v.name === 'trait.' + t.id)?.type ?? 'number'][0].value, values: [] }
      return ctx.schema.models[0] ? { type: 'trait', inline: { method: 'count', model_id: ctx.schema.models[0].id }, operator: 'gte', value: 1 } : null
    }
    case 'audience': {
      const a = ctx.audiences.find((x) => x.id !== ctx.currentAudienceId)
      return a ? { type: 'audience', audience_id: a.id, included: false } : null
    }
  }
  return null
}

function AddCondition({ onAdd, model, nested }: { onAdd: (n: ConditionNode) => void; model: Model; nested?: boolean }) {
  const ctx = useBuilder()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  const isParent = model.kind === 'parent'
  const available = (t: string) => {
    if (t === 'relation') return ctx.schema.models.length > 0
    if (t === 'event') return ctx.schema.models.some((m) => m.kind === 'event')
    if (t === 'audience') return ctx.audiences.some((a) => a.id !== ctx.currentAudienceId)
    if (t === 'trait') return ctx.schema.traits.length > 0 || ctx.schema.models.length > 0
    return true
  }
  if (!isParent) {
    return (
      <div className="row">
        <button className="btn ghost sm" onClick={() => onAdd(defaultProperty(model))}>+ Add condition</button>
        <button className="btn ghost sm" onClick={() => onAdd({ ...emptyGroup(), op: 'or', conditions: [defaultProperty(model)] })}>+ Add “OR” group</button>
      </div>
    )
  }
  return (
    <div className="add-menu" ref={ref}>
      <button className={`btn ${nested ? 'ghost sm' : ''}`} onClick={() => setOpen(!open)}>+ Add filter</button>
      {open && (
        <div className="menu">
          {KINDS.filter((k) => available(k.type)).map((k) => (
            <button key={k.type} onClick={() => { const n = newNode(k.type, ctx, model); if (n) onAdd(n); setOpen(false) }}>
              <span className="swatch" style={{ background: k.color }} />
              <div><strong>{k.title}</strong><span>{k.desc}</span></div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const TITLES: Record<string, string> = { property: 'Property', relation: 'Related records', event: 'Event', sequence: 'Event', audience: 'Audience', trait: 'Trait' }

/** "Match [all | any] of these filters" — replaces the old click-the-AND-pill toggle. */
function MatchMode({ group, onChange, noun }: { group: GroupNode; onChange: (g: GroupNode) => void; noun: string }) {
  return (
    <div className="match-mode">
      <span>Match</span>
      <div className="seg" role="radiogroup">
        {(['and', 'or'] as const).map((op) => (
          <button key={op} role="radio" aria-checked={group.op === op} className={group.op === op ? 'on' : ''}
            onClick={() => onChange({ ...group, op })}>{op === 'and' ? 'all' : 'any'}</button>
        ))}
      </div>
      <span>of these {noun}</span>
      <span className="faint small">{group.op === 'and' ? '— people must meet every one' : '— meeting one is enough'}</span>
    </div>
  )
}

export function GroupEditor({ group, onChange, model, nested }: {
  group: GroupNode; onChange: (g: GroupNode) => void; model?: Model; nested?: boolean
}) {
  const ctx = useBuilder()
  const { schema, steps } = ctx
  const m = model ?? schema.parent!
  const update = (i: number, n: ConditionNode) => onChange({ ...group, conditions: group.conditions.map((c, j) => (j === i ? n : c)) })
  const remove = (i: number) => onChange({ ...group, conditions: group.conditions.filter((_, j) => j !== i) })
  const inFilter = m.kind !== 'parent'
  const isRoot = !nested && !inFilter
  const stepFor = (i: number) => (isRoot && group.op === 'and' && steps && steps.length === group.conditions.length ? steps[i] : undefined)

  return (
    <div className={`group ${nested && !inFilter ? 'nested' : ''} ${inFilter ? 'in-filter' : ''}`}>
      {group.conditions.length > 1 && <MatchMode group={group} onChange={onChange} noun={inFilter ? 'conditions' : 'filters'} />}
      {group.conditions.map((c, i) => (
        <div key={i}>
          {i > 0 && (
            <div className={`joiner ${group.op}`}><span>{group.op === 'and' ? 'and' : 'or'}</span></div>
          )}
          {c.type === 'group' ? (
            <div style={{ position: 'relative' }}>
              <GroupEditor group={c} model={model} nested onChange={(g) => (g.conditions.length ? update(i, g) : remove(i))} />
              {stepFor(i) !== undefined && <div className="small faint" style={{ marginTop: 4 }}>{fmtN(stepFor(i)!)} match so far</div>}
            </div>
          ) : inFilter ? (
            <div className="row">
              <PropertyEditor node={c as PropertyNode} model={m} onChange={(n) => update(i, n)} />
              <button className="btn ghost icon sm" onClick={() => remove(i)} aria-label="Remove">✕</button>
            </div>
          ) : (
            <div className={`cond ${c.type}`}>
              <div className="cond-head">
                <span className="cond-kind">{TITLES[c.type]}</span>
                {stepFor(i) !== undefined && <span className="badge brand">{fmtN(stepFor(i)!)} people match so far</span>}
                <button className="btn ghost icon sm cond-remove" onClick={() => remove(i)} aria-label="Remove filter" title="Remove filter">✕</button>
              </div>
              {c.type !== 'property' && c.type !== 'audience' && <div className="cond-summary">{conditionText(c, ctx)}</div>}
              {c.type === 'property' && <PropertyEditor node={c} model={m} onChange={(n) => update(i, n)} />}
              {c.type === 'relation' && <RelationEditor node={c} onChange={(n) => update(i, n)} />}
              {c.type === 'event' && <EventEditor node={c} onChange={(n) => update(i, n)} />}
              {c.type === 'audience' && <AudienceRefEditor node={c} onChange={(n) => update(i, n)} />}
              {c.type === 'trait' && <TraitConditionEditor node={c} onChange={(n) => update(i, n)} />}
            </div>
          )}
        </div>
      ))}
      <div style={{ marginTop: group.conditions.length ? 10 : 0 }}>
        <AddCondition model={m} nested={nested} onAdd={(n) => onChange({ ...group, conditions: [...group.conditions, n] })} />
      </div>
    </div>
  )
}
