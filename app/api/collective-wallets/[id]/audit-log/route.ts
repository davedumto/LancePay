import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import {
  SIGNER_USER_SELECT,
  requireWalletActor,
  requireWalletSigner,
} from '@/app/api/_lib/collective-wallet-auth'

type RouteContext = { params: Promise<{ id: string }> }

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

export interface AuditLogEvent {
  id: string
  proposalId: string
  eventType: 'created' | 'signed' | 'executed' | 'cancelled' | 'expired'
  type: string
  actorId: string | null
  actor?: { id: string; name: string | null; email: string } | null
  timestamp: Date
  createdAt: Date
  metadata?: Record<string, unknown> | null
}

/**
 * GET /api/collective-wallets/[id]/audit-log
 * Chronological audit trail of proposal lifecycle events (created, signed, executed, cancelled, expired).
 * Restricts visibility to wallet signers only.
 * Supports cursor-based pagination.
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response

    const { id } = await params
    const access = await requireWalletSigner(id, auth.actor.id)
    if ('response' in access) return access.response

    const { searchParams } = new URL(request.url)
    const cursor = searchParams.get('cursor')?.trim() || null
    const parsedLimit = Number(searchParams.get('limit'))
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(Math.floor(parsedLimit), MAX_LIMIT)
        : DEFAULT_LIMIT

    const proposals = await prisma.multisigProposal.findMany({
      where: { walletId: id },
      include: {
        proposer: { select: SIGNER_USER_SELECT },
        signatures: {
          select: {
            id: true,
            signerId: true,
            createdAt: true,
            signer: { select: SIGNER_USER_SELECT },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    const now = Date.now()
    const events: AuditLogEvent[] = []

    for (const p of proposals) {
      // 1. Created event
      events.push({
        id: `${p.id}-created`,
        proposalId: p.id,
        eventType: 'created',
        type: 'created',
        actorId: p.proposerId,
        actor: p.proposer,
        timestamp: p.createdAt,
        createdAt: p.createdAt,
        metadata: {
          destinationAddress: p.destinationAddress,
          amountUsdc: p.amountUsdc,
          memo: p.memo,
        },
      })

      // 2. Signed events
      for (const sig of p.signatures) {
        events.push({
          id: `${sig.id}-signed`,
          proposalId: p.id,
          eventType: 'signed',
          type: 'signed',
          actorId: sig.signerId,
          actor: sig.signer,
          timestamp: sig.createdAt,
          createdAt: sig.createdAt,
          metadata: { signatureId: sig.id },
        })
      }

      // 3. Executed event
      if (p.status === 'executed' || p.executedAt) {
        const executedTimestamp = p.executedAt ?? p.createdAt
        events.push({
          id: `${p.id}-executed`,
          proposalId: p.id,
          eventType: 'executed',
          type: 'executed',
          actorId: null,
          timestamp: executedTimestamp,
          createdAt: executedTimestamp,
          metadata: { stellarTxHash: p.stellarTxHash },
        })
      }

      // 4. Cancelled event
      if (p.status === 'cancelled') {
        const cancelledTimestamp = p.executedAt ?? p.createdAt
        events.push({
          id: `${p.id}-cancelled`,
          proposalId: p.id,
          eventType: 'cancelled',
          type: 'cancelled',
          actorId: null,
          timestamp: cancelledTimestamp,
          createdAt: cancelledTimestamp,
          metadata: {},
        })
      }

      // 5. Expired event
      const isExpired =
        p.status === 'expired' ||
        (p.status !== 'executed' && p.status !== 'cancelled' && p.expiresAt.getTime() <= now)

      if (isExpired) {
        events.push({
          id: `${p.id}-expired`,
          proposalId: p.id,
          eventType: 'expired',
          type: 'expired',
          actorId: null,
          timestamp: p.expiresAt,
          createdAt: p.expiresAt,
          metadata: { expiresAt: p.expiresAt },
        })
      }
    }

    // Chronological order (oldest to newest)
    events.sort((a, b) => {
      const diff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      if (diff !== 0) return diff
      return a.id.localeCompare(b.id)
    })

    let startIndex = 0
    if (cursor) {
      const cursorIndex = events.findIndex((e) => e.id === cursor)
      if (cursorIndex !== -1) {
        startIndex = cursorIndex + 1
      }
    }

    const page = events.slice(startIndex, startIndex + limit)
    const hasMore = startIndex + limit < events.length
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].id : null

    return NextResponse.json({
      events: page,
      nextCursor,
      hasMore,
      total: events.length,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/collective-wallets/[id]/audit-log error')
    return NextResponse.json({ error: 'Failed to fetch audit log' }, { status: 500 })
  }
}
