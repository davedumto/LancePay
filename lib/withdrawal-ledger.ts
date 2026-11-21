import { Decimal } from '@prisma/client/runtime/library'
import type { Prisma } from '@prisma/client'
import { parsePositiveMoney } from './money'
import { sendAdminAlertEmail } from './email'

export type WithdrawalReservationStatus =
  | 'reserved'
  | 'insufficient_funds'
  | 'invalid_amount'

export interface WithdrawalReservationResult {
  status: WithdrawalReservationStatus
  /**
   * Set when the ledger balance was higher than the on-chain balance and was
   * reconciled down inside the same transaction. `reconciledDrift` is the
   * USDC amount removed from the ledger by that reconciliation.
   */
  reconciledDrift?: Decimal
}

// Drift larger than this many USDC pages operators; smaller drift is still
// reconciled and audited but does not send an admin alert.
const DEFAULT_DRIFT_ALERT_THRESHOLD = new Decimal('100')

function driftAlertThreshold(): Decimal {
  const raw = process.env.WITHDRAWAL_LEDGER_DRIFT_ALERT_THRESHOLD
  if (!raw) return DEFAULT_DRIFT_ALERT_THRESHOLD
  try {
    const parsed = new Decimal(raw.trim())
    return parsed.isFinite() && parsed.gte(0)
      ? parsed
      : DEFAULT_DRIFT_ALERT_THRESHOLD
  } catch {
    return DEFAULT_DRIFT_ALERT_THRESHOLD
  }
}

function toNonNegativeDecimal(
  value: Decimal | string | number,
): Decimal | null {
  try {
    const d = value instanceof Decimal ? value : new Decimal(String(value))
    return d.isFinite() && d.gte(0) ? d : null
  } catch {
    return null
  }
}

/**
 * Reserve `amount` USDC from a user's withdrawal ledger inside an existing
 * Prisma transaction.
 *
 * All comparisons and decrements use Prisma Decimal values — never JS
 * floats — so amounts like 0.1 + 0.2 cannot leave sub-cent residue.
 *
 * Ledger drift: when the recorded `availableUsdc` exceeds the on-chain USDC
 * balance (a refund, fee, or failed payout lowered the chain balance), the
 * ledger is reconciled down to the on-chain balance inside the same
 * transaction, a `WithdrawalLedgerAudit` row records the drift, and operators
 * are alerted via sendAdminAlertEmail when the drift exceeds
 * WITHDRAWAL_LEDGER_DRIFT_ALERT_THRESHOLD (default 100 USDC). The
 * reservation then proceeds against the reconciled balance, so drift no
 * longer locks the user out of withdrawals.
 *
 * @returns a typed result distinguishing invalid amounts, genuine
 *   insufficient funds, and successful reservations (with drift info when
 *   reconciliation occurred)
 */
export async function reserveWithdrawalInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  amount: Decimal | string | number,
  onChainUsdcBalance: Decimal | string | number,
): Promise<WithdrawalReservationResult> {
  const parsedAmount = parsePositiveMoney(
    amount instanceof Decimal ? amount.toString() : amount,
  )
  const onChain = toNonNegativeDecimal(onChainUsdcBalance)
  if (!parsedAmount || !onChain) {
    return { status: 'invalid_amount' }
  }

  await tx.userWithdrawalBalance.upsert({
    where: { userId },
    create: { userId, availableUsdc: onChain },
    update: {},
  })

  const existing = await tx.userWithdrawalBalance.findUnique({
    where: { userId },
  })
  if (!existing) {
    return { status: 'insufficient_funds' }
  }

  const ledgerAvailable = new Decimal(existing.availableUsdc.toString())
  let reconciledDrift: Decimal | undefined

  if (ledgerAvailable.gt(onChain)) {
    reconciledDrift = ledgerAvailable.minus(onChain)

    await tx.userWithdrawalBalance.update({
      where: { userId },
      data: { availableUsdc: onChain },
    })

    await tx.withdrawalLedgerAudit.create({
      data: {
        userId,
        ledgerAvailable,
        onChainUsdc: onChain,
        drift: reconciledDrift,
      },
    })

    if (reconciledDrift.gt(driftAlertThreshold())) {
      await sendAdminAlertEmail({
        subject: 'Withdrawal ledger drift detected',
        message:
          'The withdrawal ledger balance exceeded the on-chain USDC balance and was reconciled down automatically.',
        severity: 'warning',
        context: {
          userId,
          ledgerAvailable: ledgerAvailable.toString(),
          onChainUsdc: onChain.toString(),
          drift: reconciledDrift.toString(),
        },
        actionRequired:
          'Review recent refunds, fees, or failed payouts for this user if drift recurs.',
      }).catch((err) => {
        console.error('Failed to send ledger drift admin alert:', err)
      })
    }
  }

  const reserved = await tx.userWithdrawalBalance.updateMany({
    where: {
      userId,
      availableUsdc: { gte: parsedAmount },
    },
    data: {
      availableUsdc: { decrement: parsedAmount },
    },
  })

  if (reserved.count !== 1) {
    return { status: 'insufficient_funds', reconciledDrift }
  }

  return { status: 'reserved', reconciledDrift }
}
