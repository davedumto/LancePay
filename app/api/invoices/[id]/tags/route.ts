import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

async function resolveInvoiceId(context?: RouteContext): Promise<string> {
  if (!context?.params) return ''
  const resolved = await Promise.resolve(context.params)
  return (resolved?.id ?? '').trim()
}

async function authenticate(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return {
      error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }),
    }
  }

  const user =
    (await prisma.user.findUnique({ where: { privyId: claims.userId } })) ??
    (await prisma.user.findUnique({ where: { id: claims.userId } }))
  if (!user) {
    return {
      error: NextResponse.json({ error: 'User not found' }, { status: 404 }),
    }
  }

  return { user }
}

function serializeInvoiceTag(row: Record<string, any>) {
  const tag = row.tag ?? null
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    tagId: row.tagId,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    ...(tag
      ? {
          tag: {
            id: tag.id,
            userId: tag.userId,
            name: tag.name,
            color: tag.color,
            createdAt: tag.createdAt
              ? new Date(tag.createdAt).toISOString()
              : null,
          },
        }
      : {}),
  }
}

/**
 * GET /api/invoices/[id]/tags
 * Lists tags attached to the specified invoice.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const invoiceId = await resolveInvoiceId(context)
    if (!invoiceId) {
      return NextResponse.json(
        { error: 'Invoice ID is required' },
        { status: 400 },
      )
    }

    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
    })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }
    if (invoice.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const rows = ((await prisma.invoiceTag.findMany({
      where: { invoiceId },
      include: { tag: true },
      orderBy: { createdAt: 'asc' },
    })) ?? []) as Array<Record<string, any>>

    return NextResponse.json({
      invoiceId,
      invoiceTags: rows.map(serializeInvoiceTag),
      tags: rows
        .map((r) => r.tag)
        .filter(Boolean)
        .map((t: any) => ({
          id: t.id,
          userId: t.userId,
          name: t.name,
          color: t.color,
          createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : null,
        })),
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'GET /api/invoices/[id]/tags error')
    return NextResponse.json(
      { error: 'Failed to list invoice tags' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/invoices/[id]/tags
 * Attaches an existing `Tag` to an invoice via `InvoiceTag`:
 * - Rejects attaching a tag that does not belong to the invoice owner (`403`).
 * - Enforces the unique `(invoiceId, tagId)` constraint with a clean `409` on duplicate attach.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const invoiceId = await resolveInvoiceId(context)
    if (!invoiceId) {
      return NextResponse.json(
        { error: 'Invoice ID is required' },
        { status: 400 },
      )
    }

    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    let body: Record<string, unknown>
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const tagId = typeof body.tagId === 'string' ? body.tagId.trim() : ''
    if (!tagId) {
      return NextResponse.json(
        { error: 'tagId is required', code: 'TAG_ID_REQUIRED' },
        { status: 400 },
      )
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
    })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }
    if (invoice.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const tag = await prisma.tag.findUnique({
      where: { id: tagId },
    })
    if (!tag) {
      return NextResponse.json({ error: 'Tag not found' }, { status: 404 })
    }

    if (tag.userId !== invoice.userId) {
      return NextResponse.json(
        {
          error: 'Forbidden: tag does not belong to the invoice owner',
          code: 'TAG_OWNERSHIP_MISMATCH',
        },
        { status: 403 },
      )
    }

    let existingAttach: Record<string, any> | null = null
    if (typeof prisma.invoiceTag?.findUnique === 'function') {
      existingAttach = await prisma.invoiceTag.findUnique({
        where: {
          invoiceId_tagId: {
            invoiceId,
            tagId,
          },
        },
      })
    } else if (typeof prisma.invoiceTag?.findFirst === 'function') {
      existingAttach = await prisma.invoiceTag.findFirst({
        where: { invoiceId, tagId },
      })
    }

    if (existingAttach) {
      return NextResponse.json(
        {
          error: 'Tag is already attached to this invoice',
          code: 'TAG_ALREADY_ATTACHED',
        },
        { status: 409 },
      )
    }

    let created: Record<string, any>
    try {
      created = await prisma.invoiceTag.create({
        data: {
          invoiceId,
          tagId,
        },
        include: { tag: true },
      })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return NextResponse.json(
          {
            error: 'Tag is already attached to this invoice',
            code: 'TAG_ALREADY_ATTACHED',
          },
          { status: 409 },
        )
      }
      throw err
    }

    return NextResponse.json(
      {
        invoiceTag: serializeInvoiceTag({
          ...created,
          tag: created.tag ?? tag,
        }),
      },
      { status: 201 },
    )
  } catch (error) {
    logger?.error?.({ err: error }, 'POST /api/invoices/[id]/tags error')
    return NextResponse.json(
      { error: 'Failed to attach tag to invoice' },
      { status: 500 },
    )
  }
}

/**
 * DELETE /api/invoices/[id]/tags
 * Removes a specific tag attachment (`InvoiceTag`) from an invoice without affecting
 * the underlying `Tag` definition itself.
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const invoiceId = await resolveInvoiceId(context)
    if (!invoiceId) {
      return NextResponse.json(
        { error: 'Invoice ID is required' },
        { status: 400 },
      )
    }

    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const { searchParams } = new URL(request.url)
    let tagId = (searchParams.get('tagId') ?? '').trim()
    if (!tagId) {
      const body = await request.json().catch(() => ({}))
      if (body && typeof body === 'object' && typeof body.tagId === 'string') {
        tagId = body.tagId.trim()
      }
    }

    if (!tagId) {
      return NextResponse.json(
        { error: 'tagId is required', code: 'TAG_ID_REQUIRED' },
        { status: 400 },
      )
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
    })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }
    if (invoice.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    let existingAttach: Record<string, any> | null = null
    if (typeof prisma.invoiceTag?.findUnique === 'function') {
      existingAttach = await prisma.invoiceTag.findUnique({
        where: {
          invoiceId_tagId: {
            invoiceId,
            tagId,
          },
        },
      })
    } else if (typeof prisma.invoiceTag?.findFirst === 'function') {
      existingAttach = await prisma.invoiceTag.findFirst({
        where: { invoiceId, tagId },
      })
    }

    if (!existingAttach) {
      return NextResponse.json(
        { error: 'Tag is not attached to this invoice' },
        { status: 404 },
      )
    }

    if (typeof prisma.invoiceTag?.delete === 'function') {
      await prisma.invoiceTag.delete({
        where: { id: existingAttach.id },
      })
    } else if (typeof prisma.invoiceTag?.deleteMany === 'function') {
      await prisma.invoiceTag.deleteMany({
        where: { invoiceId, tagId },
      })
    }

    return NextResponse.json({
      detached: true,
      invoiceId,
      tagId,
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'DELETE /api/invoices/[id]/tags error')
    return NextResponse.json(
      { error: 'Failed to detach tag from invoice' },
      { status: 500 },
    )
  }
}
