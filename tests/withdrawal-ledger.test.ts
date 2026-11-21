import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { reserveWithdrawalInTransaction } from '@/lib/withdrawal-ledger'
import { sendAdminAlertEmail } from '@/lib/email'
import type { Prisma } from '@prisma/client'

vi.mock('@/lib/email', () => ({
  sendAdminAlertEmail: vi.fn().mockResolvedValue(undefined),
}))

type LedgerRow = { userId: string; availableUsdc: Decimal }

function createMockTx(initialBalance: string | number) {
  const ledger: LedgerRow = {
    userId: 'user-1',
    availableUsdc: new Decimal(initialBalance),
  }
  const audits: Array<Record<string, unknown>> = []
  let seeded = false

  const tx = {
    userWithdrawalBalance: {
      upsert: async () => {
        seeded = true
        return ledger
      },
      findUnique: async () => (seeded ? ledger : null),
      update: async ({
        data,
      }: {
        data: { availableUsdc?: Decimal | string | number }
      }) => {
        if (data.availableUsdc !== undefined) {
          ledger.availableUsdc = new Decimal(data.availableUsdc)
        }
        return ledger
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { userId: string; availableUsdc?: { gte: Decimal } }
        data: { availableUsdc: { decrement: Decimal } }
      }) => {
        const min = where.availableUsdc?.gte ?? new Decimal(0)
        if (ledger.availableUsdc.gte(min)) {
          ledger.availableUsdc = ledger.availableUsdc.sub(data.availableUsdc.decrement)
          return { count: 1 }
        }
        return { count: 0 }
      },
    },
    withdrawalLedgerAudit: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data)
        return { id: `audit-${audits.length}`, ...data }
      },
    },
    transaction: {
      create: async () => ({ id: 'tx-1', status: 'pending' }),
    },
  }

  return { tx: tx as unknown as Prisma.TransactionClient, ledger, audits }
}

describe('reserveWithdrawalInTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.WITHDRAWAL_LEDGER_DRIFT_ALERT_THRESHOLD
  })

  it('reserves funds and returns a typed reserved result', async () => {
    const { tx, ledger } = createMockTx(100)

    const result = await reserveWithdrawalInTransaction(tx, 'user-1', 30, '100')

    expect(result.status).toBe('reserved')
    expect(result.reconciledDrift).toBeUndefined()
    expect(ledger.availableUsdc.toString()).toBe('70')
  })

  it('rejects a second reservation when the ledger no longer has enough available USDC', async () => {
    const shared = createMockTx(100)

    const first = await reserveWithdrawalInTransaction(shared.tx, 'user-1', 80, '100')
    const second = await reserveWithdrawalInTransaction(shared.tx, 'user-1', 80, '100')

    expect(first.status).toBe('reserved')
    expect(second.status).toBe('insufficient_funds')
    expect(shared.ledger.availableUsdc.toString()).toBe('20')
  })

  it('allows only one of two concurrent reservations when combined amount exceeds balance', async () => {
    const shared = createMockTx(100)

    const results = await Promise.all([
      reserveWithdrawalInTransaction(shared.tx, 'user-1', 80, '100'),
      reserveWithdrawalInTransaction(shared.tx, 'user-1', 80, '100'),
    ])

    expect(results.filter((r) => r.status === 'reserved')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'insufficient_funds')).toHaveLength(1)
    expect(shared.ledger.availableUsdc.toString()).toBe('20')
  })

  it('handles float-unsafe amounts like 0.3 without residue', async () => {
    const { tx, ledger } = createMockTx('0.60')

    const first = await reserveWithdrawalInTransaction(tx, 'user-1', '0.3', '0.60')
    const second = await reserveWithdrawalInTransaction(tx, 'user-1', '0.3', '0.60')

    expect(first.status).toBe('reserved')
    expect(second.status).toBe('reserved')
    expect(ledger.availableUsdc.toString()).toBe('0')
  })

  it('reserves an exact-balance withdrawal', async () => {
    const { tx, ledger } = createMockTx('10.00')

    const result = await reserveWithdrawalInTransaction(tx, 'user-1', '10', '10.00')

    expect(result.status).toBe('reserved')
    expect(ledger.availableUsdc.toString()).toBe('0')
  })

  it('accepts sub-cent precision strings that money validation rejects', async () => {
    const { tx } = createMockTx('100')

    // parsePositiveMoney caps at 2 decimal places.
    const result = await reserveWithdrawalInTransaction(tx, 'user-1', '1.005', '100')

    expect(result.status).toBe('invalid_amount')
  })

  it('returns invalid_amount for non-positive or malformed amounts', async () => {
    const { tx } = createMockTx('100')

    for (const bad of [0, -5, 'abc', '', NaN]) {
      const result = await reserveWithdrawalInTransaction(tx, 'user-1', bad, '100')
      expect(result.status).toBe('invalid_amount')
    }
  })

  it('reconciles ledger drift down to the on-chain balance and records an audit entry', async () => {
    const { tx, ledger, audits } = createMockTx('150')

    const result = await reserveWithdrawalInTransaction(tx, 'user-1', '10', '120.50')

    // Drift of 29.50 reconciled the ledger to the on-chain balance first,
    // then the 10 reservation was taken against the reconciled balance.
    expect(result.status).toBe('reserved')
    expect(result.reconciledDrift).toBeDefined()
    expect(result.reconciledDrift!.toString()).toBe('29.5')
    expect(ledger.availableUsdc.toString()).toBe('110.5')
    expect(audits).toHaveLength(1)
    expect(audits[0].userId).toBe('user-1')
    expect(String(audits[0].ledgerAvailable)).toBe('150')
    expect(String(audits[0].onChainUsdc)).toBe('120.5')
    expect(String(audits[0].drift)).toBe('29.5')
  })

  it('continues the reservation against the reconciled balance when drift leaves too little', async () => {
    const { tx, ledger } = createMockTx('150')

    // On-chain is 50; after reconciliation only 50 is available, so a
    // withdrawal of 60 must report insufficient_funds — not locked out.
    const result = await reserveWithdrawalInTransaction(tx, 'user-1', '60', '50')

    expect(result.status).toBe('insufficient_funds')
    expect(ledger.availableUsdc.toString()).toBe('50')
  })

  it('sends an admin alert when drift exceeds the configured threshold', async () => {
    process.env.WITHDRAWAL_LEDGER_DRIFT_ALERT_THRESHOLD = '10'
    const { tx } = createMockTx('150')

    await reserveWithdrawalInTransaction(tx, 'user-1', '1', '120.50')

    expect(sendAdminAlertEmail).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendAdminAlertEmail).mock.calls[0][0]).toMatchObject({
      subject: expect.stringContaining('drift'),
    })
  })

  it('does not alert when drift is below the threshold', async () => {
    process.env.WITHDRAWAL_LEDGER_DRIFT_ALERT_THRESHOLD = '100'
    const { tx } = createMockTx('105')

    await reserveWithdrawalInTransaction(tx, 'user-1', '1', '100')

    expect(sendAdminAlertEmail).not.toHaveBeenCalled()
  })
})
