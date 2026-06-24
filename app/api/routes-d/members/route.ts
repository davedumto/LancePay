import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

type TeamMemberDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getMemberDelegate(): TeamMemberDelegate {
  return (prisma as unknown as { teamMember: TeamMemberDelegate }).teamMember
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null

  const claims = await verifyAuthToken(authToken)
  if (!claims) return null

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })

  return user
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const delegate = getMemberDelegate()
    const members = await delegate.findMany({
      where: {
        ownerId: user.id,
        status: { not: 'removed' },
      },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        invitedAt: true,
        acceptedAt: true,
      },
      orderBy: { invitedAt: 'desc' },
    })

    return NextResponse.json({
      members: members.map((m) => ({
        id: (m as Record<string, unknown>).id,
        email: (m as Record<string, unknown>).email,
        role: (m as Record<string, unknown>).role,
        status: (m as Record<string, unknown>).status,
        invitedAt: (m as Record<string, unknown>).invitedAt,
        acceptedAt: (m as Record<string, unknown>).acceptedAt,
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/members error')
    return NextResponse.json({ error: 'Failed to fetch members' }, { status: 500 })
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

    const email = (body as Record<string, unknown>).email
    const role = (body as Record<string, unknown>).role

    if (typeof email !== 'string' || !email.trim()) {
      return NextResponse.json({ error: 'email is required and must be a string' }, { status: 400 })
    }

    const validRoles = ['admin', 'editor', 'viewer']
    if (!role || !validRoles.includes(role as string)) {
      return NextResponse.json(
        { error: `role must be one of: ${validRoles.join(', ')}` },
        { status: 400 },
      )
    }

    const delegate = getMemberDelegate()

    const existingMember = await delegate.findMany({
      where: {
        ownerId: user.id,
        email: email.toLowerCase(),
      },
      take: 1,
    })

    if (existingMember.length > 0) {
      return NextResponse.json(
        { error: 'Member with this email already exists' },
        { status: 409 },
      )
    }

    const member = await delegate.create({
      data: {
        ownerId: user.id,
        email: email.toLowerCase(),
        role,
        status: 'pending',
      },
    })

    return NextResponse.json(
      {
        id: (member as Record<string, unknown>).id,
        email: (member as Record<string, unknown>).email,
        role: (member as Record<string, unknown>).role,
        status: (member as Record<string, unknown>).status,
        invitedAt: (member as Record<string, unknown>).invitedAt,
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/members error')
    return NextResponse.json({ error: 'Failed to invite member' }, { status: 500 })
  }
}
