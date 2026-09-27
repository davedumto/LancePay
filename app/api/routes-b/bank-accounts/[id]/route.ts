import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId } })
}

export async function GET(
  request: NextRequest,
  { params }: any
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const bankAccount = await prisma.bankAccount.findFirst({
      where: { id: (await params)., userId: user.id },
      select: {
        id: true,
        bankName: true,
        bankCode: true,
        accountNumber: true,
        accountName: true,
        isVerified: true,
        isDefault: true,
        nickname: true,
        createdAt: true,
      },
    })

    if (!bankAccount) {
      return NextResponse.json({ error: 'Bank account not found' }, { status: 404 })
    }

    return NextResponse.json({ bankAccount })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/bank-accounts/[id] error')
    return NextResponse.json({ error: 'Failed to fetch bank account' }, { status: 500 })
  }
}
