import { withRequestId } from '../../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function POSTHandler(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const { id } = await context.params

  const trashItem = await prisma.trashItem.findFirst({
    where: { id, userId: user.id },
    select: { id: true, resourceType: true, resourceId: true, deletedAt: true },
  })
  if (!trashItem) {
    return NextResponse.json({ error: 'Trash item not found' }, { status: 404 })
  }

  await prisma.$transaction([
    prisma.trashItem.delete({ where: { id } }),
    prisma.invoice.updateMany({
      where: { id: trashItem.resourceId, userId: user.id },
      data: { deletedAt: null },
    }),
  ])

  logger.info({ userId: user.id, trashItemId: id, resourceType: trashItem.resourceType }, 'Item restored from trash')

  return NextResponse.json({
    restored: true,
    resourceType: trashItem.resourceType,
    resourceId: trashItem.resourceId,
  })
}

export const POST = withRequestId(POSTHandler)
