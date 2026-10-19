import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { verifyAuthToken } from '@/lib/auth'

export type AdminTier = 'tier1' | 'tier2' | 'superadmin'

export interface ActivityEvent {
  id: string
  source: 'audit_log' | 'invoice_ledger' | 'withdrawal_ledger' | 'compliance_ledger' | 'session'
  type: string
  timestamp: string
  title: string
  description?: string
  metadata?: Record<string, unknown>
}

function maskIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined
  const parts = ip.split('.')
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.***.***`
  }
  return '***.***.***.***'
}

function maskEmail(email: string | undefined): string | undefined {
  if (!email) return undefined
  const [local, domain] = email.split('@')
  if (!local || !domain) return undefined
  return `${local.charAt(0)}***@${domain}`
}

export function maskEventForTier(
  event: ActivityEvent,
  tier: AdminTier,
): ActivityEvent {
  if (tier === 'superadmin') {
    return event
  }

  const maskedMeta = event.metadata ? { ...event.metadata } : {}

  if (typeof maskedMeta.ip === 'string') {
    maskedMeta.ip = maskIp(maskedMeta.ip)
  }
  if (typeof maskedMeta.ipAddress === 'string') {
    maskedMeta.ipAddress = maskIp(maskedMeta.ipAddress)
  }
  if (typeof maskedMeta.email === 'string') {
    maskedMeta.email = maskEmail(maskedMeta.email)
  }
  if (typeof maskedMeta.clientEmail === 'string') {
    maskedMeta.clientEmail = maskEmail(maskedMeta.clientEmail)
  }

  // Redact internal secrets, auth tokens, signatures
  if ('signature' in maskedMeta) maskedMeta.signature = '***'
  if ('token' in maskedMeta) maskedMeta.token = '***'
  if ('secret' in maskedMeta) maskedMeta.secret = '***'

  return {
    ...event,
    metadata: maskedMeta,
  }
}

async function getAuthenticatedAdmin(
  request: NextRequest,
): Promise<{ id: string; email: string; tier: AdminTier } | null> {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null

  const claims = await verifyAuthToken(authToken)
  if (!claims?.userId) return null

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, email: true, role: true },
  })

  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
    return null
  }

  let tier: AdminTier = user.role === 'superadmin' ? 'superadmin' : 'tier1'
  const headerTier = request.headers.get('x-admin-tier')?.toLowerCase()
  if (headerTier === 'superadmin' && user.role === 'superadmin') {
    tier = 'superadmin'
  } else if (headerTier === 'tier2') {
    tier = 'tier2'
  } else if (headerTier === 'tier1') {
    tier = 'tier1'
  }

  return { id: user.id, email: user.email, tier }
}

/**
 * GET /api/admin/activity-timeline/[userId]
 *
 * Produces a unified chronological timeline across sessions, invoices,
 * payouts, and compliance events for a user.
 * - Collates events from audit log, invoice ledger, withdrawal ledger, and compliance ledger.
 * - Masks sensitive fields according to the caller's admin tier.
 * - Paginates by cursor for efficient, bounded scrolling.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const { userId } = await params
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      return NextResponse.json({ error: 'User ID is required' }, { status: 400 })
    }

    const admin = await getAuthenticatedAdmin(request)
    if (!admin) {
      return NextResponse.json(
        { error: 'Forbidden: admin access required', code: 'FORBIDDEN' },
        { status: 403 },
      )
    }

    // Verify target user exists
    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    })
    if (!targetUser) {
      return NextResponse.json({ error: 'User not found', code: 'USER_NOT_FOUND' }, { status: 404 })
    }

    const { searchParams } = new URL(request.url)
    const cursor = searchParams.get('cursor')
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '20', 10) || 20, 1), 100)

    let cursorTimestamp: Date | undefined
    let cursorId: string | undefined

    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
        if (decoded.timestamp) cursorTimestamp = new Date(decoded.timestamp)
        if (decoded.id) cursorId = decoded.id
      } catch {
        return NextResponse.json({ error: 'Invalid pagination cursor', code: 'INVALID_CURSOR' }, { status: 400 })
      }
    }

    // 1. Audit Log Events
    const auditEvents = await prisma.auditEvent.findMany({
      where: {
        OR: [{ actorId: userId }, { invoice: { userId } }],
      },
      orderBy: { createdAt: 'desc' },
      take: limit * 2,
      select: {
        id: true,
        eventType: true,
        metadata: true,
        createdAt: true,
      },
    })

    // 2. Invoice Ledger Events
    const invoices = await prisma.invoice.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit * 2,
      select: {
        id: true,
        invoiceNumber: true,
        amount: true,
        currency: true,
        status: true,
        clientEmail: true,
        createdAt: true,
      },
    })

    // 3. Withdrawal Ledger Events
    const withdrawals = await prisma.withdrawalTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit * 2,
      select: {
        id: true,
        amount: true,
        asset: true,
        status: true,
        anchorId: true,
        createdAt: true,
      },
    })

    // 4. Compliance Ledger Events (sanctions & structuring flags)
    const [sanctions, structuringFlags] = await Promise.all([
      prisma.sanctionsScreening.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit * 2,
        select: {
          id: true,
          status: true,
          provider: true,
          createdAt: true,
        },
      }),
      prisma.structuringFlag.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit * 2,
        select: {
          id: true,
          status: true,
          reason: true,
          createdAt: true,
        },
      }),
    ])

    // 5. User Sessions
    const sessions = await prisma.userSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit * 2,
      select: {
        id: true,
        deviceLabel: true,
        userAgent: true,
        ipAddress: true,
        createdAt: true,
      },
    })

    // Collate into unified timeline
    const allEvents: ActivityEvent[] = []

    for (const a of auditEvents) {
      allEvents.push({
        id: a.id,
        source: 'audit_log',
        type: a.eventType,
        timestamp: a.createdAt.toISOString(),
        title: `Audit: ${a.eventType}`,
        metadata: (a.metadata && typeof a.metadata === 'object' ? a.metadata : {}) as Record<string, unknown>,
      })
    }

    for (const inv of invoices) {
      allEvents.push({
        id: inv.id,
        source: 'invoice_ledger',
        type: `invoice_${inv.status.toLowerCase()}`,
        timestamp: inv.createdAt.toISOString(),
        title: `Invoice ${inv.invoiceNumber} (${inv.status})`,
        metadata: {
          amount: inv.amount.toString(),
          currency: inv.currency,
          clientEmail: inv.clientEmail,
        },
      })
    }

    for (const w of withdrawals) {
      allEvents.push({
        id: w.id,
        source: 'withdrawal_ledger',
        type: `withdrawal_${w.status.toLowerCase()}`,
        timestamp: w.createdAt.toISOString(),
        title: `Withdrawal ${w.amount.toString()} ${w.asset} via ${w.anchorId}`,
        metadata: {
          amount: w.amount.toString(),
          asset: w.asset,
          status: w.status,
          anchorId: w.anchorId,
        },
      })
    }

    for (const s of sanctions) {
      allEvents.push({
        id: s.id,
        source: 'compliance_ledger',
        type: 'sanctions_screening',
        timestamp: s.createdAt.toISOString(),
        title: `Sanctions screening (${s.status})`,
        metadata: {
          status: s.status,
          provider: s.provider,
        },
      })
    }

    for (const sf of structuringFlags) {
      allEvents.push({
        id: sf.id,
        source: 'compliance_ledger',
        type: 'structuring_flag',
        timestamp: sf.createdAt.toISOString(),
        title: `Structuring Flag: ${sf.reason}`,
        metadata: {
          status: sf.status,
          reason: sf.reason,
        },
      })
    }

    for (const sess of sessions) {
      allEvents.push({
        id: sess.id,
        source: 'session',
        type: 'session_login',
        timestamp: sess.createdAt.toISOString(),
        title: `Session created: ${sess.deviceLabel || 'Unknown Device'}`,
        metadata: {
          ipAddress: sess.ipAddress,
          userAgent: sess.userAgent,
        },
      })
    }

    // Sort collated stream descending by timestamp
    allEvents.sort((x, y) => {
      const diff = new Date(y.timestamp).getTime() - new Date(x.timestamp).getTime()
      if (diff !== 0) return diff
      return y.id.localeCompare(x.id)
    })

    // Apply cursor filtering if cursor provided
    let filteredEvents = allEvents
    if (cursorTimestamp) {
      filteredEvents = allEvents.filter((e) => {
        const t = new Date(e.timestamp).getTime()
        const c = cursorTimestamp!.getTime()
        if (t < c) return true
        if (t === c && cursorId) return e.id < cursorId
        return false
      })
    }

    const paginatedEvents = filteredEvents.slice(0, limit)
    const hasMore = filteredEvents.length > limit

    let nextCursor: string | null = null
    if (hasMore && paginatedEvents.length > 0) {
      const last = paginatedEvents[paginatedEvents.length - 1]
      nextCursor = Buffer.from(
        JSON.stringify({ timestamp: last.timestamp, id: last.id }),
      ).toString('base64url')
    }

    // Mask sensitive fields based on caller's admin tier
    const maskedEvents = paginatedEvents.map((event) =>
      maskEventForTier(event, admin.tier),
    )

    logger.info(
      { adminId: admin.id, targetUserId: userId, returnedCount: maskedEvents.length, tier: admin.tier },
      'GET /api/admin/activity-timeline/[userId] succeeded',
    )

    return NextResponse.json({
      userId,
      events: maskedEvents,
      nextCursor,
      hasMore,
      adminTier: admin.tier,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/admin/activity-timeline/[userId] error')
    return NextResponse.json({ error: 'Failed to fetch activity timeline' }, { status: 500 })
  }
}
