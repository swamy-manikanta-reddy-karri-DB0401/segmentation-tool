import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Schema, Trait, TraitConfig, TraitMethod } from '../api'
import { BuilderProvider } from '../components/builder/ConditionEditor'
import TraitConfigEditor, { METHODS } from '../components/TraitConfigEditor'
import { Empty, ErrorBox, Field, Modal, PageHead, Spinner, useAsync } from '../components/ui'

function TraitModal({ schema, existing, onClose, onSaved }: { schema: Schema; existing?: Trait; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [method, setMethod] = useState<TraitMethod>(existing?.method ?? 'aggregation')
  const [config, setConfig] = useState<TraitConfig>(existing?.config ?? { model_id: schema.models[0]?.id, fn: 'sum' })
  const [preview, setPreview] = useState<{ columns: string[]; rows: unknown[][] } | null>(null)
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const runPreview = async () => {
    setBusy('preview'); setError(null)
    try { setPreview(await api.post('/traits/preview', { method, config, parent_id: schema.parent!.id })) }
    catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const save = async () => {
    setBusy('save'); setError(null)
    const body = { name, description, method, config, parent_id: schema.parent!.id }
    try {
      if (existing) await api.put(`/traits/${existing.id}`, body)
      else await api.post('/traits', body)
      onSaved()
    } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }

  return (
    <Modal wide title={existing ? `Edit ${existing.name}` : 'New trait'} subtitle={`A calculated value for each ${schema.parent!.name.toLowerCase()} — usable in audience filters and syncs.`}
      onClose={onClose} footer={<>
        <button className="btn" onClick={runPreview} disabled={!!busy}>{busy === 'preview' ? 'Calculating…' : 'Preview results'}</button>
        <span className="grow" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={!!busy || !name.trim()}>{busy === 'save' ? 'Saving…' : 'Save trait'}</button>
      </>}>
      <div className="grid-2">
        <Field label="Name" help="Say what the value means, e.g. “90-day booking value”."><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description" help="Time window, units, exclusions…"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      </div>
      <Field label="Calculation">
        <TraitConfigEditor method={method} config={config} onChange={(m, c) => { setMethod(m); setConfig(c); setPreview(null) }} />
      </Field>
      <ErrorBox error={error} />
      {preview && (
        <div className="table-wrap" style={{ maxHeight: 260 }}>
          <table className="table compact">
            <thead><tr><th>{schema.parent!.name}</th><th>Value</th></tr></thead>
            <tbody>{preview.rows.map((r, i) => <tr key={i}><td>{String(r[0])}</td><td className="mono">{r[1] == null ? '—' : String(r[1])}</td></tr>)}</tbody>
          </table>
          {!preview.rows.length && <div className="empty"><p>No customer has a value for this trait yet.</p></div>}
        </div>
      )}
    </Modal>
  )
}

export default function Traits() {
  const schema = useAsync(() => api.get<Schema>('/schema'))
  const [modal, setModal] = useState<{ existing?: Trait } | null>(null)
  const s = schema.data

  const remove = async (t: Trait) => {
    if (!confirm(`Delete trait “${t.name}”? Audiences and syncs that use it will stop working.`)) return
    await api.del(`/traits/${t.id}`); schema.reload()
  }

  if (schema.loading) return <div className="page"><Spinner label="Loading…" /></div>
  if (!s?.parent) {
    return <div className="page"><Empty title="Set up your data first" action={<Link to="/setup" className="btn primary">Open data setup</Link>}>Traits are calculated from your customer data.</Empty></div>
  }
  return (
    <BuilderProvider value={{ schema: s, audiences: [] }}>
      <div className="page">
        <PageHead stage="modeling" title="Traits" subtitle="Reusable calculated values — total page views, video minutes, favorite section — for filters, profiles and syncs."
          actions={<button className="btn primary" onClick={() => setModal({})} disabled={!s.models.length}>+ New trait</button>} />
        <ErrorBox error={schema.error} />
        <div className="card">
          {s.traits.length ? (
            <table className="table">
              <thead><tr><th>Trait</th><th>Method</th><th>Calculated from</th><th>Type</th><th>Updated</th><th /></tr></thead>
              <tbody>
                {s.traits.map((t) => (
                  <tr key={t.id}>
                    <td><strong>{t.name}</strong>{t.description && <div className="small muted">{t.description}</div>}</td>
                    <td><span className="badge amber">{METHODS.find((m) => m.value === t.method)?.label}</span></td>
                    <td className="muted">{t.method === 'sql_formula' ? 'Customer columns & traits' : s.models.find((m) => m.id === t.config.model_id)?.name}</td>
                    <td className="muted">{s.virtual_columns.find((v) => v.name === `trait.${t.id}`)?.type}</td>
                    <td className="muted">{fmt.ago((t as Trait & { updated_at?: string }).updated_at)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn ghost sm" onClick={() => setModal({ existing: t })}>Edit</button>
                      <button className="btn ghost sm danger" onClick={() => remove(t)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="No traits yet" action={<button className="btn primary" onClick={() => setModal({})}>Create a trait</button>}>
              Build a value once — like total spend over 90 days — and reuse it in every audience and sync.
            </Empty>
          )}
        </div>
        {modal && <TraitModal schema={s} existing={modal.existing} onClose={() => setModal(null)} onSaved={() => { setModal(null); schema.reload() }} />}
      </div>
    </BuilderProvider>
  )
}
