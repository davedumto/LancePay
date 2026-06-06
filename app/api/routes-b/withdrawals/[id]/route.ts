import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { withRetry } from '../../_lib/retry'
import { logger } from '@/lib/logger'
import { checkResourceOwnership } from '../../_lib/access-control'
import { withCompression } from '../../_lib/with-compression'
import { errorResponse } from '../../_lib/errors'

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

async function fetchProviderStatus(txHash: string): Promise<OfframpStatusResponse> {
    try {
        return await withRetry(
            async () => fetchOfframpStatus(txHash),
            {
                maxAttempts: 3,
                baseDelayMs: 200,
                // Keep this endpoint responsive even if the upstream is flaky.
                maxTotalMs: 1_500,
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
    } catch (error) {
        logger.warn({ error }, 'routes-b withdrawal status upstream failed after retries')
        return {}
    }
}

async function GETHandler(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const requestId = request.headers.get('x-request-id')

    try {
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        const claims = await verifyAuthToken(authToken || '')
        if (!claims) {
            return withCompression(
                request,
                errorResponse('UNAUTHORIZED', 'Unauthorized', { requestId }, 401),
            )
        }

        const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
        if (!user) {
            return withCompression(
                request,
                errorResponse('NOT_FOUND', 'User not found', { requestId }, 404),
            )
        }

        const { id } = await params

        const transaction = await prisma.transaction.findUnique({
            where: { id },
        })

        if (!transaction) {
            return withCompression(
                request,
                errorResponse('NOT_FOUND', 'Withdrawal not found', { requestId }, 404),
            )
        }

        if (transaction.type !== 'withdrawal') {
            return withCompression(
                request,
                errorResponse('NOT_FOUND', 'Withdrawal not found', { requestId }, 404),
            )
        }

        const accessCheck = checkResourceOwnership(transaction.userId, user.id)
        if (accessCheck) return accessCheck

        const providerStatus = transaction.txHash
            ? await fetchProviderStatus(transaction.txHash!)
            : {}

        return withCompression(
            request,
            NextResponse.json({
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
            }),
        )
    } catch (error) {
        logger.error({ err: error }, 'Routes B withdrawals/[id] GET error')

        return withCompression(
            request,
            errorResponse(
                'INTERNAL',
                'Failed to fetch withdrawal',
                { requestId },
                500,
            ),
        )
    }
}

export const GET = withRequestId(GETHandler)
