import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const account = await prisma.plaidAccount.findUnique({
      where: { id },
    })

    if (!account) {
      return NextResponse.json({ error: 'Account not found or already unlinked' }, { status: 404 })
    }

    if (account.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    await prisma.$transaction(async (tx) => {
      // Find any bank accounts for this user matching mask/institution or having a BankFeedSync
      const bankAccounts = await tx.bankAccount.findMany({
        where: { userId: user.id },
        include: { feedSync: true },
      })

      for (const ba of bankAccounts) {
        if (ba.feedSync) {
          // If bank account matches the unlinked plaid account (e.g. by mask or name)
          if (!account.mask || ba.accountNumber.endsWith(account.mask) || ba.bankName === account.institutionName) {
            await tx.bankFeedSync.delete({ where: { id: ba.feedSync.id } })
          }
        }
      }

      await tx.plaidAccount.delete({ where: { id } })
    })

    return NextResponse.json({ success: true, message: 'Plaid account unlinked successfully' })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/integrations/plaid/accounts/[id] error')
    return NextResponse.json({ error: 'Failed to unlink Plaid account' }, { status: 500 })
  }
}
