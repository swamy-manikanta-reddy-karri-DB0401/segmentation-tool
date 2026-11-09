/**
 * Shared alerting pieces: types, severity / status visuals, channel icons, the mute menu and the
 * trigger editor (used for destination defaults on the Alerts page and per-sync overrides on a sync).
 */
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { toast } from './kit'

export type Severity = 'warning' | 'critical'
export type AlertStatus = 'healthy' | Severity
export type TriggerKey = 'fatal' | 'rejected' | 'throughput' | 'audience' | 'duration'
export type Threshold = 'min_rows' | 'days' | 'minutes'

export interface AlertRow {
  id: number; sync_id: number; trigger: TriggerKey; status: AlertStatus; message: string; error: string
  opened_at: string | null; updated_at: string; resolved_at: string | null; muted_until: string | null; last_run_id: number | null
  sync_name: string; destination_id: number; destination_name: string; destination_type: string; audience_name: string
  brand_id: number | null; label: string; muted: boolean; can_mute: boolean
}
export interface AlertEvent {
  id: number; alert_id: number; sync_id: number; trigger: TriggerKey; old_status: AlertStatus; new_status: AlertStatus; message: string
  at: string; muted: number; run_id: number | null; sync_name: string; destination_id: number; destination_name: string
  brand_id: number | null; label: string
  deliveries: { recipient_id: number; name: string; channel: Channel; ok: boolean; error?: string }[]
}
export interface TriggerDef { key: TriggerKey; label: string; description: string; defaults: TriggerCfg; threshold: Threshold | null }
export type Channel = 'email' | 'slack' | 'pagerduty' | 'webhook'
export interface Catalog { triggers: TriggerDef[]; channels: { key: Channel; label: string; fields: string[] }[]; email_configured: boolean }
export interface TriggerCfg { enabled?: boolean; severity?: Severity; min_rows?: number; days?: number; minutes?: number }
export interface Recipient {
  id: number; name: string; channel: Channel; config: Record<string, string>; severity: 'all' | 'critical'
  destination_ids: number[]; brand_id: number | null; enabled: boolean; created_by: string; created_at: string; target: string
}
export interface Policy {
  triggers: Record<TriggerKey, TriggerCfg & { source: 'default' | 'destination' | 'sync' }>
  recipient_ids: number[] | null
  recipients_source: 'default' | 'destination' | 'sync'
  own: { triggers: Partial<Record<TriggerKey, TriggerCfg>>; recipient_ids: number[] | null }
}

/** How each threshold reads in a sentence. */
export const THRESHOLD_TEXT: Record<TriggerKey, { before: string; after: string } | null> = {
  fatal: null,
  rejected: { before: 'when at least', after: 'records are rejected in a run' },
  throughput: { before: 'when nothing is delivered for', after: 'days' },
  audience: { before: 'when fewer than', after: 'people qualify at run time' },
  duration: { before: 'when a run takes longer than', after: 'minutes' },
}

export const MUTE_OPTIONS: { label: string; minutes: number | null }[] = [
  { label: '1 hour', minutes: 60 }, { label: '4 hours', minutes: 240 }, { label: '1 day', minutes: 1440 },
  { label: '1 week', minutes: 10080 }, { label: 'Until I unmute', minutes: null },
]

export function muteLabel(until: string | null): string {
  if (!until) return ''
  if (until === 'forever') return 'Muted until unmuted'
  const ms = new Date(until).getTime() - Date.now()
  if (ms <= 0) return ''
  const h = ms / 3600000
  return `Muted for ${h < 1 ? `${Math.ceil(ms / 60000)} more min` : h < 48 ? `${Math.round(h)} more h` : `${Math.round(h / 24)} more days`}`
}

export function since(iso: string | null): string {
  if (!iso) return '—'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`
}

/** opened / escalated / downgraded / recovered */
export function changeKind(e: Pick<AlertEvent, 'old_status' | 'new_status'>): { label: string; tone: string } {
  if (e.new_status === 'healthy') return { label: 'Recovered', tone: 'green' }
  if (e.old_status === 'healthy') return { label: 'Opened', tone: e.new_status === 'critical' ? 'red' : 'amber' }
  if (e.new_status === 'critical') return { label: 'Escalated', tone: 'red' }
  return { label: 'Downgraded', tone: 'amber' }
}

export function SeverityBadge({ status, muted }: { status: AlertStatus; muted?: boolean }) {
  const text = status === 'critical' ? 'Critical' : status === 'warning' ? 'Warning' : 'Healthy'
  return <span className={`al-sev ${status} ${muted ? 'muted' : ''}`}><span className="al-sev-dot" aria-hidden="true" />{text}</span>
}

const CH_ICON: Record<Channel, string> = {
  email: 'M4 6h16v12H4zM4 7l8 6 8-6',
  slack: 'M9 3a2 2 0 0 0 0 4h2V5a2 2 0 0 0-2-2zM3 9a2 2 0 0 0 2 2h6V9a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2zM15 21a2 2 0 0 0 0-4h-2v2a2 2 0 0 0 2 2zM21 15a2 2 0 0 0-2-2h-6v2a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2zM21 9a2 2 0 1 0-4 0v2h2a2 2 0 0 0 2-2zM3 15a2 2 0 1 0 4 0v-2H5a2 2 0 0 0-2 2z',
  pagerduty: 'M7 21V3h6a5 5 0 0 1 0 10H7',
  webhook: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
}
export const CHANNEL_LABEL: Record<Channel, string> = { email: 'Email', slack: 'Slack', pagerduty: 'PagerDuty', webhook: 'Webhook' }

export function ChannelIcon({ channel, size = 36 }: { channel: Channel; size?: number }) {
  return (
    <span className={`al-ch ${channel}`} style={{ width: size, height: size }} aria-label={CHANNEL_LABEL[channel]} role="img">
      <svg viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={CH_ICON[channel]} /></svg>
    </span>
  )
}

/** Mute a trigger for a while; tells the shell to refresh the nav count. */
export function MuteMenu({ syncId, trigger, muted, onDone, compact }: { syncId: number; trigger: TriggerKey; muted: boolean; onDone: () => void; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])
  const call = async (path: string, body: object, msg: string) => {
    setBusy(true)
    try { await api.post(path, body); toast(msg); window.dispatchEvent(new Event('alerts:changed')); onDone() }
    catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false); setOpen(false) }
  }
  if (muted) {
    return <button className={`btn ${compact ? 'ghost sm' : 'sm'}`} disabled={busy} onClick={() => call('/alerts/unmute', { sync_id: syncId, trigger }, 'Unmuted — notifications resume')}>Unmute</button>
  }
  return (
    <div className="al-mute" ref={ref}>
      <button className={`btn ${compact ? 'ghost sm' : 'sm'}`} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} disabled={busy}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6" /></svg>
        Mute ▾
      </button>
      {open && (
        <div className="al-mute-menu" role="menu">
          <div className="al-mute-hint">Keep tracking, stop notifying for…</div>
          {MUTE_OPTIONS.map((o) => (
            <button key={o.label} role="menuitem" onClick={() => call('/alerts/mute', { sync_id: syncId, trigger, minutes: o.minutes }, o.minutes ? `Muted for ${o.label}` : 'Muted until you unmute it')}>{o.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`al-switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <span />
    </button>
  )
}
export { Switch }

/**
 * Edits the triggers for a scope. `base` is what applies without overrides (built-in defaults for a
 * destination; the destination's settings for a sync); `own` holds this scope's overrides.
 */
export function TriggerEditor({ catalog, base, own, onChange, readOnly, baseName, statuses }: {
  catalog: TriggerDef[]; base: Record<string, TriggerCfg>; own: Partial<Record<TriggerKey, TriggerCfg>>
  onChange: (own: Partial<Record<TriggerKey, TriggerCfg>>) => void; readOnly?: boolean; baseName: string
  statuses?: Partial<Record<TriggerKey, { status: AlertStatus; muted: boolean; extra?: React.ReactNode }>>
}) {
  const set = (key: TriggerKey, patch: TriggerCfg) => {
    const next: TriggerCfg = { ...(own[key] ?? {}), ...patch }
    // drop values equal to the inherited ones so "customized" means really different
    for (const k of Object.keys(next) as (keyof TriggerCfg)[]) if (next[k] === base[key]?.[k]) delete next[k]
    const out = { ...own, [key]: next }
    if (!Object.keys(next).length) delete out[key]
    onChange(out)
  }
  return (
    <div className="al-rules" role="table" aria-label="Alert triggers">
      {catalog.map((t) => {
        const v: TriggerCfg = { ...base[t.key], ...(own[t.key] ?? {}) }
        const custom = !!own[t.key] && Object.keys(own[t.key]!).length > 0
        const th = THRESHOLD_TEXT[t.key]
        const st = statuses?.[t.key]
        return (
          <div key={t.key} className={`al-rule ${v.enabled ? '' : 'off'}`} role="row">
            <div className="al-rule-main" role="cell">
              <div className="al-rule-title">
                <strong>{t.label}</strong>
                {st && <SeverityBadge status={st.status} muted={st.muted} />}
                {custom ? <span className="al-tag custom">Customized</span> : <span className="al-tag">Using {baseName}</span>}
              </div>
              <div className="small muted">{t.description}</div>
              {th && t.threshold && (
                <div className="al-rule-th">
                  <span>Alert {th.before}</span>
                  <input className="input sm num" type="number" min={1} value={v[t.threshold] ?? ''} disabled={readOnly || !v.enabled}
                    aria-label={`${t.label} threshold`} onChange={(e) => set(t.key, { [t.threshold!]: Math.max(1, Number(e.target.value) || 1) })} />
                  <span>{th.after}</span>
                </div>
              )}
              {st?.extra}
            </div>
            <div className="al-rule-side" role="cell">
              <select className="input sm" value={v.severity ?? 'warning'} disabled={readOnly || !v.enabled} aria-label={`${t.label} severity`}
                onChange={(e) => set(t.key, { severity: e.target.value as Severity })}>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </select>
              <Switch on={!!v.enabled} onChange={(on) => set(t.key, { enabled: on })} label={`${t.label} ${v.enabled ? 'on' : 'off'}`} disabled={readOnly} />
              {!readOnly && (
                <button className={`btn ghost sm al-reset ${custom ? '' : 'hidden'}`} tabIndex={custom ? 0 : -1} aria-hidden={!custom}
                  onClick={() => { const out = { ...own }; delete out[t.key]; onChange(out) }} title={`Go back to ${baseName}`}>Reset</button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Who gets notified: everyone whose scope matches, or a picked list. */
export function RoutingEditor({ recipients, value, onChange, readOnly, inheritedText }: {
  recipients: Recipient[]; value: number[] | null; onChange: (v: number[] | null) => void; readOnly?: boolean; inheritedText: string
}) {
  const picked = value ?? []
  return (
    <div className="al-routing">
      <label className={`al-route-opt ${value === null ? 'on' : ''}`}>
        <input type="radio" checked={value === null} disabled={readOnly} onChange={() => onChange(null)} />
        <div><strong>{inheritedText}</strong><div className="small muted">Recipients whose scope includes this destination are told automatically.</div></div>
      </label>
      <label className={`al-route-opt ${value !== null ? 'on' : ''}`}>
        <input type="radio" checked={value !== null} disabled={readOnly || !recipients.length} onChange={() => onChange(picked)} />
        <div><strong>Only specific recipients</strong><div className="small muted">{recipients.length ? 'Pick exactly who is notified.' : 'Add a recipient first.'}</div></div>
      </label>
      {value !== null && (
        <div className="al-route-list">
          {recipients.map((r) => (
            <label key={r.id} className="al-route-item">
              <input type="checkbox" checked={picked.includes(r.id)} disabled={readOnly}
                onChange={(e) => onChange(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} />
              <ChannelIcon channel={r.channel} size={24} />
              <span className="al-ellipsis">{r.name}</span>
              <span className="small faint">{r.severity === 'critical' ? 'Critical only' : 'All alerts'}</span>
            </label>
          ))}
          {value.length === 0 && <div className="small" style={{ color: 'var(--amber)' }}>Nobody will be notified — pick at least one recipient.</div>}
        </div>
      )}
    </div>
  )
}
