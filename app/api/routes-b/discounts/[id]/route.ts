import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// DELETE /api/routes-b/discounts/[id] — delete a discount code owned by the
// authenticated user.

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const discount = await prisma.discount.findUnique({
      where: { id },
      select: { id: true, userId: true },
    })

    if (!discount) {
      return NextResponse.json({ error: 'Discount not found' }, { status: 404 })
    }
    if (discount.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    await prisma.discount.delete({ where: { id } })

    return NextResponse.json({ id }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/routes-b/discounts/[id] error')
    return NextResponse.json({ error: 'Failed to delete discount' }, { status: 500 })
  }
}
