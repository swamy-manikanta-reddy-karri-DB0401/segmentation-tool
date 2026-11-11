import { switchBrand, useMe } from './me'

/**
 * Sidebar brand switcher. Choosing a brand reloads the app in that brand: its data, and only the
 * permissions the person's roles give them there. People who may work across every brand (admins,
 * brand-wide roles) also get "All brands".
 */
export default function BrandSwitcher() {
  const { me, roleLabel } = useMe()
  if (!me || me.switch.brands.length === 0) return null
  const options = [...(me.switch.all ? [{ id: 'all', name: 'All brands' }] : []), ...me.switch.brands.map((b) => ({ id: String(b.id), name: b.name }))]
  const value = me.active_brand_id == null ? 'all' : String(me.active_brand_id)
  const current = options.find((o) => o.id === value)
  return (
    <div className="brand-switch">
      <label htmlFor="brand-switch-select">Brand</label>
      {options.length > 1 ? (
        <select id="brand-switch-select" className="input sm" value={value} onChange={(e) => switchBrand(e.target.value)}>
          {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      ) : (
        <strong className="brand-switch-one">{current?.name ?? options[0]!.name}</strong>
      )}
      <small>{roleLabel}{me.active_brand_id != null ? ' here' : ''}</small>
    </div>
  )
}
