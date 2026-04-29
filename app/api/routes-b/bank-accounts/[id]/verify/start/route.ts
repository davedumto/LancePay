import { withRequestId } from '../../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { startVerification } from '../../../../_lib/verify-store'

async function POSTHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const claims = await verifyAuthToken(authToken)
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const account = await prisma.bankAccount.findUnique({
    where: { id },
    select: { id: true, userId: true, isVerified: true },
  })
  if (!account) return NextResponse.json({ error: 'Bank account not found' }, { status: 404 })
  if (account.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  if (account.isVerified) {
    return NextResponse.json({ message: 'Bank account is already verified' })
  }

  const { expectedAmount } = startVerification(id)

  return NextResponse.json(
    { message: 'Micro-deposit initiated', simulatedAmount: expectedAmount },
    { status: 201 },
  )
}

export const POST = withRequestId(POSTHandler)
