import { NextResponse } from 'next/server'

// GET /api/routes-b/exchange-rate — get current USDC to NGN exchange rate
export async function GET() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD')
    
    if (!res.ok) {
      return NextResponse.json(
        { error: 'Unable to fetch exchange rate. Please try again.' },
        { status: 503 }
      )
    }

    const data = await res.json()
    const usdToNgn = data.rates?.NGN

    if (typeof usdToNgn !== 'number' || isNaN(usdToNgn)) {
      return NextResponse.json(
        { error: 'Unable to fetch exchange rate. Please try again.' },
        { status: 503 }
      )
    }

    return NextResponse.json({
      rate: {
        from: 'USDC',
        to: 'NGN',
        value: usdToNgn,
        source: 'open.er-api.com',
        fetchedAt: new Date().toISOString(),
      }
    })
  } catch (error) {
    console.error('Error fetching exchange rate:', error)
    return NextResponse.json(
      { error: 'Unable to fetch exchange rate. Please try again.' },
      { status: 503 }
    )
  }
}