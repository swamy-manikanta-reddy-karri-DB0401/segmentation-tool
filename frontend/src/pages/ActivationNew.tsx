import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Audience, ColumnType, ConfigField, Destination, DestinationType, Mapping, Schedule, Schema, Sync, SyncConfig, SyncTemplate, SyncTypeDef } from '../api'
import ScheduleEditor, { fromApi, scheduleLabel, toApi } from '../components/ScheduleEditor'
import { DestIcon, Empty, ErrorBox, Field, Spinner, Toggle, useAsync } from '../components/ui'
import { useMe } from '../components/me'
import { matches, Pager, SearchBox, toast, usePaged } from '../components/kit'
import { TypeIcon } from '../components/builder/ConditionEditor'
import '../ux/activate.css'
import '../ux/wizard.css'

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

/** Every required destination field gets a row up front, so people only have to pick the column. */
function withRequired(mapping: Mapping[], t: SyncTypeDef): Mapping[] {
  const missing = t.target_fields.filter((f) => f.required && !mapping.some((m) => m.target === f.name))
  return [...missing.map((f) => ({ source: '', target: f.name })), ...mapping]
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

/** Google Ad Manager: create the audience segment from here instead of in Ad Manager. */
function CreateSegment({ destId, defaultName, days, onCreated }: { destId: number; defaultName: string; days: unknown; onCreated: (id: string) => void }) {
  const [name, setName] = useState(defaultName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const create = async () => {
    setBusy(true); setError(null)
    try {
      const seg = await api.post<{ id: string; name: string }>(`/destinations/${destId}/segments`, { name, membership_days: days || undefined })
      onCreated(seg.id)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="create-seg">
      <div className="small muted">No segment yet? Create one in Ad Manager now (or leave the ID empty and it's created on the first run).</div>
      <div className="row">
        <input className="input grow" value={name} placeholder="Segment name" onChange={(e) => setName(e.target.value)} />
        <button className="btn" onClick={create} disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create in Ad Manager'}</button>
      </div>
      <ErrorBox error={error} />
    </div>
  )
}

const VARIABLES = [
  { value: 'model-id', label: 'Audience ID' }, { value: 'model-name', label: 'Audience name' },
  { value: 'current-timestamp', label: 'Current timestamp' }, { value: 'sync-id', label: 'Sync ID' }, { value: 'sync-run-id', label: 'Sync run ID' },
]

const KIND_LABEL: Record<string, string> = { column: 'Column', static: 'Fixed value', variable: 'Variable', template: 'Template' }

function MappingRow({ m, columns, labels, typeOf, st, required, onChange, onRemove }: {
  m: Mapping; columns: string[]; labels: Record<string, string>; typeOf: (c: string) => ColumnType | undefined; st: SyncTypeDef
  required: boolean; onChange: (m: Mapping) => void; onRemove: () => void
}) {
  const kind = m.type ?? 'column'
  const t = kind === 'column' && m.source ? typeOf(m.source) : undefined
  const empty = kind === 'column' ? !m.source : kind === 'variable' ? !m.variable : kind === 'template' ? !m.template : false
  return (
    <div className={`wz2-map ${empty ? 'is-unfilled' : ''}`}>
      <div className="wz2-map-from">
        <select className="input sm wz2-kind" value={kind} aria-label="Value comes from" onChange={(e) => onChange({ target: m.target, type: e.target.value as Mapping['type'], null_behavior: m.null_behavior })}>
          {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <div className="wz2-map-value">
          {kind === 'column' && (<>
            {t && <TypeIcon type={t} />}
            <select className={`input ${!m.source ? 'wz-invalid' : ''}`} value={m.source ?? ''} onChange={(e) => onChange({ ...m, source: e.target.value })} aria-label="Column">
              <option value="">Choose a column…</option>
              {columns.map((c) => <option key={c} value={c}>{labels[c] ?? c}</option>)}
            </select>
          </>)}
          {kind === 'static' && (<>
            <select className="input sm" style={{ width: 104 }} value={m.value_type ?? 'string'} onChange={(e) => onChange({ ...m, value_type: e.target.value as Mapping['value_type'] })} aria-label="Value type">
              <option value="string">Text</option><option value="number">Number</option><option value="boolean">Yes / no</option><option value="null">Empty</option>
            </select>
            {m.value_type !== 'null' && <input className="input" value={m.value ?? ''} placeholder="Value sent for everyone" onChange={(e) => onChange({ ...m, value: e.target.value })} />}
          </>)}
          {kind === 'variable' && (
            <select className={`input ${!m.variable ? 'wz-invalid' : ''}`} value={m.variable ?? ''} onChange={(e) => onChange({ ...m, variable: e.target.value })} aria-label="Variable">
              <option value="">Choose a variable…</option>
              {VARIABLES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
            </select>
          )}
          {kind === 'template' && (
            <input className="input mono" value={m.template ?? ''} placeholder="{{ row.first_name | capitalize }}" onChange={(e) => onChange({ ...m, template: e.target.value })}
              title="Liquid template. Columns: row.column_name. Filters include sha256, md5, cast, regex_replace, to_unix, to_date, validate_email." aria-label="Template" />
          )}
        </div>
      </div>
      <span className="wz2-arrow" aria-hidden="true">→</span>
      <div className="wz2-map-to">
        {st.custom_fields ? (<>
          <input className={`input ${!m.target ? 'wz-invalid' : ''}`} list={'targets-' + st.name} value={m.target} placeholder="Field name" onChange={(e) => onChange({ ...m, target: e.target.value })} aria-label="Destination field" />
          <datalist id={'targets-' + st.name}>{st.target_fields.map((tf) => <option key={tf.name} value={tf.name}>{tf.label}</option>)}</datalist>
        </>) : (
          <select className={`input ${!m.target ? 'wz-invalid' : ''}`} value={m.target} onChange={(e) => onChange({ ...m, target: e.target.value })} aria-label="Destination field">
            <option value="">Choose a field…</option>
            {st.target_fields.map((tf) => <option key={tf.name} value={tf.name}>{tf.label}{tf.required ? ' (required)' : ''}</option>)}
          </select>
        )}
        {required && <span className="wz2-req" title="The destination needs this field">Required</span>}
      </div>
      <div className="wz2-map-end">
        <select className="input sm" value={m.null_behavior ?? 'always'} title="What to send when the value is empty" aria-label="When empty"
          onChange={(e) => onChange({ ...m, null_behavior: e.target.value as Mapping['null_behavior'] })}>
          <option value="always">Send blanks</option><option value="skip_nulls">Skip blanks</option>
        </select>
        <button className="btn ghost icon sm" onClick={onRemove} aria-label="Remove field" title="Remove field">✕</button>
      </div>
    </div>
  )
}

/** "Every day at 09:00 (Asia/Calcutta)" plus when it would run next, in the viewer's own time. */
function SchedulePreview({ schedule }: { schedule: Schedule }) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const text = scheduleLabel(toApi(schedule))
  const manual = schedule.type === 'manual'
  return (
    <div className={`wz2-sched ${manual ? 'manual' : ''}`} role="status">
      <span className="wz2-sched-icon" aria-hidden="true">{manual ? '▶' : '⟳'}</span>
      <div>
        <strong>{manual ? 'Runs only when someone clicks “Run now”' : `${text}${schedule.type === 'recurrence' ? ' your time' : ''}`}</strong>
        <small>{manual ? 'Good for one-off sends and testing.' : schedule.type === 'cron' ? 'Cron schedules run in UTC.' : schedule.type === 'recurrence' ? `Times are in ${tz}; each run sends only what changed since the last one.` : 'Each run sends only what changed since the last one.'}</small>
      </div>
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
  const me = useMe()
  const { can } = me
  const audienceBrand = audiences.data?.find((a) => a.id === audienceId)?.brand_id ?? null
  const needsApproval = !can('syncs.approve', audienceBrand)
  // A sync can only use destinations shared across brands or owned by the audience's brand.
  const brandDests = (dests.data ?? []).filter((d) => d.brand_id == null || audienceBrand == null || d.brand_id === audienceBrand)
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

  const typeOf = useMemo(() => {
    const t: Record<string, ColumnType> = {}
    for (const c of parent?.columns ?? []) { t[c.name] = c.type; t['customer.' + c.name] = c.type }
    for (const v of schema.data?.virtual_columns ?? []) { t[v.name] = v.type; t['customer.' + v.name] = v.type }
    for (const c of eventModel?.columns ?? []) t[c.name] = c.type
    return (c: string) => t[c]
  }, [parent, schema.data, eventModel])

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
      mapping: withRequired(t.target_fields.length ? suggest(cols, t.target_fields) : cols.filter((c) => /name|country|email/i.test(c)).slice(0, 3).map((c) => ({ source: c, target: c.replace(/^customer\./, '') })), t),
      delete_behavior: t.default_delete && t.delete_behaviors[t.default_delete] ? t.default_delete : Object.keys(t.delete_behaviors)[0] ?? 'do_nothing',
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
      setTemplateSaved(true); templates.reload(); toast(`Template “${templateName}” saved`)
    } catch (e) { setError((e as Error).message) }
  }

  const save = async () => {
    setSaving(true); setError(null)
    const body = { name, audience_id: audienceId, destination_id: destId, config: cfg, schedule: toApi(schedule), enabled: true }
    try {
      const s = editId ? await api.put<Sync>(`/syncs/${editId}`, body) : await api.post<Sync>('/syncs', body)
      if (s.approval_status !== 'approved') { toast('Submitted for approval'); nav(`/activations/${s.id}?submitted=1`); return }
      if (runNow && s.destination_configured !== false) await api.post(`/syncs/${s.id}/run`, {})
      toast(editId ? 'Sync saved' : 'Sync created')
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
  const requiredOptions = visibleOptions.filter((o) => o.required && !cfg.options[o.name])
  const STEPS = ['Audience & destination', 'What to send', 'Name & schedule']
  const STEP_HINTS = ['Who, and to which tool', 'Matching and fields', 'When it runs']
  // In-place reasons why the user can't continue yet.
  const step1Problems = [!audienceId && 'Choose an audience', !destId && 'Choose a destination'].filter(Boolean) as string[]
  const step2Problems = [
    identifiers.length > 0 && !cfg.match?.source && 'Choose the column used to match records',
    ...requiredMissing.map((t) => `Map the required field “${t.label}”`),
    ...requiredOptions.map((o) => `Fill in “${o.label}”`),
  ].filter(Boolean) as string[]
  const canReach = (n: number) => n === 1 ? !editId : n === 2 ? !step1Problems.length : !step1Problems.length && !step2Problems.length
  const go = (n: number) => { if (n === 2 && step === 1) goToConfigure(); else setStep(n) }

  return (
    <div className="page wide">
      <div className="act-crumbs"><Link to="/activations">Syncs</Link><span>/</span><span>{editId ? 'Edit sync' : 'New sync'}</span></div>
      <header className="wz2-head">
        <h1>{editId ? `Edit “${name || 'sync'}”` : 'New sync'}</h1>
        <p>Send an audience to a marketing tool and keep it up to date — every run sends only who joined, changed or left.</p>
      </header>
      <ol className="wz2-steps" aria-label="Steps">
        {STEPS.map((label, i) => {
          const n = i + 1
          const state = step === n ? 'active' : step > n ? 'done' : ''
          return (
            <li key={label} className={state} aria-current={step === n ? 'step' : undefined}>
              <button disabled={n === step || !canReach(n) || (n > step && n - step > 1)} onClick={() => go(n)}>
                <span className="n">{step > n ? '✓' : n}</span>
                <span className="wz2-step-text"><strong>{label}</strong><small>{STEP_HINTS[i]}</small></span>
              </button>
            </li>
          )
        })}
      </ol>

      <div className="wz-layout">
        <div className="wz-main">
          {step === 1 && (<>
            <AudiencePicker audiences={audiences.data} value={audienceId} brandName={me.brandName}
              onChange={(id) => { setAudienceId(id); const b = audiences.data!.find((a) => a.id === id)?.brand_id ?? null; if (dest && dest.brand_id != null && b != null && dest.brand_id !== b) setDestId(null) }} />
            <DestinationPicker dests={brandDests} types={types.data ?? []} value={destId} onChange={setDestId}
              brandNote={audience && audienceBrand != null ? `Showing ${me.brandName(audienceBrand)} destinations and shared ones.` : undefined} />
            <WizardNav problems={step1Problems} next={<button className="btn primary" disabled={step1Problems.length > 0} onClick={goToConfigure}>Continue</button>} />
          </>)}

          {step === 2 && dtype && st && (
            <div className="stack" style={{ gap: 16 }}>
              {(templates.data?.length ?? 0) > 0 && (
                <div className="card card-body row wrap">
                  <strong>Start from a template</strong>
                  {templates.data!.map((t) => <button key={t.id} className="btn sm" onClick={() => { setCfg(t.config); toast(`Applied template “${t.name}”`, 'info') }}>{t.name}</button>)}
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
                <h2>How records are matched</h2>
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
                ) : <div className="small muted">Sync mode: <strong>{st.modes[0][0].toUpperCase() + st.modes[0].slice(1)}</strong> — {MODE_INFO[st.modes[0]] ?? 'Adds and removes people'}</div>}

                {identifiers.length > 0 && (
                  <Field label="Record matching" help={`How rows are matched to records in ${dest?.name}. Pick a column that is unique and never empty.`}>
                    <div className="map-row">
                      <select className={`input ${!cfg.match?.source ? 'wz-invalid' : ''}`} value={cfg.match?.source ?? ''} onChange={(e) => set({ match: { field: cfg.match?.field ?? identifiers[0].name, source: e.target.value } })}>
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
                    {dest?.type === 'gam' && o.name === 'list_id' && !cfg.options.list_id && (
                      <CreateSegment destId={dest.id} defaultName={audience?.name ?? ''} days={cfg.options.membership_days}
                        onCreated={(id) => { set({ options: { ...cfg.options, list_id: id } }); toast(`Segment ${id} created in Ad Manager`) }} />
                    )}
                  </Field>
                ))}
              </div>

              <div className="card wz2-fields">
                <div className="wz2-fields-head">
                  <div>
                    <h2>Fields to send</h2>
                    <div className="small muted">What each {dest?.name} field is filled with.{st.custom_fields && ' Type a new field name to create a custom field.'}</div>
                  </div>
                  {st.target_fields.length > 0 && <button className="btn sm" onClick={() => { set({ mapping: [...cfg.mapping.filter((m) => !suggest(columns, st.target_fields).some((x) => x.target === m.target)), ...suggest(columns, st.target_fields)] }); toast('Suggested mappings added', 'info') }}>Suggest mappings</button>}
                </div>
                {(st.target_fields.some((t) => t.required)) && (
                  <div className="wz2-required" aria-label="Required fields">
                    <span>Required by {dest?.name}:</span>
                    {st.target_fields.filter((t) => t.required).map((t) => {
                      const ok = cfg.mapping.some((m) => m.target === t.name && (m.source || m.type && m.type !== 'column'))
                      return <span key={t.name} className={`wz2-req-chip ${ok ? 'ok' : ''}`}>{ok ? '✓' : '○'} {t.label}</span>
                    })}
                  </div>
                )}
                {cfg.mapping.length > 0 && (
                  <div className="wz2-map-cols" aria-hidden="true"><span>From your data</span><span /><span>To {dest?.name}</span><span>When empty</span></div>
                )}
                <div className="wz2-map-list">
                  {cfg.mapping.map((m, i) => (
                    <MappingRow key={i} m={m} columns={columns} labels={labels} typeOf={typeOf} st={st}
                      required={!!st.target_fields.find((t) => t.name === m.target)?.required}
                      onChange={(x) => set({ mapping: cfg.mapping.map((y, j) => (j === i ? x : y)) })}
                      onRemove={() => set({ mapping: cfg.mapping.filter((_, j) => j !== i) })} />
                  ))}
                </div>
                {!cfg.mapping.length && <div className="wz2-none">No fields yet — only the matching identifier will be sent. Add the fields your campaigns use, like first name or favourite section.</div>}
                <div className="wz2-fields-foot"><button className="btn ghost sm" onClick={() => set({ mapping: [...cfg.mapping, { source: '', target: '' }] })}>+ Add field</button></div>
              </div>

              <ErrorBox error={error} />
              <WizardNav problems={step2Problems}
                back={<button className="btn" onClick={() => setStep(1)} disabled={!!editId}>Back</button>}
                next={<button className="btn primary" disabled={step2Problems.length > 0} onClick={() => setStep(3)}>Continue</button>} />
            </div>
          )}

          {step === 3 && st && (
            <div className="card card-body stack" style={{ gap: 18 }}>
              <Field label="Sync name" help="Shown in the syncs list and in alerts.">
                <input className={`input ${!name.trim() ? 'wz-invalid' : ''}`} value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              {st.source === 'audience' && Object.keys(st.delete_behaviors).length > 1 && (
                <Field label="When someone leaves the audience" help="What should happen in the destination when a person no longer qualifies?">
                  <div className="wz-radios">
                    {Object.entries(st.delete_behaviors).map(([k, desc]) => (
                      <label key={k} className={cfg.delete_behavior === k ? 'on' : ''}>
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
              <SchedulePreview schedule={schedule} />
              <div className="wz2-alerting">
                <span className="wz2-bell" aria-hidden="true">🔔</span>
                <div><strong>Alerts are on</strong>
                  <small>Failed runs, rejected records and stalled deliveries are watched using {dest?.name ?? 'the destination'}’s alert rules. You can fine-tune them on the sync page after saving, or under <Link to="/alerts?tab=rules">Alerts → Rules</Link>.</small></div>
              </div>
              <details className="wz-more">
                <summary>Save as a template</summary>
                <div className="stack" style={{ gap: 14, marginTop: 12 }}>
                  <Field label="Template name" help="Reuse this configuration for other audiences sent to the same destination.">
                    <div className="row">
                      <input className="input" style={{ maxWidth: 260 }} placeholder="Template name" value={templateName} onChange={(e) => { setTemplateName(e.target.value); setTemplateSaved(false) }} />
                      <button className="btn sm" disabled={!templateName.trim()} onClick={saveTemplate}>{templateSaved ? 'Saved ✓' : 'Save template'}</button>
                    </div>
                  </Field>
                </div>
              </details>
              {needsApproval ? (
                <div className="callout amber" style={{ marginBottom: 0 }}>
                  <div className="callout-icon">✓</div>
                  <div className="grow">
                    <strong>This sync will be submitted for approval</strong>
                    <div className="small muted">A Brand Marketing Admin reviews it before anything is sent to {dest?.name ?? 'the destination'}. You'll see its status on the sync page.</div>
                  </div>
                </div>
              ) : dest?.configured === false ? (
                <div className="small muted">Runs start automatically once {dest.name} credentials are added.</div>
              ) : (
                <label className="row small"><input type="checkbox" checked={runNow} onChange={(e) => setRunNow(e.target.checked)} /> Run once right after saving</label>
              )}
              <ErrorBox error={error} />
              <WizardNav problems={name.trim() ? [] : ['Give the sync a name']}
                back={<button className="btn" onClick={() => setStep(2)}>Back</button>}
                next={<button className="btn primary" onClick={save} disabled={saving || !name.trim()}>{saving ? 'Saving…' : needsApproval ? 'Submit for approval' : editId ? 'Save changes' : 'Create sync'}</button>} />
            </div>
          )}
        </div>

        <aside className="wz-summary card" aria-label="Summary">
          <div className="act-card-k">Summary</div>
          <SummaryRow k="Audience" v={audience ? audience.name : null} sub={audience?.last_size != null ? `${fmt.num(audience.last_size)} people` : undefined} />
          <SummaryRow k="Destination" v={dest ? dest.name : null} icon={dest ? <DestIcon type={dest.type} size={20} /> : undefined}
            sub={dest?.configured === false ? 'Credentials needed' : dtype?.label} warn={dest?.configured === false} />
          {step >= 2 && st && <SummaryRow k="Sending" v={`${st.label} · ${cfg.mode ? cfg.mode[0].toUpperCase() + cfg.mode.slice(1) : ''}`}
            sub={cfg.match?.source ? `Matched on ${labels[cfg.match.source] ?? cfg.match.source}` : undefined} />}
          {step >= 2 && cfg.mapping.some((m) => m.target) && (
            <div className="wz-sum-row">
              <span>Fields</span>
              <div className="wz2-sum-fields">{cfg.mapping.filter((m) => m.target).slice(0, 8).map((m) => <code key={m.target}>{m.target}</code>)}
                {cfg.mapping.filter((m) => m.target).length > 8 && <small>+{cfg.mapping.filter((m) => m.target).length - 8} more</small>}</div>
            </div>
          )}
          {step >= 3 && <SummaryRow k="Schedule" v={scheduleLabel(toApi(schedule))} />}
          <div className={`wz-approval ${needsApproval ? 'amber' : 'green'}`}>
            {needsApproval ? 'Needs approval by a Brand Marketing Admin before it runs' : 'You can publish this directly'}
          </div>
        </aside>
      </div>
    </div>
  )
}

function SummaryRow({ k, v, sub, icon, warn }: { k: string; v: string | null; sub?: string; icon?: ReactNode; warn?: boolean }) {
  return (
    <div className="wz-sum-row">
      <span>{k}</span>
      {v ? <strong className="row" style={{ gap: 6 }}>{icon}<span className="act-ellipsis">{v}</span></strong> : <em>Not chosen yet</em>}
      {sub && <small className={warn ? 'wz-warn' : ''}>{sub}</small>}
    </div>
  )
}

function WizardNav({ problems, back, next }: { problems: string[]; back?: ReactNode; next: ReactNode }) {
  return (
    <div className="wz-nav">
      {back ?? <span />}
      <div className="row" style={{ gap: 12 }}>
        {problems.length > 0 && <span className="small wz-problems" role="status">{problems[0]}{problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}</span>}
        {next}
      </div>
    </div>
  )
}

/** Searchable, paginated audience list — scales to hundreds of audiences. */
function AudiencePicker({ audiences, value, onChange, brandName }: { audiences: Audience[]; value: number | null; onChange: (id: number) => void; brandName: (id: number | null | undefined) => string }) {
  const [q, setQ] = useState('')
  const brands = new Set(audiences.map((a) => a.brand_id ?? null))
  const rows = audiences.filter((a) => matches(q, a.name, a.description, a.parent_name, brandName(a.brand_id)))
    .sort((a, b) => Number(b.id === value) - Number(a.id === value) || a.name.localeCompare(b.name))
  const paged = usePaged(rows, 8, q)
  return (
    <section className="card wz-pick">
      <div className="wz-pick-head">
        <div><h2>Which audience?</h2><div className="small muted">The people to send. Members are added and removed as the audience changes.</div></div>
        {audiences.length > 6 && <SearchBox value={q} onChange={setQ} placeholder={`Search ${audiences.length} audiences…`} />}
      </div>
      <div className="wz-options" role="radiogroup" aria-label="Audience">
        {paged.slice.map((a) => (
          <button key={a.id} role="radio" aria-checked={value === a.id} className={`wz-option ${value === a.id ? 'on' : ''}`} onClick={() => onChange(a.id)}>
            <span className="wz-radio" aria-hidden="true" />
            <span className="wz-opt-main">
              <strong className="act-ellipsis">{a.name}</strong>
              <small className="act-ellipsis">{a.description || `Built on ${a.parent_name ?? 'the parent model'}`}</small>
            </span>
            {brands.size > 1 && <span className="badge">{brandName(a.brand_id)}</span>}
            <span className="wz-opt-size">{a.last_size != null ? <><strong>{fmt.compact(a.last_size)}</strong> people</> : <span className="faint">Not calculated</span>}</span>
          </button>
        ))}
        {!rows.length && <div className="dm-none">No audiences match “{q}”.</div>}
      </div>
      {rows.length > 8 && <div className="act-pager"><Pager page={paged.page} pages={paged.pages} total={rows.length} pageSize={8} onPage={paged.setPage} noun="audience" /></div>}
    </section>
  )
}

function DestinationPicker({ dests, types, value, onChange, brandNote }: { dests: Destination[]; types: DestinationType[]; value: number | null; onChange: (id: number) => void; brandNote?: string }) {
  const [q, setQ] = useState('')
  const label = (t: string) => types.find((x) => x.type === t)?.label ?? t
  const rows = dests.filter((d) => matches(q, d.name, label(d.type)))
  return (
    <section className="card wz-pick">
      <div className="wz-pick-head">
        <div><h2>Send it to…</h2><div className="small muted">{brandNote ?? 'The marketing tool that receives the audience.'}</div></div>
        {dests.length > 6 && <SearchBox value={q} onChange={setQ} placeholder={`Search ${dests.length} destinations…`} />}
      </div>
      {!dests.length ? <div className="dm-none">No destinations for this brand yet. <Link to="/destinations">Add one</Link>.</div> : (
        <div className="wz-dest-grid" role="radiogroup" aria-label="Destination">
          {rows.map((d) => (
            <button key={d.id} role="radio" aria-checked={value === d.id} className={`wz-dest ${value === d.id ? 'on' : ''}`} onClick={() => onChange(d.id)}>
              <DestIcon type={d.type} size={34} />
              <span className="wz-opt-main"><strong className="act-ellipsis" title={d.name}>{d.name}</strong><small className="act-ellipsis">{label(d.type)}</small>
                {d.configured === false && <span className="wz-dest-warn" title="Syncs wait until credentials are added">● Needs credentials</span>}</span>
            </button>
          ))}
          {!rows.length && <div className="dm-none">No destinations match “{q}”.</div>}
        </div>
      )}
    </section>
  )
}
