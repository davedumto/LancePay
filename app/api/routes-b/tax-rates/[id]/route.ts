import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── DELETE /api/routes-b/tax-rates/[id] — delete a tax rate ──
//
// Only the owner can delete. If the rate is marked as the default,
// deleting it simply removes it without auto-promoting another.

type TaxRateDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getTaxRateDelegate(): TaxRateDelegate {
  return (prisma as unknown as { taxRate: TaxRateDelegate }).taxRate
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    const delegate = getTaxRateDelegate()

    const taxRate = await delegate.findUnique({
      where: { id },
      select: { id: true, userId: true },
    })

    if (!taxRate) {
      return NextResponse.json({ error: 'Tax rate not found' }, { status: 404 })
    }

    if ((taxRate as { userId: string }).userId !== user.id) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    }

    await delegate.delete({ where: { id } })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/routes-b/tax-rates/[id] error')
    return NextResponse.json({ error: 'Failed to delete tax rate' }, { status: 500 })
  }
}
