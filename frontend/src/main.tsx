import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom'
import './styles.css'
import './cdp.css'
import Overview from './pages/Overview'
import Sources from './pages/Sources'
import Setup from './pages/Setup'
import Profiles from './pages/Profiles'
import Audiences from './pages/Audiences'
import AudienceBuilder from './pages/AudienceBuilder'
import Destinations from './pages/Destinations'
import Activations from './pages/Activations'
import ActivationNew from './pages/ActivationNew'
import ActivationDetail from './pages/ActivationDetail'
import Inbox from './pages/Inbox'
import Traits from './pages/Traits'
import Governance from './pages/Governance'
import ThemeSwitch from './components/ThemeSwitch'
import Access from './pages/Access'
import { MeProvider, setPersona, useMe } from './components/me'
import { api, getPersona } from './api'
import { useAsync } from './components/ui'

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
)
const I = {
  overview: 'M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 9h8V3h-8z',
  source: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  schema: 'M6 3h4v4H6zM14 17h4v4h-4zM14 3h4v4h-4zM8 7v4a2 2 0 0 0 2 2h6v4M16 7v6',
  traits: 'M4 19h16M7 16V9M12 16V5M17 16v-4',
  profiles: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  audiences: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8',
  priority: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  destinations: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z',
  syncs: 'M21 12a9 9 0 0 1-15.5 6.2M3 12a9 9 0 0 1 15.5-6.2M21 4v5h-5M3 20v-5h5',
  rules: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM9 12l2 2 4-4',
  access: 'M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM4 21v-1a6 6 0 0 1 9.5-4.9M17 14v4M17 22h.01M19 18h-4',
}

interface Item { to: string; label: string; icon: string; match?: (path: string, search: URLSearchParams) => boolean }
const TOP: Item[] = [
  { to: '/', label: 'Overview', icon: I.overview, match: (p) => p === '/' },
  { to: '/sources', label: 'Sources', icon: I.source },
]
const SECTIONS: { n: number; label: string; items: Item[] }[] = [
  { n: 1, label: 'Schema', items: [{ to: '/schema', label: 'Data model', icon: I.schema, match: (p) => p === '/schema' || p === '/setup' }] },
  { n: 2, label: 'Modeling', items: [{ to: '/traits', label: 'Traits', icon: I.traits }, { to: '/profiles', label: 'Profiles', icon: I.profiles }] },
  {
    n: 3, label: 'Segmentation', items: [
      { to: '/audiences', label: 'Audiences', icon: I.audiences },
      { to: '/governance?tab=priority', label: 'Priority lists', icon: I.priority, match: (p, s) => p === '/governance' && s.get('tab') === 'priority' },
    ],
  },
  {
    n: 4, label: 'Activation', items: [
      { to: '/destinations', label: 'Destinations', icon: I.destinations },
      { to: '/activations', label: 'Syncs', icon: I.syncs },
      { to: '/governance?tab=rules', label: 'Destination rules', icon: I.rules, match: (p, s) => p === '/governance' && s.get('tab') !== 'priority' },
    ],
  },
]
const ADMIN: Item[] = [{ to: '/access', label: 'Access', icon: I.access }]
const ALL = [...TOP, ...SECTIONS.flatMap((s) => s.items)]

function initials(name: string) {
  return name.split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?'
}

/** Who is signed in, their role, and (local development only) a persona picker. */
function UserChip() {
  const { me, roleLabel } = useMe()
  const personas = useAsync(() => (me && !me.in_databricks_app ? api.get<string[]>('/dev/personas') : Promise.resolve([] as string[])), [me?.in_databricks_app])
  if (!me) return null
  const persona = getPersona()
  return (
    <div className="user-chip">
      <div className="row" style={{ gap: 10 }}>
        <span className="user-avatar" aria-hidden="true">{initials(me.name || me.email)}</span>
        <div className="user-meta">
          <strong title={me.email}>{me.name || me.email}</strong>
          <small>{roleLabel}</small>
        </div>
      </div>
      {!me.in_databricks_app && (
        <label className="persona">
          <span>Preview as</span>
          <select value={persona} onChange={(e) => setPersona(e.target.value)}>
            <option value="">Me (Platform Admin)</option>
            {(personas.data ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      )}
    </div>
  )
}

function useActive() {
  const loc = useLocation()
  const search = new URLSearchParams(loc.search)
  return (item: Item) => (item.match ? item.match(loc.pathname, search) : loc.pathname === item.to || loc.pathname.startsWith(item.to + '/'))
}

function NavItem({ item, active }: { item: Item; active: boolean }) {
  return <Link to={item.to} className={`nav-link ${active ? 'active' : ''}`}><Icon d={item.icon} />{item.label}</Link>
}

function Layout() {
  const isActive = useActive()
  const { canPlatform } = useMe()
  return (
    <div className="app">
      <header className="topbar">
        <img src="/mediamint-logo.svg" alt="MediaMint" className="topbar-logo" />
        <span className="topbar-product">CDP</span>
        <ThemeSwitch />
        <nav className="topbar-nav">
          {ALL.map((n) => <Link key={n.to} to={n.to} className={`topbar-link ${isActive(n) ? 'active' : ''}`}>{n.label}</Link>)}
        </nav>
      </header>
      <aside className="sidebar">
        <Link to="/" className="side-brand">
          <img src="/mediamint-logo.svg" alt="MediaMint" className="brand-logo" />
          <span className="brand-sub">Customer Data Platform</span>
        </Link>
        <nav className="side-nav">
          {TOP.map((n) => <NavItem key={n.to} item={n} active={isActive(n)} />)}
          {SECTIONS.map((s) => (
            <div key={s.n} className="nav-group">
              <div className="nav-section"><span className="nav-step">{s.n}</span>{s.label}</div>
              {s.items.map((n) => <NavItem key={n.to} item={n} active={isActive(n)} />)}
            </div>
          ))}
          {canPlatform('access.manage') && (
            <div className="nav-group">
              <div className="nav-section">Admin</div>
              {ADMIN.map((n) => <NavItem key={n.to} item={n} active={isActive(n)} />)}
            </div>
          )}
        </nav>
        <UserChip />
        <div className="sidebar-theme"><span>Theme</span><ThemeSwitch /></div>
        <div className="sidebar-foot">
          <span className="status-dot" aria-hidden="true" />
          <div>Databricks<small>Connected · no data copied</small></div>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/sources" element={<Sources />} />
          <Route path="/schema" element={<Setup />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/traits" element={<Traits />} />
          <Route path="/profiles" element={<Profiles />} />
          <Route path="/audiences" element={<Audiences />} />
          <Route path="/audiences/:id" element={<AudienceBuilder />} />
          <Route path="/governance" element={<Governance />} />
          <Route path="/destinations" element={<Destinations />} />
          <Route path="/activations" element={<Activations />} />
          <Route path="/activations/new" element={<ActivationNew />} />
          <Route path="/activations/:id" element={<ActivationDetail />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/access" element={<Access />} />
        </Routes>
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MeProvider><BrowserRouter><Layout /></BrowserRouter></MeProvider>
  </StrictMode>,
)
