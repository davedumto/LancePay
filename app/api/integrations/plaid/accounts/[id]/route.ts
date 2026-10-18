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
 * DELETE /api/integrations/plaid/accounts/[id]
 * Unlinks a Plaid account owned by the authenticated user and removes any
 * associated BankFeedSync rows so no orphaned sync state remains.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } | Promise<{ id: string }> },
) {
  try {
    const userId = await resolveAuthenticatedUserId(req)
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await Promise.resolve(params)
    const accountId = id?.trim()
    if (!accountId) {
      return NextResponse.json(
        { error: 'Plaid account ID is required' },
        { status: 400 },
      )
    }

    const plaidAccount = await prisma.plaidAccount.findUnique({
      where: { id: accountId },
    })

    if (!plaidAccount || plaidAccount.status === 'unlinked') {
      return NextResponse.json(
        { error: 'Plaid account not found or already unlinked' },
        { status: 404 },
      )
    }

    if (plaidAccount.userId !== userId) {
      return NextResponse.json(
        { error: 'Forbidden: You may only unlink your own Plaid account' },
        { status: 403 },
      )
    }

    const cleanupAndDelete = async (
      tx: Pick<typeof prisma, 'plaidAccount' | 'bankFeedSync' | 'bankAccount'>,
    ) => {
      // Find any bank accounts belonging to this user that correspond to this Plaid link
      const relatedBankAccountIds = new Set<string>([
        plaidAccount.id,
        plaidAccount.plaidAccountId,
      ])

      if (typeof tx.bankAccount?.findMany === 'function') {
        const matchingBankAccounts =
          (await tx.bankAccount.findMany({
            where: {
              userId,
              bankName: plaidAccount.institutionName,
              ...(plaidAccount.mask
                ? { accountNumber: { endsWith: plaidAccount.mask } }
                : {}),
            },
            select: { id: true },
          })) ?? []

        for (const ba of matchingBankAccounts) {
          relatedBankAccountIds.add(ba.id)
        }
      }

      let removedSyncCount = 0
      if (typeof tx.bankFeedSync?.deleteMany === 'function') {
        const deleteResult = await tx.bankFeedSync.deleteMany({
          where: {
            userId,
            bankAccountId: { in: Array.from(relatedBankAccountIds) },
          },
        })
        removedSyncCount = deleteResult?.count ?? 0
      }

      const deletedAccount = await tx.plaidAccount.delete({
        where: { id: accountId },
      })

      return { deletedAccount, removedSyncCount }
    }

    const { deletedAccount, removedSyncCount } =
      typeof prisma.$transaction === 'function'
        ? await prisma.$transaction(async (tx) => cleanupAndDelete(tx))
        : await cleanupAndDelete(prisma)

    logger?.info?.(
      {
        userId,
        plaidAccountId: deletedAccount.plaidAccountId,
        removedSyncCount,
      },
      'DELETE /api/integrations/plaid/accounts/[id] unlinked account',
    )

    return NextResponse.json({
      success: true,
      unlinked: true,
      id: deletedAccount.id,
      plaidAccountId: deletedAccount.plaidAccountId,
      removedBankFeedSyncs: removedSyncCount,
    })
  } catch (err) {
    logger?.error?.(
      { err },
      'DELETE /api/integrations/plaid/accounts/[id] error',
    )
    return NextResponse.json(
      { error: 'Failed to unlink Plaid account' },
      { status: 500 },
    )
  }
}
