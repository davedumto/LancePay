import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { PrivyClient } from '@privy-io/server-auth'

const privyClient = new PrivyClient(
  process.env.NEXT_PUBLIC_PRIVY_APP_ID!,
  process.env.PRIVY_APP_SECRET!
)

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    // Find user
    let user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      include: { wallet: true }
    })

    // If no user, create one
    if (!user) {
      const email = (claims as any).email || `${claims.userId}@privy.local`
      const roleHint = request.headers.get('x-role-hint') || 'freelancer'

      user = await prisma.user.create({
        data: {
          privyId: claims.userId,
          email,
          role: roleHint
        },
        include: { wallet: true }
      })

      // If user is a client, link existing invoices by email
      if (roleHint === 'client') {
        await prisma.invoice.updateMany({
          where: { clientEmail: email, clientId: null },
          data: { clientId: user.id }
        })
      }
    }

    // If wallet already exists, return it
    if (user.wallet) {
      return NextResponse.json({
        synced: false,
        message: 'Wallet already exists',
        address: user.wallet.address
      })
    }

    // Fetch user from Privy to get wallet address
    const privyUser = await privyClient.getUser(claims.userId)

    // Find embedded wallet in linked accounts
    const embeddedWallet = privyUser.linkedAccounts.find(
      (account: any) => account.type === 'wallet' && account.walletClientType === 'privy'
    )

    if (!embeddedWallet || !('address' in embeddedWallet)) {
      return NextResponse.json({
        synced: false,
        error: 'No embedded wallet found. Please try logging out and back in.'
      }, { status: 404 })
    }

    // Create wallet record
    const wallet = await prisma.wallet.create({
      data: {
        userId: user.id,
        address: embeddedWallet.address as string,
      }
    })

    return NextResponse.json({
      synced: true,
      message: 'Wallet synced successfully',
      address: wallet.address
    })
  } catch (error) {
    logger.error({ err: error }, 'Wallet sync error')
    return NextResponse.json({ error: 'Failed to sync wallet' }, { status: 500 })
  }
}
