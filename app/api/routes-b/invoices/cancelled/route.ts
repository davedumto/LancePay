import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getArchiveFilter, parseIncludeArchivedParam } from '../../_lib/invoice-archive'

async function GETHandler(request: NextRequest) {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { searchParams } = new URL(request.url)
  const includeArchived = parseIncludeArchivedParam(searchParams.get('includeArchived'))
    const page = Math.max(1, Number.parseInt(searchParams.get('page') || '1', 10) || 1)
    const limit = Math.min(
        50,
        Math.max(1, Number.parseInt(searchParams.get('limit') || '20', 10) || 20),
    )

    const [invoices, total] = await Promise.all([
        prisma.invoice.findMany({
            where: {
                userId: user.id,
                status: 'cancelled',
                ...getArchiveFilter(includeArchived),
            },
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
            select: {
                id: true,
                invoiceNumber: true,
                clientName: true,
                amount: true,
                cancellationReason: true,
                createdAt: true,
            },
        }),
        prisma.invoice.count({
            where: {
                userId: user.id,
                status: 'cancelled',
                ...getArchiveFilter(includeArchived),
            },
        }),
    ])

    const totalPages = Math.ceil(total / limit)

    return NextResponse.json({
        invoices: invoices.map(invoice => ({
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            clientName: invoice.clientName,
            amount: Number(invoice.amount),
            cancellationReason: invoice.cancellationReason,
            createdAt: invoice.createdAt,
        })),
        pagination: {
            page,
            limit,
            total,
            totalPages,
        },
    })
}

export const GET = withRequestId(GETHandler)
