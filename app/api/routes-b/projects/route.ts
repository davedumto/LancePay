import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const VALID_STATUSES = ['active', 'archived'] as const
type ProjectStatus = typeof VALID_STATUSES[number]

type ProjectDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getProjectDelegate(): ProjectDelegate {
  return (prisma as unknown as { project: ProjectDelegate }).project
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const statusParam = searchParams.get('status')

    if (statusParam && !VALID_STATUSES.includes(statusParam as ProjectStatus)) {
      return NextResponse.json(
        { error: `status must be one of: ${VALID_STATUSES.join(', ')}` },
        { status: 400 },
      )
    }

    const projects = await getProjectDelegate().findMany({
      where: {
        userId: user.id,
        ...(statusParam ? { status: statusParam } : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        description: true,
        clientName: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        archivedAt: true,
      },
    })

    return NextResponse.json({
      projects: projects.map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description ?? null,
        clientName: p.clientName ?? null,
        status: p.status,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        archivedAt: p.archivedAt ?? null,
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/projects error')
    return NextResponse.json({ error: 'Failed to list projects' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const b = body as Record<string, unknown>

    const title = typeof b?.title === 'string' ? b.title.trim() : ''
    if (!title || title.length > 200) {
      return NextResponse.json({ error: 'title is required and must be at most 200 characters' }, { status: 400 })
    }

    const description =
      b?.description === undefined || b?.description === null
        ? null
        : typeof b.description === 'string'
          ? b.description.trim() || null
          : undefined

    if (description === undefined) {
      return NextResponse.json({ error: 'description must be a string' }, { status: 400 })
    }

    const clientName =
      b?.clientName === undefined || b?.clientName === null
        ? null
        : typeof b.clientName === 'string'
          ? b.clientName.trim().slice(0, 200) || null
          : undefined

    if (clientName === undefined) {
      return NextResponse.json({ error: 'clientName must be a string' }, { status: 400 })
    }

    const project = await getProjectDelegate().create({
      data: {
        userId: user.id,
        title,
        description,
        clientName,
        status: 'active',
      },
      select: {
        id: true,
        title: true,
        description: true,
        clientName: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json(
      {
        project: {
          id: project.id,
          title: project.title,
          description: project.description ?? null,
          clientName: project.clientName ?? null,
          status: project.status,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/projects error')
    return NextResponse.json({ error: 'Failed to create project' }, { status: 500 })
  }
}
