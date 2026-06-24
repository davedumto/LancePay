import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── DELETE /api/routes-d/members/[id] — remove a team member ──
//
// Only the owner of the team can remove a member. Once removed the
// member record is soft-deleted (status → 'removed') rather than
// destroyed so audit history is preserved.

type TeamMemberDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getMemberDelegate(): TeamMemberDelegate {
  return (prisma as unknown as { teamMember: TeamMemberDelegate }).teamMember
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    const delegate = getMemberDelegate()

    const member = await delegate.findUnique({
      where: { id },
      select: { id: true, ownerId: true, status: true },
    })

    if (!member) {
      return NextResponse.json({ error: 'Team member not found' }, { status: 404 })
    }

    if ((member as { ownerId: string }).ownerId !== user.id) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    }

    if ((member as { status: string }).status === 'removed') {
      return NextResponse.json({ error: 'Team member already removed' }, { status: 409 })
    }

    await delegate.update({
      where: { id },
      data: { status: 'removed', removedAt: new Date() },
    })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/routes-d/members/[id] error')
    return NextResponse.json({ error: 'Failed to remove team member' }, { status: 500 })
  }
}
