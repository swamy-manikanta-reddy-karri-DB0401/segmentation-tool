import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, fmt } from '../api'
import type { AuditEntry, AuthConfig, Brand, Destination, DirectoryGroup, DirectoryResult, DirectoryUser, RoleBinding, RoleInfo, UserRow } from '../api'
import { Empty, ErrorBox, Field, Modal, PageHead, Toggle, useAsync } from '../components/ui'
import { useMe } from '../components/me'
import { askConfirm, FilterChips, matches, NoResults, Pager, SearchBox, SkeletonRows, toast, usePaged, useUrlState } from '../components/kit'
import { CollectionLayout, Inspector, ListPane, ListRow, Section } from '../components/collection'
import { byRole, CAPABILITIES, pickOrder, PLATFORM_CAPS, ROLE_TONE, roleRank } from '../ux/capabilities'
import '../ux/access.css'
import '../ux/auth.css'

const ACTION_LABEL: Record<string, string> = {
  create: 'created', update: 'changed', delete: 'deleted', approve: 'approved', reject: 'sent back', run: 'ran',
  pause: 'paused', resume: 'resumed', grant: 'granted', revoke: 'revoked', mute: 'muted', unmute: 'unmuted',
}
const ACTION_TONE: Record<string, string> = { approve: 'green', grant: 'green', resume: 'green', reject: 'red', delete: 'red', revoke: 'red', run: 'blue', pause: 'amber', mute: 'amber' }

const initials = (s: string) => s.split(/[@.\s_-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'
const objectName = (o: string) => o.replace(/_/g, ' ')

type Principal = { key: string; type: 'user' | 'group'; name: string; grants: RoleBinding[] }

function PrincipalIcon({ p, size = 34 }: { p: Pick<Principal, 'type' | 'name'>; size?: number }) {
  if (p.type === 'group') {
    return (
      <span className="ac-icon group" style={{ width: size, height: size }} aria-hidden="true">
        <svg viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </span>
    )
  }
  return <span className="ac-icon user" style={{ width: size, height: size, fontSize: size * 0.36 }} aria-hidden="true">{initials(p.name)}</span>
}

function RoleChip({ role, label }: { role: string; label: string }) {
  return <span className={`ac-role ${ROLE_TONE[role] ?? 'gray'}`}>{label}</span>
}

// ---- grant role ------------------------------------------------------------------------------

/**
 * Pick a Databricks user (or group) from the workspace directory: a searchable dropdown that narrows as you
 * type. If the directory can't be read the admin sees why and can still type an email or group name.
 */
function DirectoryInput({ kind, value, onChange, placeholder }: { kind: 'users' | 'groups'; value: string; onChange: (v: string) => void; placeholder: string }) {
  const [items, setItems] = useState<{ value: string; label: string }[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let stop = false
    const t = setTimeout(() => {
      api.get<DirectoryResult<DirectoryUser & DirectoryGroup>>(`/directory/${kind}?q=${encodeURIComponent(value)}`)
        .then((r) => {
          if (stop) return
          setError(r.error)
          setItems(r.items.map((i) => (kind === 'users' ? { value: i.email, label: i.name } : { value: i.name, label: '' })))
        })
        .catch((e) => { if (!stop) setError((e as Error).message) })
    }, 250)
    return () => { stop = true; clearTimeout(t) }
  }, [kind, value])
  const id = `ac-dir-${kind}`
  return (
    <>
      <input className="input" value={value} autoFocus list={id} autoComplete="off" onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      <datalist id={id}>{items.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}</datalist>
      {error
        ? <div className="small" style={{ color: 'var(--amber)' }}>{error} You can still type {kind === 'users' ? 'an email' : 'a group name'}.</div>
        : <div className="small muted">Start typing to search your Databricks {kind === 'users' ? 'users by name or email' : 'groups'}.</div>}
    </>
  )
}

function GrantModal({ roles, brands, dests, preset, local, users, onClose, onSaved }: {
  roles: RoleInfo[]; brands: Brand[]; dests: Destination[]; preset?: { type: 'user' | 'group'; name: string }
  /** Sign-in is by email + password here (not Databricks): grants go to people, not groups. */
  local?: boolean; users?: string[]
  onClose: () => void; onSaved: (key: string) => void
}) {
  const [ptype, setPtype] = useState<'group' | 'user'>(preset?.type ?? (local ? 'user' : 'group'))
  const [principal, setPrincipal] = useState(preset?.name ?? '')
  const [role, setRole] = useState('viewer')
  const [brandId, setBrandId] = useState<number | ''>(brands[0]?.id ?? '')
  const [destIds, setDestIds] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const platform = role === 'platform_admin'
  const brandDests = dests.filter((d) => d.brand_id == null || d.brand_id === brandId)
  const ordered = pickOrder(roles)
  const limitsDestinations = !platform && !!roles.find((r) => r.role === role)?.permissions.includes('syncs.run')
  const invalid = !principal.trim() ? (ptype === 'group' ? 'Enter the Databricks group name' : 'Enter the person’s email')
    : ptype === 'user' && !principal.includes('@') ? (local ? 'Use the email of their account' : 'Use the email they sign in to Databricks with') : null
  const save = async () => {
    setError(null); setSaving(true)
    try {
      await api.post('/role-bindings', { principal_type: ptype, principal: principal.trim(), role, brand_id: platform ? null : brandId || null,
                                         destination_ids: limitsDestinations ? destIds : [] })
      toast(`${roles.find((r) => r.role === role)?.label ?? 'Role'} granted to ${principal.trim()}`)
      onSaved(`${ptype}:${ptype === 'user' ? principal.trim().toLowerCase() : principal.trim()}`)
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  return (
    <Modal wide title="Grant a role" subtitle={local ? 'A person can hold several roles, on one brand or many. What they can do is everything their roles allow, combined.'
      : 'Grant roles to Databricks groups so access follows group membership — people join or leave in Databricks, not here.'}
      onClose={onClose} footer={<>
        {invalid && principal && <span className="small" style={{ color: 'var(--amber)' }}>{invalid}</span>}
        <span className="grow" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={!!invalid || saving}>{saving ? 'Granting…' : 'Grant role'}</button>
      </>}>
      <div className="ac-grant">
        <div className="stack" style={{ gap: 16 }}>
          <Field label="Who">
            {!local && <Toggle value={ptype} onChange={(v) => setPtype(v)} options={[{ value: 'group', label: 'Databricks group' }, { value: 'user', label: 'One person' }]} />}
            {local ? (
              <>
                <input className="input" value={principal} autoFocus list="ac-user-emails" onChange={(e) => setPrincipal(e.target.value)} placeholder="e.g. jane.doe@company.com" />
                <datalist id="ac-user-emails">{(users ?? []).map((u) => <option key={u} value={u} />)}</datalist>
              </>
            ) : (
              <DirectoryInput key={ptype} kind={ptype === 'group' ? 'groups' : 'users'} value={principal} onChange={setPrincipal}
                placeholder={ptype === 'group' ? 'e.g. cnbc-marketing-admins' : 'e.g. jane.doe@company.com'} />
            )}
          </Field>
          {!platform && (
            <Field label="On which brand" help="They only see brands they have a role on.">
              <select className="input" value={brandId} onChange={(e) => { setBrandId(e.target.value ? Number(e.target.value) : ''); setDestIds([]) }}>
                {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                <option value="">Every brand</option>
              </select>
            </Field>
          )}
          {limitsDestinations && (
            <Field label="Destinations they may run syncs to" help="Leave all unticked to allow every destination of the brand.">
              {brandDests.length ? (
                <div className="ac-checks">
                  {brandDests.map((d) => (
                    <label key={d.id} className={destIds.includes(d.id) ? 'on' : ''}>
                      <input type="checkbox" checked={destIds.includes(d.id)}
                        onChange={(e) => setDestIds(e.target.checked ? [...destIds, d.id] : destIds.filter((x) => x !== d.id))} />
                      {d.name}
                    </label>
                  ))}
                </div>
              ) : <div className="small muted">This brand has no destinations yet.</div>}
            </Field>
          )}
        </div>
        <fieldset className="ac-role-pick">
          <legend>Role</legend>
          {ordered.map((r) => (
            <label key={r.role} className={`ac-role-card ${role === r.role ? 'on' : ''}`}>
              <input type="radio" name="role" value={r.role} checked={role === r.role} onChange={() => setRole(r.role)} />
              <span className="ac-role-card-body">
                <span className="row" style={{ gap: 8 }}><strong>{r.label}</strong>{r.role === 'platform_admin' && <span className="ac-tag">all brands</span>}</span>
                <small>{r.description}</small>
              </span>
            </label>
          ))}
        </fieldset>
      </div>
      <ErrorBox error={error} />
    </Modal>
  )
}

/** Capability matrix: rows = what you can do, columns = roles. */
function RoleMatrix({ roles, onClose }: { roles: RoleInfo[]; onClose: () => void }) {
  const ordered = [...roles].sort(byRole)
  const has = (r: RoleInfo, perm: string) => r.role === 'platform_admin' || r.permissions.includes(perm)
  return (
    <Modal wide title="What each role can do" subtitle="Roles are granted per brand. Platform Admins can do everything, on every brand." onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="table-wrap">
        <table className="table ac-matrix">
          <thead><tr><th>Can…</th>{ordered.map((r) => <th key={r.role} className="c"><RoleChip role={r.role} label={r.label} /></th>)}</tr></thead>
          <tbody>
            {CAPABILITIES.map((c) => (
              <tr key={c.perm}><td>{c.label}</td>{ordered.map((r) => <td key={r.role} className="c">{has(r, c.perm) ? <span className="ac-yes" aria-label="Yes">✓</span> : <span className="ac-no" aria-label="No">—</span>}</td>)}</tr>
            ))}
            {PLATFORM_CAPS.map((c) => (
              <tr key={c}><td>{c}</td>{ordered.map((r) => <td key={r.role} className="c">{r.role === 'platform_admin' ? <span className="ac-yes">✓</span> : <span className="ac-no">—</span>}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}

// ---- people & groups -------------------------------------------------------------------------

function GrantCard({ b, info, destName, onRevoke }: { b: RoleBinding; info?: RoleInfo; destName: (id: number) => string; onRevoke: () => void }) {
  const platform = b.role === 'platform_admin'
  const perms = new Set(info?.permissions ?? [])
  return (
    <div className="ac-grant-card">
      <div className="ac-grant-head">
        <div style={{ minWidth: 0 }}>
          <div className="ac-grant-scope">{platform ? 'Platform' : b.brand_name ?? 'Every brand'}</div>
          <RoleChip role={b.role} label={info?.label ?? b.role} />
        </div>
        <button className="btn ghost sm danger" onClick={onRevoke}>Revoke</button>
      </div>
      <ul className="ac-caps">
        {CAPABILITIES.filter((c) => platform || perms.has(c.perm)).map((c) => (
          <li key={c.perm} className="yes"><span aria-hidden="true">✓</span>{c.label}
            {c.perm === 'syncs.run' && b.destination_ids.length > 0 && <em> — only to {b.destination_ids.map(destName).join(', ')}</em>}</li>
        ))}
        {platform && PLATFORM_CAPS.map((c) => <li key={c} className="yes"><span aria-hidden="true">✓</span>{c}</li>)}
      </ul>
      {!platform && CAPABILITIES.some((c) => !perms.has(c.perm)) && (
        <div className="ac-cant"><span>Can’t</span>{CAPABILITIES.filter((c) => !perms.has(c.perm)).map((c) => c.label.charAt(0).toLowerCase() + c.label.slice(1)).join(' · ')}</div>
      )}
      <div className="ac-grant-foot">Granted {b.created_by ? `by ${b.created_by} ` : ''}{fmt.ago(b.created_at)}</div>
    </div>
  )
}

function summary(p: Principal, roleLabel: (r: string) => string): string {
  const parts = [...p.grants].sort((a, b) => roleRank(a.role) - roleRank(b.role))
    .map((g) => g.role === 'platform_admin' ? 'Platform Admin on everything' : `${roleLabel(g.role)} for ${g.brand_name ?? 'every brand'}`)
  const who = p.type === 'group' ? 'Everyone in this Databricks group is' : 'This person is'
  return `${who} ${parts.join(', ')}.`
}

function PeopleTab({ openMatrix }: { openMatrix: () => void }) {
  const bindings = useAsync(() => api.get<RoleBinding[]>('/role-bindings'))
  const roles = useAsync(() => api.get<RoleInfo[]>('/roles'))
  const brands = useAsync(() => api.get<Brand[]>('/brands'))
  const dests = useAsync(() => api.get<Destination[]>('/destinations'))
  const { me } = useMe()
  const local = me?.auth_mode === 'local'
  const users = useAsync(() => (local ? api.get<UserRow[]>('/users') : Promise.resolve([] as UserRow[])), [local])
  const userEmails = (users.data ?? []).map((u) => u.email)
  const [q, setQ] = useUrlState('q')
  const [kind, setKind] = useUrlState('kind', 'all')
  const [roleF, setRoleF] = useUrlState('role')
  const [brandF, setBrandF] = useUrlState('brand')
  const [sel, setSel] = useUrlState('who')
  const [grant, setGrant] = useState<{ preset?: { type: 'user' | 'group'; name: string } } | null>(null)
  const label = (r: string) => roles.data?.find((x) => x.role === r)?.label ?? r
  const destName = (id: number) => dests.data?.find((d) => d.id === id)?.name ?? `#${id}`

  const principals = useMemo(() => {
    const map = new Map<string, Principal>()
    for (const b of bindings.data ?? []) {
      const key = `${b.principal_type}:${b.principal}`
      if (!map.has(key)) map.set(key, { key, type: b.principal_type, name: b.principal, grants: [] })
      map.get(key)!.grants.push(b)
    }
    return [...map.values()].sort((a, b) => Number(a.type === 'user') - Number(b.type === 'user') || a.name.localeCompare(b.name))
  }, [bindings.data])
  const rows = principals.filter((p) => matches(q, p.name, ...p.grants.map((g) => g.brand_name))
    && (kind === 'all' || p.type === kind)
    && (!roleF || p.grants.some((g) => g.role === roleF))
    && (!brandF || p.grants.some((g) => (brandF === 'all' ? g.brand_id == null : String(g.brand_id) === brandF))))
  const paged = usePaged(rows, 25, `${q}|${kind}|${roleF}|${brandF}`)
  const selected = principals.find((p) => p.key === sel)
  const filtered = !!(q || kind !== 'all' || roleF || brandF)

  const revoke = async (b: RoleBinding) => {
    const p = principals.find((x) => x.key === `${b.principal_type}:${b.principal}`)
    const last = (p?.grants.length ?? 0) <= 1
    if (!await askConfirm({ title: `Revoke ${label(b.role)} from ${b.principal}?`, confirmLabel: 'Revoke role', danger: true,
      body: <>{b.principal_type === 'group' ? 'Everyone in this Databricks group' : 'They'} lose{b.principal_type === 'group' ? 's' : ''} this role within 5 minutes.
        {last && <> This is their only role — they won’t see {b.role === 'platform_admin' ? 'anything' : b.brand_name ?? 'any brand'} any more.</>}</> })) return
    try { await api.del(`/role-bindings/${b.id}`); bindings.reload(); toast('Role revoked') } catch (e) { toast((e as Error).message, 'error') }
  }

  if (bindings.loading && !bindings.data) return <SkeletonRows rows={6} cols={3} />
  if (!principals.length) {
    return (
      <div className="card">
        <Empty title="Nobody has a role yet" action={<button className="btn primary" onClick={() => setGrant({})} disabled={!roles.data || !brands.data}>Grant the first role</button>}>
          {local
            ? <>Add people under <b>Users</b>, then grant them roles here, on one brand or several. Admins already have full access to every brand.</>
            : <>Grant roles to Databricks groups — e.g. “cnbc-marketing-admins” → Brand Marketing Admin for CNBC — so access follows your workspace’s group membership.
              Platform Admins listed in the app’s configuration already have full access.</>}
        </Empty>
        {grant && roles.data && brands.data && <GrantModal roles={roles.data} brands={brands.data} dests={dests.data ?? []} local={local} users={userEmails} onClose={() => setGrant(null)}
          onSaved={(k) => { setGrant(null); bindings.reload(); setSel(k) }} />}
      </div>
    )
  }

  return (<>
    <ErrorBox error={bindings.error} />
    <CollectionLayout open={!!selected} onClose={() => setSel('')}
      list={
        <ListPane title="People & groups" count={principals.length}
          actions={<button className="btn ghost sm" onClick={openMatrix}>Role guide</button>}
          toolbar={<>
            <SearchBox value={q} onChange={setQ} placeholder="Search names, emails, brands…" />
            <FilterChips label="Type" value={kind as 'all' | 'group' | 'user'} onChange={setKind} options={[
              { value: 'all', label: 'All', count: principals.length },
              { value: 'group', label: 'Groups', count: principals.filter((p) => p.type === 'group').length },
              { value: 'user', label: 'People', count: principals.filter((p) => p.type === 'user').length },
            ]} />
            <select className="input sm ac-select" value={roleF} onChange={(e) => setRoleF(e.target.value)} aria-label="Role">
              <option value="">Any role</option>
              {[...(roles.data ?? [])].sort(byRole).map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
            </select>
            {(brands.data?.length ?? 0) > 1 && (
              <select className="input sm ac-select" value={brandF} onChange={(e) => setBrandF(e.target.value)} aria-label="Brand">
                <option value="">Any brand</option>
                {(brands.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                <option value="all">Every brand / platform</option>
              </select>
            )}
          </>}
          footer={<Pager page={paged.page} pages={paged.pages} total={rows.length} pageSize={25} onPage={paged.setPage} noun={kind === 'group' ? 'group' : kind === 'user' ? 'person' : 'principal'} />}>
          {paged.slice.map((p) => {
            const roleSet = [...new Set(p.grants.map((g) => g.role))].sort((a, b) => roleRank(a) - roleRank(b))
            const brandsList = [...new Set(p.grants.map((g) => (g.role === 'platform_admin' ? 'Platform' : g.brand_name ?? 'Every brand')))]
            return (
              <ListRow key={p.key} selected={selected?.key === p.key} onSelect={() => setSel(p.key)} leading={<PrincipalIcon p={p} />}
                title={p.name} subtitle={`${p.type === 'group' ? 'Databricks group' : 'Person'} · ${brandsList.join(', ')}`}
                meta={<span className="ac-row-roles">{roleSet.slice(0, 2).map((r) => <RoleChip key={r} role={r} label={label(r)} />)}{roleSet.length > 2 && <span className="ac-more">+{roleSet.length - 2}</span>}</span>} />
            )
          })}
          {!rows.length && filtered && <NoResults what="people or groups" onClear={() => { setQ(''); setKind('all'); setRoleF(''); setBrandF('') }} />}
        </ListPane>
      }
      inspector={selected ? (
        <Inspector icon={<PrincipalIcon p={selected} size={44} />} kicker={selected.type === 'group' ? 'Databricks group' : 'Person'} title={selected.name}
          sentence={summary(selected, label)}
          actions={<button className="btn sm primary" onClick={() => setGrant({ preset: { type: selected.type, name: selected.name } })} disabled={!roles.data || !brands.data}>+ Add role</button>}>
          {selected.type === 'group' && (
            <div className="ac-note">Membership is managed in Databricks. Add or remove people there — they pick up these roles within 5 minutes.</div>
          )}
          <Section title={`Access ${selected.grants.length > 1 ? `· ${selected.grants.length} roles` : ''}`}>
            <div className="stack" style={{ gap: 10 }}>
              {[...selected.grants].sort((a, b) => roleRank(a.role) - roleRank(b.role)).map((g) => (
                <GrantCard key={g.id} b={g} info={roles.data?.find((r) => r.role === g.role)} destName={destName} onRevoke={() => revoke(g)} />
              ))}
            </div>
          </Section>
        </Inspector>
      ) : <Inspector empty={<div>Select a person or group to see what they can do.</div>} />} />
    {grant && roles.data && brands.data && (
      <GrantModal roles={roles.data} brands={brands.data} dests={dests.data ?? []} preset={grant.preset} local={local} users={userEmails} onClose={() => setGrant(null)}
        onSaved={(k) => { setGrant(null); bindings.reload(); setSel(k) }} />
    )}
  </>)
}

// ---- users (email + password sign-in) ------------------------------------------------------------

function UserModal({ existing, min, onClose, onSaved }: { existing?: UserRow; min: number; onClose: () => void; onSaved: () => void }) {
  const [email, setEmail] = useState(existing?.email ?? '')
  const [name, setName] = useState(existing?.name ?? '')
  const [password, setPassword] = useState('')
  const [admin, setAdmin] = useState(existing?.is_admin ?? false)
  const [active, setActive] = useState(existing?.active ?? true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const short = password.length > 0 && password.length < min
  const invalid = existing ? short : !email.includes('@') || password.length < min
  const save = async () => {
    setError(null); setSaving(true)
    try {
      if (existing) {
        await api.put(`/users/${existing.id}`, { name, is_admin: admin, active, ...(password ? { password } : {}) })
        toast(password ? 'Saved. They’ll be signed out and need the new password.' : 'User updated')
      } else {
        await api.post('/users', { email, name, password, is_admin: admin })
        toast(`${email.trim().toLowerCase()} can now sign in. Give them a role so they can see a brand.`)
      }
      onSaved()
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  return (
    <Modal title={existing ? `Edit ${existing.name || existing.email}` : 'Add a user'}
      subtitle={existing ? existing.email : 'They sign in with this email and password. Add roles afterwards to give them access to brands.'}
      onClose={onClose} footer={<>
        {short && <span className="small" style={{ color: 'var(--amber)' }}>Use at least {min} characters</span>}
        <span className="grow" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={invalid || saving}>{saving ? 'Saving…' : existing ? 'Save' : 'Add user'}</button>
      </>}>
      <div className="stack" style={{ gap: 14 }}>
        {!existing && <Field label="Email"><input className="input" type="email" autoFocus value={email} placeholder="jane.doe@company.com" onChange={(e) => setEmail(e.target.value)} /></Field>}
        <Field label="Name (optional)"><input className="input" value={name} placeholder="Jane Doe" onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={existing ? 'New password' : 'Password'} help={existing ? 'Leave empty to keep the current one. Setting one signs them out everywhere.' : `At least ${min} characters. They can change it under My access.`}>
          <input className="input" type="text" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <label className="rl-perm" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
          <span><b>Admin</b><small>Full access to every brand, and can manage users, roles, brands and settings.</small></span>
        </label>
        {existing && (
          <label className="rl-perm" style={{ alignItems: 'center' }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            <span><b>Can sign in</b><small>Untick to switch the account off without deleting it.</small></span>
          </label>
        )}
        <ErrorBox error={error} />
      </div>
    </Modal>
  )
}

function UsersTab({ min }: { min: number }) {
  const users = useAsync(() => api.get<UserRow[]>('/users'))
  const roles = useAsync(() => api.get<RoleInfo[]>('/roles'))
  const brands = useAsync(() => api.get<Brand[]>('/brands'))
  const dests = useAsync(() => api.get<Destination[]>('/destinations'))
  const { me } = useMe()
  const [, setParams] = useSearchParams()
  const [q, setQ] = useUrlState('q')
  const [modal, setModal] = useState<{ existing?: UserRow } | null>(null)
  const [grant, setGrant] = useState<UserRow | null>(null)
  const rows = (users.data ?? []).filter((u) => matches(q, u.email, u.name, ...u.roles.map((r) => r.label), ...u.roles.map((r) => r.brand_name)))

  const remove = async (u: UserRow) => {
    if (!await askConfirm({ title: `Delete ${u.email}?`, confirmLabel: 'Delete user', danger: true,
      body: 'Their account and all of their role grants are removed. This can’t be undone.' })) return
    try { await api.del(`/users/${u.id}`); users.reload(); toast(`${u.email} deleted`) } catch (e) { toast((e as Error).message, 'error') }
  }

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="ac-bar">
        <SearchBox value={q} onChange={setQ} placeholder="Search people, roles, brands…" />
        <span className="grow" />
        <button className="btn primary" onClick={() => setModal({})}>+ Add user</button>
      </div>
      <ErrorBox error={users.error} />
      {users.loading && !users.data ? <SkeletonRows rows={4} cols={4} /> : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>User</th><th>Access</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="row" style={{ gap: 10 }}>
                      <PrincipalIcon p={{ type: 'user', name: u.name || u.email }} />
                      <div style={{ minWidth: 0 }}><strong>{u.name || u.email.split('@')[0]}</strong>{u.email === me?.email && <span className="muted"> (you)</span>}<div className="small muted">{u.email}</div></div>
                    </div>
                  </td>
                  <td style={{ whiteSpace: 'normal' }}>
                    <span className="us-flags">
                      {u.is_admin && <span className="ac-role violet">Admin · every brand</span>}
                      {u.roles.map((r) => <span key={r.id} className={`ac-role ${ROLE_TONE[r.role] ?? 'gray'}`}>{r.label} · {r.brand_name ?? 'every brand'}</span>)}
                      {!u.is_admin && !u.roles.length && <span className="small muted">No role yet. They can’t see any brand.</span>}
                    </span>
                  </td>
                  <td>
                    <span className="us-flags">{u.active ? <span className="small">Active</span> : <span className="us-off">Off</span>}</span>
                    <div className="small muted">{u.last_login_at ? `Signed in ${fmt.ago(u.last_login_at)}` : 'Never signed in'}</div>
                  </td>
                  <td>
                    <span className="us-actions">
                      <button className="btn ghost sm" onClick={() => setGrant(u)} disabled={!roles.data || !brands.data}>+ Role</button>
                      {u.roles.length > 0 && <button className="btn ghost sm" onClick={() => setParams({ tab: 'people', who: `user:${u.email}` })}>Manage roles</button>}
                      <button className="btn ghost sm" onClick={() => setModal({ existing: u })}>Edit</button>
                      <button className="btn ghost sm danger" onClick={() => remove(u)} disabled={u.email === me?.email}>Delete</button>
                    </span>
                  </td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={4}><NoResults what="users" onClear={() => setQ('')} /></td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {modal && <UserModal existing={modal.existing} min={min} onClose={() => setModal(null)} onSaved={() => { setModal(null); users.reload() }} />}
      {grant && roles.data && brands.data && (
        <GrantModal local roles={roles.data} brands={brands.data} dests={dests.data ?? []} preset={{ type: 'user', name: grant.email }} users={(users.data ?? []).map((u) => u.email)}
          onClose={() => setGrant(null)} onSaved={() => { setGrant(null); users.reload() }} />
      )}
    </div>
  )
}

// ---- custom roles --------------------------------------------------------------------------------

function RoleModal({ existing, onClose, onSaved }: { existing?: RoleInfo; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(existing?.label ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [perms, setPerms] = useState<string[]>(existing?.permissions ?? ['view'])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setError(null); setSaving(true)
    try {
      if (existing) await api.put(`/roles/${existing.role}`, { label, description, permissions: perms })
      else await api.post('/roles', { label, description, permissions: perms })
      toast(existing ? 'Role updated. Everyone with it gets the change straight away.' : `Role ${label.trim()} created. Grant it to people from Users.`)
      onSaved()
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  return (
    <Modal wide title={existing ? `Edit ${existing.label}` : 'New role'} subtitle="Pick exactly what this role allows. It’s granted per brand, and a person can hold several roles."
      onClose={onClose} footer={<>
        <span className="grow" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={!label.trim() || saving}>{saving ? 'Saving…' : existing ? 'Save' : 'Create role'}</button>
      </>}>
      <div className="stack" style={{ gap: 14 }}>
        <Field label="Role name"><input className="input" autoFocus value={label} placeholder="e.g. Audience reviewer" onChange={(e) => setLabel(e.target.value)} /></Field>
        <Field label="Description (optional)"><input className="input" value={description} placeholder="What this role is for" onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="What it can do">
          <div className="rl-perms">
            {CAPABILITIES.map((c) => {
              const locked = c.perm === 'view'
              const on = locked || perms.includes(c.perm)
              return (
                <label key={c.perm} className={`rl-perm ${on ? 'on' : ''} ${locked ? 'locked' : ''}`}>
                  <input type="checkbox" checked={on} disabled={locked}
                    onChange={(e) => setPerms(e.target.checked ? [...perms, c.perm] : perms.filter((p) => p !== c.perm))} />
                  <span>{c.label}{locked && <small>Always included. Without it the person couldn’t see the brand.</small>}</span>
                </label>
              )
            })}
          </div>
        </Field>
        <div className="small muted">Managing users, roles, brands, sources and the data model stay with admins. A role can’t grant those.</div>
        <ErrorBox error={error} />
      </div>
    </Modal>
  )
}

function RolesTab() {
  const roles = useAsync(() => api.get<RoleInfo[]>('/roles'))
  const [modal, setModal] = useState<{ existing?: RoleInfo } | null>(null)
  const list = [...(roles.data ?? [])].sort(byRole)
  const remove = async (r: RoleInfo) => {
    if (!await askConfirm({ title: `Delete the role “${r.label}”?`, confirmLabel: 'Delete role', danger: true,
      body: 'A role that is still granted to someone can’t be deleted. Revoke those grants first.' })) return
    try { await api.del(`/roles/${r.role}`); roles.reload(); toast(`${r.label} deleted`) } catch (e) { toast((e as Error).message, 'error') }
  }
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="ac-bar">
        <span className="small muted">Built-in roles are fixed. Create your own for any other mix of permissions.</span>
        <span className="grow" />
        <button className="btn primary" onClick={() => setModal({})}>+ New role</button>
      </div>
      <ErrorBox error={roles.error} />
      {roles.loading && !roles.data ? <SkeletonRows rows={3} cols={3} /> : (
        <div className="rl-cards">
          {list.map((r) => {
            const perms = new Set(r.permissions)
            const platform = r.role === 'platform_admin'
            return (
              <article key={r.role} className="card rl-card">
                <header><RoleChip role={r.role} label={r.label} />{r.custom ? <span className="ac-tag">custom</span> : <span className="small muted">built-in</span>}</header>
                {r.description && <p>{r.description}</p>}
                <ul className="ac-caps" style={{ padding: 0 }}>
                  {CAPABILITIES.filter((c) => platform || perms.has(c.perm)).map((c) => <li key={c.perm} className="yes"><span aria-hidden="true">✓</span>{c.label}</li>)}
                  {platform && PLATFORM_CAPS.map((c) => <li key={c} className="yes"><span aria-hidden="true">✓</span>{c}</li>)}
                </ul>
                {r.custom && (
                  <footer>
                    <button className="btn ghost sm" onClick={() => setModal({ existing: r })}>Edit</button>
                    <button className="btn ghost sm danger" onClick={() => remove(r)}>Delete</button>
                  </footer>
                )}
              </article>
            )
          })}
        </div>
      )}
      {modal && <RoleModal existing={modal.existing} onClose={() => setModal(null)} onSaved={() => { setModal(null); roles.reload() }} />}
    </div>
  )
}

// ---- brands ------------------------------------------------------------------------------------

function BrandModal({ existing, onClose, onSaved }: { existing?: Brand; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setError(null)
    try {
      if (existing) await api.put(`/brands/${existing.id}`, { name, description })
      else await api.post('/brands', { name, description })
      toast(existing ? 'Brand updated' : `Brand ${name} created`)
      onSaved()
    } catch (e) { setError((e as Error).message) }
  }
  return (
    <Modal title={existing ? `Edit ${existing.name}` : 'New brand'} subtitle="Each brand has its own parent models, destinations, audiences and syncs. People only see brands they have a role on."
      onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={!name.trim()}>{existing ? 'Save' : 'Create brand'}</button></>}>
      <Field label="Name"><input className="input" value={name} autoFocus placeholder="e.g. CNBC" onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Description (optional)"><input className="input" value={description} placeholder="e.g. Business news — US" onChange={(e) => setDescription(e.target.value)} /></Field>
      <ErrorBox error={error} />
    </Modal>
  )
}

function BrandsTab() {
  const brands = useAsync(() => api.get<Brand[]>('/brands'))
  const bindings = useAsync(() => api.get<RoleBinding[]>('/role-bindings'))
  const [modal, setModal] = useState<{ existing?: Brand } | null>(null)
  const [q, setQ] = useUrlState('q')
  const [, setParams] = useSearchParams()
  const people = (id: number) => new Set((bindings.data ?? []).filter((b) => b.brand_id === id).map((b) => `${b.principal_type}:${b.principal}`)).size
  const remove = async (b: Brand) => {
    if (!await askConfirm({ title: `Delete the brand “${b.name}”?`, confirmLabel: 'Delete brand', danger: true,
      body: 'Role grants on this brand are removed too. A brand that still has parent models or destinations can’t be deleted — move or remove them first.' })) return
    try { await api.del(`/brands/${b.id}`); brands.reload(); bindings.reload(); toast(`${b.name} deleted`) } catch (e) { toast((e as Error).message, 'error') }
  }
  const rows = (brands.data ?? []).filter((b) => matches(q, b.name, b.description))
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="ac-bar">
        {(brands.data?.length ?? 0) > 6 && <SearchBox value={q} onChange={setQ} placeholder={`Search ${brands.data!.length} brands…`} />}
        <span className="grow" />
        <button className="btn primary" onClick={() => setModal({})}>+ New brand</button>
      </div>
      <ErrorBox error={brands.error} />
      {brands.loading && !brands.data ? <SkeletonRows rows={3} cols={3} /> : (
        <div className="ac-brands">
          {rows.map((b) => (
            <article key={b.id} className="card ac-brand">
              <header>
                <span className="ac-brand-mark" aria-hidden="true">{initials(b.name)}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <h3 className="dm-ellipsis" title={b.name}>{b.name}</h3>
                  <small className="dm-ellipsis">{b.description || `Created ${fmt.ago(b.created_at)}`}</small>
                </div>
              </header>
              <div className="ac-brand-stats">
                <div><strong>{b.parent_count ?? 0}</strong><span>Parent model{b.parent_count === 1 ? '' : 's'}</span></div>
                <div><strong>{b.destination_count ?? 0}</strong><span>Destination{b.destination_count === 1 ? '' : 's'}</span></div>
                <button className="ac-brand-people" onClick={() => setParams({ tab: 'people', brand: String(b.id) })} title="See who has access">
                  <strong>{people(b.id)}</strong><span>People →</span>
                </button>
              </div>
              <footer>
                <button className="btn ghost sm" onClick={() => setModal({ existing: b })}>Edit</button>
                <button className="btn ghost sm danger" onClick={() => remove(b)}>Delete</button>
              </footer>
            </article>
          ))}
          {!q && (
            <button className="ac-brand ac-brand-new" onClick={() => setModal({})}>
              <span aria-hidden="true">+</span><strong>New brand</strong><small>e.g. CNBC, GolfNow, Fandango</small>
            </button>
          )}
        </div>
      )}
      {q && !rows.length && <NoResults what="brands" onClear={() => setQ('')} />}
      {modal && <BrandModal existing={modal.existing} onClose={() => setModal(null)} onSaved={() => { setModal(null); brands.reload() }} />}
    </div>
  )
}

// ---- activity ----------------------------------------------------------------------------------

function sentence(r: AuditEntry): ReactNode {
  const d = r.details as Record<string, unknown>
  const name = (d.name as string) || (d.principal as string) || (r.object_id != null ? `#${r.object_id}` : '')
  const verb = ACTION_LABEL[r.action] ?? r.action
  if (r.action === 'grant' || r.action === 'revoke') {
    return <><b>{r.actor}</b> {verb} <b>{String(d.role ?? '').replace(/_/g, ' ')}</b> {r.action === 'grant' ? 'to' : 'from'} <b>{String(d.principal ?? '')}</b></>
  }
  return <><b>{r.actor}</b> {verb} the {objectName(r.object_type)} {name && <b>{name}</b>}</>
}

function extra(r: AuditEntry): string {
  const d = r.details as Record<string, unknown>
  const skip = new Set(['name', 'principal', 'role'])
  return Object.entries(d).filter(([k, v]) => !skip.has(k) && v !== '' && v != null && v !== false)
    .map(([k, v]) => (k === 'note' ? `“${v}”` : `${k.replace(/_/g, ' ')}: ${v === true ? 'yes' : String(v)}`)).join(' · ')
}

function dayLabel(iso: string) {
  const d = new Date(iso), today = new Date()
  const y = new Date(today); y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

function ActivityTab() {
  const log = useAsync(() => api.get<AuditEntry[]>('/audit?limit=500'))
  const me = useMe()
  const [q, setQ] = useUrlState('q')
  const [action, setAction] = useUrlState('action', 'all')
  const [kind, setKind] = useUrlState('object')
  const all = useMemo(() => [...(log.data ?? [])].sort((a, b) => b.at.localeCompare(a.at)), [log.data])
  const groupOf = (a: string) => (['approve', 'reject'].includes(a) ? 'approvals' : ['grant', 'revoke'].includes(a) ? 'access' : ['run', 'pause', 'resume', 'mute', 'unmute'].includes(a) ? 'operations' : 'changes')
  const rows = all.filter((r) => (action === 'all' || groupOf(r.action) === action) && (!kind || r.object_type === kind)
    && matches(q, r.actor, r.object_type, JSON.stringify(r.details)))
  const paged = usePaged(rows, 30, `${q}|${action}|${kind}`, 'page')
  const days: [string, AuditEntry[]][] = []
  for (const r of paged.slice) {
    const k = dayLabel(r.at)
    if (!days.length || days[days.length - 1][0] !== k) days.push([k, []])
    days[days.length - 1][1].push(r)
  }
  const count = (g: string) => all.filter((r) => groupOf(r.action) === g).length
  return (
    <div className="card ac-activity">
      <div className="ac-activity-tools">
        <SearchBox value={q} onChange={setQ} placeholder="Search people, names, notes…" />
        <FilterChips label="Kind of change" value={action as 'all' | 'changes' | 'approvals' | 'operations' | 'access'} onChange={setAction} options={[
          { value: 'all', label: 'All', count: all.length },
          { value: 'changes', label: 'Changes', count: count('changes') },
          { value: 'approvals', label: 'Approvals', count: count('approvals'), tone: 'green' },
          { value: 'operations', label: 'Runs & pauses', count: count('operations'), tone: 'blue' },
          { value: 'access', label: 'Access', count: count('access'), tone: 'violet' },
        ]} />
        <select className="input sm ac-select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Object">
          <option value="">Everything</option>
          {[...new Set(all.map((r) => r.object_type))].sort().map((o) => <option key={o} value={o}>{objectName(o)[0].toUpperCase() + objectName(o).slice(1)}s</option>)}
        </select>
      </div>
      <ErrorBox error={log.error} />
      {log.loading && !log.data ? <SkeletonRows rows={6} cols={3} /> : !all.length ? (
        <Empty title="No activity yet">Every create, approval, run and role change is recorded here, with who did it and when.</Empty>
      ) : !rows.length ? <NoResults what="activity entries" onClear={() => { setQ(''); setAction('all'); setKind('') }} /> : (
        <div className="ac-timeline">
          {days.map(([day, items]) => (
            <section key={day}>
              <h3 className="ac-day">{day}</h3>
              <ol>
                {items.map((r) => (
                  <li key={r.id} className="ac-event">
                    <span className={`ac-dot ${ACTION_TONE[r.action] ?? ''}`} aria-hidden="true" />
                    <span className="ac-event-avatar" aria-hidden="true">{initials(r.actor)}</span>
                    <div className="ac-event-body">
                      <div className="ac-event-line">{sentence(r)}</div>
                      {extra(r) && <div className="ac-event-extra">{extra(r)}</div>}
                    </div>
                    <div className="ac-event-meta">
                      {r.brand_id != null && <span className="ac-brand-chip">{me.brandName(r.brand_id)}</span>}
                      <time dateTime={r.at} title={new Date(r.at).toLocaleString()}>{new Date(r.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
      {rows.length > 0 && <div className="ac-activity-foot"><Pager page={paged.page} pages={paged.pages} total={rows.length} pageSize={30} onPage={paged.setPage} noun="event" /></div>}
    </div>
  )
}

// ---- page ----------------------------------------------------------------------------------------

export default function Access() {
  const [params, setParams] = useSearchParams()
  const me = useMe()
  const [matrix, setMatrix] = useState(false)
  const roles = useAsync(() => api.get<RoleInfo[]>('/roles'))
  const cfg = useAsync(() => api.get<AuthConfig>('/auth/config'))
  const local = me.me?.auth_mode === 'local'
  const raw = params.get('tab')
  type Tab = 'users' | 'people' | 'roles' | 'brands' | 'activity'
  const known: Tab[] = ['users', 'people', 'roles', 'brands', 'activity']
  const tab: Tab = known.includes(raw as Tab) && (raw !== 'users' || local) ? (raw as Tab) : local ? 'users' : 'people'
  if (me.me && !me.canPlatform('access.manage')) {
    return <div className="page"><Empty title="Platform Admins only">Ask a Platform Admin to change users, brands or roles.</Empty></div>
  }
  const tabs: [Tab, string][] = [
    ...(local ? [['users', 'Users'] as [Tab, string]] : []),
    ['people', local ? 'Role grants' : 'People & roles'], ['roles', 'Roles'], ['brands', 'Brands'], ['activity', 'Activity'],
  ]
  return (
    <div className="page wide ac-page">
      <PageHead title="Access" subtitle={local
        ? 'Add people, give them roles on the brands they work on, and create custom roles. Admins have full access to every brand.'
        : 'Who can see and change what. People sign in with Databricks; roles are granted per brand, ideally to Databricks groups.'} />
      <div className="tabs ac-tabs" role="tablist">
        {tabs.map(([t, l]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setParams({ tab: t })}>{l}</button>
        ))}
      </div>
      {tab === 'users' ? <UsersTab min={cfg.data?.min_password ?? 8} /> : tab === 'people' ? <PeopleTab openMatrix={() => setMatrix(true)} />
        : tab === 'roles' ? <RolesTab /> : tab === 'brands' ? <BrandsTab /> : <ActivityTab />}
      {matrix && roles.data && <RoleMatrix roles={roles.data} onClose={() => setMatrix(false)} />}
    </div>
  )
}
