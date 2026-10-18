import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export type AdminTier = 'tier_1' | 'tier_2' | 'tier_3'

export type TimelineSource =
  | 'audit_log'
  | 'invoice_ledger'
  | 'withdrawal_ledger'
  | 'compliance_ledger'

export interface TimelineEvent {
  id: string
  recordId: string
  source: TimelineSource
  eventType: string
  timestamp: string
  summary: string
  details: Record<string, unknown>
}

export const DEFAULT_PAGE_LIMIT = 20
export const MAX_PAGE_LIMIT = 100

function resolveAdminTier(
  role: string | null | undefined,
  explicitTier?: string | null,
): AdminTier | null {
  const tierNorm = (explicitTier ?? '').trim().toLowerCase()
  const roleNorm = (role ?? '').trim().toLowerCase()

  if (
    tierNorm === 'tier_3' ||
    tierNorm === '3' ||
    roleNorm === 'super_admin' ||
    roleNorm === 'compliance_admin' ||
    roleNorm === 'admin_tier_3'
  ) {
    return 'tier_3'
  }

  if (
    tierNorm === 'tier_1' ||
    tierNorm === '1' ||
    roleNorm === 'support_admin' ||
    roleNorm === 'readonly_admin' ||
    roleNorm === 'admin_tier_1'
  ) {
    return 'tier_1'
  }

  if (
    tierNorm === 'tier_2' ||
    tierNorm === '2' ||
    roleNorm === 'admin' ||
    roleNorm === 'ops_admin' ||
    roleNorm === 'admin_tier_2'
  ) {
    return 'tier_2'
  }

  return null
}

async function authenticateAdminWithTier(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, admin: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, admin: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, admin: null }
  }

  let role = (claims as { role?: string | null }).role ?? null
  let claimTier = (claims as { adminTier?: string | null; tier?: string | null }).adminTier ??
    (claims as { tier?: string | null }).tier ??
    null
  let adminId = claims.userId

  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser =
      (await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: { id: true, role: true },
      })) ??
      (await prisma.user.findUnique({
        where: { id: claims.userId },
        select: { id: true, role: true },
      }))

    if (dbUser) {
      adminId = dbUser.id
      role = dbUser.role ?? role
    }
  }

  const headerTier = req.headers.get('x-admin-tier')
  if (headerTier && !claimTier) {
    claimTier = headerTier
  }

  const tier = resolveAdminTier(role, claimTier)
  if (!tier) {
    return {
      error: 'Forbidden: Admin access required',
      status: 403 as const,
      admin: null,
    }
  }

  return {
    error: null,
    status: 200 as const,
    admin: { id: adminId, role: role ?? 'admin', tier },
  }
}

export function maskEmailValue(email: unknown): string | null {
  if (typeof email !== 'string' || !email.includes('@')) return null
  const [local, domain] = email.split('@')
  if (!local || !domain) return '***'
  return `${local[0]}***@${domain}`
}

export function maskAddressOrHash(val: unknown): string | null {
  if (typeof val !== 'string' || !val) return null
  if (val.length <= 8) return '****'
  return `${val.slice(0, 4)}...${val.slice(-4)}`
}

export function maskIpValue(ip: unknown): string | null {
  if (typeof ip !== 'string' || !ip) return null
  const parts = ip.split('.')
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.***.***`
  }
  return '***'
}

export function maskDetailsForTier(
  source: TimelineSource,
  details: Record<string, unknown>,
  tier: AdminTier,
): Record<string, unknown> {
  if (tier === 'tier_3') {
    return { ...details }
  }

  const masked: Record<string, unknown> = { ...details }

  // Tier 2 and Tier 1 both mask elevated compliance fields
  if (source === 'compliance_ledger') {
    if ('caseReference' in masked && masked.caseReference != null) {
      masked.caseReference = '[REDACTED_TIER_3]'
    }
    if ('matchScore' in masked) {
      masked.matchScore = null
    }
    if ('signals' in masked) {
      masked.signals = null
    }
  }

  if (tier === 'tier_2') {
    return masked
  }

  // Tier 1 (lowest support tier) additionally masks PII, addresses, tx hashes, and compliance reasons
  if ('clientEmail' in masked && masked.clientEmail) {
    masked.clientEmail = maskEmailValue(masked.clientEmail)
  }
  if ('actorEmail' in masked && masked.actorEmail) {
    masked.actorEmail = maskEmailValue(masked.actorEmail)
  }
  if ('ip' in masked && masked.ip) {
    masked.ip = maskIpValue(masked.ip)
  }
  if ('ipAddress' in masked && masked.ipAddress) {
    masked.ipAddress = maskIpValue(masked.ipAddress)
  }
  if ('withdrawAddress' in masked && masked.withdrawAddress) {
    masked.withdrawAddress = maskAddressOrHash(masked.withdrawAddress)
  }
  if ('stellarTxHash' in masked && masked.stellarTxHash) {
    masked.stellarTxHash = maskAddressOrHash(masked.stellarTxHash)
  }
  if ('txHash' in masked && masked.txHash) {
    masked.txHash = maskAddressOrHash(masked.txHash)
  }
  if (source === 'compliance_ledger' && 'reason' in masked && masked.reason) {
    masked.reason = '[MASKED_FOR_TIER_1]'
  }

  return masked
}

export function encodeCursor(timestamp: string, id: string): string {
  return Buffer.from(JSON.stringify({ timestamp, id }), 'utf8').toString(
    'base64url',
  )
}

export function decodeCursor(
  cursorStr: string,
): { timestamp: string; id: string } | null {
  try {
    const raw = Buffer.from(cursorStr, 'base64url').toString('utf8')
    const parsed = JSON.parse(raw) as { timestamp?: unknown; id?: unknown }
    if (
      typeof parsed.timestamp !== 'string' ||
      typeof parsed.id !== 'string' ||
      Number.isNaN(new Date(parsed.timestamp).getTime())
    ) {
      return null
    }
    return { timestamp: parsed.timestamp, id: parsed.id }
  } catch {
    return null
  }
}

function toIsoString(d: unknown): string {
  if (d instanceof Date) return d.toISOString()
  if (typeof d === 'string') {
    const ms = new Date(d).getTime()
    if (!Number.isNaN(ms)) return new Date(ms).toISOString()
  }
  return new Date(0).toISOString()
}

/**
 * GET /api/admin/activity-timeline/[userId]
 * Renders a unified chronological timeline of actions for a user across:
 * 1. Audit log (`auditEvent` / `auditLog`)
 * 2. Invoice ledger (`invoice`)
 * 3. Withdrawal ledger (`withdrawalTransaction`)
 * 4. Compliance ledger (`structuringFlag`, `sanctionsScreening`, `riskAssessment`)
 * Masks sensitive fields according to the caller's admin tier and paginates by cursor.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ userId: string }> | { userId: string } },
) {
  try {
    const auth = await authenticateAdminWithTier(req)
    if (auth.error || !auth.admin) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const resolvedParams = await Promise.resolve(context.params)
    const userId = resolvedParams?.userId?.trim() || ''
    if (!userId) {
      return NextResponse.json(
        { error: 'userId route parameter is required' },
        { status: 400 },
      )
    }

    const { searchParams } = new URL(req.url)
    const rawLimit = searchParams.get('limit')
    const limit =
      rawLimit !== null ? parseInt(rawLimit, 10) : DEFAULT_PAGE_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
      return NextResponse.json(
        { error: `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}` },
        { status: 400 },
      )
    }

    const cursorParam = searchParams.get('cursor')?.trim() || null
    const decodedCursor = cursorParam ? decodeCursor(cursorParam) : null
    if (cursorParam && !decodedCursor) {
      return NextResponse.json(
        { error: 'Invalid pagination cursor', code: 'INVALID_CURSOR' },
        { status: 400 },
      )
    }

    const db = prisma as unknown as {
      auditEvent?: {
        findMany: (args: unknown) => Promise<Record<string, any>[]>
      }
      auditLog?: {
        findMany: (args: unknown) => Promise<Record<string, any>[]>
      }
      invoice?: {
        findMany: (args: unknown) => Promise<Record<string, any>[]>
      }
      withdrawalTransaction?: {
        findMany: (args: unknown) => Promise<Record<string, any>[]>
      }
      structuringFlag?: {
        findMany: (args: unknown) => Promise<Record<string, any>[]>
      }
      sanctionsScreening?: {
        findMany?: (args: unknown) => Promise<Record<string, any>[]>
        findUnique?: (args: unknown) => Promise<Record<string, any> | null>
      }
      riskAssessment?: {
        findMany: (args: unknown) => Promise<Record<string, any>[]>
      }
    }

    const [
      auditEvents,
      auditLogs,
      invoices,
      withdrawals,
      structuringFlags,
      sanctionsRows,
      riskAssessments,
    ] = await Promise.all([
      db.auditEvent?.findMany
        ? db.auditEvent.findMany({
            where: {
              OR: [{ actorId: userId }, { invoice: { userId } }],
            },
          })
        : Promise.resolve([]),
      db.auditLog?.findMany
        ? db.auditLog.findMany({
            where: { actorId: userId },
          })
        : Promise.resolve([]),
      db.invoice?.findMany
        ? db.invoice.findMany({ where: { userId } })
        : Promise.resolve([]),
      db.withdrawalTransaction?.findMany
        ? db.withdrawalTransaction.findMany({ where: { userId } })
        : Promise.resolve([]),
      db.structuringFlag?.findMany
        ? db.structuringFlag.findMany({ where: { userId } })
        : Promise.resolve([]),
      db.sanctionsScreening?.findMany
        ? db.sanctionsScreening.findMany({ where: { userId } })
        : db.sanctionsScreening?.findUnique
          ? db.sanctionsScreening
              .findUnique({ where: { userId } })
              .then((r) => (r ? [r] : []))
          : Promise.resolve([]),
      db.riskAssessment?.findMany
        ? db.riskAssessment.findMany({
            where: { entityType: 'user', entityId: userId },
          })
        : Promise.resolve([]),
    ])

    const events: TimelineEvent[] = []

    for (const ae of auditEvents ?? []) {
      const meta =
        ae.metadata && typeof ae.metadata === 'object'
          ? (ae.metadata as Record<string, unknown>)
          : {}
      events.push({
        id: `audit_log:${ae.id}`,
        recordId: String(ae.id),
        source: 'audit_log',
        eventType: String(ae.eventType ?? 'audit.event'),
        timestamp: toIsoString(ae.createdAt),
        summary: `Audit event ${ae.eventType ?? 'recorded'}`,
        details: maskDetailsForTier(
          'audit_log',
          {
            invoiceId: ae.invoiceId ?? null,
            actorId: ae.actorId ?? null,
            ...meta,
          },
          auth.admin.tier,
        ),
      })
    }

    for (const al of auditLogs ?? []) {
      const meta =
        al.metadata && typeof al.metadata === 'object'
          ? (al.metadata as Record<string, unknown>)
          : {}
      events.push({
        id: `audit_log:${al.id}`,
        recordId: String(al.id),
        source: 'audit_log',
        eventType: String(al.action ?? 'audit.log'),
        timestamp: toIsoString(al.createdAt),
        summary: `Audit log ${al.action ?? 'recorded'}`,
        details: maskDetailsForTier(
          'audit_log',
          {
            actorId: al.actorId ?? null,
            actorEmail: al.actorEmail ?? null,
            resourceType: al.resourceType ?? null,
            resourceId: al.resourceId ?? null,
            ...meta,
          },
          auth.admin.tier,
        ),
      })
    }

    for (const inv of invoices ?? []) {
      events.push({
        id: `invoice_ledger:${inv.id}`,
        recordId: String(inv.id),
        source: 'invoice_ledger',
        eventType: `invoice.${inv.status ?? 'created'}`,
        timestamp: toIsoString(inv.createdAt),
        summary: `Invoice ${inv.invoiceNumber ?? inv.id} (${inv.status ?? 'pending'})`,
        details: maskDetailsForTier(
          'invoice_ledger',
          {
            invoiceNumber: inv.invoiceNumber,
            amount: inv.amount !== undefined ? Number(inv.amount) : null,
            currency: inv.currency ?? 'USD',
            status: inv.status ?? 'pending',
            clientEmail: inv.clientEmail ?? null,
            clientName: inv.clientName ?? null,
          },
          auth.admin.tier,
        ),
      })
    }

    for (const wd of withdrawals ?? []) {
      events.push({
        id: `withdrawal_ledger:${wd.id}`,
        recordId: String(wd.id),
        source: 'withdrawal_ledger',
        eventType: `withdrawal.${wd.status ?? 'pending'}`,
        timestamp: toIsoString(wd.createdAt),
        summary: `Withdrawal of ${wd.amount} ${wd.asset ?? 'USDC'} via ${wd.anchorId ?? 'anchor'}`,
        details: maskDetailsForTier(
          'withdrawal_ledger',
          {
            anchorId: wd.anchorId,
            amount: wd.amount !== undefined ? Number(wd.amount) : null,
            asset: wd.asset ?? 'USDC',
            status: wd.status ?? 'pending',
            withdrawAddress: wd.withdrawAddress ?? null,
            stellarTxHash: wd.stellarTxHash ?? null,
          },
          auth.admin.tier,
        ),
      })
    }

    for (const sf of structuringFlags ?? []) {
      events.push({
        id: `compliance_ledger:sf_${sf.id}`,
        recordId: String(sf.id),
        source: 'compliance_ledger',
        eventType: `compliance.structuring_flag.${sf.status ?? 'open'}`,
        timestamp: toIsoString(sf.createdAt),
        summary: `Structuring flag (${sf.status ?? 'open'})`,
        details: maskDetailsForTier(
          'compliance_ledger',
          {
            status: sf.status ?? 'open',
            reason: sf.reason ?? null,
            totalAmount:
              sf.totalAmount !== undefined && sf.totalAmount !== null
                ? Number(sf.totalAmount)
                : null,
            caseReference: sf.caseReference ?? null,
          },
          auth.admin.tier,
        ),
      })
    }

    for (const ss of sanctionsRows ?? []) {
      events.push({
        id: `compliance_ledger:ss_${ss.id}`,
        recordId: String(ss.id),
        source: 'compliance_ledger',
        eventType: `compliance.sanctions_screening.${ss.status ?? 'screened'}`,
        timestamp: toIsoString(ss.screenedAt ?? ss.createdAt),
        summary: `Sanctions screening (${ss.status ?? 'clear'})`,
        details: maskDetailsForTier(
          'compliance_ledger',
          {
            status: ss.status,
            provider: ss.provider,
            matchScore: ss.matchScore ?? null,
          },
          auth.admin.tier,
        ),
      })
    }

    for (const ra of riskAssessments ?? []) {
      events.push({
        id: `compliance_ledger:ra_${ra.id}`,
        recordId: String(ra.id),
        source: 'compliance_ledger',
        eventType: `compliance.risk_assessment.${ra.status ?? 'logged'}`,
        timestamp: toIsoString(ra.createdAt),
        summary: `Risk assessment score ${ra.riskScore}`,
        details: maskDetailsForTier(
          'compliance_ledger',
          {
            riskScore: ra.riskScore,
            status: ra.status ?? 'logged',
            signals: ra.signals ?? null,
          },
          auth.admin.tier,
        ),
      })
    }

    // Sort descending by timestamp, tie-breaking deterministically by id ascending
    events.sort((a, b) => {
      const timeDiff =
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      if (timeDiff !== 0) return timeDiff
      return a.id.localeCompare(b.id)
    })

    // Apply cursor filter if provided
    let filtered = events
    if (decodedCursor) {
      const cursorTime = new Date(decodedCursor.timestamp).getTime()
      filtered = events.filter((ev) => {
        const evTime = new Date(ev.timestamp).getTime()
        if (evTime < cursorTime) return true
        if (evTime === cursorTime && ev.id.localeCompare(decodedCursor.id) > 0) {
          return true
        }
        return false
      })
    }

    const pageItems = filtered.slice(0, limit)
    const hasMore = filtered.length > limit
    const lastItem = pageItems[pageItems.length - 1]
    const nextCursor =
      hasMore && lastItem ? encodeCursor(lastItem.timestamp, lastItem.id) : null

    return NextResponse.json({
      userId,
      adminTier: auth.admin.tier,
      timeline: pageItems,
      pagination: {
        limit,
        nextCursor,
        hasMore,
        totalReturned: pageItems.length,
      },
    })
  } catch (err) {
    logger?.error?.({ err }, 'GET /api/admin/activity-timeline/[userId] error')
    return NextResponse.json(
      { error: 'Failed to render user activity timeline' },
      { status: 500 },
    )
  }
}
