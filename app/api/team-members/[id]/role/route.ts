import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { getAuthenticatedUser, resolveTeamRole } from '@/lib/team'
import { canGrantRole, isTeamRole } from '@/lib/team-roles'

// PATCH /api/team-members/[id]/role — change a member's role with permission-matrix enforcement

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } | Promise<{ id: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await Promise.resolve(params)
    if (!id || !id.trim()) {
      return NextResponse.json({ error: 'Team member ID is required' }, { status: 400 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { role: newRole } = (body ?? {}) as { role?: string }

    // Validate the requested role exists in the permission matrix.
    if (!isTeamRole(newRole)) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
    }

    const target = await prisma.teamMember.findUnique({ where: { id } })
    if (!target) {
      return NextResponse.json({ error: 'Team member not found' }, { status: 404 })
    }

    const callerRole = await resolveTeamRole(target.ownerId, user.id)
    if (!callerRole) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // A non-owner may never grant the owner role to anyone, including themselves.
    if (!canGrantRole(callerRole, newRole)) {
      return NextResponse.json(
        { error: 'Only an owner may grant the owner role' },
        { status: 403 },
      )
    }

    // Reject demoting the last remaining owner.
    if (target.role === 'owner' && newRole !== 'owner') {
      const ownerCount = await prisma.teamMember.count({
        where: { ownerId: target.ownerId, role: 'owner' },
      })
      if (ownerCount <= 1) {
        return NextResponse.json(
          { error: 'Cannot demote the last remaining owner' },
          { status: 400 },
        )
      }
    }

    const updated = await prisma.teamMember.update({
      where: { id },
      data: { role: newRole },
    })

    logger.info(
      { ownerId: target.ownerId, memberId: id, from: target.role, to: newRole },
      'PATCH /api/team-members/[id]/role',
    )

    return NextResponse.json({ member: updated })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/team-members/[id]/role error')
    return NextResponse.json({ error: 'Failed to update team member role' }, { status: 500 })
  }
}
