import { useEffect, useState } from 'react'

export type Theme = 'system' | 'light' | 'dark'
const KEY = 'mm-cdp-theme'

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

const ICONS: Record<Theme, string> = {
  system: 'M4 5h16v11H4zM8 20h8M12 16v4',
  light: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  dark: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
}
const LABELS: Record<Theme, string> = { system: 'Match system', light: 'Light', dark: 'Dark' }

export default function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(readTheme)
  useEffect(() => {
    applyTheme(theme)
    try {
      if (theme === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, theme)
    } catch {
      /* storage unavailable — the choice just won't be remembered */
    }
  }, [theme])
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Color theme">
      {(['system', 'light', 'dark'] as Theme[]).map((t) => (
        <button key={t} type="button" role="radio" aria-checked={theme === t} title={LABELS[t]} aria-label={LABELS[t]}
          className={theme === t ? 'on' : ''} onClick={() => setTheme(t)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={ICONS[t]} /></svg>
        </button>
      ))}
    </div>
  )
}
