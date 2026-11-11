import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api, PERSONA_KEY, setActiveBrand } from '../api'
import type { BrandPerm, Me, PlatformPerm } from '../api'

interface MeCtx {
  me: Me | null
  error: string | null
  /** Platform-level permission (sources, data model, settings, access). */
  canPlatform: (perm: PlatformPerm) => boolean
  /** Brand permission; without a brand: true if the user has it for any brand. */
  can: (perm: BrandPerm, brandId?: number | null) => boolean
  /** Brands where the user has `perm`. */
  brandsWith: (perm: BrandPerm) => { id: number; name: string }[]
  brandName: (id: number | null | undefined) => string
  roleLabel: string
}

const Ctx = createContext<MeCtx | null>(null)

/** "Builder" · "Builder, Viewer" · "Builder +2" — distinct role names, for the small user chip. */
function roleSummary(labels: string[]): string {
  const uniq = [...new Set(labels)]
  if (!uniq.length) return 'No role yet'
  return uniq.length <= 2 ? uniq.join(', ') : `${uniq[0]} +${uniq.length - 1}`
}

export function MeProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.get<Me>('/me').then((m) => {
      // keep the remembered choice in step with what the server accepted (e.g. a brand they lost access to)
      setActiveBrand(m.active_brand_id != null ? String(m.active_brand_id) : m.switch.all ? 'all' : '')
      setMe(m)
    }).catch((e) => setError((e as Error).message))
  }, [])
  // roles that apply in the brand they're working in
  const activeRoles = me ? me.roles.filter((r) => me.active_brand_id == null || r.brand_id == null || r.brand_id === me.active_brand_id) : []
  const value: MeCtx = {
    me,
    error,
    canPlatform: (perm) => !!me && (me.platform_admin || !!me.platform[perm]),
    can: (perm, brandId) => {
      if (!me) return false
      if (me.platform_admin) return true
      if (brandId == null) return me.brands.some((b) => b.can[perm])
      return !!me.brands.find((b) => b.id === brandId)?.can[perm]
    },
    brandsWith: (perm) => (me?.brands ?? []).filter((b) => me?.platform_admin || b.can[perm]).map((b) => ({ id: b.id, name: b.name })),
    brandName: (id) => (id == null ? 'All brands' : me?.switch.brands.find((b) => b.id === id)?.name ?? me?.brands.find((b) => b.id === id)?.name ?? `Brand ${id}`),
    roleLabel: !me ? '' : me.platform_admin ? 'Platform Admin' : roleSummary(activeRoles.map((r) => r.label)),
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useMe = () => useContext(Ctx)!

/** Work in another brand ("all" = every brand, for people who may). Reloads so every screen shows that brand's data and permissions. */
export function switchBrand(value: string) {
  setActiveBrand(value)
  window.location.reload()
}

/** Switch the local-development persona (sent as X-Dev-User) and reload. */
export function setPersona(email: string) {
  try {
    if (email) localStorage.setItem(PERSONA_KEY, email)
    else localStorage.removeItem(PERSONA_KEY)
  } catch {
    /* storage unavailable */
  }
  window.location.reload()
}
