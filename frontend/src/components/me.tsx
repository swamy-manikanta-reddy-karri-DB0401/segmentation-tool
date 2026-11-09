import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api, PERSONA_KEY } from '../api'
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

export function MeProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.get<Me>('/me').then(setMe).catch((e) => setError((e as Error).message))
  }, [])
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
    brandName: (id) => (id == null ? 'All brands' : me?.brands.find((b) => b.id === id)?.name ?? `Brand ${id}`),
    roleLabel: !me ? '' : me.platform_admin ? 'Platform Admin' : me.roles[0]?.label ?? 'No role yet',
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useMe = () => useContext(Ctx)!

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
