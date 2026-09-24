import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function resolveUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return { error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) }
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return { error: NextResponse.json({ error: 'User not found' }, { status: 404 }) }
  }

  return { user }
}

const PRIVILEGED_ROLES = ['owner', 'admin']

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await resolveUser(request)
    if ('error' in auth) return auth.error

    const { id } = await params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Team member ID is required' }, { status: 400 })
    }

    const member = await prisma.teamMember.findUnique({ where: { id } })
    if (!member || member.status === 'removed') {
      return NextResponse.json({ error: 'Team member not found' }, { status: 404 })
    }

    // Authorization: the caller must be the team owner, or an active member of
    // the same team holding an owner/admin role.
    const isTeamOwner = auth.user.id === member.ownerId
    let hasPrivilegedRole = isTeamOwner
    if (!hasPrivilegedRole) {
      const callerMembership = await prisma.teamMember.findFirst({
        where: {
          ownerId: member.ownerId,
          memberId: auth.user.id,
          status: 'active',
        },
      })
      hasPrivilegedRole = !!callerMembership && PRIVILEGED_ROLES.includes(callerMembership.role)
    }

    if (!hasPrivilegedRole) {
      return NextResponse.json(
        { error: 'Only an owner or admin can remove a team member' },
        { status: 403 }
      )
    }

    // Never remove the last remaining owner of a team.
    if (member.role === 'owner') {
      const ownerCount = await prisma.teamMember.count({
        where: {
          ownerId: member.ownerId,
          role: 'owner',
          status: { not: 'removed' },
        },
      })
      if (ownerCount <= 1) {
        return NextResponse.json(
          { error: 'Cannot remove the last remaining owner' },
          { status: 409 }
        )
      }
    }

    // Flag the removed member's open collaborations instead of leaving dangling
    // references. Only unpaid ("pending") rows are touched; already-paid rows
    // are historical and left intact. Removal is a soft delete so the audit
    // trail (invitedAt/acceptedAt/removedAt) is preserved.
    const result = await prisma.$transaction(async (tx) => {
      let reassignedCollaborations = 0
      if (member.memberId) {
        const flagged = await tx.invoiceCollaborator.updateMany({
          where: { subContractorId: member.memberId, payoutStatus: 'pending' },
          data: { payoutStatus: 'unassigned' },
        })
        reassignedCollaborations = flagged.count
      }

      const updated = await tx.teamMember.update({
        where: { id },
        data: { status: 'removed', removedAt: new Date() },
      })

      return { updated, reassignedCollaborations }
    })

    return NextResponse.json(
      { teamMember: result.updated, reassignedCollaborations: result.reassignedCollaborations },
      { status: 200 }
    )
  } catch (error) {
    logger.error({ err: error }, 'Failed to remove team member')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
