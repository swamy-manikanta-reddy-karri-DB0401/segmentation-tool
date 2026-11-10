/**
 * Small, dependency-free charts that follow the data-viz rules used across the app:
 * colour by job (categorical slots for identity, one teal hue for magnitude), thin marks with 4px rounded
 * ends, 2px surface gaps, recessive grid, a legend for 2+ series, hover tooltips, light + dark via CSS vars.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

const fmtN = (n: number) => n.toLocaleString()

/** Width of an element in CSS pixels, kept up to date — charts draw at real size instead of scaling text. */
function useWidth(ref: React.RefObject<HTMLElement | null>, fallback = 640) {
  const [w, setW] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

function niceMax(v: number) {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  return Math.ceil(v / p) * p
}

function Tooltip({ x, y, children, width }: { x: number; y: number; children: ReactNode; width: number }) {
  const left = Math.min(Math.max(x, 70), width - 70)
  return <div className="viz-tip" style={{ left, top: y }} role="status">{children}</div>
}

// ---- stacked run history ------------------------------------------------------------------

export type RunBar = { id: number | string; label: string; when: string; added: number; changed: number; removed: number; failed: number; status: string }
const RUN_SERIES = [
  { key: 'added', label: 'Added', cls: 's1' },
  { key: 'changed', label: 'Updated', cls: 's2' },
  { key: 'removed', label: 'Removed', cls: 's3' },
] as const

/** Records sent per run, oldest → newest; failed runs get a status marker under their slot. */
export function RunsChart({ runs, height = 180, onSelect }: { runs: RunBar[]; height?: number; onSelect?: (id: RunBar['id']) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const W = useWidth(box), H = height, padL = 36, padB = 26, padT = 8
  const max = niceMax(Math.max(1, ...runs.map((r) => r.added + r.changed + r.removed)))
  const slot = (W - padL) / Math.max(runs.length, 1)
  const bw = Math.max(4, Math.min(28, slot * 0.6))
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max)
  const ticks = [0, max / 2, max]
  const h = hover != null ? runs[hover] : null
  return (
    <div className="viz" ref={box}>
      <div className="viz-legend">{RUN_SERIES.map((s) => <span key={s.key}><i className={`viz-key ${s.cls}`} />{s.label}</span>)}
        <span><i className="viz-key fail" />Failed run</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="viz-svg" role="img" aria-label="Records sent per run" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => <g key={t}><line x1={padL} x2={W} y1={y(t)} y2={y(t)} className="viz-grid" /><text x={padL - 6} y={y(t) + 4} className="viz-axis" textAnchor="end">{fmtN(Math.round(t))}</text></g>)}
        {runs.map((r, i) => {
          const cx = padL + slot * i + slot / 2
          let acc = 0
          const segs = RUN_SERIES.map((s) => ({ s, v: r[s.key] })).filter((p) => p.v > 0)
          return (
            <g key={r.id} className={`viz-col ${hover === i ? 'on' : ''} ${hover != null && hover !== i ? 'dim' : ''}`}>
              {segs.map(({ s, v }, j) => {
                const top = y(acc + v), bottom = y(acc)
                acc += v
                const hgt = Math.max(1, bottom - top - (j < segs.length - 1 ? 2 : 0))
                const last = j === segs.length - 1
                return <rect key={s.key} className={`viz-bar ${s.cls}`} x={cx - bw / 2} y={top} width={bw} height={hgt} rx={last ? 4 : 0} />
              })}
              {r.status === 'failed' && <g className="viz-fail"><circle cx={cx} cy={H - padB + 12} r={5} /><path d={`M${cx - 2} ${H - padB + 10}l4 4M${cx + 2} ${H - padB + 10}l-4 4`} /></g>}
              <rect x={cx - slot / 2} y={0} width={slot} height={H} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)}
                onClick={() => onSelect?.(r.id)} style={{ cursor: onSelect ? 'pointer' : 'default' }} tabIndex={0} aria-label={`${r.label}: ${r.added} added, ${r.changed} updated, ${r.removed} removed`} />
            </g>
          )
        })}
      </svg>
      {h && hover != null && (
        <Tooltip x={padL + slot * hover + slot / 2} y={8} width={W}>
          <strong>{h.label}</strong><span className="viz-tip-sub">{h.when}</span>
          {RUN_SERIES.map((s) => <div key={s.key} className="viz-tip-row"><i className={`viz-key ${s.cls}`} />{s.label}<b>{fmtN(h[s.key])}</b></div>)}
          {h.failed > 0 && <div className="viz-tip-row"><i className="viz-key fail" />Rejected<b>{fmtN(h.failed)}</b></div>}
          {h.status === 'failed' && <div className="viz-tip-warn">Run failed</div>}
        </Tooltip>
      )}
    </div>
  )
}

// ---- horizontal bars (top values, shares) ---------------------------------------------------

export function TopValues({ items, total, unit = 'people', max: maxItems = 8 }: { items: { label: string; value: number }[]; total?: number; unit?: string; max?: number }) {
  const shown = items.slice(0, maxItems)
  const rest = items.slice(maxItems).reduce((a, b) => a + b.value, 0)
  const rows = rest > 0 ? [...shown, { label: `Other (${items.length - maxItems})`, value: rest }] : shown
  const peak = Math.max(1, ...rows.map((r) => r.value))
  const sum = total ?? rows.reduce((a, b) => a + b.value, 0)
  return (
    <div className="viz-hbars" role="table" aria-label="Top values">
      {rows.map((r) => (
        <div key={r.label} className="viz-hrow" role="row" title={`${r.label}: ${fmtN(r.value)} ${unit}`}>
          <span className="viz-hlabel" role="cell">{r.label === '' || r.label == null ? <em>empty</em> : r.label}</span>
          <span className="viz-htrack" role="cell"><span className="viz-hfill" style={{ width: `${(r.value / peak) * 100}%` }} /></span>
          <span className="viz-hval" role="cell">{fmtN(r.value)}<small>{sum ? ` · ${Math.round((r.value / sum) * 100)}%` : ''}</small></span>
        </div>
      ))}
    </div>
  )
}

// ---- sparkline (one series, magnitude over time) -----------------------------------------------

export function Sparkline({ points, height = 44, label, format = fmtN }: { points: { x: string; y: number }[]; height?: number; label: string; format?: (n: number) => string }) {
  const box = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const W = 240, H = height
  const max = Math.max(1, ...points.map((p) => p.y))
  const path = useMemo(() => points.map((p, i) => `${i ? 'L' : 'M'}${(i / Math.max(points.length - 1, 1)) * W},${H - 3 - (p.y / max) * (H - 8)}`).join(' '), [points, max, H])
  if (points.length < 2) return null
  const hp = hover != null ? points[hover] : null
  return (
    <div className="viz viz-spark" ref={box} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="viz-svg" role="img" aria-label={label}
        onMouseMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); setHover(Math.round(((e.clientX - r.left) / r.width) * (points.length - 1))) }}>
        <path d={`${path} L${W},${H} L0,${H} Z`} className="viz-area" />
        <path d={path} className="viz-line" vectorEffect="non-scaling-stroke" />
        {hover != null && <line x1={(hover / (points.length - 1)) * W} x2={(hover / (points.length - 1)) * W} y1={0} y2={H} className="viz-cross" vectorEffect="non-scaling-stroke" />}
      </svg>
      {hp && hover != null && <Tooltip x={(hover / (points.length - 1)) * (box.current?.clientWidth ?? W)} y={-6} width={box.current?.clientWidth ?? W}><strong>{format(hp.y)}</strong><span className="viz-tip-sub">{hp.x}</span></Tooltip>}
    </div>
  )
}

// ---- funnel (audience narrowing filter by filter) --------------------------------------------------

export function Funnel({ steps, total }: { steps: { label: string; value: number }[]; total: number }) {
  const peak = Math.max(1, total)
  return (
    <div className="viz-funnel">
      <div className="viz-frow base"><span className="viz-flabel">Everyone</span><span className="viz-ftrack"><span className="viz-ffill" style={{ width: '100%' }} /></span><span className="viz-fval">{fmtN(total)}</span></div>
      {steps.map((s, i) => {
        const prev = i ? steps[i - 1].value : total
        const drop = prev ? Math.round(((prev - s.value) / prev) * 100) : 0
        return (
          <div key={i} className="viz-frow" title={`${s.label}: ${fmtN(s.value)}`}>
            <span className="viz-flabel"><span className="viz-fstep">{i + 1}</span>{s.label}</span>
            <span className="viz-ftrack"><span className="viz-ffill" style={{ width: `${(s.value / peak) * 100}%` }} /></span>
            <span className="viz-fval">{fmtN(s.value)}{drop > 0 && <small> −{drop}%</small>}</span>
          </div>
        )
      })}
    </div>
  )
}
