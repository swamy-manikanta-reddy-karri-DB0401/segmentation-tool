import { useState } from 'react'
import { api } from '../api'
import type { Audience, Destination, DestinationRule, GroupNode, PriorityList, Schema } from '../api'
import { BuilderProvider, GroupEditor } from '../components/builder/ConditionEditor'
import { useSearchParams } from 'react-router-dom'
import { DestIcon, Empty, ErrorBox, Field, Modal, PageHead, Spinner, useAsync } from '../components/ui'
import { useMe } from '../components/me'

function RuleModal({ schema, dests, existing, onClose, onSaved }: {
  schema: Schema; dests: Destination[]; existing?: DestinationRule; onClose: () => void; onSaved: () => void
}) {
  const [name, setName] = useState(existing?.name ?? '')
  const [destId, setDestId] = useState<number>(existing?.destination_id ?? dests[0]?.id)
  const [definition, setDefinition] = useState<GroupNode>(existing?.definition ?? { type: 'group', op: 'and', conditions: [] })
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    const body = { name, destination_id: destId, definition, parent_id: schema.parent!.id }
    try {
      if (existing) await api.put(`/destination-rules/${existing.id}`, body)
      else await api.post('/destination-rules', body)
      onSaved()
    } catch (e) { setError((e as Error).message) }
  }
  return (
    <Modal wide title={existing ? 'Edit destination rule' : 'New destination rule'}
      subtitle="Only records that match these filters are sent to the destination. Audience membership doesn't change."
      onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save rule</button></>}>
      <div className="grid-2">
        <Field label="Name"><input className="input" value={name} placeholder="e.g. Email opt-ins only" onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Destination">
          <select className="input" value={destId} onChange={(e) => setDestId(Number(e.target.value))}>
            {dests.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label={`Only send ${schema.parent!.name.toLowerCase()} who…`}>
        <GroupEditor group={definition} onChange={setDefinition} />
      </Field>
      <ErrorBox error={error} />
    </Modal>
  )
}

function PriorityModal({ schema, audiences, existing, onClose, onSaved }: {
  schema: Schema; audiences: Audience[]; existing?: PriorityList; onClose: () => void; onSaved: () => void
}) {
  const [name, setName] = useState(existing?.name ?? '')
  const [ids, setIds] = useState<number[]>(existing?.config.audience_ids ?? [])
  const [error, setError] = useState<string | null>(null)
  const available = audiences.filter((a) => a.parent_id === schema.parent!.id && !ids.includes(a.id))
  const move = (i: number, d: number) => {
    const next = [...ids]; const [x] = next.splice(i, 1); next.splice(i + d, 0, x); setIds(next)
  }
  const save = async () => {
    const body = { name, parent_id: schema.parent!.id, config: { audience_ids: ids } }
    try {
      if (existing) await api.put(`/priority-lists/${existing.id}`, body)
      else await api.post('/priority-lists', body)
      onSaved()
    } catch (e) { setError((e as Error).message) }
  }
  return (
    <Modal title={existing ? 'Edit priority list' : 'New priority list'}
      subtitle="When someone qualifies for several audiences in this list, they're synced only to the highest one."
      onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save list</button></>}>
      <Field label="Name"><input className="input" value={name} placeholder="e.g. Winback campaigns" onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Audiences — highest priority first">
        <div className="stack" style={{ gap: 6 }}>
          {ids.map((id, i) => (
            <div key={id} className="spread card" style={{ padding: '8px 12px' }}>
              <span className="row"><span className="badge brand">{i + 1}</span>{audiences.find((a) => a.id === id)?.name}</span>
              <span className="row" style={{ gap: 2 }}>
                <button className="btn ghost icon sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                <button className="btn ghost icon sm" disabled={i === ids.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                <button className="btn ghost icon sm" onClick={() => setIds(ids.filter((x) => x !== id))} aria-label="Remove">✕</button>
              </span>
            </div>
          ))}
          {available.length > 0 && (
            <select className="input" value="" onChange={(e) => e.target.value && setIds([...ids, Number(e.target.value)])}>
              <option value="">+ Add audience…</option>
              {available.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
        </div>
      </Field>
      <ErrorBox error={error} />
    </Modal>
  )
}

export default function Governance() {
  const schema = useAsync(() => api.get<Schema>('/schema'))
  const audiences = useAsync(() => api.get<Audience[]>('/audiences'))
  const dests = useAsync(() => api.get<Destination[]>('/destinations'))
  const rules = useAsync(() => api.get<DestinationRule[]>('/destination-rules'))
  const lists = useAsync(() => api.get<PriorityList[]>('/priority-lists'))
  const [ruleModal, setRuleModal] = useState<{ existing?: DestinationRule } | null>(null)
  const [listModal, setListModal] = useState<{ existing?: PriorityList } | null>(null)
  const [params] = useSearchParams()
  const tab = params.get('tab') === 'priority' ? 'priority' : 'rules'
  const me = useMe()

  if (schema.loading || audiences.loading || dests.loading) return <div className="page"><Spinner label="Loading…" /></div>
  const s = schema.data
  if (!s?.parent) return <div className="page"><Empty title="Set up your data first" /></div>
  const gov = me.can('governance.manage', s.parent.brand_id ?? null)
  const audName = (id: number) => audiences.data?.find((a) => a.id === id)?.name ?? `#${id}`

  return (
    <BuilderProvider value={{ schema: s, audiences: audiences.data ?? [] }}>
      <div className="page">
        {tab === 'priority' ? (
          <PageHead stage="segmentation" title="Priority lists" subtitle="When someone qualifies for several audiences, they only reach the highest-priority one — no duplicate messages."
            actions={gov ? <button className="btn primary" disabled={(audiences.data?.length ?? 0) < 2} onClick={() => setListModal({})}>+ Priority list</button> : undefined} />
        ) : (
          <PageHead stage="activation" title="Destination rules" subtitle="Filters applied at sync time — for consent, privacy or compliance. Audience membership never changes."
            actions={gov ? <button className="btn primary" disabled={!dests.data?.length} onClick={() => setRuleModal({})}>+ Destination rule</button> : undefined} />
        )}
        <ErrorBox error={rules.error || lists.error} />

        {tab === 'rules' && <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-head">
            <div><h2>Destination rules</h2><div className="small muted">Filters applied at sync time — for consent, privacy or compliance.</div></div>
            {gov && <button className="btn sm primary" disabled={!dests.data?.length} onClick={() => setRuleModal({})}>+ Add rule</button>}
          </div>
          {rules.data?.length ? (
            <table className="table">
              <thead><tr><th>Rule</th><th>Destination</th><th>Filters</th><th /></tr></thead>
              <tbody>
                {rules.data.map((r) => (
                  <tr key={r.id}>
                    <td><strong>{r.name}</strong></td>
                    <td><span className="row"><DestIcon type={r.destination_type} size={24} />{r.destination_name}</span></td>
                    <td className="muted">{r.definition.conditions.length} filter{r.definition.conditions.length === 1 ? '' : 's'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {gov && <button className="btn ghost sm" onClick={() => setRuleModal({ existing: r })}>Edit</button>}
                      {gov && <button className="btn ghost sm danger" onClick={async () => { await api.del(`/destination-rules/${r.id}`); rules.reload() }}>Delete</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="empty"><h3>No rules</h3><p>Every audience member is sent to every destination.</p></div>}
        </div>}

        {tab === 'priority' && <div className="card">
          <div className="card-head">
            <div><h2>Priority lists</h2><div className="small muted">Prevent duplicate messages: each person only reaches their highest-priority audience.</div></div>
            {gov && <button className="btn sm primary" disabled={(audiences.data?.length ?? 0) < 2} onClick={() => setListModal({})}>+ Add priority list</button>}
          </div>
          {lists.data?.length ? (
            <table className="table">
              <thead><tr><th>List</th><th>Order</th><th /></tr></thead>
              <tbody>
                {lists.data.map((l) => (
                  <tr key={l.id}>
                    <td><strong>{l.name}</strong></td>
                    <td><div className="row wrap">{l.config.audience_ids.map((id, i) => <span key={id} className="badge">{i + 1}. {audName(id)}</span>)}</div></td>
                    <td style={{ textAlign: 'right' }}>
                      {gov && <button className="btn ghost sm" onClick={() => setListModal({ existing: l })}>Edit</button>}
                      {gov && <button className="btn ghost sm danger" onClick={async () => { await api.del(`/priority-lists/${l.id}`); lists.reload() }}>Delete</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="empty"><h3>No priority lists yet</h3><p>Create one once you have overlapping audiences.</p></div>}
        </div>}

        {ruleModal && dests.data && <RuleModal schema={s} dests={dests.data} existing={ruleModal.existing} onClose={() => setRuleModal(null)} onSaved={() => { setRuleModal(null); rules.reload() }} />}
        {listModal && audiences.data && <PriorityModal schema={s} audiences={audiences.data} existing={listModal.existing} onClose={() => setListModal(null)} onSaved={() => { setListModal(null); lists.reload() }} />}
      </div>
    </BuilderProvider>
  )
}
