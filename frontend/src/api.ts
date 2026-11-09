export type ColumnType = 'string' | 'number' | 'boolean' | 'date' | 'timestamp' | 'other'

export interface Column {
  name: string
  data_type: string
  type: ColumnType
  description: string
}

export interface ColumnSettings {
  alias?: string
  hidden?: boolean
  privacy?: 'unreviewed' | 'approved' | 'blocked' | 'redacted' | 'sync_only' | 'sync_blocked'
  suggestions?: boolean
  case_sensitive?: boolean
}

export interface JoinKey { parent: string; model: string }

export interface Model {
  id: number
  connection_id?: number | null
  kind: 'parent' | 'related' | 'event'
  name: string
  description: string
  table_ref: string
  query_type: 'table' | 'sql'
  sql: string | null
  parent_id: number | null
  relationship: '1:many' | '1:1' | 'many:1' | null
  join_keys: JoinKey[]
  merge_columns: string[]
  column_settings: Record<string, ColumnSettings>
  secondary_label: string | null
  primary_key: string | null
  label_column: string | null
  foreign_key: string | null
  parent_key: string | null
  timestamp_column: string | null
  event_name_column: string | null
  columns: Column[]
}

export interface VirtualColumn { name: string; label: string; group: string; type: ColumnType; description: string }

export interface Trait {
  id: number
  parent_id: number
  name: string
  description: string
  method: TraitMethod
  config: TraitConfig
}
export type TraitMethod = 'aggregation' | 'count' | 'occurrence' | 'list' | 'sql_aggregation' | 'sql_formula'
export interface TraitConfig {
  model_id?: number
  fn?: 'sum' | 'avg'
  column?: string
  occurrence?: 'first' | 'last' | 'most_frequent' | 'least_frequent'
  order_by?: string
  descending?: boolean
  distinct?: boolean
  limit?: number | string
  sql?: string
  formula?: string
  result_type?: ColumnType
  filter?: GroupNode
  time_window?: TimeWindow
  event_names?: string[]
}

export interface Schema {
  parent: Model | null
  models: Model[]
  traits: Trait[]
  virtual_columns: VirtualColumn[]
  parents: Model[]
}

export type TimeWindow = {
  type: 'anytime' | 'within' | 'not_within' | 'before' | 'after' | 'between'
  direction?: 'previous' | 'next'
  calendar?: boolean
  amount?: number | string
  unit?: string
  from?: string
  to?: string
  date?: string
}

export interface GroupNode {
  type: 'group'
  op: 'and' | 'or'
  conditions: ConditionNode[]
}
export interface PropertyNode {
  type: 'property'
  column: string
  operator: string
  value?: string | number
  value2?: string | number
  values?: string[]
  amount?: number | string
  unit?: string
  direction?: 'previous' | 'next'
  calendar?: boolean
  compare?: { column: string }
}
export interface Aggregate {
  fn: 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max'
  column?: string
  operator: string
  value: number | string
  value2?: number | string
}
export interface RelationNode {
  type: 'relation'
  model_id: number
  filter: GroupNode
  time_window: TimeWindow
  aggregate: Aggregate
}
export interface EventNode {
  type: 'event'
  model_id: number
  did: boolean
  event_names: string[]
  filter: GroupNode
  time_window: TimeWindow
  frequency: { operator: string; value: number | string; value2?: number | string }
  then?: EventThen
}
export interface EventThen {
  did: boolean
  model_id: number
  event_names: string[]
  filter: GroupNode
  within: { amount: number | string; unit: string }
}
export interface SequenceStep {
  model_id: number
  event_names: string[]
  filter: GroupNode
}
export interface SequenceNode {
  type: 'sequence'
  first: SequenceStep
  then: SequenceStep
  did_then: boolean
  within: { amount: number | string; unit: string }
  time_window: TimeWindow
}
export interface TraitNode {
  type: 'trait'
  trait_id?: number
  inline?: { method: TraitMethod } & TraitConfig
  operator: string
  value?: string | number
  value2?: string | number
  values?: string[]
}
export interface AudienceRefNode {
  type: 'audience'
  audience_id: number
  included: boolean
}
export type ConditionNode = GroupNode | PropertyNode | RelationNode | EventNode | SequenceNode | AudienceRefNode | TraitNode

export interface Splits { enabled: boolean; groups: { name: string; percent: number }[] }

export interface Audience {
  id: number
  parent_id: number
  parent_name?: string
  splits: Splits
  name: string
  description: string
  definition: GroupNode
  last_size: number | null
  size_updated_at: string | null
  created_at: string
  updated_at: string
  sync_count?: number
}

export interface ConfigField {
  name: string
  label: string
  type: string
  required: boolean
  help: string
  default: string | number | null
  options: { value: string; label: string }[]
  modes: string[]
}

export interface TargetField { name: string; label: string; required: boolean }

export interface SyncTypeDef {
  name: string
  label: string
  description: string
  modes: string[]
  identifiers: { name: string; label: string; modes: string[] }[]
  target_fields: TargetField[]
  custom_fields: boolean
  delete_behaviors: Record<string, string>
  options: ConfigField[]
  source: 'audience' | 'events'
}

export interface DestinationType {
  type: string
  label: string
  description: string
  category: string
  beta: boolean
  config_fields: ConfigField[]
  sync_types: SyncTypeDef[]
}

export interface Destination {
  id: number
  name: string
  type: string
  config: Record<string, string>
  created_at: string
  sync_count?: number
  configured?: boolean
  missing_fields?: string[]
}

export interface Mapping {
  target: string
  type?: 'column' | 'static' | 'variable' | 'template'
  source?: string
  value?: string
  value_type?: 'string' | 'number' | 'boolean' | 'null'
  variable?: string
  template?: string
  null_behavior?: 'always' | 'skip_nulls'
}

export type Schedule =
  | { type: 'manual' }
  | { type: 'interval'; every: number; unit: 'minutes' | 'hours' | 'days' | 'weeks' }
  | { type: 'recurrence'; recurrences: { days: number[]; time: string }[] }
  | { type: 'cron'; expression: string }

export interface SyncConfig {
  sync_type: string
  mode: string
  model_id?: number
  match?: { source: string; field: string }
  mapping: Mapping[]
  delete_behavior: string
  options: Record<string, string | number>
  split_group?: string | null
  alerts?: { webhook_url?: string; on_failure?: boolean; on_rejected?: boolean }
}

export interface DestinationRule { id: number; parent_id: number; destination_id: number; destination_name: string; destination_type: string; name: string; definition: GroupNode }
export interface PriorityList { id: number; parent_id: number; name: string; config: { audience_ids: number[] } }
export interface SyncTemplate { id: number; name: string; destination_id: number; config: SyncConfig }

export interface Sync {
  id: number
  name: string
  audience_id: number
  destination_id: number
  audience_name: string
  destination_name: string
  destination_type: string
  config: SyncConfig
  schedule: Schedule
  next_run_at: string | null
  enabled: boolean
  last_run_at: string | null
  last_status: string | null
  running: boolean
  destination_configured?: boolean
}

export interface SyncRun {
  id: number
  sync_id: number
  status: 'running' | 'success' | 'completed_with_errors' | 'partial' | 'failed'
  trigger: string
  started_at: string
  finished_at: string | null
  audience_rows: number | null
  added: number
  changed: number
  removed: number
  failed: number
  error: string | null
  details?: {
    errors?: { id: string; kind: string; error: string }[]; query?: string; traceback?: string
    requests?: { method: string; url: string; request: string; status: number | null; response: string }[]
    snapshot?: { table: string } | null
  }
  sync_name?: string
}

export interface Calculation {
  total: number
  size: number
  steps: number[]
}

export interface Settings {
  as_of_date: string
  null_behavior: 'value' | 'special'
  audience_snapshots: boolean
  snapshot_table: string
  parent_as_of_date: Record<string, string>
}

export interface Overview {
  source: { ok: boolean; warehouse: { name: string; state: string; size: string } | null; host: string; connections: number; connections_ok: number; datasets: number; tables: number; rows: number }
  schema: { parents: number; related: number; events: number; parent_names: string[] }
  modeling: { traits: number; profiles: number }
  segmentation: { audiences: number; largest: { id: number; name: string; size: number } | null }
  activation: {
    destinations: number; configured_destinations: number; unconfigured: { id: number; name: string; type: string }[]
    syncs: number; records_synced: number; last_run: { status: string; started_at: string } | null
  }
}

export interface SourceTable {
  name: string
  full_name: string
  rows: number | null
  columns: number | null
  size_bytes: number | null
  last_modified: string | null
  comment: string | null
  used_by: { model_id: number; model_name: string; kind: string }[]
}
export interface Dataset { catalog: string; schema: string; tables: SourceTable[] }
export interface SourceConnection {
  id?: number
  name: string
  host: string
  auth_type: 'oauth' | 'pat'
  client_id: string
  secret: string
  warehouse_id: string
  state_schema: string
  parents?: { id: number; name: string }[]
  is_default?: boolean
}
export interface SourceStatus extends SourceConnection {
  id: number
  ok: boolean
  error?: string
  warehouse: { name: string; state: string; size: string } | null
  datasets: Dataset[]
}
export interface SourcesResponse { connections: SourceStatus[] }
export interface Warehouse { id: string; name: string; state: string; size: string; serverless: boolean }

export interface ProfileSearch {
  parent: { id: number; name: string; primary_key: string; label_column: string | null; secondary_label: string | null }
  results: { id: string; label: string | null; secondary: string | null }[]
}
export interface Profile {
  id: string
  label: string | null
  secondary: string | null
  parent: { id: number; name: string }
  attributes: { name: string; label: string; type: string; value: unknown }[]
  traits: { id: number; name: string; type: string; value: unknown }[]
  audiences: { id: number; name: string; member: boolean }[]
  events: { model_id: number; model_name: string; timestamp_column: string | null; columns: string[]; rows: unknown[][] }[]
}

export class ApiError extends Error {}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const data = await res.json()
      if (data.detail) msg = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)
    } catch {
      /* not json */
    }
    throw new ApiError(msg)
  }
  return res.json() as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
}

export const fmt = {
  num: (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString()),
  pct: (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—'),
  bytes: (n: number | null | undefined) => {
    if (n == null) return '—'
    const u = ['B', 'KB', 'MB', 'GB', 'TB']
    let i = 0
    let v = n
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
    return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`
  },
  compact: (n: number | null | undefined) => (n == null ? '—' : Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)),
  ago: (iso: string | null | undefined) => {
    if (!iso) return 'never'
    const s = (Date.now() - new Date(iso).getTime()) / 1000
    if (s < 60) return 'just now'
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
  },
  duration: (a: string, b: string | null) => {
    if (!b) return '…'
    const s = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000)
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
  },
}
