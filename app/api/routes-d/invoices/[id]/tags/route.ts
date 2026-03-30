import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── POST /api/routes-d/invoices/[id]/tags — apply a tag to an invoice ──

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    const body = await request.json()

    if (!body.tagId) {
      return NextResponse.json({ error: 'tagId is required' }, { status: 400 })
    }

    // Verify invoice exists and belongs to this user
    const invoice = await prisma.invoice.findUnique({ where: { id } })
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    if (invoice.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Verify tag exists and belongs to this user
    const tag = await prisma.tag.findUnique({ where: { id: body.tagId } })
    if (!tag) return NextResponse.json({ error: 'Tag not found' }, { status: 404 })
    if (tag.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    let isNew = true

    try {
      await prisma.invoiceTag.create({ data: { invoiceId: id, tagId: body.tagId } })
    } catch (err: unknown) {
      const isPrismaUniqueError =
        typeof err === 'object' && err !== null && 'code' in err &&
        (err as { code: string }).code === 'P2002'
      if (!isPrismaUniqueError) throw err
      // Tag already applied — idempotent, fall through to 200
      isNew = false
    }

    return NextResponse.json(
      { invoiceId: id, tagId: tag.id, tagName: tag.name, tagColor: tag.color },
      { status: isNew ? 201 : 200 }
    )
  } catch (error) {
    logger.error({ err: error }, 'Invoice tags POST error')
    return NextResponse.json({ error: 'Failed to apply tag' }, { status: 500 })
  }
}
