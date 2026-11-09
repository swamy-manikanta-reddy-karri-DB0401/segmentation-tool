import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const fnRef = useRef(fn)
  fnRef.current = fn
  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setData(await fnRef.current())
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { data, error, loading, reload, setData }
}

/** Re-run `fn` every `ms` while `active` is true. */
export function usePolling(fn: () => void, ms: number, active: boolean) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => ref.current(), ms)
    return () => clearInterval(t)
  }, [ms, active])
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row muted small">
      <span className="spinner" /> {label}
    </span>
  )
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  if (!error) return null
  return <div className="alert error">{error}</div>
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

export function Modal({
  title, subtitle, children, footer, onClose, wide,
}: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {help && <div className="help">{help}</div>}
    </div>
  )
}

const STATUS: Record<string, [string, string]> = {
  success: ['green', 'Completed'],
  completed_with_errors: ['amber', 'Completed with errors'],
  partial: ['amber', 'Completed with errors'],
  failed: ['red', 'Failed'],
  running: ['blue', 'Running'],
}

export function StatusBadge({ status, running }: { status: string | null | undefined; running?: boolean }) {
  if (running) status = 'running'
  if (!status) return <span className="badge">Not run yet</span>
  const [color, label] = STATUS[status] ?? ['', status]
  return (
    <span className={`badge ${color}`}>
      <span className={`dot ${status === 'running' ? 'pulse' : ''}`} /> {label}
    </span>
  )
}

export function Toggle<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void
}) {
  return (
    <div className="toggle">
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

const ICON_COLORS: Record<string, [string, string]> = {
  webhook: ['var(--blue-soft)', 'var(--blue)'],
  csv: ['var(--green-soft)', 'var(--green)'],
  hubspot: ['var(--amber-soft)', 'var(--amber)'],
  meta_custom_audience: ['var(--violet-soft)', 'var(--violet)'],
  sailthru: ['linear-gradient(135deg, #00B5B0, #058EA8)', '#fff'],
}
const ICON_TEXT: Record<string, string> = { webhook: '{ }', csv: 'CSV', hubspot: 'HS', meta_custom_audience: 'M', sailthru: 'ST' }

export function DestIcon({ type, size = 34 }: { type: string; size?: number }) {
  const [bg, fg] = ICON_COLORS[type] ?? ['var(--surface-2)', 'var(--text-2)']
  return (
    <div className="tile-icon" style={{ background: bg, color: fg, width: size, height: size, fontSize: size < 30 ? 10 : size > 40 ? 15 : 12, borderRadius: size > 40 ? 12 : undefined }}>
      {ICON_TEXT[type] ?? type.slice(0, 2).toUpperCase()}
    </div>
  )
}

export const STAGES = {
  source: { n: 0, label: 'Source' },
  schema: { n: 1, label: 'Schema' },
  modeling: { n: 2, label: 'Modeling' },
  segmentation: { n: 3, label: 'Segmentation' },
  activation: { n: 4, label: 'Activation' },
} as const
export type Stage = keyof typeof STAGES

/** Page header with a pipeline-stage eyebrow, e.g. "STEP 2 · MODELING". */
export function PageHead({ stage, title, subtitle, actions, back }: {
  stage?: Stage; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode
}) {
  const s = stage ? STAGES[stage] : null
  return (
    <div className="page-head">
      <div className="grow">
        {back}
        {s && <div className="eyebrow">{s.n ? <><span className="eyebrow-n">{s.n}</span>Step {s.n} · {s.label}</> : s.label}</div>}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="row wrap">{actions}</div>}
    </div>
  )
}

export function WaitingBadge() {
  return <span className="badge amber"><span className="dot" /> Waiting for credentials</span>
}
