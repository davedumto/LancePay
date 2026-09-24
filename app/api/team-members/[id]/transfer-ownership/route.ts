import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { getAuthenticatedUser, resolveTeamRole } from '@/lib/team'

// POST /api/team-members/[id]/transfer-ownership — hand the owner role to another member

export async function POST(
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

    const target = await prisma.teamMember.findUnique({ where: { id } })
    if (!target) {
      return NextResponse.json({ error: 'Team member not found' }, { status: 404 })
    }

    // Only the current owner may initiate a transfer.
    const callerRole = await resolveTeamRole(target.ownerId, user.id)
    if (callerRole !== 'owner') {
      return NextResponse.json(
        { error: 'Only the current owner may transfer ownership' },
        { status: 403 },
      )
    }

    // The target must already be an active, accepted member (not a pending invite).
    if (target.status !== 'active') {
      return NextResponse.json(
        { error: 'The target must be an active team member' },
        { status: 400 },
      )
    }

    if (target.role === 'owner') {
      return NextResponse.json(
        { error: 'The target is already the owner' },
        { status: 400 },
      )
    }

    // Locate the outgoing owner row so both roles change in one atomic swap.
    const currentOwner = await prisma.teamMember.findFirst({
      where: { ownerId: target.ownerId, role: 'owner' },
    })
    if (!currentOwner) {
      return NextResponse.json(
        { error: 'No current owner member to transfer from' },
        { status: 400 },
      )
    }

    // Atomic swap: demote the outgoing owner and promote the incoming member in a
    // single transaction so the team is never left with zero or two owners.
    const [, incoming] = await prisma.$transaction([
      prisma.teamMember.update({
        where: { id: currentOwner.id },
        data: { role: 'admin' },
      }),
      prisma.teamMember.update({
        where: { id: target.id },
        data: { role: 'owner' },
      }),
    ])

    logger.info(
      { ownerId: target.ownerId, from: currentOwner.id, to: target.id },
      'POST /api/team-members/[id]/transfer-ownership',
    )

    return NextResponse.json({ member: incoming })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/team-members/[id]/transfer-ownership error')
    return NextResponse.json({ error: 'Failed to transfer ownership' }, { status: 500 })
  }
}
