import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, fmt } from '../api'
import type { AuditEntry, Brand, Destination, RoleBinding, RoleInfo } from '../api'
import { Empty, ErrorBox, Field, Modal, PageHead, Toggle, useAsync } from '../components/ui'
import { useMe } from '../components/me'
import { askConfirm, matches, NoResults, Pager, SearchBox, SkeletonRows, toast, Toolbar, usePaged, useUrlState } from '../components/kit'
import '../ux/activate.css'

const ROLE_BADGE: Record<string, string> = { platform_admin: 'violet', brand_admin: 'brand', builder: 'blue', operator: 'amber', viewer: '' }
const ACTION_LABEL: Record<string, string> = {
  create: 'Created', update: 'Changed', delete: 'Deleted', approve: 'Approved', reject: 'Sent back', run: 'Ran',
  pause: 'Paused', resume: 'Resumed', grant: 'Granted', revoke: 'Revoked',
}

// ---- brands ------------------------------------------------------------------------------

function BrandModal({ existing, onClose, onSaved }: { existing?: Brand; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setError(null)
    try {
      if (existing) await api.put(`/brands/${existing.id}`, { name, description })
      else await api.post('/brands', { name, description })
      toast(existing ? 'Brand renamed' : `Brand ${name} created`)
      onSaved()
    } catch (e) { setError((e as Error).message) }
  }
  return (
    <Modal title={existing ? `Rename ${existing.name}` : 'New brand'} subtitle="Each brand has its own parent models, destinations, audiences and syncs."
      onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={!name.trim()}>Save</button></>}>
      <Field label="Name"><input className="input" value={name} autoFocus placeholder="e.g. CNBC" onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Description (optional)"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <ErrorBox error={error} />
    </Modal>
  )
}

function BrandsTab() {
  const brands = useAsync(() => api.get<Brand[]>('/brands'))
  const [modal, setModal] = useState<{ existing?: Brand } | null>(null)
  const [q, setQ] = useUrlState('q')
  const remove = async (b: Brand) => {
    if (!await askConfirm({ title: `Delete the brand “${b.name}”?`, body: 'Role grants on this brand are removed too. Brands that still have parent models or destinations can’t be deleted.', confirmLabel: 'Delete brand', danger: true })) return
    try { await api.del(`/brands/${b.id}`); brands.reload(); toast(`${b.name} deleted`) } catch (e) { toast((e as Error).message, 'error') }
  }
  const rows = (brands.data ?? []).filter((b) => matches(q, b.name, b.description))
  const paged = usePaged(rows, 20, q)
  return (
    <div className="card">
      <div className="card-head">
        <div><h2>Brands</h2><div className="small muted">Roles are granted per brand. People only see the brands they have a role on.</div></div>
        <button className="btn sm primary" onClick={() => setModal({})}>+ New brand</button>
      </div>
      <ErrorBox error={brands.error} />
      {(brands.data?.length ?? 0) > 6 && <div className="card-body acc-tools"><Toolbar><SearchBox value={q} onChange={setQ} placeholder={`Search ${brands.data!.length} brands…`} /></Toolbar></div>}
      {brands.loading ? <SkeletonRows rows={3} cols={4} /> : brands.data?.length ? (<>
        <table className="table">
          <thead><tr><th>Brand</th><th>Parent models</th><th>Destinations</th><th>Created</th><th /></tr></thead>
          <tbody>
            {paged.slice.map((b) => (
              <tr key={b.id}>
                <td><strong>{b.name}</strong>{b.description && <div className="small faint">{b.description}</div>}</td>
                <td>{b.parent_count ?? 0}</td>
                <td>{b.destination_count ?? 0}</td>
                <td className="muted">{fmt.ago(b.created_at)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn ghost sm" onClick={() => setModal({ existing: b })}>Rename</button>
                  <button className="btn ghost sm danger" onClick={() => remove(b)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <NoResults what="brands" onClear={() => setQ('')} />}
        <div className="act-pager"><Pager page={paged.page} pages={paged.pages} total={rows.length} pageSize={20} onPage={paged.setPage} noun="brand" /></div>
      </>) : <Empty title="No brands yet" action={<button className="btn primary" onClick={() => setModal({})}>Create a brand</button>} />}
      {modal && <BrandModal existing={modal.existing} onClose={() => setModal(null)} onSaved={() => { setModal(null); brands.reload() }} />}
    </div>
  )
}

// ---- roles -------------------------------------------------------------------------------

function GrantModal({ roles, brands, dests, onClose, onSaved }: {
  roles: RoleInfo[]; brands: Brand[]; dests: Destination[]; onClose: () => void; onSaved: () => void
}) {
  const [ptype, setPtype] = useState<'group' | 'user'>('group')
  const [principal, setPrincipal] = useState('')
  const [role, setRole] = useState('viewer')
  const [brandId, setBrandId] = useState<number | ''>(brands[0]?.id ?? '')
  const [destIds, setDestIds] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)
  const info = roles.find((r) => r.role === role)
  const platform = role === 'platform_admin'
  const brandDests = dests.filter((d) => d.brand_id == null || d.brand_id === brandId)
  const save = async () => {
    setError(null)
    try {
      await api.post('/role-bindings', { principal_type: ptype, principal, role, brand_id: platform ? null : brandId || null,
                                         destination_ids: role === 'operator' ? destIds : [] })
      toast(`${info?.label ?? 'Role'} granted to ${principal}`)
      onSaved()
    } catch (e) { setError((e as Error).message) }
  }
  return (
    <Modal title="Grant a role" subtitle="Grant roles to Databricks groups so access follows group membership in your workspace."
      onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={!principal.trim()}>Grant role</button></>}>
      <Field label="Who">
        <Toggle value={ptype} onChange={(v) => setPtype(v)} options={[{ value: 'group', label: 'Databricks group' }, { value: 'user', label: 'User' }]} />
        <input className="input" value={principal} autoFocus onChange={(e) => setPrincipal(e.target.value)}
          placeholder={ptype === 'group' ? 'e.g. cnbc-marketing-admins' : 'e.g. jane.doe@company.com'} />
      </Field>
      <Field label="Role" help={info?.description}>
        <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
          {roles.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
        </select>
      </Field>
      {!platform && (
        <Field label="Brand">
          <select className="input" value={brandId} onChange={(e) => { setBrandId(e.target.value ? Number(e.target.value) : ''); setDestIds([]) }}>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            <option value="">All brands</option>
          </select>
        </Field>
      )}
      {role === 'operator' && (
        <Field label="Destinations they may run syncs to" help="Leave all unticked to allow every destination of the brand.">
          {brandDests.length ? (
            <div className="check-list">
              {brandDests.map((d) => (
                <label key={d.id}>
                  <input type="checkbox" checked={destIds.includes(d.id)}
                    onChange={(e) => setDestIds(e.target.checked ? [...destIds, d.id] : destIds.filter((x) => x !== d.id))} />
                  {d.name}
                </label>
              ))}
            </div>
          ) : <div className="small muted">This brand has no destinations yet.</div>}
        </Field>
      )}
      <ErrorBox error={error} />
    </Modal>
  )
}

function RolesTab() {
  const bindings = useAsync(() => api.get<RoleBinding[]>('/role-bindings'))
  const roles = useAsync(() => api.get<RoleInfo[]>('/roles'))
  const brands = useAsync(() => api.get<Brand[]>('/brands'))
  const dests = useAsync(() => api.get<Destination[]>('/destinations'))
  const [open, setOpen] = useState(false)
  const label = (r: string) => roles.data?.find((x) => x.role === r)?.label ?? r
  const destName = (id: number) => dests.data?.find((d) => d.id === id)?.name ?? `#${id}`
  const [q, setQ] = useUrlState('q')
  const [roleF, setRoleF] = useUrlState('role')
  const [brandF, setBrandF] = useUrlState('brand')
  const revoke = async (b: RoleBinding) => {
    if (!await askConfirm({ title: `Remove ${label(b.role)} from ${b.principal}?`, body: b.principal_type === 'group' ? 'Everyone in this Databricks group loses this role within 5 minutes.' : 'They lose this role within 5 minutes.', confirmLabel: 'Remove role', danger: true })) return
    try { await api.del(`/role-bindings/${b.id}`); bindings.reload(); toast('Role removed') } catch (e) { toast((e as Error).message, 'error') }
  }
  const all = bindings.data ?? []
  const rows = all.filter((b) => matches(q, b.principal, b.brand_name) && (!roleF || b.role === roleF)
    && (!brandF || (brandF === 'all' ? b.brand_id == null : String(b.brand_id) === brandF)))
  const paged = usePaged(rows, 20, `${q}|${roleF}|${brandF}`, 'page')
  return (<>
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-head">
        <div><h2>Role assignments</h2><div className="small muted">Platform Admins listed in the app's configuration always have full access.</div></div>
        <button className="btn sm primary" onClick={() => setOpen(true)} disabled={!roles.data || !brands.data}>+ Grant role</button>
      </div>
      <ErrorBox error={bindings.error} />
      {all.length > 0 && (
        <div className="card-body acc-tools">
          <Toolbar>
            <SearchBox value={q} onChange={setQ} placeholder={`Search ${all.length} people and groups…`} />
            <select className="input sm act-select" value={roleF} onChange={(e) => setRoleF(e.target.value)} aria-label="Role">
              <option value="">All roles</option>
              {(roles.data ?? []).map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
            </select>
            {(brands.data?.length ?? 0) > 1 && (
              <select className="input sm act-select" value={brandF} onChange={(e) => setBrandF(e.target.value)} aria-label="Brand">
                <option value="">Any brand</option>
                {(brands.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                <option value="all">All brands / platform</option>
              </select>
            )}
          </Toolbar>
        </div>
      )}
      {bindings.loading ? <SkeletonRows rows={4} cols={4} /> : all.length ? (<>
        <table className="table">
          <thead><tr><th>Who</th><th>Role</th><th>Brand</th><th>Limited to</th><th>Granted</th><th /></tr></thead>
          <tbody>
            {paged.slice.map((b) => (
              <tr key={b.id}>
                <td><span className="badge" style={{ marginRight: 6 }}>{b.principal_type === 'group' ? 'Group' : 'User'}</span><strong>{b.principal}</strong></td>
                <td><span className={`badge ${ROLE_BADGE[b.role] ?? ''}`}>{label(b.role)}</span></td>
                <td>{b.role === 'platform_admin' ? <span className="faint">—</span> : b.brand_name ?? 'All brands'}</td>
                <td className="small">{b.destination_ids.length ? b.destination_ids.map(destName).join(', ') : <span className="faint">—</span>}</td>
                <td className="muted small">{b.created_by ? `${b.created_by} · ` : ''}{fmt.ago(b.created_at)}</td>
                <td style={{ textAlign: 'right' }}><button className="btn ghost sm danger" onClick={() => revoke(b)}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <NoResults what="role assignments" onClear={() => { setQ(''); setRoleF(''); setBrandF('') }} />}
        <div className="act-pager"><Pager page={paged.page} pages={paged.pages} total={rows.length} pageSize={20} onPage={paged.setPage} noun="assignment" /></div>
      </>) : <Empty title="No roles granted yet" action={<button className="btn primary" onClick={() => setOpen(true)}>Grant a role</button>}>
          Grant roles to Databricks groups, e.g. “cnbc-marketing-admins” → Brand Marketing Admin for CNBC.</Empty>}
    </div>
    <div className="card">
      <div className="card-head"><h2>What each role can do</h2></div>
      <table className="table">
        <thead><tr><th>Role</th><th>Can do</th></tr></thead>
        <tbody>
          {(roles.data ?? []).map((r) => (
            <tr key={r.role}><td><span className={`badge ${ROLE_BADGE[r.role] ?? ''}`}>{r.label}</span></td><td className="small">{r.description}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
    {open && roles.data && brands.data && (
      <GrantModal roles={roles.data} brands={brands.data} dests={dests.data ?? []} onClose={() => setOpen(false)}
        onSaved={() => { setOpen(false); bindings.reload() }} />
    )}
  </>)
}

// ---- activity ------------------------------------------------------------------------------

function ActivityTab() {
  const log = useAsync(() => api.get<AuditEntry[]>('/audit?limit=500'))
  const me = useMe()
  const [q, setQ] = useUrlState('q')
  const [action, setAction] = useUrlState('action')
  const [kind, setKind] = useUrlState('object')
  const detail = (d: Record<string, unknown>) => Object.entries(d).filter(([, v]) => v !== '' && v != null && v !== false)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v === true ? 'yes' : String(v)}`).join(' · ')
  return (
    <div className="card">
      <div className="card-head"><div><h2>Activity</h2><div className="small muted">Who created, approved, ran and granted what.</div></div></div>
      <ErrorBox error={log.error} />
      {(log.data?.length ?? 0) > 0 && (
        <div className="card-body acc-tools">
          <Toolbar>
            <SearchBox value={q} onChange={setQ} placeholder="Search people, names, notes…" />
            <select className="input sm act-select" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action">
              <option value="">All actions</option>
              {[...new Set(log.data!.map((r) => r.action))].map((a) => <option key={a} value={a}>{ACTION_LABEL[a] ?? a}</option>)}
            </select>
            <select className="input sm act-select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Object">
              <option value="">Everything</option>
              {[...new Set(log.data!.map((r) => r.object_type))].map((o) => <option key={o} value={o}>{o[0].toUpperCase() + o.slice(1)}s</option>)}
            </select>
          </Toolbar>
        </div>
      )}
      {log.loading ? <SkeletonRows rows={5} cols={5} /> : log.data?.length ? (<ActivityTable rows={log.data.filter((r) => (!action || r.action === action) && (!kind || r.object_type === kind)
        && matches(q, r.actor, r.object_type, JSON.stringify(r.details)))} detail={detail} brandName={me.brandName}
        onClear={() => { setQ(''); setAction(''); setKind('') }} />) : null}
      {!log.loading && !log.data?.length && <Empty title="No activity yet">Approvals, runs and role changes appear here.</Empty>}
    </div>
  )
}

function ActivityTable({ rows, detail, brandName, onClear }: {
  rows: AuditEntry[]; detail: (d: Record<string, unknown>) => string; brandName: (id: number | null | undefined) => string; onClear: () => void
}) {
  const paged = usePaged(rows, 25, rows.length, 'page')
  return (<>
    <table className="table">
      <thead><tr><th>When</th><th>Who</th><th>Action</th><th>What</th><th>Brand</th><th>Details</th></tr></thead>
      <tbody>
        {paged.slice.map((r) => (
          <tr key={r.id}>
            <td className="muted small" title={new Date(r.at).toLocaleString()}>{fmt.ago(r.at)}</td>
            <td className="small">{r.actor}</td>
            <td><span className={`badge ${r.action === 'approve' ? 'green' : r.action === 'reject' || r.action === 'delete' || r.action === 'revoke' ? 'red' : ''}`}>{ACTION_LABEL[r.action] ?? r.action}</span></td>
            <td className="small">{r.object_type[0].toUpperCase() + r.object_type.slice(1)}{r.object_id != null ? ` #${r.object_id}` : ''}</td>
            <td className="small">{r.brand_id != null ? brandName(r.brand_id) : <span className="faint">—</span>}</td>
            <td className="small muted acc-detail">{detail(r.details)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    {!rows.length && <NoResults what="activity entries" onClear={onClear} />}
    <div className="act-pager"><Pager page={paged.page} pages={paged.pages} total={rows.length} pageSize={25} onPage={paged.setPage} noun="event" /></div>
  </>)
}

export default function Access() {
  const [params, setParams] = useSearchParams()
  const me = useMe()
  const tab = (params.get('tab') as 'brands' | 'roles' | 'activity') || 'roles'
  if (me.me && !me.canPlatform('access.manage')) {
    return <div className="page"><Empty title="Platform Admins only">Ask a Platform Admin to change brands or roles.</Empty></div>
  }
  return (
    <div className="page wide">
      <PageHead title="Access" subtitle="Brands, who can do what, and an activity trail. People sign in with Databricks; roles decide what they can change." />
      <div className="tabs">
        {(['roles', 'brands', 'activity'] as const).map((t) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setParams({ tab: t })}>
            {t === 'roles' ? 'Roles' : t === 'brands' ? 'Brands' : 'Activity'}
          </button>
        ))}
      </div>
      {tab === 'roles' ? <RolesTab /> : tab === 'brands' ? <BrandsTab /> : <ActivityTab />}
    </div>
  )
}
