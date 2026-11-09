import { useState } from 'react'
import { api } from '../api'
import type { Destination, DestinationType } from '../api'
import { Link } from 'react-router-dom'
import { DestIcon, Empty, ErrorBox, Field, Modal, PageHead, Spinner, useAsync } from '../components/ui'

const INBOX_URL = `${window.location.protocol}//${window.location.hostname}:8100/api/inbox`

function DestinationModal({ types, existing, onClose, onSaved }: {
  types: DestinationType[]; existing?: Destination; onClose: () => void; onSaved: () => void
}) {
  const [type, setType] = useState<DestinationType | undefined>(existing && types.find((t) => t.type === existing.type))
  const [name, setName] = useState(existing?.name ?? '')
  const [config, setConfig] = useState<Record<string, string>>(existing?.config ?? {})
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const choose = (t: DestinationType) => {
    setType(t)
    setName(t.label)
    setConfig(Object.fromEntries(t.config_fields.filter((f) => f.default != null).map((f) => [f.name, String(f.default)])))
  }
  const runTest = async () => {
    setTesting(true); setTest(null)
    try { setTest(await api.post('/destinations/test', { type: type!.type, config, id: existing?.id })) } finally { setTesting(false) }
  }
  const save = async () => {
    setSaving(true); setError(null)
    try {
      if (existing) await api.put(`/destinations/${existing.id}`, { name, config })
      else await api.post('/destinations', { name, type: type!.type, config })
      onSaved()
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }

  if (!type) {
    const featured = types.find((t) => t.type === 'sailthru')
    const others = types.filter((t) => t.type !== 'sailthru')
    return (
      <Modal title="Add a destination" subtitle="Where should audiences be sent?" onClose={onClose} wide>
        {featured && (
          <button className="tile featured" onClick={() => choose(featured)}>
            <DestIcon type={featured.type} size={44} />
            <div className="grow">
              <strong>{featured.label} <span className="badge brand" style={{ marginLeft: 6 }}>Recommended</span></strong>
              <span>{featured.description}</span>
              <div className="row wrap" style={{ gap: 4, marginTop: 8 }}>
                {featured.sync_types.map((st) => <span key={st.name} className="badge">{st.label}</span>)}
              </div>
            </div>
          </button>
        )}
        <div className="section-title" style={{ marginTop: 6 }}>More destinations</div>
        <div className="tiles">
          {others.map((t) => (
            <button key={t.type} className="tile" onClick={() => choose(t)}>
              <DestIcon type={t.type} />
              <div><strong>{t.label} {t.beta && <span className="badge amber" style={{ marginLeft: 4 }}>Beta</span>}</strong><span>{t.description}</span></div>
            </button>
          ))}
        </div>
      </Modal>
    )
  }
  const missing = type.config_fields.some((f) => f.required && !config[f.name])
  return (
    <Modal title={existing ? `Edit ${existing.name}` : `Connect ${type.label}`} subtitle={type.description} onClose={onClose}
      footer={<>
        <button className="btn" onClick={runTest} disabled={testing || missing}>{testing ? 'Testing…' : 'Test connection'}</button>
        <span className="grow" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={saving || missing || !name}>{saving ? 'Saving…' : 'Save'}</button>
      </>}>
      <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      {type.config_fields.map((f) => (
        <Field key={f.name} label={`${f.label}${f.required ? '' : ' (optional)'}`} help={f.help}>
          {f.type === 'textarea' ? (
            <textarea className="input" value={config[f.name] ?? ''} onChange={(e) => setConfig({ ...config, [f.name]: e.target.value })} />
          ) : f.type === 'select' && f.options.length ? (
            <select className="input" value={config[f.name] ?? String(f.default ?? '')} onChange={(e) => setConfig({ ...config, [f.name]: e.target.value })}>
              {!f.required && <option value="">—</option>}
              {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <input className="input" type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
              value={config[f.name] ?? ''} onChange={(e) => setConfig({ ...config, [f.name]: e.target.value })} />
          )}
          {type.type === 'webhook' && f.name === 'url' && (
            <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setConfig({ ...config, url: INBOX_URL })}>Use built-in Test Inbox</button>
          )}
        </Field>
      ))}
      {test && <div className={`alert ${test.ok ? 'success' : 'error'}`}>{test.message}</div>}
      <ErrorBox error={error} />
    </Modal>
  )
}

export default function Destinations() {
  const types = useAsync(() => api.get<DestinationType[]>('/destination-types'))
  const dests = useAsync(() => api.get<Destination[]>('/destinations'))
  const [modal, setModal] = useState<{ existing?: Destination } | null>(null)
  const typeOf = (t: string) => types.data?.find((x) => x.type === t)

  const remove = async (d: Destination) => {
    if (!confirm(`Remove destination “${d.name}”?`)) return
    try { await api.del(`/destinations/${d.id}`); dests.reload() } catch (e) { alert((e as Error).message) }
  }

  return (
    <div className="page">
      <PageHead stage="activation" title="Destinations" subtitle="The tools your audiences are delivered to. Credentials are stored securely and never shown again."
        actions={<button className="btn primary" onClick={() => setModal({})} disabled={!types.data}>+ Add destination</button>} />
      <ErrorBox error={dests.error || types.error} />
      {dests.loading ? <Spinner label="Loading…" /> : dests.data?.length ? (
        <div className="dest-grid">
          {dests.data.map((d) => {
            const t = typeOf(d.type)
            const configured = d.configured !== false
            return (
              <div key={d.id} className={`card dest-card ${configured ? '' : 'needs'}`}>
                <div className="dest-top">
                  <DestIcon type={d.type} size={48} />
                  <div className="grow">
                    <h2>{d.name}</h2>
                    <div className="small muted">{t?.label ?? d.type} · {t?.category}</div>
                  </div>
                  {configured ? <span className="badge green"><span className="dot" />Connected</span>
                    : <span className="badge amber"><span className="dot" />Credentials needed</span>}
                </div>
                <p className="small muted dest-desc">{t?.description}</p>
                {t && t.sync_types.length > 1 && (
                  <div className="row wrap" style={{ gap: 4 }}>{t.sync_types.map((st) => <span key={st.name} className="badge">{st.label}</span>)}</div>
                )}
                {!configured && (
                  <div className="dest-missing small">
                    Missing: {(d.missing_fields ?? []).join(', ') || 'credentials'}. Syncs are set up and will start once you add them.
                  </div>
                )}
                <div className="dest-foot">
                  <Link to="/activations" className="small">{d.sync_count ? `${d.sync_count} sync${d.sync_count === 1 ? '' : 's'}` : 'No syncs yet'}</Link>
                  <span className="grow" />
                  <button className="btn ghost sm danger" onClick={() => remove(d)}>Remove</button>
                  <button className={`btn sm ${configured ? '' : 'primary'}`} onClick={() => setModal({ existing: d })}>{configured ? 'Edit' : 'Add credentials'}</button>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="card">
          <Empty title="No destinations yet" action={<button className="btn primary" onClick={() => setModal({})}>Add destination</button>}>
            Connect Sailthru to start delivering audiences.
          </Empty>
        </div>
      )}
      {modal && types.data && (
        <DestinationModal types={types.data} existing={modal.existing} onClose={() => setModal(null)} onSaved={() => { setModal(null); dests.reload() }} />
      )}
    </div>
  )
}
