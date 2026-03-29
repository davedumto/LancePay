import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

// ── GET /api/routes-b/invoices/[id]/tags — get all tags applied to this invoice ──
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id: invoiceId } = await params
        const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
        const claims = await verifyAuthToken(authToken || '')
        if (!claims) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
        if (!user) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 })
        }

        // Verify invoice exists and belongs to this user
        const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } })
        if (!invoice) {
            return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
        }
        if (invoice.userId !== user.id) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const invoiceTags = await prisma.invoiceTag.findMany({
            where: { invoiceId },
            include: { tag: { select: { id: true, name: true, color: true } } },
            orderBy: { createdAt: 'asc' },
        })

        return NextResponse.json({
            tags: invoiceTags.map((it: any) => ({
                id: it.tag.id,
                name: it.tag.name,
                color: it.tag.color,
            })),
        })
    } catch (error) {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

// ── POST /api/routes-b/invoices/[id]/tags — apply an existing tag to an invoice ──
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id: invoiceId } = await params
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
        if (!body.tagId) {
            return NextResponse.json({ error: 'tagId is required' }, { status: 400 })
        }

        // Verify invoice exists and belongs to this user
        const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } })
        if (!invoice) {
            return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
        }
        if (invoice.userId !== user.id) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        // Verify tag exists and belongs to this user
        const tag = await prisma.tag.findUnique({ where: { id: body.tagId } })
        if (!tag) {
            return NextResponse.json({ error: 'Tag not found' }, { status: 404 })
        }
        if (tag.userId !== user.id) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        let isNew = true
        try {
            await prisma.invoiceTag.create({
                data: { invoiceId, tagId: body.tagId },
            })
        } catch (err: unknown) {
            const isPrismaUniqueError =
                typeof err === 'object' &&
                err !== null &&
                'code' in err &&
                (err as { code: string }).code === 'P2002'
            if (!isPrismaUniqueError) throw err
            // Connection already exists — idempotent
            isNew = false
        }

        return NextResponse.json(
            { invoiceId, tagId: tag.id, tagName: tag.name, tagColor: tag.color },
            { status: isNew ? 201 : 200 }
        )
    } catch (error) {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
