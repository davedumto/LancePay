import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// GET  /api/routes-b/disputes/[id]/messages — list messages on a dispute
// POST /api/routes-b/disputes/[id]/messages — post a threaded message

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const MAX_MESSAGE_LENGTH = 5000
const CLOSED_STATUSES = ['resolved', 'closed']

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, email: true },
  })
}

// Resolve the two parties to a dispute: the invoice owner (freelancer) and the
// client the invoice was billed to. Only these two may read or post.
function resolveParty(
  userEmail: string,
  ownerEmail: string | undefined,
  clientEmail: string | undefined,
): 'freelancer' | 'client' | null {
  const email = userEmail.toLowerCase()
  if (ownerEmail && email === ownerEmail.toLowerCase()) return 'freelancer'
  if (clientEmail && email === clientEmail.toLowerCase()) return 'client'
  return null
}

async function loadDispute(disputeId: string) {
  return prisma.dispute.findUnique({
    where: { id: disputeId },
    select: {
      id: true,
      status: true,
      invoice: {
        select: {
          clientEmail: true,
          user: { select: { email: true } },
        },
      },
    },
  })
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } | Promise<{ id: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: disputeId } = await Promise.resolve(params)
    if (!disputeId || !disputeId.trim()) {
      return NextResponse.json({ error: 'Dispute ID is required' }, { status: 400 })
    }

    const dispute = await loadDispute(disputeId)
    if (!dispute) {
      return NextResponse.json({ error: 'Dispute not found' }, { status: 404 })
    }

    const party = resolveParty(
      user.email,
      dispute.invoice?.user?.email,
      dispute.invoice?.clientEmail,
    )
    if (!party) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const parsedLimit = Number(searchParams.get('limit'))
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(Math.floor(parsedLimit), MAX_LIMIT)
      : DEFAULT_LIMIT
    const cursor = searchParams.get('cursor')

    const messages = await prisma.disputeMessage.findMany({
      where: { disputeId },
      orderBy: { createdAt: 'asc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })

    const hasMore = messages.length > limit
    const page = hasMore ? messages.slice(0, limit) : messages

    return NextResponse.json({
      messages: page,
      nextCursor: hasMore ? page[page.length - 1].id : null,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/disputes/[id]/messages error')
    return NextResponse.json({ error: 'Failed to fetch dispute messages' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } | Promise<{ id: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: disputeId } = await Promise.resolve(params)
    if (!disputeId || !disputeId.trim()) {
      return NextResponse.json({ error: 'Dispute ID is required' }, { status: 400 })
    }

    const dispute = await loadDispute(disputeId)
    if (!dispute) {
      return NextResponse.json({ error: 'Dispute not found' }, { status: 404 })
    }

    const party = resolveParty(
      user.email,
      dispute.invoice?.user?.email,
      dispute.invoice?.clientEmail,
    )
    if (!party) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (CLOSED_STATUSES.includes(dispute.status)) {
      return NextResponse.json(
        { error: `Cannot post to a dispute that is ${dispute.status}` },
        { status: 409 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as { message?: unknown; attachments?: unknown }
    const message = typeof payload.message === 'string' ? payload.message.trim() : ''
    if (!message) {
      return NextResponse.json({ error: 'message is required' }, { status: 400 })
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json(
        { error: `message must be at most ${MAX_MESSAGE_LENGTH} characters` },
        { status: 400 },
      )
    }

    let attachments: Prisma.InputJsonValue = []
    if (payload.attachments !== undefined) {
      if (!Array.isArray(payload.attachments)) {
        return NextResponse.json({ error: 'attachments must be an array' }, { status: 400 })
      }
      attachments = payload.attachments as Prisma.InputJsonValue
    }

    const created = await prisma.disputeMessage.create({
      data: {
        disputeId,
        senderType: party,
        senderEmail: user.email,
        message,
        attachments,
      },
    })

    logger.info(
      { userId: user.id, disputeId, messageId: created.id, senderType: party },
      'POST /api/routes-b/disputes/[id]/messages',
    )

    return NextResponse.json({ message: created }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/disputes/[id]/messages error')
    return NextResponse.json({ error: 'Failed to post dispute message' }, { status: 500 })
  }
}
