import type { Schedule } from '../api'
import { Field } from './ui'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const TYPES = [
  { value: 'manual', label: 'Manual', help: 'Runs only when you click Run (or something triggers it via the API).' },
  { value: 'interval', label: 'Interval', help: 'Runs every n minutes, hours, days or weeks. Start times can drift after manual runs.' },
  { value: 'recurrence', label: 'Custom recurrence', help: 'Runs on specific days and times. Pick times in your local timezone; they are saved in UTC.' },
  { value: 'cron', label: 'Cron expression', help: 'Five fields, evaluated in UTC. W, LW, L-n and # are not supported.' },
] as const

const pad = (n: number) => String(n).padStart(2, '0')

/** Convert a local weekday/time to UTC (days: 0 = Monday). */
function shift(days: number[], time: string, toUtc: boolean) {
  const [h, m] = time.split(':').map(Number)
  const offset = new Date().getTimezoneOffset() // minutes, local -> UTC
  let minutes = h * 60 + m + (toUtc ? offset : -offset)
  let dayShift = 0
  while (minutes < 0) { minutes += 1440; dayShift -= 1 }
  while (minutes >= 1440) { minutes -= 1440; dayShift += 1 }
  return { days: days.map((d) => (d + dayShift + 7) % 7), time: `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}` }
}
export const recurrenceToLocal = (r: { days: number[]; time: string }) => shift(r.days, r.time, false)
export const recurrenceToUtc = (r: { days: number[]; time: string }) => shift(r.days, r.time, true)

/** The editor keeps recurrence times in LOCAL time; call `toApi` before saving. */
export function toApi(s: Schedule): Schedule {
  return s.type === 'recurrence' ? { ...s, recurrences: s.recurrences.map(recurrenceToUtc) } : s
}
export function fromApi(s: Schedule | null | undefined): Schedule {
  if (!s) return { type: 'manual' }
  return s.type === 'recurrence' ? { ...s, recurrences: s.recurrences.map(recurrenceToLocal) } : s
}

export function scheduleLabel(s: Schedule | null | undefined): string {
  if (!s || s.type === 'manual') return 'Manual'
  if (s.type === 'interval') return `Every ${s.every} ${s.every === 1 ? s.unit.replace(/s$/, '') : s.unit}`
  if (s.type === 'cron') return `Cron: ${s.expression} (UTC)`
  return s.recurrences.map((r) => {
    const l = recurrenceToLocal(r)
    const days = l.days.length === 7 ? 'Every day'
      : l.days.join() === '0,1,2,3,4' ? 'Weekdays'
        : l.days.join() === '5,6' ? 'Weekends' : l.days.map((d) => DAYS[d]).join(', ')
    return `${days} at ${l.time}`
  }).join('; ')
}

export default function ScheduleEditor({ value, onChange }: { value: Schedule; onChange: (s: Schedule) => void }) {
  const info = TYPES.find((t) => t.value === value.type)!
  return (
    <Field label="Schedule type" help={info.help}>
      <select className="input" style={{ maxWidth: 260 }} value={value.type} onChange={(e) => {
        const t = e.target.value
        onChange(t === 'interval' ? { type: 'interval', every: 1, unit: 'hours' }
          : t === 'recurrence' ? { type: 'recurrence', recurrences: [{ days: [0, 1, 2, 3, 4], time: '09:00' }] }
            : t === 'cron' ? { type: 'cron', expression: '0 12 * * *' } : { type: 'manual' })
      }}>
        {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
      </select>
      {value.type === 'interval' && (
        <div className="row" style={{ marginTop: 6 }}>
          <span className="muted">Every</span>
          <input className="input num" type="number" min={1} value={value.every} onChange={(e) => onChange({ ...value, every: Number(e.target.value) })} />
          <select className="input" value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value as typeof value.unit })}>
            {['minutes', 'hours', 'days', 'weeks'].map((u) => <option key={u}>{u}</option>)}
          </select>
        </div>
      )}
      {value.type === 'recurrence' && (
        <div className="stack" style={{ marginTop: 6, gap: 8 }}>
          {value.recurrences.map((r, i) => (
            <div key={i} className="row wrap">
              {DAYS.map((d, di) => (
                <label key={d} className="row small" style={{ gap: 3 }}>
                  <input type="checkbox" checked={r.days.includes(di)} onChange={(e) => {
                    const days = e.target.checked ? [...r.days, di].sort() : r.days.filter((x) => x !== di)
                    onChange({ ...value, recurrences: value.recurrences.map((x, j) => (j === i ? { ...x, days } : x)) })
                  }} />{d}
                </label>
              ))}
              <span className="muted small">at</span>
              <input className="input sm" type="time" value={r.time}
                onChange={(e) => onChange({ ...value, recurrences: value.recurrences.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)) })} />
              {value.recurrences.length > 1 && (
                <button className="btn ghost icon sm" onClick={() => onChange({ ...value, recurrences: value.recurrences.filter((_, j) => j !== i) })}>✕</button>
              )}
            </div>
          ))}
          <div><button className="btn ghost sm" onClick={() => onChange({ ...value, recurrences: [...value.recurrences, { days: [5, 6], time: '08:00' }] })}>+ Add recurrence</button></div>
          <div className="small faint">Times are in your local timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</div>
        </div>
      )}
      {value.type === 'cron' && (
        <input className="input mono" style={{ maxWidth: 260, marginTop: 6 }} value={value.expression} onChange={(e) => onChange({ ...value, expression: e.target.value })} />
      )}
    </Field>
  )
}
