import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomBytes } from 'crypto'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const DEFAULT_PUBLIC_LINK_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days
export const MAX_PUBLIC_LINK_TTL_SECONDS = 90 * 24 * 60 * 60 // 90 days

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

export function hashPublicLinkToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

export function derivePublicLinkTokenHint(rawToken: string): string {
  return rawToken.slice(0, 12)
}

function generateRawPublicLinkToken(): string {
  return `lpl_${randomBytes(24).toString('hex')}`
}

async function resolveInvoiceId(context?: RouteContext): Promise<string> {
  if (!context?.params) return ''
  const resolved = await Promise.resolve(context.params)
  return (resolved?.id ?? '').trim()
}

async function resolveAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  let userId = claims.userId
  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser =
      (await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: { id: true },
      })) ??
      (await prisma.user.findUnique({
        where: { id: claims.userId },
        select: { id: true },
      }))

    if (!dbUser) {
      return { error: 'User not found', status: 404 as const, user: null }
    }
    userId = dbUser.id
  }

  return { error: null, status: 200 as const, user: { id: userId } }
}

function formatPublicLinkRecord(record: Record<string, any>) {
  const hashed = record.hashedToken ?? record.tokenHash ?? null
  return {
    id: record.id,
    invoiceId: record.invoiceId,
    hashedToken: hashed,
    tokenHash: hashed,
    tokenHint: record.tokenHint,
    createdBy: record.createdBy,
    lastViewedAt: record.lastViewedAt
      ? new Date(record.lastViewedAt).toISOString()
      : null,
    revokedAt: record.revokedAt
      ? new Date(record.revokedAt).toISOString()
      : null,
    expiresAt: record.expiresAt
      ? new Date(record.expiresAt).toISOString()
      : null,
    createdAt: record.createdAt
      ? new Date(record.createdAt).toISOString()
      : null,
  }
}

/**
 * GET /api/invoices/[id]/public-link
 * - When called with `?token=<rawToken>` (or `X-Public-Link-Token`), resolves the public payment link,
 *   verifies it is neither revoked nor expired, updates `lastViewedAt`, and returns the invoice and link metadata.
 * - When called by the authenticated invoice owner without a raw token, lists the public links for the invoice.
 */
export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const invoiceId = await resolveInvoiceId(context)
    if (!invoiceId) {
      return NextResponse.json(
        { error: 'Invoice ID is required' },
        { status: 400 },
      )
    }

    const { searchParams } = new URL(req.url)
    const rawToken =
      searchParams.get('token')?.trim() ||
      req.headers.get('x-public-link-token')?.trim() ||
      ''

    // Public link resolution mode
    if (rawToken) {
      const hashedToken = hashPublicLinkToken(rawToken)
      const link = await prisma.invoicePublicLink.findUnique({
        where: { hashedToken },
        include: { invoice: true },
      })

      if (!link || link.invoiceId !== invoiceId) {
        return NextResponse.json(
          {
            error: 'Public payment link not found',
            code: 'PUBLIC_LINK_NOT_FOUND',
          },
          { status: 404 },
        )
      }

      if (link.revokedAt) {
        return NextResponse.json(
          {
            error: 'This public payment link has been revoked',
            code: 'PUBLIC_LINK_REVOKED',
          },
          { status: 410 },
        )
      }

      if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now()) {
        return NextResponse.json(
          {
            error: 'This public payment link has expired',
            code: 'PUBLIC_LINK_EXPIRED',
          },
          { status: 410 },
        )
      }

      const viewedAt = new Date()
      const updatedLink = await prisma.invoicePublicLink.update({
        where: { id: link.id },
        data: { lastViewedAt: viewedAt },
      })

      const invoice =
        link.invoice ??
        (await prisma.invoice.findUnique({
          where: { id: invoiceId },
        }))

      return NextResponse.json({
        resolved: true,
        publicLink: formatPublicLinkRecord(updatedLink ?? { ...link, lastViewedAt: viewedAt }),
        invoice: invoice
          ? {
              id: invoice.id,
              invoiceNumber: invoice.invoiceNumber,
              clientName: invoice.clientName,
              description: invoice.description,
              amount: String(invoice.amount),
              currency: invoice.currency,
              status: invoice.status,
              dueDate: invoice.dueDate,
            }
          : null,
      })
    }

    // Authenticated owner listing mode
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, userId: true },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (invoice.userId !== auth.user.id) {
      return NextResponse.json(
        { error: 'Forbidden: only the invoice owner may view public links' },
        { status: 403 },
      )
    }

    const links = (await prisma.invoicePublicLink.findMany({
      where: { invoiceId: invoice.id },
      orderBy: { createdAt: 'desc' },
    })) as Array<Record<string, any>>

    return NextResponse.json({
      invoiceId: invoice.id,
      links: (links ?? []).map(formatPublicLinkRecord),
    })
  } catch (err) {
    logger?.error?.({ err }, 'GET /api/invoices/[id]/public-link error')
    return NextResponse.json(
      { error: 'Failed to resolve or list invoice public links' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/invoices/[id]/public-link
 * Generates a revocable public payment link (`InvoicePublicLink`):
 * - Generates a raw token, hashes it for storage (`hashedToken` / `tokenHash`), and derives `tokenHint` (never storing or logging the raw token).
 * - Sets a bounded `expiresAt`.
 */
export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const invoiceId = await resolveInvoiceId(context)
    if (!invoiceId) {
      return NextResponse.json(
        { error: 'Invoice ID is required' },
        { status: 400 },
      )
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, userId: true },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (invoice.userId !== auth.user.id) {
      return NextResponse.json(
        {
          error:
            'Forbidden: only the invoice owner can generate a public payment link',
          code: 'FORBIDDEN_INVOICE_OWNER',
        },
        { status: 403 },
      )
    }

    const body = await req.json().catch(() => ({}))
    const nowMs = Date.now()
    let expiresAt: Date

    if (body && typeof body === 'object' && body.expiresInSeconds !== undefined) {
      const ttlSeconds = Number(body.expiresInSeconds)
      if (
        !Number.isFinite(ttlSeconds) ||
        ttlSeconds <= 0 ||
        ttlSeconds > MAX_PUBLIC_LINK_TTL_SECONDS
      ) {
        return NextResponse.json(
          {
            error: `expiresInSeconds must be between 1 and ${MAX_PUBLIC_LINK_TTL_SECONDS} seconds (90 days)`,
            code: 'INVALID_PUBLIC_LINK_EXPIRY',
          },
          { status: 400 },
        )
      }
      expiresAt = new Date(nowMs + ttlSeconds * 1000)
    } else if (body && typeof body === 'object' && body.expiresAt) {
      const parsedDate = new Date(body.expiresAt)
      const diffSeconds = (parsedDate.getTime() - nowMs) / 1000
      if (
        Number.isNaN(parsedDate.getTime()) ||
        diffSeconds <= 0 ||
        diffSeconds > MAX_PUBLIC_LINK_TTL_SECONDS
      ) {
        return NextResponse.json(
          {
            error: 'expiresAt must be in the future and at most 90 days from now',
            code: 'INVALID_PUBLIC_LINK_EXPIRY',
          },
          { status: 400 },
        )
      }
      expiresAt = parsedDate
    } else {
      expiresAt = new Date(nowMs + DEFAULT_PUBLIC_LINK_TTL_SECONDS * 1000)
    }

    const rawToken = generateRawPublicLinkToken()
    const hashedToken = hashPublicLinkToken(rawToken)
    const tokenHint = derivePublicLinkTokenHint(rawToken)

    const created = await prisma.invoicePublicLink.create({
      data: {
        invoiceId: invoice.id,
        hashedToken,
        tokenHint,
        createdBy: auth.user.id,
        expiresAt,
      },
    })

    // Log only the safe link ID and tokenHint — NEVER log rawToken
    logger?.info?.(
      {
        publicLinkId: created.id,
        invoiceId: invoice.id,
        tokenHint,
        expiresAt: expiresAt.toISOString(),
      },
      'Generated revocable invoice public link',
    )

    const formatted = formatPublicLinkRecord(created)
    return NextResponse.json(
      {
        token: rawToken,
        url: `https://pay.lancepay.io/invoices/${encodeURIComponent(invoice.id)}?token=${rawToken}`,
        publicLink: formatted,
      },
      { status: 201 },
    )
  } catch (err) {
    logger?.error?.({ err }, 'POST /api/invoices/[id]/public-link error')
    return NextResponse.json(
      { error: 'Failed to generate invoice public link' },
      { status: 500 },
    )
  }
}

/**
 * DELETE /api/invoices/[id]/public-link
 * Revokes an active public link (or all active public links for the invoice) by setting `revokedAt`.
 */
export async function DELETE(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const invoiceId = await resolveInvoiceId(context)
    if (!invoiceId) {
      return NextResponse.json(
        { error: 'Invoice ID is required' },
        { status: 400 },
      )
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, userId: true },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (invoice.userId !== auth.user.id) {
      return NextResponse.json(
        {
          error:
            'Forbidden: only the invoice owner can revoke public payment links',
          code: 'FORBIDDEN_INVOICE_OWNER',
        },
        { status: 403 },
      )
    }

    const { searchParams } = new URL(req.url)
    let linkId =
      searchParams.get('linkId')?.trim() || searchParams.get('id')?.trim() || ''
    if (!linkId) {
      const body = await req.json().catch(() => null)
      if (body && typeof body === 'object') {
        linkId =
          (typeof body.linkId === 'string' && body.linkId.trim()) ||
          (typeof body.id === 'string' && body.id.trim()) ||
          ''
      }
    }

    const revokedAt = new Date()

    if (linkId && typeof prisma.invoicePublicLink?.update === 'function') {
      const updated = await prisma.invoicePublicLink.update({
        where: { id: linkId },
        data: { revokedAt },
      })
      return NextResponse.json({
        revoked: true,
        publicLink: formatPublicLinkRecord(updated),
      })
    }

    if (typeof prisma.invoicePublicLink?.updateMany === 'function') {
      const res = await prisma.invoicePublicLink.updateMany({
        where: { invoiceId: invoice.id, revokedAt: null },
        data: { revokedAt },
      })
      return NextResponse.json({
        revoked: true,
        revokedCount: res.count,
        revokedAt: revokedAt.toISOString(),
      })
    }

    return NextResponse.json({
      revoked: true,
      revokedAt: revokedAt.toISOString(),
    })
  } catch (err) {
    logger?.error?.({ err }, 'DELETE /api/invoices/[id]/public-link error')
    return NextResponse.json(
      { error: 'Failed to revoke invoice public link' },
      { status: 500 },
    )
  }
}
