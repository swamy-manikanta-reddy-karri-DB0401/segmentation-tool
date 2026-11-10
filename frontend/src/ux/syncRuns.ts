/** Shape sync runs for the run-history chart (oldest → newest, finished runs only). */
import type { SyncRun } from '../api'
import type { RunBar } from '../components/viz'

export function runBars(runs: SyncRun[] | undefined, limit = 30): RunBar[] {
  return (runs ?? []).filter((r) => r.status !== 'running').slice(0, limit).reverse().map((r) => ({
    id: r.id,
    label: `Run #${r.id}`,
    when: new Date(r.started_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
    added: r.added ?? 0, changed: r.changed ?? 0, removed: r.removed ?? 0, failed: r.failed ?? 0, status: r.status,
  }))
}

/** Totals across runs, for headline tiles. */
export function runTotals(runs: SyncRun[] | undefined) {
  const done = (runs ?? []).filter((r) => r.status !== 'running')
  return {
    count: done.length,
    failed: done.filter((r) => r.status === 'failed').length,
    sent: done.reduce((a, r) => a + (r.added ?? 0) + (r.changed ?? 0) + (r.removed ?? 0), 0),
  }
}

/** The first run sends everyone, which dwarfs the daily changes. When it's an outlier (more than 4x the
 * median of the rest) it is set aside and reported separately so the chart stays readable. */
export function splitInitialLoad(bars: RunBar[]): { bars: RunBar[]; initial: RunBar | null } {
  if (bars.length < 4) return { bars, initial: null }
  const total = (b: RunBar) => b.added + b.changed + b.removed
  const rest = bars.slice(1).map(total).sort((a, b) => a - b)
  const median = rest[Math.floor(rest.length / 2)] || 0
  return total(bars[0]) > Math.max(4 * median, 50) ? { bars: bars.slice(1), initial: bars[0] } : { bars, initial: null }
}
