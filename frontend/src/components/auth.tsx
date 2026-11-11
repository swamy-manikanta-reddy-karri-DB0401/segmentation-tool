import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { api, getToken, setActiveBrand, setToken } from '../api'
import type { AuthConfig } from '../api'
import '../ux/auth.css'

/** Sign out: end the session on the server, forget the token, and show the sign-in page. */
export async function signOut() {
  try { await api.post('/auth/logout') } catch { /* already signed out */ }
  setToken('')
  setActiveBrand('') // the next person on this browser starts in their own default brand
  window.dispatchEvent(new Event('auth:signed-out'))
}

function Login({ notice, onSignedIn }: { notice: string; onSignedIn: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null); setBusy(true)
    try {
      const r = await api.post<{ token: string }>('/auth/login', { email, password })
      setToken(r.token)
      onSignedIn()
    } catch (err) {
      setError((err as Error).message)
      setPassword('')
    } finally { setBusy(false) }
  }

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <img src="/mediamint-logo-ink.svg" alt="MediaMint" className="auth-logo logo-ink" />
        <img src="/mediamint-logo.svg" alt="" aria-hidden="true" className="auth-logo logo-white" />
        <h1>Sign in</h1>
        <p className="auth-sub">Customer Data Platform</p>
        {notice && !error && <div className="auth-notice" role="status">{notice}</div>}
        <label className="auth-field">
          <span>Email</span>
          <input className="input" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="auth-field">
          <span>Password</span>
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="btn primary auth-submit" type="submit" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="auth-foot">Don’t have an account? Ask an admin to add you.</p>
      </form>
    </main>
  )
}

/**
 * Shows the sign-in page when the app uses local email + password sign-in and nobody is signed in.
 * Deployed as a Databricks App (or with sign-in switched off) it renders the app straight away.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<AuthConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [signedIn, setSignedIn] = useState(() => !!getToken())
  const [notice, setNotice] = useState('')

  useEffect(() => {
    api.get<AuthConfig>('/auth/config').then(setCfg).catch((e) => setError((e as Error).message))
    const expired = () => { setNotice('Your session ended. Sign in again to continue.'); setSignedIn(false) }
    const out = () => { setNotice(''); setSignedIn(false) }
    window.addEventListener('auth:expired', expired)
    window.addEventListener('auth:signed-out', out)
    return () => { window.removeEventListener('auth:expired', expired); window.removeEventListener('auth:signed-out', out) }
  }, [])

  if (error) return <main className="auth-page"><div className="auth-card"><h1>Can’t reach the app</h1><div className="auth-error">{error}</div></div></main>
  if (!cfg) return <main className="auth-page" aria-busy="true" />
  if (cfg.mode === 'local' && !signedIn) return <Login notice={notice} onSignedIn={() => { setNotice(''); setSignedIn(true) }} />
  return <>{children}</>
}
