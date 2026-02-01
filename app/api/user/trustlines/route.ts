import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { addTrustline, removeTrustline } from '@/lib/stellar'
import { z } from 'zod'

const TrustlineSchema = z.object({
    assetCode: z.string().min(1).max(12),
    assetIssuer: z.string().length(56),
})

/**
 * Get sender's Stellar secret key for signing.
 * Reuse of pattern from internal/route.ts
 */
async function getUserSecretKey(userId: string, walletAddress: string): Promise<string | null> {
    if (process.env.NODE_ENV === 'development' && process.env.DEV_USER_SECRET_KEY) {
        return process.env.DEV_USER_SECRET_KEY;
    }

    return null
}

export async function POST(request: NextRequest) {
    try {
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const claims = await verifyAuthToken(authToken)
        if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

        const body = await request.json()
        const parsed = TrustlineSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 })
        }

        const { assetCode, assetIssuer } = parsed.data

        const user = await prisma.user.findUnique({
            where: { privyId: claims.userId },
            include: { wallet: true },
        })

        if (!user || !user.wallet) {
            return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })
        }

        const secretKey = await getUserSecretKey(claims.userId, user.wallet.address)

        if (!secretKey) {
            return NextResponse.json(
                { error: 'Signing capability unavailable. Please configure server-side keys or implement client-side signing.' },
                { status: 501 }
            )
        }

        const txHash = await addTrustline(secretKey, assetCode, assetIssuer)

        return NextResponse.json({ success: true, txHash })

    } catch (error: any) {
        console.error('Add trustline error:', error)
        return NextResponse.json(
            { error: error?.message || 'Failed to add trustline' },
            { status: 500 }
        )
    }
}

export async function DELETE(request: NextRequest) {
    try {
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const claims = await verifyAuthToken(authToken)
        if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

        const body = await request.json()
        const parsed = TrustlineSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 })
        }

        const { assetCode, assetIssuer } = parsed.data

        const user = await prisma.user.findUnique({
            where: { privyId: claims.userId },
            include: { wallet: true },
        })

        if (!user || !user.wallet) {
            return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })
        }

        const secretKey = await getUserSecretKey(claims.userId, user.wallet.address)

        if (!secretKey) {
            return NextResponse.json(
                { error: 'Signing capability unavailable.' },
                { status: 501 }
            )
        }

        const txHash = await removeTrustline(secretKey, assetCode, assetIssuer)

        return NextResponse.json({ success: true, txHash })

    } catch (error: any) {
        console.error('Remove trustline error:', error)
        return NextResponse.json(
            { error: error?.message || 'Failed to remove trustline' },
            { status: 500 }
        )
    }
}
