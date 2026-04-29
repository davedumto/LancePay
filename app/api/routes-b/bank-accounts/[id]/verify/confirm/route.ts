import { withRequestId } from '../../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { confirmVerification } from '../../../../_lib/verify-store'

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

  let body: { amount?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (typeof body.amount !== 'number' || isNaN(body.amount)) {
    return NextResponse.json({ error: 'amount must be a number' }, { status: 400 })
  }

  const result = confirmVerification(id, body.amount)

  if ('notStarted' in result) {
    return NextResponse.json(
      { error: 'Verification not started. Call /verify/start first.' },
      { status: 400 },
    )
  }

  if (!result.ok) {
    if (result.locked) {
      return NextResponse.json(
        {
          error: 'Too many failed attempts. Verification locked.',
          lockedUntil: new Date(result.lockedUntil).toISOString(),
        },
        { status: 429 },
      )
    }
    return NextResponse.json(
      { error: 'Amount does not match.', attemptsLeft: result.attemptsLeft },
      { status: 422 },
    )
  }

  await prisma.bankAccount.update({
    where: { id },
    data: { isVerified: true },
  })

  return NextResponse.json({ message: 'Bank account verified successfully' })
}

export const POST = withRequestId(POSTHandler)
