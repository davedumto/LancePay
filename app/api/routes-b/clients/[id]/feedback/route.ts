import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const MAX_COMMENT_LENGTH = 2000

async function resolveContext(request: NextRequest, clientId: string) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return { error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) }
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
  if (!user) {
    return { error: NextResponse.json({ error: 'User not found' }, { status: 404 }) }
  }

  const client = await prisma.user.findUnique({
    where: { id: clientId },
    select: { id: true },
  })
  if (!client) {
    return { error: NextResponse.json({ error: 'Client not found' }, { status: 404 }) }
  }

  return { user, client }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const ctx = await resolveContext(request, id)
    if (ctx.error) return ctx.error

    const feedback = await prisma.clientFeedback.findMany({
      where: { userId: ctx.user.id, clientId: ctx.client.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        rating: true,
        comment: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ feedback })
  } catch (error) {
    logger.error({ err: error }, 'GET /clients/[id]/feedback error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const ctx = await resolveContext(request, id)
    if (ctx.error) return ctx.error

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { rating, comment } = (body ?? {}) as { rating?: unknown; comment?: unknown }

    if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      return NextResponse.json(
        { error: 'rating must be an integer between 1 and 5' },
        { status: 400 },
      )
    }

    if (comment !== undefined && typeof comment !== 'string') {
      return NextResponse.json({ error: 'comment must be a string' }, { status: 400 })
    }

    if (typeof comment === 'string' && comment.length > MAX_COMMENT_LENGTH) {
      return NextResponse.json(
        { error: `comment must be at most ${MAX_COMMENT_LENGTH} characters` },
        { status: 400 },
      )
    }

    const feedback = await prisma.clientFeedback.create({
      data: {
        userId: ctx.user.id,
        clientId: ctx.client.id,
        rating,
        comment: typeof comment === 'string' && comment.trim() !== '' ? comment.trim() : null,
      },
      select: {
        id: true,
        rating: true,
        comment: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ feedback }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /clients/[id]/feedback error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
