import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const ALLOWED_SENDER_TYPES = new Set(['client', 'freelancer', 'admin'])

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: disputeId } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      include: {
        invoice: {
          select: {
            id: true,
            userId: true,
            clientId: true,
            user: { select: { email: true } },
            client: { select: { email: true } },
          },
        },
      },
    })

    if (!dispute) {
      return NextResponse.json({ error: 'Dispute not found' }, { status: 404 })
    }

    const isParty =
      user.role === 'admin' ||
      dispute.initiatedBy === user.id ||
      dispute.initiatorEmail === user.email ||
      dispute.invoice.userId === user.id ||
      dispute.invoice.clientId === user.id ||
      dispute.invoice.user?.email === user.email ||
      dispute.invoice.client?.email === user.email

    if (!isParty) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const page = Math.max(1, Number(searchParams.get('page')) || 1)
    const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit')) || 25))

    const [messages, total] = await Promise.all([
      prisma.disputeMessage.findMany({
        where: { disputeId },
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.disputeMessage.count({ where: { disputeId } }),
    ])

    return NextResponse.json({
      messages: messages.map((m) => ({
        ...m,
        createdAt: m.createdAt.toISOString(),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/disputes/[id]/messages error')
    return NextResponse.json({ error: 'Failed to fetch dispute messages' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: disputeId } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      include: {
        invoice: {
          select: {
            id: true,
            userId: true,
            clientId: true,
            user: { select: { email: true } },
            client: { select: { email: true } },
          },
        },
      },
    })

    if (!dispute) {
      return NextResponse.json({ error: 'Dispute not found' }, { status: 404 })
    }

    if (dispute.status === 'resolved' || dispute.status === 'closed') {
      return NextResponse.json(
        { error: 'Cannot post messages to a resolved or closed dispute' },
        { status: 400 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { senderType, senderEmail, message, attachments = [] } = (body ?? {}) as {
      senderType?: string
      senderEmail?: string
      message?: string
      attachments?: unknown
    }

    if (!senderType || !ALLOWED_SENDER_TYPES.has(senderType)) {
      return NextResponse.json(
        { error: `senderType must be one of: ${Array.from(ALLOWED_SENDER_TYPES).join(', ')}` },
        { status: 400 },
      )
    }

    if (!senderEmail || typeof senderEmail !== 'string' || !senderEmail.includes('@')) {
      return NextResponse.json({ error: 'A valid senderEmail is required' }, { status: 400 })
    }

    if (!message || typeof message !== 'string' || !message.trim()) {
      return NextResponse.json({ error: 'message is required' }, { status: 400 })
    }

    // Party validation: senderEmail must match one of the two parties (or admin)
    const partyEmails = new Set<string>()
    if (dispute.initiatorEmail) partyEmails.add(dispute.initiatorEmail.toLowerCase())
    if (dispute.invoice.user?.email) partyEmails.add(dispute.invoice.user.email.toLowerCase())
    if (dispute.invoice.client?.email) partyEmails.add(dispute.invoice.client.email.toLowerCase())
    if (user.email) partyEmails.add(user.email.toLowerCase())

    const normalizedSenderEmail = senderEmail.trim().toLowerCase()
    const isAuthorizedParty =
      user.role === 'admin' ||
      partyEmails.has(normalizedSenderEmail)

    if (!isAuthorizedParty) {
      return NextResponse.json(
        { error: 'senderEmail does not match an authorized party on this dispute' },
        { status: 403 },
      )
    }

    const created = await prisma.disputeMessage.create({
      data: {
        disputeId,
        senderType,
        senderEmail: normalizedSenderEmail,
        message: message.trim(),
        attachments: Array.isArray(attachments) ? (attachments as any) : [],
      },
    })

    return NextResponse.json(
      {
        message: {
          ...created,
          createdAt: created.createdAt.toISOString(),
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/disputes/[id]/messages error')
    return NextResponse.json({ error: 'Failed to post dispute message' }, { status: 500 })
  }
}
