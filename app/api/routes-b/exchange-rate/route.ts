import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    // Fetch USDC to NGN exchange rate from an external API
    // Using CoinGecko or similar API
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=ngn',
      {
        headers: {
          'Accept': 'application/json',
        },
      }
    )

    if (!response.ok) {
      // Fallback rate if API fails
      return NextResponse.json({
        rate: 1550.0,
        source: 'fallback',
        updatedAt: new Date().toISOString(),
      })
    }

    const data = await response.json()
    const rate = data['usd-coin']?.ngn || 1550.0

    return NextResponse.json({
      rate,
      source: 'coingecko',
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    logger.error({ err: error }, 'Exchange rate fetch error')
    // Return fallback rate on error
    return NextResponse.json({
      rate: 1550.0,
      source: 'fallback',
      updatedAt: new Date().toISOString(),
    })
  }
}