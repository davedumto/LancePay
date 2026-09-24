import type { Prisma } from '@prisma/client'

export async function reserveWithdrawalInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  amount: number,
  onChainUsdcBalance: number,
): Promise<boolean> {
  if (!Number.isFinite(amount) || amount <= 0) {
    return false
  }

  await tx.userWithdrawalBalance.upsert({
    where: { userId },
    create: { userId, availableUsdc: onChainUsdcBalance },
    update: {},
  })

  const existing = await tx.userWithdrawalBalance.findUnique({ where: { userId } })
  if (!existing) {
    return false
  }

  const ledgerAvailable = Number(existing.availableUsdc)
  if (ledgerAvailable > onChainUsdcBalance) {
    return false
  }

  const reserved = await tx.userWithdrawalBalance.updateMany({
    where: {
      userId,
      availableUsdc: { gte: amount },
    },
    data: {
      availableUsdc: { decrement: amount },
    },
  })

  return reserved.count === 1
}
