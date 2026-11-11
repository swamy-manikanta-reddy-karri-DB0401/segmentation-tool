import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, getPersona } from '../api'
import { signOut } from './auth'
import { setPersona, useMe } from './me'
import { useAsync } from './ui'
import ThemeSwitch from './ThemeSwitch'

function initials(name: string) {
  return name.split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?'
}

/** The signed-in person: a round avatar at the top right that opens their profile, access and sign-out. */
export default function UserMenu() {
  const { me, roleLabel } = useMe()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const personas = useAsync(() => (me?.auth_mode === 'open' ? api.get<string[]>('/dev/personas') : Promise.resolve([] as string[])), [me?.auth_mode])

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])

  if (!me) return null
  const who = me.name || me.email
  return (
    <div className="um" ref={box}>
      <button className="um-btn" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label={`Account: ${who}`} title={`${who} · ${roleLabel}`}>
        {initials(who)}
      </button>
      {open && (
        <div className="um-pop" role="menu">
          <div className="um-head">
            <span className="um-avatar" aria-hidden="true">{initials(who)}</span>
            <div className="um-id">
              <strong title={who}>{who}</strong>
              <small title={me.email}>{me.email}</small>
              <span className="um-role">{roleLabel}</span>
            </div>
          </div>
          <Link to="/account" className="um-item" role="menuitem" onClick={() => setOpen(false)}>My access</Link>
          <div className="um-theme"><span>Theme</span><ThemeSwitch /></div>
          {me.auth_mode === 'open' && (
            <label className="um-persona">
              <span>Preview as</span>
              <select value={getPersona()} onChange={(e) => setPersona(e.target.value)}>
                <option value="">Me (Platform Admin)</option>
                {(personas.data ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          )}
          {me.auth_mode === 'local' && <button className="um-item" role="menuitem" onClick={() => void signOut()}>Sign out</button>}
        </div>
      )}
    </div>
  )
}
