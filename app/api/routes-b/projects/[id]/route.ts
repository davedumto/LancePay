import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET /api/routes-b/projects/[id] — fetch a single project ──

type ProjectDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
}

function getProjectDelegate(): ProjectDelegate {
  return (prisma as unknown as { project: ProjectDelegate }).project
}

export async function GET(
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

    const project = await getProjectDelegate().findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        description: true,
        clientName: true,
        status: true,
        archivedAt: true,
        createdAt: true,
        updatedAt: true,
        userId: true,
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if ((project as { userId: string }).userId !== user.id) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    }

    return NextResponse.json({ project })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/projects/[id] error')
    return NextResponse.json({ error: 'Failed to fetch project' }, { status: 500 })
  }
}
