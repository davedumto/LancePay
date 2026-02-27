import { NextResponse } from 'next/server'
import { logger } from '@/lib/logger'

// Base rates relative to USD
const BASE_RATES = {
    USDC: 1.0,
    EURC: 1.092, // Current approx EUR/USD
    XLM: 0.1145,  // Approx XLM/USD
    NGN: 1620.00, // Nigerian Naira
}

/**
 * Helper to add slight random fluctuation (±0.1% to ±0.5%)
 * to make the "real-time" mock feel alive.
 */
function fluctuate(base: number, volatility = 0.005) {
    const change = 1 + (Math.random() * volatility * 2 - volatility)
    return parseFloat((base * change).toFixed(6))
}

export async function GET() {
    try {
        const timestamp = new Date().toISOString()

        const rates = {
            USDC: fluctuate(BASE_RATES.USDC, 0.0001), // USDC is very stable
            EURC: fluctuate(BASE_RATES.EURC),
            XLM: fluctuate(BASE_RATES.XLM, 0.02),   // Crypto is more volatile
            NGN: fluctuate(BASE_RATES.NGN, 0.01),
        }

        return NextResponse.json({
            success: true,
            base: 'USD',
            timestamp,
            rates,
            provider: 'LancePay Mock Engine',
            disclaimer: 'These are mock rates for development and testing purposes.'
        }, {
            headers: {
                'Cache-Control': 'no-store, max-age=0'
            }
        })
    } catch (error) {
        logger.error({ err: error }, 'Exchange rates GET error:')
        return NextResponse.json({ error: 'Failed to fetch exchange rates' }, { status: 500 })
    }
}
