/** Plain-language health of a sync, used by the syncs list and the sync page. */
import { fmt } from '../api'
import type { Sync, SyncRun } from '../api'

export type HealthKey = 'pending' | 'rejected' | 'waiting' | 'running' | 'paused' | 'failing' | 'warning' | 'healthy' | 'new'
export type Health = { key: HealthKey; tone: 'amber' | 'red' | 'blue' | 'gray' | 'green'; label: string; sentence: string }

/** Filter groups shown as chips on the syncs list. */
export const HEALTH_GROUPS = {
  approval: ['pending', 'rejected'],
  failing: ['failing', 'warning'],
  waiting: ['waiting'],
  paused: ['paused'],
  healthy: ['healthy', 'running', 'new'],
} as const satisfies Record<string, readonly HealthKey[]>

export function syncHealth(s: Sync, last?: Pick<SyncRun, 'status' | 'failed' | 'added' | 'changed' | 'removed' | 'error' | 'finished_at' | 'started_at'>): Health {
  if (s.approval_status === 'pending') return { key: 'pending', tone: 'amber', label: 'Pending approval', sentence: `Submitted by ${s.submitted_by || 'a builder'} — waiting for a Brand Marketing Admin` }
  if (s.approval_status === 'rejected') return { key: 'rejected', tone: 'red', label: 'Changes requested', sentence: s.review_note ? `Sent back: “${s.review_note}”` : `Sent back by ${s.approved_by || 'an admin'}` }
  if (s.running) return { key: 'running', tone: 'blue', label: 'Running', sentence: 'Sending changes now…' }
  if (s.destination_configured === false) return { key: 'waiting', tone: 'amber', label: 'Waiting for credentials', sentence: `Waiting for ${s.destination_name} credentials` }
  if (!s.enabled) return { key: 'paused', tone: 'gray', label: 'Paused', sentence: 'Schedule paused — runs only when started manually' }
  const when = fmt.ago(last?.finished_at ?? last?.started_at ?? s.last_run_at)
  switch (s.last_status) {
    case 'failed':
      return { key: 'failing', tone: 'red', label: 'Failed', sentence: `Last run failed ${when}${last?.error ? ` — ${short(last.error)}` : ''}` }
    case 'completed_with_errors':
    case 'partial':
      return { key: 'warning', tone: 'amber', label: 'Delivered with errors', sentence: `${last?.failed ? `${fmt.num(last.failed)} row${last.failed === 1 ? '' : 's'} rejected` : 'Some rows rejected'} · ${when}` }
    case 'success':
      return { key: 'healthy', tone: 'green', label: 'Delivered', sentence: `Delivered ${when}${last ? changes(last) : ''}` }
    default:
      return { key: 'new', tone: 'gray', label: 'Not run yet', sentence: s.next_run_at ? 'Waiting for its first scheduled run' : 'Hasn’t run yet' }
  }
}

function changes(r: { added: number; changed: number; removed: number }) {
  const parts = [r.added && `+${fmt.num(r.added)}`, r.changed && `~${fmt.num(r.changed)}`, r.removed && `−${fmt.num(r.removed)}`].filter(Boolean)
  return parts.length ? ` · ${parts.join(' ')}` : ' · no changes'
}

const short = (t: string) => (t.length > 70 ? t.slice(0, 67) + '…' : t)

/** "in 3h", "in 2d", "overdue" for upcoming times. */
export function until(iso: string | null | undefined): string {
  if (!iso) return '—'
  const s = (new Date(iso).getTime() - Date.now()) / 1000
  if (s < 0) return 'due now'
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `in ${Math.round(s / 3600)}h`
  return `in ${Math.round(s / 86400)}d`
}

export const DELETE_LABEL: Record<string, string> = { do_nothing: 'Do nothing', clear: 'Clear', delete: 'Delete', remove: 'Remove' }
