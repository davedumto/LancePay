import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const ALLOWED_SENDER_TYPES = [
  'freelancer',
  'client',
  'system',
  'owner',
] as const

export type InvoiceMessageSenderType = (typeof ALLOWED_SENDER_TYPES)[number]

const DEFAULT_PAGE = 1
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

async function resolveInvoiceId(context?: RouteContext): Promise<string> {
  if (!context?.params) return ''
  const resolved = await Promise.resolve(context.params)
  return (resolved?.id ?? '').trim()
}

function parsePage(raw: string | null): number {
  if (!raw) return DEFAULT_PAGE
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_PAGE
}

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT
  return Math.min(parsed, MAX_LIMIT)
}

async function resolveOptionalUser(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return null
  }
  const token = authHeader.slice(7).trim()
  if (!token || token.startsWith('cps_') || token.startsWith('lpl_')) {
    return null
  }

  const claims = await verifyAuthToken(token)
  if (!claims) return null

  const user =
    (await prisma.user.findUnique({ where: { privyId: claims.userId } })) ??
    (await prisma.user.findUnique({ where: { id: claims.userId } }))

  return user ?? null
}

function serializeMessage(msg: Record<string, any>) {
  return {
    id: msg.id,
    invoiceId: msg.invoiceId,
    senderId: msg.senderId ?? null,
    senderType: msg.senderType,
    senderName: msg.senderName,
    content: msg.content,
    attachmentUrl: msg.attachmentUrl ?? null,
    isInternal: Boolean(msg.isInternal),
    createdAt: msg.createdAt ? new Date(msg.createdAt).toISOString() : null,
  }
}

/**
 * GET /api/invoices/[id]/messages
 * Lists threaded `InvoiceMessage` rows on an invoice:
 * - Excludes `isInternal: true` messages from any client-facing view of the thread.
 * - Orders messages by `createdAt` ascending and supports pagination (`page`, `limit`).
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const invoiceId = await resolveInvoiceId(context)
    if (!invoiceId) {
      return NextResponse.json(
        { error: 'Invoice ID is required' },
        { status: 400 },
      )
    }

    const invoice =
      typeof prisma.invoice?.findUnique === 'function'
        ? await prisma.invoice.findUnique({ where: { id: invoiceId } })
        : await prisma.invoice.findFirst({ where: { id: invoiceId } })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const user = await resolveOptionalUser(request)
    const { searchParams } = new URL(request.url)
    const viewParam = searchParams.get('view')?.toLowerCase()
    const clientViewParam = searchParams.get('clientView')?.toLowerCase()

    // A request is client-facing if explicitly requested (?view=client / ?clientView=true)
    // or if the caller is not the invoice owner (e.g. guest client or portal viewer)
    const isOwnerView =
      Boolean(user && user.id === invoice.userId) &&
      viewParam !== 'client' &&
      clientViewParam !== 'true'

    const page = parsePage(searchParams.get('page'))
    const limit = parseLimit(searchParams.get('limit'))
    const skip = (page - 1) * limit

    const where: Record<string, unknown> = {
      invoiceId,
      ...(isOwnerView ? {} : { isInternal: false }),
    }

    const rawMessages = ((await prisma.invoiceMessage.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip,
      take: limit,
    })) ?? []) as Array<Record<string, any>>

    // Enforce internal message filtering and createdAt ascending order in memory as well
    const filteredMessages = rawMessages
      .filter((m) => (isOwnerView ? true : !m.isInternal))
      .sort((a, b) => {
        const tA = a.createdAt ? new Date(a.createdAt).getTime() : 0
        const tB = b.createdAt ? new Date(b.createdAt).getTime() : 0
        return tA - tB
      })

    const total =
      typeof prisma.invoiceMessage?.count === 'function'
        ? ((await prisma.invoiceMessage.count({ where })) ??
          filteredMessages.length)
        : filteredMessages.length

    return NextResponse.json({
      invoiceId,
      view: isOwnerView ? 'owner' : 'client',
      messages: filteredMessages.map(serializeMessage),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'GET /api/invoices/[id]/messages error')
    return NextResponse.json(
      { error: 'Failed to fetch invoice messages' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/invoices/[id]/messages
 * Posts a threaded `InvoiceMessage` on an invoice:
 * - Supports `isInternal` messages that are excluded from any client-facing view of the thread.
 * - Validates `senderType` against the allowed set and requires `senderId` when `senderType`
 *   is not a guest client without an account.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const invoiceId = await resolveInvoiceId(context)
    if (!invoiceId) {
      return NextResponse.json(
        { error: 'Invoice ID is required' },
        { status: 400 },
      )
    }

    let body: Record<string, unknown>
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const rawSenderType =
      typeof body.senderType === 'string'
        ? body.senderType.trim().toLowerCase()
        : ''
    if (
      !(ALLOWED_SENDER_TYPES as readonly string[]).includes(rawSenderType)
    ) {
      return NextResponse.json(
        {
          error: `senderType must be one of: ${ALLOWED_SENDER_TYPES.join(', ')}`,
          code: 'INVALID_SENDER_TYPE',
        },
        { status: 400 },
      )
    }
    const senderType = rawSenderType as InvoiceMessageSenderType

    const content = typeof body.content === 'string' ? body.content.trim() : ''
    if (!content) {
      return NextResponse.json(
        {
          error: 'content is required and must be non-empty',
          code: 'CONTENT_REQUIRED',
        },
        { status: 400 },
      )
    }

    const user = await resolveOptionalUser(request)

    // Determine senderId: if explicitly provided in body, use it; otherwise if not explicitly null, fall back to authenticated user
    let senderId: string | null = null
    if (typeof body.senderId === 'string' && body.senderId.trim()) {
      senderId = body.senderId.trim()
    } else if (body.senderId === undefined && user?.id) {
      senderId = user.id
    }

    // Require senderId when senderType is not a guest client without an account
    if (senderType !== 'client' && !senderId) {
      return NextResponse.json(
        {
          error: `senderId is required when senderType is "${senderType}"`,
          code: 'SENDER_ID_REQUIRED',
        },
        { status: 400 },
      )
    }

    const isInternal = Boolean(body.isInternal)
    if (isInternal && senderType === 'client') {
      return NextResponse.json(
        {
          error: 'Clients cannot post internal-only messages',
          code: 'CLIENT_INTERNAL_MESSAGE_FORBIDDEN',
        },
        { status: 403 },
      )
    }

    const invoice =
      typeof prisma.invoice?.findUnique === 'function'
        ? await prisma.invoice.findUnique({ where: { id: invoiceId } })
        : await prisma.invoice.findFirst({ where: { id: invoiceId } })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const senderName =
      typeof body.senderName === 'string' && body.senderName.trim()
        ? body.senderName.trim()
        : user?.name ||
          user?.email ||
          (senderType === 'client'
            ? invoice.clientName || invoice.clientEmail || 'Client'
            : 'Freelancer')

    const attachmentUrl =
      typeof body.attachmentUrl === 'string' && body.attachmentUrl.trim()
        ? body.attachmentUrl.trim()
        : null

    const created = await prisma.invoiceMessage.create({
      data: {
        invoiceId: invoice.id,
        senderId,
        senderType,
        senderName,
        content,
        attachmentUrl,
        isInternal,
      },
    })

    return NextResponse.json(
      {
        message: serializeMessage(created),
      },
      { status: 201 },
    )
  } catch (error) {
    logger?.error?.({ err: error }, 'POST /api/invoices/[id]/messages error')
    return NextResponse.json(
      { error: 'Failed to post invoice message' },
      { status: 500 },
    )
  }
}
