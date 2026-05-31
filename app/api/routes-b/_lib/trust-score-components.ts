export type TrustScoreComponent = {
  name: string
  weight: number
  contribution: number
  currentValue: number
}

const BASE_SCORE = 45
const VOLUME_MAX = 30
const VOLUME_DIVISOR = 1000
const INVOICE_MAX = 25
const DISPUTE_PENALTY_MAX = 40
const DISPUTE_PENALTY_MULTIPLIER = 10
const SCORE_MIN = 0
const SCORE_MAX = 100

export function computeTrustScoreComponents(
  volume: number,
  successfulInvoices: number,
  disputeCount: number,
): { score: number; components: TrustScoreComponent[] } {
  const volumePoints = Math.min(VOLUME_MAX, Math.floor(volume / VOLUME_DIVISOR))
  const invoicePoints = Math.min(INVOICE_MAX, successfulInvoices)
  const disputePenalty = Math.min(DISPUTE_PENALTY_MAX, disputeCount * DISPUTE_PENALTY_MULTIPLIER)

  const rawScore = BASE_SCORE + volumePoints + invoicePoints - disputePenalty
  const score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, rawScore))

  const components: TrustScoreComponent[] = [
    {
      name: 'account_age',
      weight: BASE_SCORE / SCORE_MAX,
      contribution: BASE_SCORE,
      currentValue: BASE_SCORE,
    },
    {
      name: 'payment_history',
      weight: VOLUME_MAX / SCORE_MAX,
      contribution: volumePoints,
      currentValue: volume,
    },
    {
      name: 'withdrawal_consistency',
      weight: INVOICE_MAX / SCORE_MAX,
      contribution: invoicePoints,
      currentValue: successfulInvoices,
    },
    {
      name: 'dispute_rate',
      weight: DISPUTE_PENALTY_MAX / SCORE_MAX,
      contribution: -disputePenalty,
      currentValue: disputeCount,
    },
  ]

  return { score, components }
}

export function computeTrustScore(
  volume: number,
  successfulInvoices: number,
  disputeCount: number,
): number {
  return computeTrustScoreComponents(volume, successfulInvoices, disputeCount).score
}
