import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')

  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
  if (!wallet) {
    return NextResponse.json({ wallet: null }, { status: 200 })
  }

  return NextResponse.json({
    wallet: {
      id: wallet.id,
      stellarAddress: wallet.address,
      createdAt: wallet.createdAt,
    },
  })
}
