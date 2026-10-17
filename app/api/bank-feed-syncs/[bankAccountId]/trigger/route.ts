import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

function extractToken(req: NextRequest): string | null {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice(7).trim() || null
}

async function resolveAuthenticatedUserId(req: NextRequest): Promise<string | null> {
  const token = extractToken(req)
  if (!token) return null
  const claims = await verifyAuthToken(token)
  if (!claims) return null

  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (dbUser?.id) return dbUser.id
  }

  return claims.userId
}

/**
 * POST /api/bank-feed-syncs/[bankAccountId]/trigger
 * Manually triggers a bank feed synchronization for a specific bank account.
 * - Rejects concurrent syncs when status is already 'syncing' (409).
 * - Updates existing BankFeedSync row by bankAccountId (or creates initial row) without duplicates.
 * - Transitions status to 'syncing' during execution, then 'idle' with lastSyncedAt on success.
 * - Catches any sync failure and records status='error' + lastError so status is never left stuck in 'syncing'.
 */
export async function POST(
  req: NextRequest,
  {
    params,
  }: {
    params: { bankAccountId: string } | Promise<{ bankAccountId: string }>
  },
) {
  let activeBankAccountId: string | null = null
  let syncEnteredInProgress = false

  try {
    const userId = await resolveAuthenticatedUserId(req)
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const resolvedParams = await Promise.resolve(params)
    const bankAccountId = resolvedParams.bankAccountId?.trim()
    if (!bankAccountId) {
      return NextResponse.json(
        { error: 'bankAccountId is required' },
        { status: 400 },
      )
    }

    const bankAccount = await prisma.bankAccount.findUnique({
      where: { id: bankAccountId },
    })

    if (!bankAccount) {
      return NextResponse.json(
        { error: 'Bank account not found' },
        { status: 404 },
      )
    }

    if (bankAccount.userId !== userId) {
      return NextResponse.json(
        { error: 'Forbidden: You do not own this bank account' },
        { status: 403 },
      )
    }

    const existingSync = await prisma.bankFeedSync.findUnique({
      where: { bankAccountId },
    })

    if (existingSync && existingSync.status === 'syncing') {
      return NextResponse.json(
        {
          error: 'A bank feed synchronization is already in progress for this account',
          code: 'SYNC_IN_PROGRESS',
          syncId: existingSync.id,
          bankAccountId,
          status: existingSync.status,
        },
        { status: 409 },
      )
    }

    activeBankAccountId = bankAccountId

    // Transition to 'syncing' by updating the existing row (enforcing unique bankAccountId)
    // or creating the initial row if none exists yet.
    const syncingRecord = existingSync
      ? await prisma.bankFeedSync.update({
          where: { bankAccountId },
          data: {
            status: 'syncing',
            lastError: null,
          },
        })
      : await prisma.bankFeedSync.create({
          data: {
            userId,
            bankAccountId,
            status: 'syncing',
            lastError: null,
          },
        })

    syncEnteredInProgress = true

    try {
      const syncedAt = new Date()

      // Update any corresponding active PlaidAccount's lastSyncedAt timestamp if present
      if (typeof prisma.plaidAccount?.updateMany === 'function') {
        await prisma.plaidAccount.updateMany({
          where: {
            userId,
            institutionName: bankAccount.bankName,
            status: 'active',
          },
          data: { lastSyncedAt: syncedAt },
        })
      }

      const completedSync = await prisma.bankFeedSync.update({
        where: { bankAccountId },
        data: {
          status: 'idle',
          lastSyncedAt: syncedAt,
          lastError: null,
        },
      })

      syncEnteredInProgress = false

      logger?.info?.(
        { userId, bankAccountId, syncId: completedSync.id },
        'POST /api/bank-feed-syncs/[bankAccountId]/trigger completed',
      )

      return NextResponse.json({
        sync: completedSync,
        syncId: completedSync.id,
        bankAccountId: completedSync.bankAccountId,
        status: completedSync.status,
        lastSyncedAt: completedSync.lastSyncedAt,
        lastError: completedSync.lastError,
      })
    } catch (syncErr) {
      const errorMessage =
        syncErr instanceof Error ? syncErr.message : 'Bank feed synchronization failed'

      const failedSync = await prisma.bankFeedSync.update({
        where: { bankAccountId },
        data: {
          status: 'error',
          lastError: errorMessage,
        },
      })

      syncEnteredInProgress = false

      logger?.error?.(
        { err: syncErr, userId, bankAccountId },
        'POST /api/bank-feed-syncs/[bankAccountId]/trigger sync failed',
      )

      return NextResponse.json(
        {
          error: errorMessage,
          syncId: failedSync.id,
          bankAccountId: failedSync.bankAccountId,
          status: failedSync.status,
          lastError: failedSync.lastError,
        },
        { status: 502 },
      )
    }
  } catch (err) {
    if (syncEnteredInProgress && activeBankAccountId) {
      const fallbackError =
        err instanceof Error ? err.message : 'Unexpected sync failure'
      try {
        await prisma.bankFeedSync.update({
          where: { bankAccountId: activeBankAccountId },
          data: {
            status: 'error',
            lastError: fallbackError,
          },
        })
      } catch {
        // Ignore secondary error while recovering stuck sync state
      }
    }

    logger?.error?.(
      { err },
      'POST /api/bank-feed-syncs/[bankAccountId]/trigger error',
    )
    return NextResponse.json(
      { error: 'Failed to trigger bank feed synchronization' },
      { status: 500 },
    )
  }
}
