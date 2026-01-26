import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getAccountBalance } from '@/lib/stellar'

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    // Find or create user
    let user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      include: { wallet: true },
    })

    if (!user) {
      const email = (claims as any).email || `${claims.userId}@privy.local`
      user = await prisma.user.create({
        data: { privyId: claims.userId, email },
        include: { wallet: true },
      })
    }

    if (!user.wallet) {
      return NextResponse.json({
        usd: '0',
        xlm: '0',
        address: null,
      })
    }

    const { xlm, usdc } = await getAccountBalance(user.wallet.address)

    return NextResponse.json({
      usd: usdc,
      xlm: xlm,
      address: user.wallet.address,
    })
  } catch (error) {
    console.error('Balance GET error:', error)
    return NextResponse.json({ error: 'Failed to get balance' }, { status: 500 })
  }
}
