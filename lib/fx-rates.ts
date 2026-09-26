import { Decimal } from '@prisma/client/runtime/library'
import type { FxRateSnapshot, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { roundMoney } from '@/lib/money'

// Rate lookups over FxRateSnapshot, the table the exchange-rate poller writes.
// A pair may be recorded in either direction; the multi-currency trial
// balance already inverts the opposite-direction snapshot when the requested
// one is missing, and this follows the same rule.

type FxClient = Pick<Prisma.TransactionClient, 'fxRateSnapshot'>

export interface ResolvedFxRate {
  fromCurrency: string
  toCurrency: string
  /** null when both currencies are the same and no conversion is needed. */
  snapshot: FxRateSnapshot | null
  /** true when the snapshot quotes toCurrency -> fromCurrency. */
  inverted: boolean
}

function latestSnapshot(client: FxClient, from: string, to: string, asOf?: Date) {
  return client.fxRateSnapshot.findFirst({
    where: {
      fromCurrency: from,
      toCurrency: to,
      ...(asOf ? { capturedAt: { lte: asOf } } : {}),
    },
    orderBy: { capturedAt: 'desc' },
  })
}

/**
 * The most recent usable rate for from -> to captured at or before `asOf`
 * (or the most recent overall when `asOf` is omitted). When snapshots exist in
 * both directions the more recently captured one wins. Returns null when no
 * positive rate is recorded.
 */
export async function findFxRate(
  fromCurrency: string,
  toCurrency: string,
  asOf?: Date,
  client: FxClient = prisma,
): Promise<ResolvedFxRate | null> {
  const from = fromCurrency.toUpperCase()
  const to = toCurrency.toUpperCase()
  if (from === to) return { fromCurrency: from, toCurrency: to, snapshot: null, inverted: false }

  const [direct, reverse] = await Promise.all([
    latestSnapshot(client, from, to, asOf),
    latestSnapshot(client, to, from, asOf),
  ])
  const usableDirect = direct && direct.rate.gt(0) ? direct : null
  const usableReverse = reverse && reverse.rate.gt(0) ? reverse : null

  if (usableDirect && (!usableReverse || usableDirect.capturedAt >= usableReverse.capturedAt)) {
    return { fromCurrency: from, toCurrency: to, snapshot: usableDirect, inverted: false }
  }
  if (usableReverse) {
    return { fromCurrency: from, toCurrency: to, snapshot: usableReverse, inverted: true }
  }
  return null
}

/** Units of toCurrency per one unit of fromCurrency. */
export function effectiveRate(resolved: Pick<ResolvedFxRate, 'snapshot' | 'inverted'>): Decimal {
  if (!resolved.snapshot) return new Decimal(1)
  const rate = new Decimal(resolved.snapshot.rate)
  return resolved.inverted ? new Decimal(1).div(rate) : rate
}

/**
 * Converts an amount with the resolved rate, rounded to cents. An inverted
 * snapshot is applied by division rather than by multiplying with a rounded
 * reciprocal, so the result is reproducible from the stored snapshot alone.
 */
export function convertAmount(
  amount: Decimal,
  resolved: Pick<ResolvedFxRate, 'snapshot' | 'inverted'>,
): Decimal {
  if (!resolved.snapshot) return roundMoney(new Decimal(amount))
  const rate = new Decimal(resolved.snapshot.rate)
  return roundMoney(resolved.inverted ? new Decimal(amount).div(rate) : new Decimal(amount).mul(rate))
}

const RATE_DECIMAL_PLACES = 8

export function serializeFxRate(resolved: Pick<ResolvedFxRate, 'snapshot' | 'inverted'>) {
  const { snapshot } = resolved
  return {
    rate: effectiveRate(resolved).toDecimalPlaces(RATE_DECIMAL_PLACES).toString(),
    inverted: resolved.inverted,
    snapshot: snapshot
      ? {
          id: snapshot.id,
          fromCurrency: snapshot.fromCurrency,
          toCurrency: snapshot.toCurrency,
          rate: snapshot.rate.toString(),
          source: snapshot.source,
          capturedAt: snapshot.capturedAt.toISOString(),
        }
      : null,
  }
}
