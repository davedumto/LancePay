import { NextResponse } from 'next/server'
import { getUsdToNgnRate } from '@/lib/exchange-rate'

export async function GET() {
  const result = await getUsdToNgnRate()

  if ('fallback' in result && result.fallback) {
    return NextResponse.json(
      { error: 'Unable to fetch exchange rate' },
      { status: 503 }
    )
  }

  return NextResponse.json({
    rate: {
      from: 'USDC',
      to: 'NGN',
      value: result.rate as number,
      fetchedAt: result.lastUpdated,
    },
  })
}
