import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const MAX_MESSAGE_LENGTH = 5000
const CLOSED_STATUSES = new Set(['resolved', 'closed'])
const ALLOWED_SENDER_TYPES = new Set(['freelancer', 'client'])

async function getAuthenticatedUser(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const authToken = authHeader.slice(7).trim()
  if (!authToken) return null

  const claims = await verifyAuthToken(authToken)
  if (!claims) return null

  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, email: true },
    })
    if (dbUser) return dbUser
  }

  if (claims.email) {
    return { id: claims.userId, email: claims.email }
  }

  return null
}

function resolveParty(
  emailToCheck: string,
  ownerEmail: string | undefined,
  clientEmail: string | undefined,
): 'freelancer' | 'client' | null {
  const normalized = emailToCheck.trim().toLowerCase()
  if (ownerEmail && normalized === ownerEmail.trim().toLowerCase()) {
    return 'freelancer'
  }
  if (clientEmail && normalized === clientEmail.trim().toLowerCase()) {
    return 'client'
  }
  return null
}

async function loadDispute(disputeId: string) {
  return prisma.dispute.findUnique({
    where: { id: disputeId },
    select: {
      id: true,
      status: true,
      initiatorEmail: true,
      invoice: {
        select: {
          clientEmail: true,
          user: { select: { email: true } },
        },
      },
    },
  })
}

/**
 * GET /api/disputes/[id]/messages
 * Lists messages in a dispute thread ordered by createdAt ascending with pagination.
 */
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
      return NextResponse.json(
        { error: 'Dispute ID is required' },
        { status: 400 },
      )
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
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(Math.floor(parsedLimit), MAX_LIMIT)
        : DEFAULT_LIMIT
    const parsedPage = Number(searchParams.get('page'))
    const page =
      Number.isFinite(parsedPage) && parsedPage >= 1
        ? Math.floor(parsedPage)
        : 1
    const cursor = searchParams.get('cursor')?.trim() || null

    const messages = await prisma.disputeMessage.findMany({
      where: { disputeId },
      orderBy: { createdAt: 'asc' },
      take: limit + 1,
      ...(cursor
        ? { cursor: { id: cursor }, skip: 1 }
        : page > 1
          ? { skip: (page - 1) * limit }
          : {}),
    })

    const hasMore = messages.length > limit
    const items = hasMore ? messages.slice(0, limit) : messages

    return NextResponse.json({
      messages: items,
      data: items,
      nextCursor: hasMore ? items[items.length - 1].id : null,
      pagination: {
        page,
        limit,
        hasMore,
      },
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'GET /api/disputes/[id]/messages error')
    return NextResponse.json(
      { error: 'Failed to fetch dispute messages' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/disputes/[id]/messages
 * Posts a message in an active dispute thread. Rejects resolved/closed disputes,
 * validates senderType against the allowed set ('freelancer' | 'client'), and
 * ensures senderEmail matches one of the two dispute parties.
 */
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
      return NextResponse.json(
        { error: 'Dispute ID is required' },
        { status: 400 },
      )
    }

    const dispute = await loadDispute(disputeId)
    if (!dispute) {
      return NextResponse.json({ error: 'Dispute not found' }, { status: 404 })
    }

    const ownerEmail = dispute.invoice?.user?.email
    const clientEmail = dispute.invoice?.clientEmail

    const authenticatedParty = resolveParty(user.email, ownerEmail, clientEmail)
    if (!authenticatedParty) {
      return NextResponse.json(
        { error: 'Forbidden: Only the freelancer or client involved in this dispute may post messages' },
        { status: 403 },
      )
    }

    if (CLOSED_STATUSES.has(String(dispute.status).toLowerCase())) {
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

    const payload = (body ?? {}) as {
      message?: unknown
      senderType?: unknown
      senderEmail?: unknown
      attachments?: unknown
    }

    if (payload.senderType !== undefined && payload.senderType !== null) {
      if (
        typeof payload.senderType !== 'string' ||
        !ALLOWED_SENDER_TYPES.has(payload.senderType.trim().toLowerCase())
      ) {
        return NextResponse.json(
          { error: 'senderType must be one of: freelancer, client' },
          { status: 400 },
        )
      }
      const requestedType = payload.senderType.trim().toLowerCase()
      if (requestedType !== authenticatedParty) {
        return NextResponse.json(
          { error: 'senderType does not match authenticated dispute party role' },
          { status: 403 },
        )
      }
    }

    let senderEmail = user.email
    if (payload.senderEmail !== undefined && payload.senderEmail !== null) {
      if (typeof payload.senderEmail !== 'string' || !payload.senderEmail.trim()) {
        return NextResponse.json(
          { error: 'senderEmail must be a valid email string' },
          { status: 400 },
        )
      }
      const providedEmail = payload.senderEmail.trim()
      const providedParty = resolveParty(providedEmail, ownerEmail, clientEmail)
      if (!providedParty || providedEmail.toLowerCase() !== user.email.toLowerCase()) {
        return NextResponse.json(
          { error: 'senderEmail must match the authenticated dispute party' },
          { status: 403 },
        )
      }
      senderEmail = providedEmail
    }

    const message =
      typeof payload.message === 'string' ? payload.message.trim() : ''
    if (!message) {
      return NextResponse.json(
        { error: 'message is required' },
        { status: 400 },
      )
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
        return NextResponse.json(
          { error: 'attachments must be an array' },
          { status: 400 },
        )
      }
      attachments = payload.attachments as Prisma.InputJsonValue
    }

    const created = await prisma.disputeMessage.create({
      data: {
        disputeId,
        senderType: authenticatedParty,
        senderEmail,
        message,
        attachments,
      },
    })

    logger?.info?.(
      {
        userId: user.id,
        disputeId,
        messageId: created.id,
        senderType: authenticatedParty,
      },
      'POST /api/disputes/[id]/messages',
    )

    return NextResponse.json(
      { message: created, data: created },
      { status: 201 },
    )
  } catch (error) {
    logger?.error?.({ err: error }, 'POST /api/disputes/[id]/messages error')
    return NextResponse.json(
      { error: 'Failed to post dispute message' },
      { status: 500 },
    )
  }
}
