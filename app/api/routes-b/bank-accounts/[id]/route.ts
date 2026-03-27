import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

// DELETE /api/routes-b/bank-accounts/[id] — remove a bank account
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = params

    const account = await prisma.bankAccount.findUnique({
      where: { id }
    })

    if (!account) {
      return NextResponse.json({ error: 'Bank account not found' }, { status: 404 })
    }

    if (account.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // If this is the default account and other accounts exist, promote the oldest remaining one
    if (account.isDefault) {
      const next = await prisma.bankAccount.findFirst({
        where: { userId: user.id, id: { not: id } },
        orderBy: { createdAt: 'asc' },
      })
      if (next) {
        await prisma.bankAccount.update({
          where: { id: next.id },
          data: { isDefault: true }
        })
      }
    }

    await prisma.bankAccount.delete({ where: { id } })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    console.error('Error deleting bank account:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}