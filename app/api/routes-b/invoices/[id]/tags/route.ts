import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const invoice = await prisma.invoice.findUnique({ where: { id } })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }
    if (invoice.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const invoiceTags = await prisma.invoiceTag.findMany({
      where: { invoiceId: id },
      include: { tag: { select: { id: true, name: true, color: true } } },
      orderBy: { createdAt: 'asc' },
    })

    return NextResponse.json({
      tags: invoiceTags.map((it: { tag: { id: string; name: string; color: string } }) => ({
        id: it.tag.id,
        name: it.tag.name,
        color: it.tag.color,
      })),
    })
  } catch (error) {
    logger.error({ err: error, invoiceId: (await params).id }, 'Invoice tags GET error')
    return NextResponse.json({ error: 'Failed to fetch tags' }, { status: 500 })
  }
}

function isValidTagIdsPayload(body: unknown): body is { tagIds: string[] } {
  if (!body || typeof body !== 'object' || !('tagIds' in body)) return false
  const tagIds = (body as { tagIds: unknown }).tagIds
  return Array.isArray(tagIds) && tagIds.every(tagId => typeof tagId === 'string' && tagId.length > 0)
}

async function POSTHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const body = await request.json()
    if (!isValidTagIdsPayload(body)) {
      return NextResponse.json({ error: 'tagIds must be a non-empty string array' }, { status: 400 })
    }
    if (body.tagIds.length > 20) {
      return NextResponse.json({ error: 'tagIds exceeds maximum of 20' }, { status: 400 })
    }

    const invoice = await prisma.invoice.findUnique({ where: { id } })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }
    if (invoice.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const uniqueTagIds = [...new Set(body.tagIds)]
    const tags = await prisma.tag.findMany({
      where: { id: { in: uniqueTagIds } },
      select: { id: true, name: true, color: true, userId: true },
    })
    if (tags.length !== uniqueTagIds.length) {
      return NextResponse.json({ error: 'Invalid tag id' }, { status: 400 })
    }
    if (tags.some(tag => tag.userId !== user.id)) {
      return NextResponse.json({ error: 'Foreign tags are not allowed' }, { status: 403 })
    }

    const created: string[] = []
    for (const tagId of uniqueTagIds) {
      try {
        await prisma.invoiceTag.create({
          data: { invoiceId: id, tagId },
        })
        created.push(tagId)
      } catch (err: unknown) {
        const isPrismaUniqueError =
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as { code: string }).code === 'P2002'
        if (!isPrismaUniqueError) throw err
      }
    }

    return NextResponse.json(
      {
        invoiceId: id,
        attachedTagIds: uniqueTagIds,
        createdTagIds: created,
      },
      { status: 200 },
    )
  } catch (error) {
    logger.error({ err: error, invoiceId: (await params).id }, 'Invoice tags POST error')
    return NextResponse.json({ error: 'Failed to apply tag' }, { status: 500 })
  }
}

async function DELETEHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const body = await request.json()
    if (!isValidTagIdsPayload(body)) {
      return NextResponse.json({ error: 'tagIds must be a non-empty string array' }, { status: 400 })
    }
    if (body.tagIds.length > 20) {
      return NextResponse.json({ error: 'tagIds exceeds maximum of 20' }, { status: 400 })
    }

    const invoice = await prisma.invoice.findUnique({ where: { id } })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }
    if (invoice.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const uniqueTagIds = [...new Set(body.tagIds)]
    const tags = await prisma.tag.findMany({
      where: { id: { in: uniqueTagIds } },
      select: { id: true, userId: true },
    })
    if (tags.length !== uniqueTagIds.length) {
      return NextResponse.json({ error: 'Invalid tag id' }, { status: 400 })
    }
    if (tags.some(tag => tag.userId !== user.id)) {
      return NextResponse.json({ error: 'Foreign tags are not allowed' }, { status: 403 })
    }

    const result = await prisma.invoiceTag.deleteMany({
      where: {
        invoiceId: id,
        tagId: { in: uniqueTagIds },
      },
    })

    return NextResponse.json({
      invoiceId: id,
      detachedTagIds: uniqueTagIds,
      removedCount: result.count,
    })
  } catch (error) {
    logger.error({ err: error, invoiceId: (await params).id }, 'Invoice tags DELETE error')
    return NextResponse.json({ error: 'Failed to remove tags' }, { status: 500 })
  }
}

export const GET = withRequestId(GETHandler)
export const POST = withRequestId(POSTHandler)
export const DELETE = withRequestId(DELETEHandler)
