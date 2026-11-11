/**
 * Recognizable logos for destinations and alert channels.
 * Brand marks come from Simple Icons (CC0). Brands not in Simple Icons (Slack, Sailthru, FreeWheel) and generic
 * channels (email, webhook, CSV) get a clean drawn glyph — never a letter tile.
 */
import { siBrevo, siDatabricks, siGoogle, siHubspot, siMeta, siPagerduty } from 'simple-icons'

type Mark = { path: string; color: string; viewBox?: string; stroke?: boolean }

const brand = (i: { path: string; hex: string }): Mark => ({ path: i.path, color: `#${i.hex}` })

// Line glyphs (24×24, stroked) for generic channels and brands without a free mark.
const GLYPH = {
  email: 'M4 6h16v12H4zM4 7l8 6 8-6',
  webhook: 'M9 7a3 3 0 1 1 3.5 2.9L15 15M7.5 19a3 3 0 1 1 1.4-5.6L12 10M18.5 18a3 3 0 1 1-2.9-3.5H9',
  csv: 'M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6M9 9h2',
  slack: 'M8 4v7M8 13v1.5a1.5 1.5 0 1 1-3 0V13zM16 20v-7M16 11V9.5a1.5 1.5 0 1 1 3 0V11zM4 16h7M13 16h1.5a1.5 1.5 0 1 1 0 3H13zM20 8h-7M11 8H9.5a1.5 1.5 0 1 1 0-3H11z',
  sailthru: 'M5 17c4 0 6-3 7-7 1 4 3 7 7 7M12 4v6M8 20h8',
  freewheel: 'M3 5h18v11H3zM8 20h8M12 16v4M10 8.5v4l3.5-2z',
  generic: 'M4 12h16M12 4v16',
}

const MARKS: Record<string, Mark> = {
  gam: brand(siGoogle),
  gam_kv: brand(siGoogle),
  google: brand(siGoogle),
  meta_custom_audience: brand(siMeta),
  meta: brand(siMeta),
  hubspot: brand(siHubspot),
  brevo: brand(siBrevo),
  pagerduty: brand(siPagerduty),
  databricks: brand(siDatabricks),
  slack: { path: GLYPH.slack, color: '#611f69', stroke: true },
  sailthru: { path: GLYPH.sailthru, color: '#00a19c', stroke: true },
  freewheel: { path: GLYPH.freewheel, color: '#2f6fd6', stroke: true },
  email: { path: GLYPH.email, color: '#3b78e0', stroke: true },
  webhook: { path: GLYPH.webhook, color: '#6d5bd0', stroke: true },
  csv: { path: GLYPH.csv, color: '#138a5e', stroke: true },
}

export const LOGO_LABEL: Record<string, string> = {
  gam: 'Google Ad Manager 360', gam_kv: 'Google Ad Manager (key-values)', meta_custom_audience: 'Meta', hubspot: 'HubSpot', brevo: 'Brevo', freewheel: 'FreeWheel Data Suite', pagerduty: 'PagerDuty', slack: 'Slack',
  sailthru: 'Sailthru', email: 'Email', webhook: 'Webhook', csv: 'CSV', databricks: 'Databricks',
}

/** A logo on a soft tile. `size` is the tile size in px. */
export function BrandLogo({ type, size = 34, title }: { type: string; size?: number; title?: string }) {
  const m = MARKS[type] ?? { path: GLYPH.generic, color: 'var(--text-3)', stroke: true }
  const inner = Math.round(size * 0.56)
  return (
    <span className="brand-tile" title={title ?? LOGO_LABEL[type] ?? type} aria-hidden={title ? undefined : true}
      style={{ width: size, height: size, borderRadius: Math.max(8, Math.round(size * 0.28)), ['--logo' as string]: m.color }}>
      <svg viewBox={m.viewBox ?? '0 0 24 24'} width={inner} height={inner} role="img"
        {...(m.stroke ? { fill: 'none', stroke: m.color, strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } : { fill: m.color })}>
        <path d={m.path} />
      </svg>
    </span>
  )
}
