import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Audience, Destination, DestinationRule, GroupNode, PriorityList, Schema } from '../api'
import { BuilderProvider, conditionText, GroupEditor } from '../components/builder/ConditionEditor'
import { DestIcon, Empty, ErrorBox, Field, Modal, PageHead, useAsync } from '../components/ui'
import { useMe } from '../components/me'
import { askConfirm, FilterChips, matches, NoResults, Pager, SearchBox, SkeletonRows, toast, Toolbar, usePaged, useUrlState } from '../components/kit'
import '../ux/segment.css'

type Ctx = { schema: Schema; audiences: Audience[] }

/** “Email consent is true and Country is US” */
function ruleWords(def: GroupNode, ctx: Ctx): string {
  const parts = def.conditions.map((c) => conditionText(c, ctx)).filter(Boolean)
  if (!parts.length) return 'No filters'
  return parts.join(def.op === 'or' ? ' or ' : ' and ')
}

function RuleModal({ schema, dests, existing, onClose, onSaved }: {
  schema: Schema; dests: Destination[]; existing?: DestinationRule; onClose: () => void; onSaved: (name: string) => void
}) {
  const [name, setName] = useState(existing?.name ?? '')
  const [destId, setDestId] = useState<number>(existing?.destination_id ?? dests[0]?.id)
  const [definition, setDefinition] = useState<GroupNode>(existing?.definition ?? { type: 'group', op: 'and', conditions: [] })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true); setError(null)
    const body = { name: name.trim(), destination_id: destId, definition, parent_id: schema.parent!.id }
    try {
      if (existing) await api.put(`/destination-rules/${existing.id}`, body)
      else await api.post('/destination-rules', body)
      onSaved(body.name || 'Destination rule')
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  return (
    <Modal wide title={existing ? 'Edit destination rule' : 'New destination rule'}
      subtitle="Only people who match these filters are sent to the destination. Audience membership doesn't change."
      onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={saving || !definition.conditions.length}>{saving ? 'Saving…' : 'Save rule'}</button></>}>
      <div className="grid-2">
        <Field label="Name"><input className="input" value={name} autoFocus placeholder="e.g. Email opt-ins only" onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Applies to destination">
          <select className="input" value={destId} onChange={(e) => setDestId(Number(e.target.value))}>
            {dests.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label={`Only send ${schema.parent!.name.toLowerCase()} who…`} help="Typical rules: email consent is true, not on a suppression list, country is in a region you may market to.">
        <GroupEditor group={definition} onChange={setDefinition} />
      </Field>
      <ErrorBox error={error} />
    </Modal>
  )
}

function PriorityModal({ schema, audiences, existing, onClose, onSaved }: {
  schema: Schema; audiences: Audience[]; existing?: PriorityList; onClose: () => void; onSaved: (name: string) => void
}) {
  const [name, setName] = useState(existing?.name ?? '')
  const [ids, setIds] = useState<number[]>(existing?.config.audience_ids ?? [])
  const [find, setFind] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const available = audiences.filter((a) => a.parent_id === schema.parent!.id && !ids.includes(a.id) && matches(find, a.name, a.description))
  const move = (i: number, d: number) => { const next = [...ids]; const [x] = next.splice(i, 1); next.splice(i + d, 0, x); setIds(next) }
  const save = async () => {
    setSaving(true); setError(null)
    const body = { name: name.trim(), parent_id: schema.parent!.id, config: { audience_ids: ids } }
    try {
      if (existing) await api.put(`/priority-lists/${existing.id}`, body)
      else await api.post('/priority-lists', body)
      onSaved(body.name || 'Priority list')
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  const aud = (id: number) => audiences.find((a) => a.id === id)
  return (
    <Modal wide title={existing ? 'Edit priority list' : 'New priority list'}
      subtitle="When someone qualifies for several audiences in this list, their syncs only send them for the highest one."
      onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={saving || ids.length < 2}>{saving ? 'Saving…' : 'Save list'}</button></>}>
      <Field label="Name"><input className="input" value={name} autoFocus placeholder="e.g. Subscription offers" onChange={(e) => setName(e.target.value)} /></Field>
      <div className="seg-prio-grid">
        <div>
          <div className="seg-prio-label">Order — highest priority first {ids.length < 2 && <span className="faint">(add at least two)</span>}</div>
          <ol className="seg-prio-list">
            {ids.map((id, i) => (
              <li key={id}>
                <span className="seg-prio-n">{i + 1}</span>
                <span className="grow seg-ellipsis" title={aud(id)?.name}>{aud(id)?.name ?? `Audience #${id}`}</span>
                <span className="small faint">{fmt.num(aud(id)?.last_size)}</span>
                <button className="btn ghost icon sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                <button className="btn ghost icon sm" disabled={i === ids.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                <button className="btn ghost icon sm" onClick={() => setIds(ids.filter((x) => x !== id))} aria-label="Remove">✕</button>
              </li>
            ))}
            {!ids.length && <li className="seg-prio-empty">Pick audiences on the right.</li>}
          </ol>
        </div>
        <div>
          <div className="seg-prio-label">Add audiences</div>
          <SearchBox value={find} onChange={setFind} placeholder="Find an audience…" />
          <div className="seg-prio-pick">
            {available.slice(0, 50).map((a) => (
              <button key={a.id} onClick={() => setIds([...ids, a.id])}>
                <span className="grow seg-ellipsis" title={a.name}>{a.name}</span><span className="small faint">{fmt.num(a.last_size)}</span><span className="seg-add">+</span>
              </button>
            ))}
            {!available.length && <div className="dm-none">No more audiences{find ? ' match' : ''}.</div>}
          </div>
        </div>
      </div>
      <div className="small muted">An audience can belong to one priority list only.</div>
      <ErrorBox error={error} />
    </Modal>
  )
}

function Explainer({ kind }: { kind: 'rules' | 'priority' }) {
  return kind === 'rules' ? (
    <div className="seg-explain">
      <div><strong>What it does</strong><span>A rule filters people out at send time — for consent, privacy or compliance — for one destination.</span></div>
      <div><strong>Example</strong><span>“Only send people with email consent to Sailthru.” The audience still counts everyone; Sailthru just doesn't receive the others.</span></div>
      <div><strong>Applies</strong><span>Automatically to every sync to that destination, so nobody can forget it.</span></div>
    </div>
  ) : (
    <div className="seg-explain">
      <div><strong>What it does</strong><span>Stops people from getting several competing messages when they qualify for more than one audience.</span></div>
      <div><strong>Example</strong><span>Winback &gt; Upsell &gt; Newsletter: someone in all three only receives the Winback sync.</span></div>
      <div><strong>Applies</strong><span>To every sync of the audiences in the list, on their next run.</span></div>
    </div>
  )
}

export default function Governance() {
  const [params, setParams] = useSearchParams()
  const pidParam = params.get('parent')
  const schema = useAsync(() => api.get<Schema>(`/schema${pidParam ? `?parent_id=${pidParam}` : ''}`), [pidParam])
  const audiences = useAsync(() => api.get<Audience[]>('/audiences'))
  const dests = useAsync(() => api.get<Destination[]>('/destinations'))
  const rules = useAsync(() => api.get<DestinationRule[]>('/destination-rules'))
  const lists = useAsync(() => api.get<PriorityList[]>('/priority-lists'))
  const [ruleModal, setRuleModal] = useState<{ existing?: DestinationRule } | null>(null)
  const [listModal, setListModal] = useState<{ existing?: PriorityList } | null>(null)
  const tab = params.get('tab') === 'priority' ? 'priority' : 'rules'
  const [q, setQ] = useUrlState('q')
  const [dest, setDest] = useUrlState('dest', 'all')
  const me = useMe()

  const s = schema.data
  const ctx: Ctx | null = s?.parent ? { schema: s, audiences: audiences.data ?? [] } : null
  const pid = s?.parent?.id
  const myRules = (rules.data ?? []).filter((r) => r.parent_id === pid)
  const myLists = (lists.data ?? []).filter((l) => l.parent_id === pid)
  const audName = (id: number) => audiences.data?.find((a) => a.id === id)?.name ?? `#${id}`
  const ruleRows = myRules.filter((r) => (dest === 'all' || String(r.destination_id) === dest)
    && matches(q, r.name, r.destination_name, ctx ? ruleWords(r.definition, ctx) : ''))
  const listRows = myLists.filter((l) => matches(q, l.name, ...l.config.audience_ids.map(audName)))
  const pagedRules = usePaged(ruleRows, 15, `${q}|${dest}|${pid}`, tab === 'rules' ? 'page' : undefined)
  const pagedLists = usePaged(listRows, 15, `${q}|${pid}`, tab === 'priority' ? 'page' : undefined)

  if ((schema.loading && !s) || (audiences.loading && !audiences.data) || (dests.loading && !dests.data)) {
    return <div className="page wide"><PageHead stage={tab === 'priority' ? 'segmentation' : 'activation'} title={tab === 'priority' ? 'Priority lists' : 'Destination rules'} /><SkeletonRows rows={4} /></div>
  }
  if (!s?.parent || !ctx) return <div className="page"><Empty title="Set up your data first" action={<Link to="/schema" className="btn primary">Open data model</Link>}>A Platform Admin sets up the data model first.</Empty></div>
  const gov = me.can('governance.manage', s.parent.brand_id ?? null)
  const brandDests = (dests.data ?? []).filter((d) => d.brand_id == null || d.brand_id === s.parent!.brand_id)
  const parentAudiences = (audiences.data ?? []).filter((a) => a.parent_id === pid)
  const ruleDests = [...new Map(myRules.map((r) => [r.destination_id, r])).values()]

  const removeRule = async (r: DestinationRule) => {
    if (!await askConfirm({ title: `Delete rule “${r.name}”?`, danger: true, confirmLabel: 'Delete rule',
      body: <>From the next run, syncs to <strong>{r.destination_name}</strong> will send everyone in their audience again — including people this rule excluded.</> })) return
    try { await api.del(`/destination-rules/${r.id}`); rules.reload(); toast(`“${r.name}” deleted`) } catch (e) { toast((e as Error).message, 'error') }
  }
  const removeList = async (l: PriorityList) => {
    if (!await askConfirm({ title: `Delete priority list “${l.name}”?`, danger: true, confirmLabel: 'Delete list',
      body: 'People who qualify for several of its audiences may receive all of their messages again from the next run.' })) return
    try { await api.del(`/priority-lists/${l.id}`); lists.reload(); toast(`“${l.name}” deleted`) } catch (e) { toast((e as Error).message, 'error') }
  }
  const switcher = s.parents.length > 1 && (
    <div className="seg-parent-switch">
      <span className="small muted">For</span>
      <select className="input sm" value={s.parent.id} onChange={(e) => setParams({ tab, parent: e.target.value }, { replace: true })} aria-label="Parent model">
        {s.parents.map((p) => <option key={p.id} value={p.id}>{p.name} · {me.brandName(p.brand_id)}</option>)}
      </select>
    </div>
  )

  return (
    <BuilderProvider value={{ schema: s, audiences: audiences.data ?? [] }}>
      <div className="page wide">
        {tab === 'priority' ? (
          <PageHead stage="segmentation" title="Priority lists" subtitle="When someone qualifies for several audiences, they only reach the highest-priority one — no competing messages."
            actions={gov ? <button className="btn primary" disabled={parentAudiences.length < 2} title={parentAudiences.length < 2 ? 'Needs at least two audiences' : undefined} onClick={() => setListModal({})}>+ Priority list</button> : undefined} />
        ) : (
          <PageHead stage="activation" title="Destination rules" subtitle="Filters applied when sending — for consent, privacy or compliance. Audience membership never changes."
            actions={gov ? <button className="btn primary" disabled={!brandDests.length} title={!brandDests.length ? 'Add a destination first' : undefined} onClick={() => setRuleModal({})}>+ Destination rule</button> : undefined} />
        )}
        <ErrorBox error={rules.error || lists.error} />
        {switcher}
        <Explainer kind={tab} />

        {tab === 'rules' ? (
          !myRules.length ? (
            <div className="card"><Empty title="No destination rules"
              action={gov && brandDests.length ? <button className="btn primary" onClick={() => setRuleModal({})}>Create a rule</button> : undefined}>
              Every audience member is sent to every destination. Add a rule if some people must never reach a tool — for example without email consent.
            </Empty></div>
          ) : (<>
            <Toolbar>
              <SearchBox value={q} onChange={setQ} placeholder={`Search ${myRules.length} rules…`} />
              {ruleDests.length > 1 && (
                <FilterChips label="Destination" value={dest} onChange={setDest} options={[
                  { value: 'all', label: 'All', count: myRules.length },
                  ...ruleDests.map((r) => ({ value: String(r.destination_id), label: r.destination_name, count: myRules.filter((x) => x.destination_id === r.destination_id).length })),
                ]} />
              )}
            </Toolbar>
            <div className="card seg-card">
              {ruleRows.length ? (
                <table className="table seg-table">
                  <thead><tr><th>Rule</th><th>Destination</th><th>Only sends people who…</th>{gov && <th aria-label="Actions" />}</tr></thead>
                  <tbody>
                    {pagedRules.slice.map((r) => (
                      <tr key={r.id}>
                        <td><strong>{r.name}</strong></td>
                        <td><span className="row" style={{ flexWrap: 'nowrap' }}><DestIcon type={r.destination_type} size={24} />{r.destination_name}</span></td>
                        <td className="small seg-rule-words">{ruleWords(r.definition, ctx)}</td>
                        {gov && (
                          <td className="seg-actions">
                            <button className="btn ghost sm" onClick={() => setRuleModal({ existing: r })}>Edit</button>
                            <button className="btn ghost sm danger" onClick={() => removeRule(r)}>Delete</button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <NoResults what="rules" onClear={() => { setQ(''); setDest('all') }} />}
            </div>
            <Pager page={pagedRules.page} pages={pagedRules.pages} total={ruleRows.length} pageSize={15} onPage={pagedRules.setPage} noun="rule" />
          </>)
        ) : (
          !myLists.length ? (
            <div className="card"><Empty title="No priority lists yet"
              action={gov && parentAudiences.length >= 2 ? <button className="btn primary" onClick={() => setListModal({})}>Create a priority list</button> : undefined}>
              {parentAudiences.length < 2 ? 'You need at least two audiences before a priority list makes sense.' : 'Create one when audiences overlap and people should only get the most important message.'}
            </Empty></div>
          ) : (<>
            <Toolbar><SearchBox value={q} onChange={setQ} placeholder={`Search ${myLists.length} lists or their audiences…`} /></Toolbar>
            <div className="card seg-card">
              {listRows.length ? (
                <table className="table seg-table">
                  <thead><tr><th>List</th><th>Order (highest first)</th>{gov && <th aria-label="Actions" />}</tr></thead>
                  <tbody>
                    {pagedLists.slice.map((l) => (
                      <tr key={l.id}>
                        <td><strong>{l.name}</strong><div className="small faint">{l.config.audience_ids.length} audiences</div></td>
                        <td><div className="seg-order">{l.config.audience_ids.map((id, i) => (
                          <span key={id} className="seg-order-item"><span className="seg-prio-n">{i + 1}</span><Link to={`/audiences/${id}`}>{audName(id)}</Link>{i < l.config.audience_ids.length - 1 && <span className="faint" aria-hidden="true">›</span>}</span>
                        ))}</div></td>
                        {gov && (
                          <td className="seg-actions">
                            <button className="btn ghost sm" onClick={() => setListModal({ existing: l })}>Edit</button>
                            <button className="btn ghost sm danger" onClick={() => removeList(l)}>Delete</button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <NoResults what="priority lists" onClear={() => setQ('')} />}
            </div>
            <Pager page={pagedLists.page} pages={pagedLists.pages} total={listRows.length} pageSize={15} onPage={pagedLists.setPage} noun="list" />
          </>)
        )}

        {ruleModal && <RuleModal schema={s} dests={brandDests} existing={ruleModal.existing} onClose={() => setRuleModal(null)}
          onSaved={(n) => { setRuleModal(null); rules.reload(); toast(`“${n}” saved`) }} />}
        {listModal && audiences.data && <PriorityModal schema={s} audiences={audiences.data} existing={listModal.existing} onClose={() => setListModal(null)}
          onSaved={(n) => { setListModal(null); lists.reload(); toast(`“${n}” saved`) }} />}
      </div>
    </BuilderProvider>
  )
}
