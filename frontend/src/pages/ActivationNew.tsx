import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Audience, ConfigField, Destination, DestinationType, Mapping, Schedule, Schema, Sync, SyncConfig, SyncTemplate, SyncTypeDef } from '../api'
import ScheduleEditor, { fromApi, toApi } from '../components/ScheduleEditor'
import { DestIcon, Empty, ErrorBox, Field, Spinner, Toggle, useAsync } from '../components/ui'

const MODE_INFO: Record<string, string> = {
  upsert: 'Update existing records and insert new ones',
  update: 'Only update records that already exist in the destination',
  insert: 'Only send new rows — rows already sent are never updated',
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
const SYNONYMS: Record<string, string[]> = {
  email: ['email', 'emailaddress', 'mail'], phone: ['phone', 'phonenumber', 'mobile'],
  firstname: ['firstname', 'givenname', 'fname'], lastname: ['lastname', 'surname', 'familyname'],
  company: ['company', 'companyname'], country: ['country', 'countrycode'], city: ['city'],
}

/** Suggest mappings: pair columns and destination fields with similar names. */
function suggest(columns: string[], targets: { name: string }[]): Mapping[] {
  const out: Mapping[] = []
  for (const t of targets) {
    const keys = SYNONYMS[norm(t.name)] ?? [norm(t.name)]
    const col = columns.find((c) => keys.includes(norm(c.replace(/^customer\./, ''))) || norm(c).endsWith(norm(t.name)))
    if (col) out.push({ source: col, target: t.name })
  }
  return out
}

function OptionInput({ field, value, columns, onChange }: { field: ConfigField; value: unknown; columns: string[]; onChange: (v: string) => void }) {
  if (field.type === 'select') {
    return (
      <select className="input" value={String(value ?? field.default ?? '')} onChange={(e) => onChange(e.target.value)}>
        {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    )
  }
  if (field.type === 'column') {
    return (
      <select className="input" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        <option value="">— none —</option>
        {columns.map((c) => <option key={c}>{c}</option>)}
      </select>
    )
  }
  return (
    <input className="input" type={field.type === 'number' ? 'number' : 'text'} value={String(value ?? '')}
      placeholder={field.default != null ? String(field.default) : ''} onChange={(e) => onChange(e.target.value)} />
  )
}

const VARIABLES = [
  { value: 'model-id', label: 'Audience ID' }, { value: 'model-name', label: 'Audience name' },
  { value: 'current-timestamp', label: 'Current timestamp' }, { value: 'sync-id', label: 'Sync ID' }, { value: 'sync-run-id', label: 'Sync run ID' },
]

function MappingRow({ m, columns, labels, st, onChange, onRemove }: {
  m: Mapping; columns: string[]; labels: Record<string, string>; st: SyncTypeDef; onChange: (m: Mapping) => void; onRemove: () => void
}) {
  const kind = m.type ?? 'column'
  return (
    <div className="mapping-row">
      <select className="input sm" value={kind} style={{ width: 120 }} onChange={(e) => onChange({ target: m.target, type: e.target.value as Mapping['type'], null_behavior: m.null_behavior })}>
        <option value="column">Column</option><option value="static">Static value</option>
        <option value="variable">Variable</option><option value="template">Template</option>
      </select>
      <div className="grow">
        {kind === 'column' && (
          <select className="input" value={m.source ?? ''} onChange={(e) => onChange({ ...m, source: e.target.value })}>
            <option value="">Choose column…</option>
            {columns.map((c) => <option key={c} value={c}>{labels[c] ?? c}</option>)}
          </select>
        )}
        {kind === 'static' && (
          <div className="row">
            <select className="input sm" value={m.value_type ?? 'string'} onChange={(e) => onChange({ ...m, value_type: e.target.value as Mapping['value_type'] })}>
              <option value="string">String</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="null">Null</option>
            </select>
            {m.value_type !== 'null' && <input className="input grow" value={m.value ?? ''} placeholder="value" onChange={(e) => onChange({ ...m, value: e.target.value })} />}
          </div>
        )}
        {kind === 'variable' && (
          <select className="input" value={m.variable ?? ''} onChange={(e) => onChange({ ...m, variable: e.target.value })}>
            <option value="">Choose variable…</option>
            {VARIABLES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
          </select>
        )}
        {kind === 'template' && (
          <input className="input mono" value={m.template ?? ''} placeholder="{{ row.first_name | capitalize }}" onChange={(e) => onChange({ ...m, template: e.target.value })}
            title="Liquid template. Columns: row.column_name. Filters include sha256, md5, cast, regex_replace, to_unix, to_date, validate_email." />
        )}
      </div>
      <span className="faint">→</span>
      {st.custom_fields ? (<>
        <input className="input" style={{ width: 200 }} list={'targets-' + st.name} value={m.target} placeholder="field name" onChange={(e) => onChange({ ...m, target: e.target.value })} />
        <datalist id={'targets-' + st.name}>{st.target_fields.map((t) => <option key={t.name} value={t.name}>{t.label}</option>)}</datalist>
      </>) : (
        <select className="input" style={{ width: 200 }} value={m.target} onChange={(e) => onChange({ ...m, target: e.target.value })}>
          <option value="">Choose…</option>
          {st.target_fields.map((t) => <option key={t.name} value={t.name}>{t.label}{t.required ? ' *' : ''}</option>)}
        </select>
      )}
      <select className="input sm" style={{ width: 132 }} value={m.null_behavior ?? 'always'} title="What to do when the value is empty"
        onChange={(e) => onChange({ ...m, null_behavior: e.target.value as Mapping['null_behavior'] })}>
        <option value="always">Always sync</option><option value="skip_nulls">Skip nulls</option>
      </select>
      <button className="btn ghost icon sm" onClick={onRemove} aria-label="Remove">✕</button>
    </div>
  )
}

export default function ActivationNew() {
  const [params] = useSearchParams()
  const editId = params.get('edit')
  const nav = useNavigate()
  const audiences = useAsync(() => api.get<Audience[]>('/audiences'))
  const dests = useAsync(() => api.get<Destination[]>('/destinations'))
  const types = useAsync(() => api.get<DestinationType[]>('/destination-types'))

  const [step, setStep] = useState(editId ? 2 : 1)
  const [audienceId, setAudienceId] = useState<number | null>(params.get('audience') ? Number(params.get('audience')) : null)
  const [destId, setDestId] = useState<number | null>(null)
  const [cfg, setCfg] = useState<SyncConfig>({ sync_type: '', mode: '', mapping: [], delete_behavior: 'do_nothing', options: {} })
  const [schedule, setSchedule] = useState<Schedule>({ type: 'interval', every: 1, unit: 'hours' })
  const [name, setName] = useState('')
  const [runNow, setRunNow] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(!editId)
  const [templateName, setTemplateName] = useState('')
  const [templateSaved, setTemplateSaved] = useState(false)
  const parentOf = audiences.data?.find((a) => a.id === audienceId)?.parent_id
  const schema = useAsync(() => (parentOf ? api.get<Schema>('/schema?parent_id=' + parentOf) : api.get<Schema>('/schema')), [parentOf])
  const templates = useAsync(() => (destId ? api.get<SyncTemplate[]>('/sync-templates?destination_id=' + destId) : Promise.resolve([])), [destId])

  useEffect(() => {
    if (!editId) return
    api.get<Sync>(`/syncs/${editId}`).then((s) => {
      setAudienceId(s.audience_id); setDestId(s.destination_id); setCfg(s.config)
      setSchedule(fromApi(s.schedule)); setName(s.name); setRunNow(false); setLoaded(true)
    })
  }, [editId])

  const parent = schema.data?.parent
  const dest = dests.data?.find((d) => d.id === destId)
  const dtype = types.data?.find((t) => t.type === dest?.type)
  const st: SyncTypeDef | undefined = dtype?.sync_types.find((t) => t.name === cfg.sync_type) ?? dtype?.sync_types[0]
  const audience = audiences.data?.find((a) => a.id === audienceId)
  const eventModels = schema.data?.models ?? []
  const eventModel = eventModels.find((m) => m.id === cfg.model_id)

  const { columns, labels } = useMemo(() => {
    const settings = parent?.column_settings ?? {}
    const syncable = (parent?.columns ?? []).filter((c) => !['blocked', 'sync_blocked'].includes(settings[c.name]?.privacy ?? ''))
    const parentCols = [...syncable.map((c) => c.name), ...(schema.data?.virtual_columns ?? []).map((v) => v.name)]
    const lbl: Record<string, string> = {}
    for (const c of syncable) lbl[c.name] = settings[c.name]?.alias || c.name
    for (const v of schema.data?.virtual_columns ?? []) lbl[v.name] = v.group === 'Traits' ? 'Trait: ' + v.label : v.label
    if (st?.source !== 'events') return { columns: parentCols, labels: lbl }
    const ev = eventModel?.columns.map((c) => c.name) ?? []
    for (const c of parentCols) lbl['customer.' + c] = 'Customer → ' + (lbl[c] ?? c)
    return { columns: [...ev, ...parentCols.map((c) => 'customer.' + c)], labels: lbl }
  }, [parent, st, eventModel, schema.data])

  const set = (patch: Partial<SyncConfig>) => setCfg((c) => ({ ...c, ...patch }))

  /** Reset type-specific settings when the sync type changes. */
  const chooseType = (t: SyncTypeDef) => {
    const ident = t.identifiers.find((i) => !i.modes.length || i.modes.includes(t.modes[0]))
    const model = t.source === 'events' ? eventModels.find((m) => m.kind === 'event' && m.primary_key) ?? eventModels[0] : undefined
    const cols = t.source === 'events' ? [...(model?.columns.map((c) => c.name) ?? []), ...(parent?.columns.map((c) => `customer.${c.name}`) ?? [])]
      : parent?.columns.map((c) => c.name) ?? []
    const emailCol = cols.find((c) => /(^|\.)e?mail(_address)?$/i.test(c))
    setCfg({
      sync_type: t.name, mode: t.modes[0], model_id: model?.id,
      match: ident ? { field: ident.name, source: ident.name === 'email' ? emailCol ?? '' : '' } : undefined,
      mapping: t.target_fields.length ? suggest(cols, t.target_fields) : cols.filter((c) => /name|country|email/i.test(c)).slice(0, 3).map((c) => ({ source: c, target: c.replace(/^customer\./, '') })),
      delete_behavior: Object.keys(t.delete_behaviors)[0] ?? 'do_nothing',
      options: Object.fromEntries(t.options.filter((o) => o.default != null).map((o) => [o.name, o.default as string])),
    })
  }

  const goToConfigure = () => {
    if (!editId || !cfg.sync_type) dtype && chooseType(dtype.sync_types[0])
    if (!name && audience && dest) setName(`${audience.name} → ${dest.name}`)
    setStep(2)
  }

  const saveTemplate = async () => {
    try {
      await api.post('/sync-templates', { name: templateName, destination_id: destId, config: cfg })
      setTemplateSaved(true); templates.reload()
    } catch (e) { setError((e as Error).message) }
  }

  const save = async () => {
    setSaving(true); setError(null)
    const body = { name, audience_id: audienceId, destination_id: destId, config: cfg, schedule: toApi(schedule), enabled: true }
    try {
      const s = editId ? await api.put<Sync>(`/syncs/${editId}`, body) : await api.post<Sync>('/syncs', body)
      if (runNow) await api.post(`/syncs/${s.id}/run`, {})
      nav(`/activations/${s.id}`)
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }

  if (schema.loading || audiences.loading || dests.loading || types.loading || !loaded) return <div className="page"><Spinner label="Loading…" /></div>
  if (!audiences.data?.length || !dests.data?.length) {
    return (
      <div className="page">
        <Empty title={!audiences.data?.length ? 'Create an audience first' : 'Add a destination first'}
          action={<Link className="btn primary" to={!audiences.data?.length ? '/audiences/new' : '/destinations'}>{!audiences.data?.length ? 'New audience' : 'Add destination'}</Link>}>
          A sync sends an audience to a destination.
        </Empty>
      </div>
    )
  }

  const identifiers = st?.identifiers.filter((i) => !i.modes.length || i.modes.includes(cfg.mode)) ?? []
  const requiredMissing = (st?.target_fields ?? []).filter((t) => t.required && !cfg.mapping.some((m) => m.target === t.name && m.source))
  const visibleOptions = st?.options.filter((o) => !o.modes.length || o.modes.includes(cfg.mode)) ?? []
  const STEPS = ['Audience & destination', 'Configure', 'Schedule']

  return (
    <div className="page" style={{ maxWidth: 920 }}>
      <div className="page-head">
        <div><div className="eyebrow"><span className="eyebrow-n">4</span>Step 4 · Activation · <Link to="/activations">Syncs</Link></div><h1>{editId ? 'Edit sync' : 'New sync'}</h1></div>
      </div>
      <div className="steps">
        {STEPS.map((s, i) => (
          <div key={s} className={`step ${step === i + 1 ? 'active' : step > i + 1 ? 'done' : ''}`}><span className="n">{step > i + 1 ? '✓' : i + 1}</span>{s}</div>
        ))}
      </div>

      {step === 1 && (
        <div className="card card-body stack" style={{ gap: 20 }}>
          <Field label="Which audience?">
            <div className="tiles">
              {audiences.data.map((a) => (
                <button key={a.id} className={`tile ${audienceId === a.id ? 'selected' : ''}`} onClick={() => setAudienceId(a.id)}>
                  <div><strong>{a.name}</strong><span>{a.last_size != null ? `${fmt.num(a.last_size)} people` : 'Size not calculated'}</span></div>
                </button>
              ))}
            </div>
          </Field>
          <Field label="Send it to…">
            <div className="tiles">
              {dests.data.map((d) => (
                <button key={d.id} className={`tile ${destId === d.id ? 'selected' : ''}`} onClick={() => setDestId(d.id)}>
                  <DestIcon type={d.type} />
                  <div><strong>{d.name}</strong><span>{types.data?.find((t) => t.type === d.type)?.label}</span></div>
                </button>
              ))}
            </div>
          </Field>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn primary" disabled={!audienceId || !destId} onClick={goToConfigure}>Continue</button>
          </div>
        </div>
      )}

      {step === 2 && dtype && st && (
        <div className="stack" style={{ gap: 16 }}>
          {(templates.data?.length ?? 0) > 0 && (
            <div className="card card-body row wrap">
              <strong>Start from a template</strong>
              {templates.data!.map((t) => <button key={t.id} className="btn sm" onClick={() => setCfg(t.config)}>{t.name}</button>)}
              <span className="small muted">Pre-fills type, matching, mappings and delete behavior.</span>
            </div>
          )}
          {dtype.sync_types.length > 1 && (
            <div className="card card-body stack">
              <h2>What do you want to sync?</h2>
              <div className="tiles">
                {dtype.sync_types.map((t) => (
                  <button key={t.name} className={`tile ${st.name === t.name ? 'selected' : ''}`} onClick={() => chooseType(t)}>
                    <div><strong>{t.label}</strong><span>{t.description}</span></div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="card card-body stack">
            {st.source === 'events' && (
              <Field label="Which rows should be sent?" help={`Rows from this table for people in “${audience?.name}”. The table needs a primary key so each row is sent once.`}>
                <select className="input" value={cfg.model_id ?? ''} onChange={(e) => set({ model_id: Number(e.target.value), mapping: [], options: { ...cfg.options, group_by: '' } })}>
                  {eventModels.map((m) => <option key={m.id} value={m.id}>{m.name}{m.primary_key ? '' : ' (no primary key)'}</option>)}
                </select>
              </Field>
            )}
            {st.modes.length > 1 ? (
              <Field label="Sync mode" help={MODE_INFO[cfg.mode]}>
                <Toggle value={cfg.mode} options={st.modes.map((m) => ({ value: m, label: m[0].toUpperCase() + m.slice(1) }))}
                  onChange={(m) => {
                    const ok = st.identifiers.find((i) => i.name === cfg.match?.field && (!i.modes.length || i.modes.includes(m)))
                    set({ mode: m, match: ok ? cfg.match : { field: st.identifiers.find((i) => !i.modes.length || i.modes.includes(m))?.name ?? '', source: cfg.match?.source ?? '' } })
                  }} />
              </Field>
            ) : <div className="small muted">Sync mode: <strong>{st.modes[0][0].toUpperCase() + st.modes[0].slice(1)}</strong> — {MODE_INFO[st.modes[0]]}</div>}

            {identifiers.length > 0 && (
              <Field label="Record matching" help={`How should rows be matched to records in ${dest?.name}? Pick a column that is unique and never empty.`}>
                <div className="map-row">
                  <select className="input" value={cfg.match?.source ?? ''} onChange={(e) => set({ match: { field: cfg.match?.field ?? identifiers[0].name, source: e.target.value } })}>
                    <option value="">Choose column…</option>
                    {columns.map((c) => <option key={c} value={c}>{labels[c] ?? c}</option>)}
                  </select>
                  <span className="faint" style={{ textAlign: 'center' }}>=</span>
                  <select className="input" value={cfg.match?.field ?? ''} onChange={(e) => set({ match: { source: cfg.match?.source ?? '', field: e.target.value } })}>
                    {identifiers.map((i) => <option key={i.name} value={i.name}>{i.label}</option>)}
                  </select>
                  <span />
                </div>
              </Field>
            )}

            {visibleOptions.map((o) => (
              <Field key={o.name} label={`${o.label}${o.required ? '' : ' (optional)'}`} help={o.help}>
                <OptionInput field={o} value={cfg.options[o.name]} columns={columns} onChange={(v) => set({ options: { ...cfg.options, [o.name]: v } })} />
              </Field>
            ))}
          </div>

          <div className="card card-body stack">
            <div className="spread">
              <div>
                <h2>Field mapping</h2>
                <div className="small muted">Choose which columns populate which {dest?.name} fields.{st.custom_fields && ' Type a new field name to create a custom field.'}</div>
              </div>
              {st.target_fields.length > 0 && <button className="btn sm" onClick={() => set({ mapping: [...cfg.mapping.filter((m) => !suggest(columns, st.target_fields).some((x) => x.target === m.target)), ...suggest(columns, st.target_fields)] })}>Suggest mappings</button>}
            </div>
            {cfg.mapping.map((m, i) => (
              <MappingRow key={i} m={m} columns={columns} labels={labels} st={st}
                onChange={(x) => set({ mapping: cfg.mapping.map((y, j) => (j === i ? x : y)) })}
                onRemove={() => set({ mapping: cfg.mapping.filter((_, j) => j !== i) })} />
            ))}
            <div><button className="btn ghost sm" onClick={() => set({ mapping: [...cfg.mapping, { source: '', target: '' }] })}>+ Add mapping</button></div>
            {requiredMissing.length > 0 && <div className="alert info">Required: {requiredMissing.map((t) => t.label).join(', ')}</div>}
          </div>

          <ErrorBox error={error} />
          <div className="spread">
            <button className="btn" onClick={() => setStep(1)} disabled={!!editId}>Back</button>
            <button className="btn primary" disabled={requiredMissing.length > 0 || (identifiers.length > 0 && !cfg.match?.source)} onClick={() => setStep(3)}>Continue</button>
          </div>
        </div>
      )}

      {step === 3 && st && (
        <div className="card card-body stack" style={{ gap: 18 }}>
          <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          {st.source === 'audience' && Object.keys(st.delete_behaviors).length > 1 && (
            <Field label="Delete behavior" help="What should happen when someone no longer appears in the audience?">
              <div className="stack" style={{ gap: 6 }}>
                {Object.entries(st.delete_behaviors).map(([k, desc]) => (
                  <label key={k} className="row" style={{ alignItems: 'flex-start' }}>
                    <input type="radio" name="delete" checked={cfg.delete_behavior === k} onChange={() => set({ delete_behavior: k })} />
                    <span><strong>{({ do_nothing: 'Do nothing', clear: 'Clear', delete: 'Delete', remove: 'Remove' } as Record<string, string>)[k]}</strong><div className="small muted">{desc}</div></span>
                  </label>
                ))}
              </div>
            </Field>
          )}
          {st.source === 'audience' && audience?.splits?.enabled && (
            <Field label="Split group" help="Send only the members assigned to one group of the audience's A/B split.">
              <select className="input" style={{ maxWidth: 260 }} value={cfg.split_group ?? ''} onChange={(e) => set({ split_group: e.target.value || null })}>
                <option value="">Everyone (no split)</option>
                {audience.splits.groups.map((g) => <option key={g.name} value={g.name}>{g.name} ({g.percent}%)</option>)}
              </select>
            </Field>
          )}
          <ScheduleEditor value={schedule} onChange={setSchedule} />
          <Field label="Alerts" help="Post to a Slack (or any) incoming-webhook URL when a run fails or rejects rows.">
            <input className="input" placeholder="https://hooks.slack.com/services/…" value={cfg.alerts?.webhook_url ?? ''}
              onChange={(e) => set({ alerts: { on_failure: true, on_rejected: true, ...cfg.alerts, webhook_url: e.target.value } })} />
            {cfg.alerts?.webhook_url && (
              <div className="row small">
                <label className="row"><input type="checkbox" checked={cfg.alerts.on_failure !== false} onChange={(e) => set({ alerts: { ...cfg.alerts, on_failure: e.target.checked } })} /> Run fails</label>
                <label className="row"><input type="checkbox" checked={cfg.alerts.on_rejected !== false} onChange={(e) => set({ alerts: { ...cfg.alerts, on_rejected: e.target.checked } })} /> Rows rejected</label>
              </div>
            )}
          </Field>
          <Field label="Save as a template (optional)" help="Reuse this configuration for other audiences sent to the same destination.">
            <div className="row">
              <input className="input" style={{ maxWidth: 260 }} placeholder="Template name" value={templateName} onChange={(e) => { setTemplateName(e.target.value); setTemplateSaved(false) }} />
              <button className="btn sm" disabled={!templateName.trim()} onClick={saveTemplate}>{templateSaved ? 'Saved ✓' : 'Save template'}</button>
            </div>
          </Field>
          <label className="row small"><input type="checkbox" checked={runNow} onChange={(e) => setRunNow(e.target.checked)} /> Run once right after saving</label>
          <ErrorBox error={error} />
          <div className="spread">
            <button className="btn" onClick={() => setStep(2)}>Back</button>
            <button className="btn primary" onClick={save} disabled={saving || !name}>{saving ? 'Saving…' : editId ? 'Save changes' : 'Create sync'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
