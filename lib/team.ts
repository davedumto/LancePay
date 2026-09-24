import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import type { TeamRole } from '@/lib/team-roles'

// Shared helpers for the team-member endpoints. Authentication mirrors the
// convention used across the app: a bearer token is verified and mapped to a
// local User row via privyId.
export async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

// A team is scoped by the account owner (TeamMember.ownerId). Resolve the role
// a given user effectively holds within that team:
//  - the account owner is always treated as an "owner"
//  - otherwise the user's active TeamMember row supplies the role
//  - a user with no active membership has no role (null)
export async function resolveTeamRole(
  teamOwnerId: string,
  userId: string,
): Promise<TeamRole | null> {
  if (userId === teamOwnerId) return 'owner'
  const membership = await prisma.teamMember.findFirst({
    where: { ownerId: teamOwnerId, memberId: userId, status: 'active' },
    select: { role: true },
  })
  return (membership?.role as TeamRole | undefined) ?? null
}
