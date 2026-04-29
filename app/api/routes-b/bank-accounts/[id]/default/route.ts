import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

interface RouteParams {
  params: Promise<{ id: string }>
}

async function PATCHHandler(request: NextRequest, { params }: RouteParams) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params

  const account = await prisma.bankAccount.findUnique({ where: { id } })

  if (!account) {
    return NextResponse.json({ error: 'Bank account not found' }, { status: 404 })
  }

  if (account.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Idempotent: already default — return current state without re-writing
  if (account.isDefault) {
    return NextResponse.json({
      id: account.id,
      bankName: account.bankName,
      accountNumber: account.accountNumber,
      isDefault: true,
    })
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Unset any existing default for this user
    await tx.bankAccount.updateMany({
      where: { userId: user.id, isDefault: true },
      data: { isDefault: false },
    })

    // Set the requested account as default
    return tx.bankAccount.update({
      where: { id },
      data: { isDefault: true },
      select: {
        id: true,
        bankName: true,
        accountNumber: true,
        isDefault: true,
      },
    })
  })

  return NextResponse.json(updated)
}

export const PATCH = withRequestId(PATCHHandler)
