import { describe, it, expect } from 'vitest'
import { reserveWithdrawalInTransaction } from '@/lib/withdrawal-ledger'
import type { Prisma } from '@prisma/client'

type LedgerRow = { userId: string; availableUsdc: number }

function createMockTx(initialBalance: number) {
  const ledger: LedgerRow = { userId: 'user-1', availableUsdc: initialBalance }
  let seeded = false

  const tx = {
    userWithdrawalBalance: {
      upsert: async () => {
        seeded = true
        return ledger
      },
      findUnique: async () => (seeded ? ledger : null),
      update: async ({ data }: { data: { availableUsdc?: number } }) => {
        if (data.availableUsdc !== undefined) {
          ledger.availableUsdc = Number(data.availableUsdc)
        }
        return ledger
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { userId: string; availableUsdc?: { gte: number } }
        data: { availableUsdc: { decrement: number } }
      }) => {
        const min = where.availableUsdc?.gte ?? 0
        if (ledger.availableUsdc >= min) {
          ledger.availableUsdc -= data.availableUsdc.decrement
          return { count: 1 }
        }
        return { count: 0 }
      },
    },
    transaction: {
      create: async () => ({ id: 'tx-1', status: 'pending' }),
    },
  }

  return { tx: tx as unknown as Prisma.TransactionClient, ledger }
}

describe('reserveWithdrawalInTransaction', () => {
  it('rejects a second reservation when the ledger no longer has enough available USDC', async () => {
    const shared = createMockTx(100)

    await expect(reserveWithdrawalInTransaction(shared.tx, 'user-1', 80, 100)).resolves.toBe(true)
    await expect(reserveWithdrawalInTransaction(shared.tx, 'user-1', 80, 100)).resolves.toBe(false)
    expect(shared.ledger.availableUsdc).toBe(20)
  })

  it('allows only one of two concurrent reservations when combined amount exceeds balance', async () => {
    const shared = createMockTx(100)

    const results = await Promise.all([
      reserveWithdrawalInTransaction(shared.tx, 'user-1', 80, 100),
      reserveWithdrawalInTransaction(shared.tx, 'user-1', 80, 100),
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(shared.ledger.availableUsdc).toBe(20)
  })
})
