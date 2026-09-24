// Central definition of team-member roles and the permission matrix that
// governs who may perform team-management actions. Keeping this in one place
// avoids drift between the invite, role-change and transfer-ownership handlers.

export const TEAM_ROLES = ['owner', 'admin', 'editor', 'viewer'] as const

export type TeamRole = (typeof TEAM_ROLES)[number]

// Statuses a TeamMember row can be in (mirrors the Prisma schema comment).
export const TEAM_MEMBER_STATUSES = ['pending', 'active', 'removed'] as const

export type TeamMemberStatus = (typeof TEAM_MEMBER_STATUSES)[number]

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === 'string' && (TEAM_ROLES as readonly string[]).includes(value)
}

// Roles that are allowed to invite new members.
const ROLES_THAT_CAN_INVITE: readonly TeamRole[] = ['owner', 'admin']

export function canInvite(role: string): boolean {
  return (ROLES_THAT_CAN_INVITE as readonly string[]).includes(role)
}

// Only an owner may grant the owner role to anyone (including themselves).
export function canGrantRole(actorRole: string, targetRole: TeamRole): boolean {
  if (targetRole === 'owner') {
    return actorRole === 'owner'
  }
  // Owners and admins may assign any non-owner role.
  return actorRole === 'owner' || actorRole === 'admin'
}
