import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── POST /api/routes-b/projects/[id]/archive — archive a project ──
//
// Only the owner can archive. Idempotent: archiving an already-archived
// project is a no-op that returns 200 with the current state.

type ProjectDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getProjectDelegate(): ProjectDelegate {
  return (prisma as unknown as { project: ProjectDelegate }).project
}

export async function POST(
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

    const delegate = getProjectDelegate()

    const existing = await delegate.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true, archivedAt: true },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if ((existing as { userId: string }).userId !== user.id) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    }

    if ((existing as { status: string }).status === 'archived') {
      return NextResponse.json({ project: existing })
    }

    const updated = await delegate.update({
      where: { id },
      data: {
        status: 'archived',
        archivedAt: new Date(),
      },
      select: {
        id: true,
        title: true,
        status: true,
        archivedAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ project: updated })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/projects/[id]/archive error')
    return NextResponse.json({ error: 'Failed to archive project' }, { status: 500 })
  }
}
