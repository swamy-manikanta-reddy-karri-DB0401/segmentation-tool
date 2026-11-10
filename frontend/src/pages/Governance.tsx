import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, fmt } from '../api'
import type { Audience, Destination, DestinationRule, GroupNode, PriorityList, Schema, Sync } from '../api'
import { BuilderProvider, conditionText, GroupEditor } from '../components/builder/ConditionEditor'
import { Empty, ErrorBox, Field, Modal, PageHead, useAsync } from '../components/ui'
import { useMe } from '../components/me'
import { askConfirm, FilterChips, matches, NoResults, Pager, SearchBox, SkeletonRows, toast, usePaged, useUrlState } from '../components/kit'
import { CollectionLayout, Inspector, ListPane, ListRow, Section } from '../components/collection'
import { BrandLogo } from '../components/logos'
import { DefinitionLines, filterLines, Glyph, Pill, syncState, useSelected } from '../ux/segment-kit'
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

function HowItWorks({ kind }: { kind: 'rules' | 'priority' }) {
  const items = kind === 'rules'
    ? [['Filters people at send time', 'For consent, privacy or compliance — per destination.'],
      ['Audiences stay the same', 'Counts still include everyone; the tool just doesn’t receive the others.'],
      ['Always applied', 'Every sync to that destination uses it, so nobody can forget it.']]
    : [['Stops competing messages', 'People who qualify for several audiences get only the most important one.'],
      ['You set the order', 'Winback › Upsell › Newsletter — someone in all three only gets Winback.'],
      ['Applies on the next run', 'To every sync of the audiences in the list.']]
  return (
    <div className="sg-how">
      {items.map(([t, d], i) => <div key={t}><span className="sg-how-n">{i + 1}</span><div><strong>{t}</strong><span>{d}</span></div></div>)}
    </div>
  )
}

/** How many people of an audience a rule would let through to its destination. */
function RuleImpact({ rule, audiences, pid }: { rule: DestinationRule; audiences: Audience[]; pid: number }) {
  const [aud, setAud] = useState<number | ''>(audiences[0]?.id ?? '')
  const [res, setRes] = useState<{ audience: number; after_rules: number; rules: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setRes(null) }, [rule.id, aud])
  if (!audiences.length) return <div className="sg-hint">Create an audience to see how many people this rule holds back.</div>
  const check = async () => {
    const a = audiences.find((x) => x.id === aud)
    if (!a) return
    setBusy(true); setError(null)
    try { setRes(await api.post('/destination-rules/preview', { definition: a.definition, destination_id: rule.destination_id, parent_id: pid })) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const held = res ? res.audience - res.after_rules : 0
  return (<>
    <div className="row" style={{ flexWrap: 'nowrap' }}>
      <select className="input sm grow" value={aud} onChange={(e) => setAud(e.target.value ? Number(e.target.value) : '')} aria-label="Audience">
        {audiences.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <button className="btn sm" onClick={check} disabled={busy || !aud}>{busy ? 'Checking…' : 'Check'}</button>
    </div>
    <ErrorBox error={error} />
    {res && (
      <div className="sg-delivery">
        <div className="sg-delivery-n"><strong>{fmt.num(res.after_rules)}</strong><span>of {fmt.num(res.audience)} would reach {rule.destination_name}</span></div>
        <div className="meter"><div style={{ width: `${res.audience ? (res.after_rules / res.audience) * 100 : 0}%` }} /></div>
        <div className="sg-hint">{held > 0 ? <>{fmt.num(held)} held back by {res.rules > 1 ? `the ${res.rules} rules for this destination` : 'this rule'}.</> : 'Nobody in this audience is held back.'}</div>
      </div>
    )}
  </>)
}

export default function Governance() {
  const [params, setParams] = useSearchParams()
  const pidParam = params.get('parent')
  const schema = useAsync(() => api.get<Schema>(`/schema${pidParam ? `?parent_id=${pidParam}` : ''}`), [pidParam])
  const audiences = useAsync(() => api.get<Audience[]>('/audiences'))
  const dests = useAsync(() => api.get<Destination[]>('/destinations'))
  const rules = useAsync(() => api.get<DestinationRule[]>('/destination-rules'))
  const lists = useAsync(() => api.get<PriorityList[]>('/priority-lists'))
  const syncs = useAsync(() => api.get<Sync[]>('/syncs'))
  const [ruleModal, setRuleModal] = useState<{ existing?: DestinationRule } | null>(null)
  const [listModal, setListModal] = useState<{ existing?: PriorityList } | null>(null)
  const tab = params.get('tab') === 'priority' ? 'priority' : 'rules'
  const [q, setQ] = useUrlState('q')
  const [dest, setDest] = useUrlState('dest', 'all')
  const [selected, setSelected] = useSelected()
  const me = useMe()

  const s = schema.data
  const ctx: Ctx | null = s?.parent ? { schema: s, audiences: audiences.data ?? [] } : null
  const pid = s?.parent?.id
  const myRules = (rules.data ?? []).filter((r) => r.parent_id === pid)
  const myLists = (lists.data ?? []).filter((l) => l.parent_id === pid)
  const aud = (id: number) => audiences.data?.find((a) => a.id === id)
  const audName = (id: number) => aud(id)?.name ?? `#${id}`
  const ruleRows = myRules.filter((r) => (dest === 'all' || String(r.destination_id) === dest)
    && matches(q, r.name, r.destination_name, ctx ? ruleWords(r.definition, ctx) : ''))
  const listRows = myLists.filter((l) => matches(q, l.name, ...l.config.audience_ids.map(audName)))
  const pagedRules = usePaged(ruleRows, 14, `${q}|${dest}|${pid}`, tab === 'rules' ? 'page' : undefined)
  const pagedLists = usePaged(listRows, 14, `${q}|${pid}`, tab === 'priority' ? 'page' : undefined)

  if ((schema.loading && !s) || (audiences.loading && !audiences.data) || (dests.loading && !dests.data)) {
    return <div className="page wide sg-page"><PageHead stage={tab === 'priority' ? 'segmentation' : 'activation'} title={tab === 'priority' ? 'Priority lists' : 'Destination rules'} /><SkeletonRows rows={4} /></div>
  }
  if (!s?.parent || !ctx) return <div className="page"><Empty title="Set up your data first" action={<Link to="/schema" className="btn primary">Open data model</Link>}>A Platform Admin sets up the data model first.</Empty></div>
  const gov = me.can('governance.manage', s.parent.brand_id ?? null)
  const brandDests = (dests.data ?? []).filter((d) => d.brand_id == null || d.brand_id === s.parent!.brand_id)
  const parentAudiences = (audiences.data ?? []).filter((a) => a.parent_id === pid)
  const ruleDests = [...new Map(myRules.map((r) => [r.destination_id, r])).values()]
  const who = s.parent.name.toLowerCase()

  const removeRule = async (r: DestinationRule) => {
    if (!await askConfirm({ title: `Delete rule “${r.name}”?`, danger: true, confirmLabel: 'Delete rule',
      body: <>From the next run, syncs to <strong>{r.destination_name}</strong> will send everyone in their audience again — including people this rule held back.</> })) return
    try { await api.del(`/destination-rules/${r.id}`); setSelected(null); rules.reload(); toast(`“${r.name}” deleted`) } catch (e) { toast((e as Error).message, 'error') }
  }
  const removeList = async (l: PriorityList) => {
    if (!await askConfirm({ title: `Delete priority list “${l.name}”?`, danger: true, confirmLabel: 'Delete list',
      body: 'People who qualify for several of its audiences may receive all of their messages again from the next run.' })) return
    try { await api.del(`/priority-lists/${l.id}`); setSelected(null); lists.reload(); toast(`“${l.name}” deleted`) } catch (e) { toast((e as Error).message, 'error') }
  }
  const parentSelect = s.parents.length > 1 && (
    <select className="input sm" value={s.parent.id} onChange={(e) => setParams({ tab, parent: e.target.value }, { replace: true })} aria-label="Parent model">
      {s.parents.map((p) => <option key={p.id} value={p.id}>{p.name} · {me.brandName(p.brand_id)}</option>)}
    </select>
  )

  const curRule = tab === 'rules' ? (myRules.find((r) => String(r.id) === selected) ?? pagedRules.slice[0] ?? ruleRows[0]) : undefined
  const curList = tab === 'priority' ? (myLists.find((l) => String(l.id) === selected) ?? pagedLists.slice[0] ?? listRows[0]) : undefined

  return (
    <BuilderProvider value={{ schema: s, audiences: audiences.data ?? [] }}>
      <div className="page wide sg-page">
        {tab === 'priority' ? (
          <PageHead stage="segmentation" title="Priority lists" subtitle="When someone qualifies for several audiences, they only receive the highest-priority one — no competing messages."
            actions={gov && myLists.length ? <button className="btn primary" disabled={parentAudiences.length < 2} title={parentAudiences.length < 2 ? 'Needs at least two audiences' : undefined} onClick={() => setListModal({})}>+ Priority list</button> : undefined} />
        ) : (
          <PageHead stage="activation" title="Destination rules" subtitle="Filters applied when sending — for consent, privacy or compliance. Audience membership never changes."
            actions={gov && myRules.length ? <button className="btn primary" disabled={!brandDests.length} title={!brandDests.length ? 'Add a destination first' : undefined} onClick={() => setRuleModal({})}>+ Destination rule</button> : undefined} />
        )}
        <ErrorBox error={rules.error || lists.error} />

        {tab === 'rules' ? (
          !myRules.length ? (
            <div className="card sg-onboard">
              <Glyph kind="rule" tone="green" size={52} />
              <h2>No destination rules yet</h2>
              <p className="muted">Right now every audience member is sent to every destination. Add a rule when some people must never reach a tool.</p>
              <HowItWorks kind="rules" />
              {gov && brandDests.length ? <button className="btn primary" onClick={() => setRuleModal({})}>+ Destination rule</button>
                : <div className="small faint">{brandDests.length ? 'Brand Marketing Admins can add rules.' : 'Add a destination first.'}</div>}
            </div>
          ) : (
            <CollectionLayout
              list={
                <ListPane title="Rules" count={ruleRows.length}
                  toolbar={<>
                    <SearchBox value={q} onChange={setQ} placeholder="Search rules…" />
                    {ruleDests.length > 1 && (
                      <FilterChips label="Destination" value={dest} onChange={setDest} options={[
                        { value: 'all', label: 'All', count: myRules.length },
                        ...ruleDests.map((r) => ({ value: String(r.destination_id), label: r.destination_name, count: myRules.filter((x) => x.destination_id === r.destination_id).length })),
                      ]} />
                    )}
                    {parentSelect}
                  </>}
                  footer={ruleRows.length > 14 ? <Pager page={pagedRules.page} pages={pagedRules.pages} total={ruleRows.length} pageSize={14} onPage={pagedRules.setPage} noun="rule" /> : undefined}>
                  {ruleRows.length ? pagedRules.slice.map((r) => (
                    <ListRow key={r.id} selected={curRule?.id === r.id} onSelect={() => setSelected(String(r.id))}
                      leading={<BrandLogo type={r.destination_type} size={32} />} title={r.name || 'Destination rule'}
                      subtitle={ruleWords(r.definition, ctx)}
                      meta={<span>{r.destination_name}</span>} />
                  )) : <NoResults what="rules" onClear={() => { setQ(''); setDest('all') }} />}
                </ListPane>
              }
              inspector={curRule ? (
                <Inspector icon={<Glyph kind="rule" tone="green" size={40} />} kicker={<>Destination rule · {curRule.destination_name}</>} title={curRule.name || 'Destination rule'}
                  actions={gov ? <button className="btn sm" onClick={() => setRuleModal({ existing: curRule })}>Edit</button> : undefined}
                  sentence={<>Only {who} who match {curRule.definition.op === 'or' ? 'any' : 'all'} of the conditions below are sent to <strong>{curRule.destination_name}</strong>.</>}>
                  <Section title="Conditions"><DefinitionLines lines={filterLines(curRule.definition, s, audiences.data ?? [])} op={curRule.definition.op} /></Section>
                  <Section title="Applies to">
                    {(() => {
                      const ds = (syncs.data ?? []).filter((x) => x.destination_id === curRule.destination_id)
                      return (
                        <div className="sg-sendlist">
                          <div className="sg-send static"><BrandLogo type={curRule.destination_type} size={30} />
                            <span className="sg-send-main"><strong>{curRule.destination_name}</strong><small>{ds.length ? `${ds.length} sync${ds.length === 1 ? '' : 's'} use this rule` : 'No syncs to this destination yet'}</small></span></div>
                          {ds.slice(0, 5).map((x) => <Link key={x.id} to={`/activations/${x.id}`} className="sg-send compact"><Glyph kind="audience" size={26} /><span className="sg-send-main"><strong>{x.audience_name}</strong><small>{x.name}</small></span><Pill tone={syncState(x).tone}>{syncState(x).text}</Pill></Link>)}
                        </div>
                      )
                    })()}
                  </Section>
                  <Section title="Check the impact on an audience"><RuleImpact rule={curRule} audiences={parentAudiences} pid={s.parent.id} /></Section>
                  <Section title="How rules work"><HowItWorks kind="rules" /></Section>
                  {gov && <div className="sg-quiet-actions"><span className="grow" /><button className="btn ghost sm danger" onClick={() => removeRule(curRule)}>Delete rule</button></div>}
                </Inspector>
              ) : <Inspector empty={<div>Select a rule.</div>} />}
            />
          )
        ) : (
          !myLists.length ? (
            <div className="card sg-onboard">
              <Glyph kind="priority" tone="violet" size={52} />
              <h2>No priority lists yet</h2>
              <p className="muted">{parentAudiences.length < 2 ? 'You need at least two audiences before a priority list makes sense.' : 'Create one when audiences overlap and people should only get the most important message.'}</p>
              <HowItWorks kind="priority" />
              {gov && parentAudiences.length >= 2 ? <button className="btn primary" onClick={() => setListModal({})}>+ Priority list</button>
                : <div className="small faint">{gov ? '' : 'Brand Marketing Admins can create priority lists.'}</div>}
            </div>
          ) : (
            <CollectionLayout
              list={
                <ListPane title="Priority lists" count={listRows.length}
                  toolbar={<><SearchBox value={q} onChange={setQ} placeholder="Search lists or their audiences…" />{parentSelect}</>}
                  footer={listRows.length > 14 ? <Pager page={pagedLists.page} pages={pagedLists.pages} total={listRows.length} pageSize={14} onPage={pagedLists.setPage} noun="list" /> : undefined}>
                  {listRows.length ? pagedLists.slice.map((l) => (
                    <ListRow key={l.id} selected={curList?.id === l.id} onSelect={() => setSelected(String(l.id))}
                      leading={<Glyph kind="priority" tone="violet" />} title={l.name || 'Priority list'}
                      subtitle={l.config.audience_ids.map(audName).join(' › ')}
                      meta={<><strong>{l.config.audience_ids.length}</strong><span>audiences</span></>} />
                  )) : <NoResults what="priority lists" onClear={() => setQ('')} />}
                </ListPane>
              }
              inspector={curList ? (
                <Inspector icon={<Glyph kind="priority" tone="violet" size={40} />} kicker="Priority list" title={curList.name || 'Priority list'}
                  actions={gov ? <button className="btn sm" onClick={() => setListModal({ existing: curList })}>Edit order</button> : undefined}
                  sentence={<>Someone who qualifies for several of these {curList.config.audience_ids.length} audiences only receives the <strong>highest</strong> one.</>}>
                  <Section title="Order — highest priority first">
                    <ol className="sg-ladder">
                      {curList.config.audience_ids.map((id, i) => {
                        const a = aud(id)
                        const n = (syncs.data ?? []).filter((x) => x.audience_id === id).length
                        return (
                          <li key={id}>
                            <span className="sg-ladder-n">{i + 1}</span>
                            <Link to={`/audiences/${id}`} className="sg-ladder-main"><strong>{audName(id)}</strong><small>{a?.last_size != null ? `${fmt.num(a.last_size)} people` : 'not counted'} · {n ? `${n} sync${n === 1 ? '' : 's'}` : 'not sent'}</small></Link>
                            {i === 0 ? <span className="sg-ladder-tag">Wins</span> : <span className="sg-ladder-tag muted">if not in {i === 1 ? '#1' : `#1–${i}`}</span>}
                          </li>
                        )
                      })}
                    </ol>
                  </Section>
                  <Section title="How priority lists work"><HowItWorks kind="priority" /></Section>
                  {gov && <div className="sg-quiet-actions"><span className="grow" /><button className="btn ghost sm danger" onClick={() => removeList(curList)}>Delete list</button></div>}
                </Inspector>
              ) : <Inspector empty={<div>Select a priority list.</div>} />}
            />
          )
        )}

        {ruleModal && <RuleModal schema={s} dests={brandDests} existing={ruleModal.existing} onClose={() => setRuleModal(null)}
          onSaved={(n) => { setRuleModal(null); rules.reload(); toast(`“${n}” saved`) }} />}
        {listModal && audiences.data && <PriorityModal schema={s} audiences={audiences.data} existing={listModal.existing} onClose={() => setListModal(null)}
          onSaved={(n) => { setListModal(null); lists.reload(); toast(`“${n}” saved`) }} />}
      </div>
    </BuilderProvider>
  )
}
