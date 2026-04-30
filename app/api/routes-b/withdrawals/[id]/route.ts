import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { withRetry } from '../../_lib/retry'
import { logger } from '@/lib/logger'
import { checkResourceOwnership } from '../../_lib/access-control'

type OfframpStatusResponse = { status?: string; description?: string }

async function fetchOfframpStatus(txHash: string): Promise<OfframpStatusResponse> {
    const baseUrl = process.env.OFFRAMP_STATUS_URL
    if (!baseUrl) {
        return {}
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(txHash)}`, {
        method: 'GET',
        cache: 'no-store',
    })

    if (!response.ok) {
        const error = new Error(`Off-ramp status fetch failed with status ${response.status}`) as Error & { status?: number }
        error.status = response.status
        throw error
    }

    return (await response.json()) as OfframpStatusResponse
}

async function GETHandler(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params

    const transaction = await prisma.transaction.findUnique({
        where: { id },
    })

    if (!transaction) return NextResponse.json({ error: 'Withdrawal not found' }, { status: 404 })
    if (transaction.type !== 'withdrawal') return NextResponse.json({ error: 'Withdrawal not found' }, { status: 404 })
    
    const accessCheck = checkResourceOwnership(transaction.userId, user.id)
    if (accessCheck) return accessCheck

    const providerStatus = transaction.txHash
        ? await withRetry(
            async () => fetchOfframpStatus(transaction.txHash!),
            {
                maxAttempts: 3,
                baseDelayMs: 200,
                onRetry: ({ attempt, delay, error }) => {
                    logger.warn({ attempt, delay, error }, 'routes-b withdrawal status retry')
                },
                shouldRetry: (error) => {
                    const status = (error as { status?: number }).status
                    const code = (error as { code?: string }).code
                    return (typeof status === 'number' && status >= 500) || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT'
                },
            },
        )
        : {}

    return NextResponse.json({
        withdrawal: {
            id: transaction.id,
            type: transaction.type,
            status: providerStatus.status ?? transaction.status,
            amount: Number(transaction.amount),
            currency: transaction.currency,
            description: providerStatus.description ?? (transaction.error || null),
            stellarTxHash: transaction.txHash,
            createdAt: transaction.createdAt,
        },
    })
}

export const GET = withRequestId(GETHandler)
