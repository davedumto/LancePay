import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateToken, hashToken } from '@/lib/crypto'
import { logger } from '@/lib/logger'

const DEFAULT_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30 // 30 days
const MAX_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 365 // 365 days

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

function parseExpiresInSeconds(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new Error('expiresInSeconds must be a positive number')
  }
  if (raw > MAX_EXPIRES_IN_SECONDS) {
    throw new Error(`expiresInSeconds must be ${MAX_EXPIRES_IN_SECONDS} or fewer`)
  }
  return Math.floor(raw)
}

async function findOwnedInvoice(invoiceId: string, userId: string) {
  return prisma.invoice.findFirst({
    where: { id: invoiceId, userId },
    select: { id: true },
  })
}

/**
 * GET /api/invoices/[id]/public-link
 * Get the public link for an invoice.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: invoiceId } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!invoiceId || !invoiceId.trim()) {
      return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 })
    }

    const invoice = await findOwnedInvoice(invoiceId, user.id)
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const publicLink = await prisma.invoicePublicLink.findFirst({
      where: { invoiceId },
      select: {
        id: true,
        tokenHint: true,
        lastViewedAt: true,
        revokedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    })

    if (!publicLink) {
      return NextResponse.json({ error: 'Public link not found' }, { status: 404 })
    }

    return NextResponse.json({
      publicLink: {
        id: publicLink.id,
        tokenHint: publicLink.tokenHint,
        lastViewedAt: publicLink.lastViewedAt ? publicLink.lastViewedAt.toISOString() : null,
        revokedAt: publicLink.revokedAt ? publicLink.revokedAt.toISOString() : null,
        expiresAt: publicLink.expiresAt ? publicLink.expiresAt.toISOString() : null,
        createdAt: publicLink.createdAt.toISOString(),
        status: publicLink.revokedAt
          ? 'revoked'
          : publicLink.expiresAt && publicLink.expiresAt.getTime() <= Date.now()
            ? 'expired'
            : 'active',
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/invoices/[id]/public-link error')
    return NextResponse.json({ error: 'Failed to fetch public link' }, { status: 500 })
  }
}

/**
 * POST /api/invoices/[id]/public-link
 * Create a new public link for an invoice.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: invoiceId } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!invoiceId || !invoiceId.trim()) {
      return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 })
    }

    const invoice = await findOwnedInvoice(invoiceId, user.id)
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      body = {}
    }

    const payload = (body ?? {}) as Record<string, unknown>
    const { expiresInSeconds } = payload

    let expiresAt: Date | null
    try {
      const parsedExpires = parseExpiresInSeconds(expiresInSeconds)
      expiresAt = parsedExpires ? new Date(Date.now() + parsedExpires * 1000) : new Date(Date.now() + DEFAULT_EXPIRES_IN_SECONDS * 1000)
    } catch (error) {
      return NextResponse.json({ error: (error as Error).message }, { status: 400 })
    }

    const token = generateToken()
    const hashedToken = hashToken(token)
    const tokenHint = token.slice(-8)

    const publicLink = await prisma.invoicePublicLink.create({
      data: {
        invoiceId,
        hashedToken,
        tokenHint,
        createdBy: user.id,
        expiresAt,
      },
      select: {
        id: true,
        tokenHint: true,
        expiresAt: true,
        createdAt: true,
      },
    })

    return NextResponse.json(
      {
        publicLink: {
          id: publicLink.id,
          token,
          tokenHint: publicLink.tokenHint,
          expiresAt: publicLink.expiresAt ? publicLink.expiresAt.toISOString() : null,
          createdAt: publicLink.createdAt.toISOString(),
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/invoices/[id]/public-link error')
    return NextResponse.json({ error: 'Failed to create public link' }, { status: 500 })
  }
}
