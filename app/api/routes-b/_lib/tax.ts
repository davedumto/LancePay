export type TaxResult = {
  rate: number
  amount: number
  total: number
}

const RATES: Record<string, number> = {
  NG: 0.075,
  GB: 0.2,
  US: 0,
}

export function computeTax(subtotal: number, region: string, _type: string): TaxResult {
  const rate = RATES[region.toUpperCase()] ?? 0
  const amount = parseFloat((subtotal * rate).toFixed(2))
  const total = parseFloat((subtotal + amount).toFixed(2))
  return { rate, amount, total }
}
