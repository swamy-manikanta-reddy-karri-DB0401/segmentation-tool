import type { RoleInfo } from '../api'

export const ROLE_TONE: Record<string, string> = { platform_admin: 'violet', brand_admin: 'brand', builder: 'blue', operator: 'amber', viewer: 'gray' }
export const ROLE_ORDER = ['platform_admin', 'brand_admin', 'builder', 'operator', 'viewer']

/** Built-in roles first (most powerful first), custom roles after, by name. */
export const roleRank = (r: string) => (ROLE_ORDER.includes(r) ? ROLE_ORDER.indexOf(r) : ROLE_ORDER.length)
export const byRole = (a: RoleInfo, b: RoleInfo) => roleRank(a.role) - roleRank(b.role) || a.label.localeCompare(b.label)

/** Order for pickers: built-in roles from least to most powerful, then custom roles by name. */
export const pickOrder = (roles: RoleInfo[]) => [
  ...roles.filter((r) => !r.custom).sort(byRole).reverse(),
  ...roles.filter((r) => r.custom).sort(byRole),
]

/** Everything a brand role can grant, in the words a marketer would use. */
export const CAPABILITIES: { perm: string; label: string }[] = [
  { perm: 'view', label: 'See audiences, profiles, syncs and run history' },
  { perm: 'audiences.edit', label: 'Build and change audiences' },
  { perm: 'traits.manage', label: 'Create and change traits' },
  { perm: 'syncs.edit', label: 'Set up and change syncs' },
  { perm: 'syncs.approve', label: 'Approve syncs and publish them' },
  { perm: 'syncs.run', label: 'Run syncs and pause them' },
  { perm: 'destinations.manage', label: 'Connect destinations and manage credentials' },
  { perm: 'governance.manage', label: 'Manage priority lists and destination rules' },
]
export const PLATFORM_CAPS = ['Connect Databricks sources', 'Change the data model', 'Manage users, brands, roles and workspace settings']
