import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

/**
 * GET /api/routes-d/analytics/transactions
 * Returns mock transaction volume and distribution data for analytics dashboard.
 */
export async function GET(request: NextRequest) {
    try {
        // 1. Basic Auth Check (Following routes-d pattern)
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        if (!authToken) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const claims = await verifyAuthToken(authToken)
        if (!claims) {
            return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
        }

        // Optional: Log the request for the specific user
        const user = await prisma.user.findUnique({
            where: { privyId: claims.userId },
            select: { id: true, email: true }
        })

        logger.info(`[Analytics API] Transaction data requested by ${user?.email || claims.userId}`)

        // 2. Generate Mock Analytics Data
        const mockData = {
            summary: {
                totalVolume: 125430.50, // USD equivalent
                totalTransactions: 1420,
                growthRate: 12.5, // % increase from previous period
                activeUsers: 89,
                avgTicketSize: 88.33
            },
            volumeHistory: [
                { date: "2026-02-16", volume: 12500, count: 140 },
                { date: "2026-02-17", volume: 18200, count: 190 },
                { date: "2026-02-18", volume: 15600, count: 165 },
                { date: "2026-02-19", volume: 21000, count: 210 },
                { date: "2026-02-20", volume: 19800, count: 195 },
                { date: "2026-02-21", volume: 22500, count: 230 },
                { date: "2026-02-22", volume: 15830.50, count: 90 }
            ],
            distribution: {
                byCurrency: [
                    { currency: "USDC", percentage: 65, value: 81530 },
                    { currency: "XLM", percentage: 25, value: 31357 },
                    { currency: "EURC", percentage: 10, value: 12543 }
                ],
                byStatus: [
                    { status: "completed", count: 1350, color: "#10b981" }, // emerald-500
                    { status: "pending", count: 45, color: "#f59e0b" },    // amber-500
                    { status: "failed", count: 25, color: "#ef4444" }      // red-500
                ],
                byRegion: [
                    { region: "North America", percentage: 40 },
                    { region: "Europe", percentage: 30 },
                    { region: "Africa", percentage: 20 },
                    { region: "Asia", percentage: 10 }
                ]
            },
            updatedAt: new Date().toISOString()
        }

        return NextResponse.json({
            success: true,
            data: mockData
        })
    } catch (error) {
        logger.error({ err: error }, 'Transaction Analytics GET error:')
        return NextResponse.json(
            { error: 'Failed to fetch transaction analytics' },
            { status: 500 }
        )
    }
}
