import { useState } from 'react'
import type { FormEvent } from 'react'
import { api } from '../api'
import type { AuthConfig } from '../api'
import { ErrorBox, Field, PageHead, useAsync } from '../components/ui'
import { useMe } from '../components/me'
import { toast } from '../components/kit'
import { CAPABILITIES, PLATFORM_CAPS, ROLE_TONE } from '../ux/capabilities'
import '../ux/access.css'
import '../ux/auth.css'

function ChangePassword({ min }: { min: number }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const problem = next && next.length < min ? `Use at least ${min} characters` : again && again !== next ? 'The two new passwords differ' : null
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null); setBusy(true)
    try {
      await api.post('/auth/change-password', { current, new: next })
      setCurrent(''); setNext(''); setAgain('')
      toast('Password changed. You were signed out on other devices.')
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <form className="card me-pw" onSubmit={submit} style={{ padding: 16 }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>Change password</h3>
      <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
      <Field label="New password"><input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
      <Field label="New password again"><input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
      {problem && <div className="small" style={{ color: 'var(--amber)' }}>{problem}</div>}
      <ErrorBox error={error} />
      <div><button className="btn primary" type="submit" disabled={busy || !current || !next || !!problem || next !== again}>{busy ? 'Saving…' : 'Change password'}</button></div>
    </form>
  )
}

/** What the signed-in person can do: their roles, then the result per brand. */
export default function Account() {
  const { me } = useMe()
  const cfg = useAsync(() => api.get<AuthConfig>('/auth/config'))
  if (!me) return null
  const admin = me.platform_admin
  return (
    <div className="page wide ac-page">
      <PageHead title="My access" subtitle="Who you’re signed in as, the roles you hold, and everything they let you do." />

      <section className="card" style={{ padding: 16, marginBottom: 18 }}>
        <div className="me-id">
          <div>
            <h2>{me.name || me.email}</h2>
            <small>{me.email}</small>
          </div>
          {admin && <span className="ac-role violet">Platform Admin</span>}
          {!admin && me.roles.length === 0 && <span className="ac-role gray">No role yet</span>}
        </div>
        {admin && <div className="me-note" style={{ marginTop: 12 }}>You have full access to <b>every brand</b> and to platform settings: sources, the data model, users, roles and brands.</div>}
        {!admin && me.roles.length === 0 && <div className="me-note" style={{ marginTop: 12 }}>You can sign in, but you haven’t been given a role yet, so no brand is visible. Ask an admin to add you to a brand.</div>}
        {me.groups.length > 0 && <div className="small muted" style={{ marginTop: 10 }}>Databricks groups: {me.groups.join(', ')}</div>}
      </section>

      {admin && (
        <>
          <h2 className="section-title" style={{ fontSize: 15, margin: '0 0 10px' }}>Platform Admin</h2>
          <div className="me-grid" style={{ marginBottom: 22 }}>
            <article className="ac-grant-card">
              <div className="ac-grant-head">
                <div><div className="ac-grant-scope">Every brand</div><span className="ac-role violet">Platform Admin</span></div>
              </div>
              <ul className="ac-caps">
                {CAPABILITIES.map((c) => <li key={c.perm} className="yes"><span aria-hidden="true">✓</span>{c.label}</li>)}
                {PLATFORM_CAPS.map((c) => <li key={c} className="yes"><span aria-hidden="true">✓</span>{c}</li>)}
              </ul>
            </article>
          </div>
        </>
      )}

      {me.roles.length > 0 && (
        <>
          <h2 className="section-title" style={{ fontSize: 15, margin: '0 0 4px' }}>Your roles</h2>
          <p className="small muted" style={{ margin: '0 0 10px' }}>
            {me.roles.length > 1 ? `You hold ${me.roles.length} roles. What you can do is everything they allow, combined.` : 'The role you hold and what it allows.'}
          </p>
          <div className="me-grid" style={{ marginBottom: 22 }}>
            {me.roles.map((r, i) => {
              const perms = new Set(r.permissions)
              return (
                <article key={`${r.role}-${r.brand_id}-${i}`} className="ac-grant-card">
                  <div className="ac-grant-head">
                    <div style={{ minWidth: 0 }}>
                      <div className="ac-grant-scope">{r.brand_name ?? 'Every brand'}</div>
                      <span className={`ac-role ${ROLE_TONE[r.role] ?? 'gray'}`}>{r.label}</span>
                    </div>
                  </div>
                  <ul className="ac-caps">
                    {CAPABILITIES.filter((c) => perms.has(c.perm)).map((c) => (
                      <li key={c.perm} className="yes"><span aria-hidden="true">✓</span>{c.label}
                        {c.perm === 'syncs.run' && r.destination_ids.length > 0 && <em> — only to {r.destination_ids.length} chosen destination{r.destination_ids.length > 1 ? 's' : ''}</em>}</li>
                    ))}
                  </ul>
                  {CAPABILITIES.some((c) => !perms.has(c.perm)) && (
                    <div className="ac-cant"><span>Can’t</span>{CAPABILITIES.filter((c) => !perms.has(c.perm)).map((c) => c.label.charAt(0).toLowerCase() + c.label.slice(1)).join(' · ')}</div>
                  )}
                </article>
              )
            })}
          </div>
        </>
      )}

      {me.all_brands_access.length > 0 && (
        <>
          <h2 className="section-title" style={{ fontSize: 15, margin: '0 0 4px' }}>What you can do in each brand</h2>
          <p className="small muted" style={{ margin: '0 0 10px' }}>
            The combined result of all your roles, brand by brand. The app applies the brand you’re working in (switch it at the bottom of the sidebar).
          </p>
          <div className="me-grid" style={{ marginBottom: 22 }}>
            {me.all_brands_access.map((b) => {
              const yes = CAPABILITIES.filter((c) => b.can[c.perm as keyof typeof b.can])
              const no = CAPABILITIES.filter((c) => !b.can[c.perm as keyof typeof b.can])
              return (
                <article key={b.id} className="card me-brand">
                  <h3>{b.name}{me.active_brand_id === b.id && <span className="ac-tag" style={{ marginLeft: 8 }}>working here</span>}</h3>
                  <div>{[...new Set(me.roles.filter((r) => r.brand_id == null || r.brand_id === b.id).map((r) => r.label))].map((l) => <span key={l} className="ac-role gray">{l}</span>)}
                    {admin && <span className="ac-role violet">Platform Admin</span>}</div>
                  <ul className="ac-caps" style={{ padding: '6px 0 0' }}>
                    {yes.map((c) => <li key={c.perm} className="yes"><span aria-hidden="true">✓</span>{c.label}</li>)}
                    {no.map((c) => <li key={c.perm} className="no"><span aria-hidden="true">—</span>{c.label}</li>)}
                  </ul>
                </article>
              )
            })}
          </div>
        </>
      )}

      {cfg.data?.mode === 'local' && <ChangePassword min={cfg.data.min_password} />}
    </div>
  )
}
