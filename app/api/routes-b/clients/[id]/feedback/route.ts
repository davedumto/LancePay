import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const client = await prisma.client.findFirst({
      where: { id: (await params).id, userId: user.id },
    })
    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

    const { searchParams } = new URL(request.url)
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') ?? '20', 10)))

    const [feedback, total] = await Promise.all([
      prisma.clientFeedback.findMany({
        where: { clientId: (await params).id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.clientFeedback.count({ where: { clientId: (await params).id } }),
    ])

    return NextResponse.json({ feedback, total, page, limit })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/clients/[id]/feedback error')
    return NextResponse.json({ error: 'Failed to fetch feedback' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const client = await prisma.client.findFirst({
      where: { id: (await params).id, userId: user.id },
    })
    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

    const body = await request.json()
    const { rating, comment } = body

    if (rating === undefined || typeof rating !== 'number' || rating < 1 || rating > 5) {
      return NextResponse.json({ error: 'rating must be a number between 1 and 5' }, { status: 400 })
    }
    if (comment !== undefined && typeof comment !== 'string') {
      return NextResponse.json({ error: 'comment must be a string' }, { status: 400 })
    }

    const entry = await prisma.clientFeedback.create({
      data: {
        clientId: (await params).id,
        userId: user.id,
        rating,
        comment: comment?.trim() ?? null,
      },
    })

    return NextResponse.json({ feedback: entry }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/clients/[id]/feedback error')
    return NextResponse.json({ error: 'Failed to add feedback' }, { status: 500 })
  }
}
