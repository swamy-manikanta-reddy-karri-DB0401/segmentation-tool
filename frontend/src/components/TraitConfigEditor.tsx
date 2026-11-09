import type { ColumnType, GroupNode, TraitConfig, TraitMethod } from '../api'
import { ColumnSelect, GroupEditor, TimeWindowPicker, useBuilder, ValuePicker } from './builder/ConditionEditor'

export const METHODS: { value: TraitMethod; label: string; help: string }[] = [
  { value: 'aggregation', label: 'Aggregation', help: 'Sum or average of a number across related or event records — e.g. total booking value.' },
  { value: 'count', label: 'Count', help: 'Number of matching records — e.g. bookings in the last 30 days.' },
  { value: 'occurrence', label: 'Occurrence', help: 'First, last, most or least frequent value — e.g. most recent booking status.' },
  { value: 'list', label: 'List', help: 'A list of values — e.g. the last 3 properties viewed.' },
  { value: 'sql_aggregation', label: 'SQL Aggregation', help: 'Your own aggregation SQL. Reference columns as {{column "name"}}.' },
  { value: 'sql_formula', label: 'SQL Formula', help: 'Combine customer columns and other traits: {{column "name"}}, {{trait "Trait name"}}.' },
]
const RESULT_TYPES: { value: ColumnType; label: string }[] = [
  { value: 'string', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'boolean', label: 'Boolean' }, { value: 'timestamp', label: 'Timestamp' },
]

const empty = (): GroupNode => ({ type: 'group', op: 'and', conditions: [] })

export default function TraitConfigEditor({ method, config, onChange, allowFormula = true }: {
  method: TraitMethod; config: TraitConfig; onChange: (method: TraitMethod, config: TraitConfig) => void; allowFormula?: boolean
}) {
  const { schema } = useBuilder()
  const models = schema.models
  const model = models.find((m) => m.id === config.model_id) ?? models[0]
  const set = (patch: Partial<TraitConfig>) => onChange(method, { ...config, ...patch })
  const methods = METHODS.filter((m) => allowFormula || m.value !== 'sql_formula')
  const needsModel = method !== 'sql_formula'

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="cond-line">
        <select className="input sm" value={method} onChange={(e) => onChange(e.target.value as TraitMethod, { model_id: config.model_id ?? model?.id })}>
          {methods.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        {needsModel && model && (<>
          <span className="word">of</span>
          <select className="input sm" value={model.id} onChange={(e) => onChange(method, { model_id: Number(e.target.value) })}>
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </>)}
      </div>
      <div className="small muted">{METHODS.find((m) => m.value === method)?.help}</div>

      {method === 'aggregation' && model && (
        <div className="cond-line">
          <select className="input sm" value={config.fn ?? 'sum'} onChange={(e) => set({ fn: e.target.value as 'sum' | 'avg' })}>
            <option value="sum">Sum</option><option value="avg">Average</option>
          </select>
          <span className="word">of</span>
          <ColumnSelect model={model} value={config.column} types={['number']} onChange={(c) => set({ column: c.name })} />
        </div>
      )}
      {method === 'count' && model && (
        <div className="cond-line">
          <span className="word">Count</span>
          <select className="input sm" value={config.column ? 'distinct' : 'rows'} onChange={(e) => set({ column: e.target.value === 'rows' ? undefined : model.columns[0]?.name })}>
            <option value="rows">all records</option><option value="distinct">distinct values of</option>
          </select>
          {config.column && <ColumnSelect model={model} value={config.column} onChange={(c) => set({ column: c.name })} />}
        </div>
      )}
      {method === 'occurrence' && model && (
        <div className="cond-line">
          <select className="input sm" value={config.occurrence ?? 'last'} onChange={(e) => set({ occurrence: e.target.value as TraitConfig['occurrence'] })}>
            <option value="first">First / Min</option><option value="last">Last / Max</option>
            <option value="most_frequent">Most frequent</option><option value="least_frequent">Least frequent</option>
          </select>
          <span className="word">value of</span>
          <ColumnSelect model={model} value={config.column} onChange={(c) => set({ column: c.name })} />
          {(config.occurrence ?? 'last') !== 'most_frequent' && config.occurrence !== 'least_frequent' && (<>
            <span className="word">ordered by</span>
            <ColumnSelect model={model} value={config.order_by ?? model.timestamp_column ?? undefined} onChange={(c) => set({ order_by: c.name })} />
          </>)}
        </div>
      )}
      {method === 'list' && model && (
        <div className="cond-line">
          <ColumnSelect model={model} value={config.column} onChange={(c) => set({ column: c.name })} />
          <span className="word">ordered by</span>
          <ColumnSelect model={model} value={config.order_by} onChange={(c) => set({ order_by: c.name })} />
          <select className="input sm" value={config.descending === false ? 'asc' : 'desc'} onChange={(e) => set({ descending: e.target.value === 'desc' })}>
            <option value="desc">newest first</option><option value="asc">oldest first</option>
          </select>
          <span className="word">max</span>
          <input className="input sm num" type="number" value={config.limit ?? ''} placeholder="all" onChange={(e) => set({ limit: e.target.value })} style={{ width: 70 }} />
          <label className="row small"><input type="checkbox" checked={!!config.distinct} onChange={(e) => set({ distinct: e.target.checked })} /> distinct</label>
        </div>
      )}
      {(method === 'sql_aggregation' || method === 'sql_formula') && (<>
        <textarea className="input mono" rows={3} value={(method === 'sql_formula' ? config.formula : config.sql) ?? ''}
          placeholder={method === 'sql_formula' ? 'CASE WHEN {{trait "Lifetime value"}} > 1000 THEN \'high\' ELSE \'low\' END' : 'ARRAY_AGG(DISTINCT {{column "product_id"}})'}
          onChange={(e) => set(method === 'sql_formula' ? { formula: e.target.value } : { sql: e.target.value })} />
        <div className="cond-line">
          <span className="word">Result type</span>
          <select className="input sm" value={config.result_type ?? 'string'} onChange={(e) => set({ result_type: e.target.value as ColumnType })}>
            {RESULT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
      </>)}

      {needsModel && model && (
        <div className="cond-sub">
          <div className="label">Which records count</div>
          {model.event_name_column && (
            <div className="cond-line">
              <span className="word">Event</span>
              <ValuePicker modelId={model.id} column={model.event_name_column} values={config.event_names ?? []} onChange={(v) => set({ event_names: v })} />
            </div>
          )}
          {model.timestamp_column && (
            <div className="cond-line">
              <span className="word">Time window</span>
              <TimeWindowPicker value={config.time_window ?? { type: 'anytime' }} onChange={(tw) => set({ time_window: tw })} />
            </div>
          )}
          <GroupEditor group={config.filter ?? empty()} model={model} nested onChange={(g) => set({ filter: g })} />
        </div>
      )}
    </div>
  )
}
