import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireScope, RoutesBForbiddenError } from '../../_lib/authz'
import { errorResponse } from '../../_lib/errors'

async function DELETEHandler(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireScope(request, 'routes-b:read')

    const { id } = await context.params

    const trashItem = await prisma.trashItem.findFirst({
      where: { id, userId: auth.userId },
      select: { id: true, resourceType: true, resourceId: true },
    })

    if (!trashItem) {
      return errorResponse('NOT_FOUND', 'Trash item not found', {}, 404)
    }

    // Permanently delete the trashed item record
    await prisma.trashItem.delete({ where: { id } })

    return NextResponse.json({
      deleted: true,
      resourceType: trashItem.resourceType,
      resourceId: trashItem.resourceId,
    })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', {}, 401)
    }
    return errorResponse('INTERNAL', 'Failed to permanently delete trash item', {}, 500)
  }
}

export const DELETE = withRequestId(DELETEHandler)