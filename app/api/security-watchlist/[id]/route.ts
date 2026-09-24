import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireComplianceActor } from '@/app/api/_lib/compliance-auth'

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

function isNotFoundError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025'
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const auth = await requireComplianceActor(request)
    if ('response' in auth) return auth.response

    const { id } = await context.params
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    let body: Record<string, unknown>
    try {
      body = await request.json() as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const removalReason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!removalReason) {
      return NextResponse.json({ error: 'removal reason is required' }, { status: 400 })
    }

    const entry = await prisma.securityWatchlist.findUnique({ where: { id } })
    if (!entry) return NextResponse.json({ error: 'Watchlist entry not found' }, { status: 404 })
    const additionReason = entry.reason?.trim() ?? ''
    if (removalReason.toLowerCase() === additionReason.toLowerCase()) {
      return NextResponse.json(
        { error: 'removal reason must be distinct from the addition reason' },
        { status: 400 },
      )
    }

    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.securityWatchlistRemovalAudit.create({
          data: {
            watchlistId: entry.id,
            type: entry.type,
            value: entry.value,
            additionReason: additionReason || 'No addition reason recorded',
            removalReason,
            removedById: auth.actor.id,
          },
        })
        await tx.securityWatchlist.delete({ where: { id: entry.id } })
      })
    } catch (error) {
      if (isNotFoundError(error)) {
        return NextResponse.json({ error: 'Watchlist entry not found' }, { status: 404 })
      }
      throw error
    }

    return NextResponse.json({ removed: true, id: entry.id })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/security-watchlist/[id] error')
    return NextResponse.json({ error: 'Failed to remove security watchlist entry' }, { status: 500 })
  }
}
