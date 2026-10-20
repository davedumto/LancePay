import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ bankAccountId: string }> },
) {
  try {
    const { bankAccountId } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const bankAccount = await prisma.bankAccount.findUnique({
      where: { id: bankAccountId },
    })

    if (!bankAccount || bankAccount.userId !== user.id) {
      return NextResponse.json({ error: 'Bank account not found or unauthorized' }, { status: 404 })
    }

    const existingSync = await prisma.bankFeedSync.findUnique({
      where: { bankAccountId },
    })

    if (existingSync && existingSync.status === 'syncing') {
      return NextResponse.json(
        { error: 'A sync is already in progress for this bank account' },
        { status: 409 },
      )
    }

    // Set status to syncing
    const sync = await prisma.bankFeedSync.upsert({
      where: { bankAccountId },
      update: {
        status: 'syncing',
        lastError: null,
      },
      create: {
        userId: user.id,
        bankAccountId,
        status: 'syncing',
        lastError: null,
      },
    })

    try {
      // Simulate/perform sync operation
      const updated = await prisma.bankFeedSync.update({
        where: { id: sync.id },
        data: {
          status: 'idle',
          lastSyncedAt: new Date(),
          lastError: null,
        },
      })

      return NextResponse.json(
        {
          message: 'Bank feed synchronization triggered successfully',
          sync: updated,
        },
        { status: 200 },
      )
    } catch (syncError: any) {
      // Record lastError and ensure status is not stuck in syncing
      await prisma.bankFeedSync.update({
        where: { id: sync.id },
        data: {
          status: 'failed',
          lastError: syncError?.message || 'Sync operation failed',
        },
      })
      throw syncError
    }
  } catch (error) {
    logger.error({ err: error }, 'POST /api/bank-feed-syncs/[bankAccountId]/trigger error')
    return NextResponse.json({ error: 'Failed to trigger bank feed sync' }, { status: 500 })
  }
}
