import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(
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
    if (transaction.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    return NextResponse.json({
        withdrawal: {
            id: transaction.id,
            type: transaction.type,
            status: transaction.status,
            amount: Number(transaction.amount),
            currency: transaction.currency,
            description: transaction.error || null,
            stellarTxHash: transaction.txHash,
            createdAt: transaction.createdAt,
        },
    })
}
