import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function authenticateUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const claims = await verifyAuthToken(authToken)
  if (!claims) return { error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return { error: NextResponse.json({ error: 'User not found' }, { status: 404 }) }

  return { user }
}

// GET /api/routes-d/tags - list tags for current user

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticateUser(request)
    if ('error' in auth) return auth.error

    const tags = await prisma.tag.findMany({
      where: { userId: auth.user.id },
      include: { _count: { select: { invoiceTags: true } } },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      tags: tags.map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color,
        invoiceCount: t._count.invoiceTags,
        createdAt: t.createdAt,
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'Tags GET error')
    return NextResponse.json({ error: 'Failed to get tags' }, { status: 500 })
  }
}

// POST /api/routes-d/tags - create a new tag

const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateUser(request)
    if ('error' in auth) return auth.error

    const body = await request.json()
    const { name, color = '#6366f1' } = body

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    if (name.trim().length > 50) {
      return NextResponse.json({ error: 'Name must be 50 characters or fewer' }, { status: 400 })
    }

    if (typeof color !== 'string' || !HEX_COLOR_REGEX.test(color)) {
      return NextResponse.json({ error: 'Invalid hex color format' }, { status: 400 })
    }

    const tag = await prisma.tag.create({
      data: {
        userId: auth.user.id,
        name: name.trim(),
        color,
      },
    })

    return NextResponse.json(
      {
        id: tag.id,
        name: tag.name,
        color: tag.color,
        invoiceCount: 0,
        createdAt: tag.createdAt,
      },
      { status: 201 }
    )
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code: string }).code === 'P2002'
    ) {
      return NextResponse.json({ error: 'Tag with this name already exists' }, { status: 409 })
    }
    logger.error({ err: error }, 'Tags POST error')
    return NextResponse.json({ error: 'Failed to create tag' }, { status: 500 })
  }
}
