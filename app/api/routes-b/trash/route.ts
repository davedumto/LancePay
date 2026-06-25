import { withRequestId } from '../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireScope, RoutesBForbiddenError } from '../_lib/authz'
import { errorResponse } from '../_lib/errors'
import { z } from 'zod'

const MoveToTrashSchema = z.object({
  resourceType: z.enum(['invoice', 'project', 'client', 'product']),
  resourceId: z.string(),
})

async function GETHandler(request: NextRequest) {
  try {
    const auth = await requireScope(request, 'routes-b:read')

    const { searchParams } = new URL(request.url)
    const resourceType = searchParams.get('resourceType')
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 100)
    const offset = parseInt(searchParams.get('offset') ?? '0', 10)

    const where: Record<string, unknown> = { userId: auth.userId }
    if (resourceType) {
      where.resourceType = resourceType
    }

    const [items, total] = await Promise.all([
      prisma.trashItem.findMany({
        where,
        orderBy: { deletedAt: 'desc' },
        take: isNaN(limit) || limit <= 0 ? 50 : limit,
        skip: isNaN(offset) || offset < 0 ? 0 : offset,
        select: {
          id: true,
          resourceType: true,
          resourceId: true,
          metadata: true,
          deletedAt: true,
          createdAt: true,
        },
      }),
      prisma.trashItem.count({ where }),
    ])

    return NextResponse.json({
      trashItems: items,
      pagination: {
        total,
        limit: isNaN(limit) || limit <= 0 ? 50 : limit,
        offset: isNaN(offset) || offset < 0 ? 0 : offset,
      },
    })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', {}, 401)
    }
    return errorResponse('INTERNAL', 'Failed to list trash items', {}, 500)
  }
}

async function POSTHandler(request: NextRequest) {
  try {
    const auth = await requireScope(request, 'routes-b:read')

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('BAD_REQUEST', 'Invalid JSON body', {}, 400)
    }

    const parsed = MoveToTrashSchema.safeParse(body)
    if (!parsed.success) {
      const fields: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.')
        fields[key] = issue.message
      }
      return errorResponse('BAD_REQUEST', 'Validation failed', { fields }, 400)
    }

    const { resourceType, resourceId } = parsed.data

    // Verify the resource belongs to the user
    if (resourceType === 'invoice') {
      const invoice = await prisma.invoice.findFirst({
        where: { id: resourceId, userId: auth.userId },
        select: { id: true },
      })
      if (!invoice) {
        return errorResponse('NOT_FOUND', 'Invoice not found', {}, 404)
      }
    } else if (resourceType === 'project') {
      const project = await prisma.project.findFirst({
        where: { id: resourceId, userId: auth.userId },
        select: { id: true },
      })
      if (!project) {
        return errorResponse('NOT_FOUND', 'Project not found', {}, 404)
      }
    }

    // Check if already in trash
    const existing = await prisma.trashItem.findFirst({
      where: { resourceType, resourceId, userId: auth.userId },
      select: { id: true },
    })
    if (existing) {
      return errorResponse('CONFLICT', 'Item is already in trash', {}, 409)
    }

    const trashItem = await prisma.trashItem.create({
      data: {
        userId: auth.userId,
        resourceType,
        resourceId,
        metadata: {},
      },
      select: {
        id: true,
        resourceType: true,
        resourceId: true,
        deletedAt: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ trashItem }, { status: 201 })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', {}, 401)
    }
    return errorResponse('INTERNAL', 'Failed to move item to trash', {}, 500)
  }
}

export const GET = withRequestId(GETHandler)
export const POST = withRequestId(POSTHandler)