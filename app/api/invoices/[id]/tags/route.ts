import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const attachTagSchema = z
  .object({
    tagId: z.string().trim().min(1, 'Tag ID is required'),
  })
  .strict()

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

/**
 * GET /api/invoices/[id]/tags
 * Returns all tags attached to an invoice
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const invoiceId = params.id
    if (!invoiceId) {
      return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 })
    }

    // Verify the invoice belongs to the user
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { userId: true },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (invoice.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const tags = await prisma.invoiceTag.findMany({
      where: { invoiceId },
      select: {
        id: true,
        tagId: true,
        tag: {
          select: { id: true, name: true, color: true },
        },
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ tags })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/invoices/[id]/tags error')
    return NextResponse.json({ error: 'Failed to fetch tags' }, { status: 500 })
  }
}

/**
 * POST /api/invoices/[id]/tags
 * Attaches a tag to an invoice
 * Enforces unique invoiceId + tagId constraint
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const invoiceId = params.id
    if (!invoiceId) {
      return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 })
    }

    let body: unknown = {}
    const rawBody = await request.text()
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody)
      } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
      }
    }

    const parsed = attachTagSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }

    const tagId = parsed.data.tagId

    // Verify the invoice belongs to the user
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { userId: true },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (invoice.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Verify the tag belongs to the user
    const tag = await prisma.tag.findUnique({
      where: { id: tagId },
      select: { userId: true },
    })

    if (!tag) {
      return NextResponse.json({ error: 'Tag not found' }, { status: 404 })
    }

    if (tag.userId !== user.id) {
      return NextResponse.json({ error: 'Tag does not belong to you' }, { status: 403 })
    }

    try {
      const invoiceTag = await prisma.invoiceTag.create({
        data: {
          invoiceId,
          tagId,
        },
        select: {
          id: true,
          tagId: true,
          tag: {
            select: { id: true, name: true, color: true },
          },
          createdAt: true,
        },
      })

      logger.info({ userId: user.id, invoiceId, tagId }, 'Tag attached to invoice')

      return NextResponse.json({ invoiceTag }, { status: 201 })
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return NextResponse.json(
          { error: 'Tag is already attached to this invoice' },
          { status: 409 },
        )
      }
      throw error
    }
  } catch (error) {
    logger.error({ err: error }, 'POST /api/invoices/[id]/tags error')
    return NextResponse.json({ error: 'Failed to attach tag' }, { status: 500 })
  }
}

/**
 * DELETE /api/invoices/[id]/tags?tagId=<tagId>
 * Removes a tag from an invoice (does not delete the Tag itself)
 */
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const invoiceId = params.id
    if (!invoiceId) {
      return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 })
    }

    const { searchParams } = new URL(request.url)
    const tagId = searchParams.get('tagId')?.trim()

    if (!tagId) {
      return NextResponse.json({ error: 'Tag ID is required' }, { status: 400 })
    }

    // Verify the invoice belongs to the user
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { userId: true },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (invoice.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Check if the invoice tag exists
    const invoiceTag = await prisma.invoiceTag.findUnique({
      where: {
        invoiceId_tagId: {
          invoiceId,
          tagId,
        },
      },
      select: { id: true },
    })

    if (!invoiceTag) {
      return NextResponse.json({ error: 'Tag is not attached to this invoice' }, { status: 404 })
    }

    await prisma.invoiceTag.delete({
      where: {
        invoiceId_tagId: {
          invoiceId,
          tagId,
        },
      },
    })

    logger.info({ userId: user.id, invoiceId, tagId }, 'Tag removed from invoice')

    return NextResponse.json({ success: true }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/invoices/[id]/tags error')
    return NextResponse.json({ error: 'Failed to remove tag' }, { status: 500 })
  }
}
