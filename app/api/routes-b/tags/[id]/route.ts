import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params

    const tag = await prisma.tag.findUnique({
        where: { id },
        include: { _count: { select: { invoiceTags: true } } },
    })

    if (!tag) return NextResponse.json({ error: 'Tag not found' }, { status: 404 })
    if (tag.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    return NextResponse.json({
        id: tag.id,
        name: tag.name,
        color: tag.color,
        invoiceCount: tag._count.invoiceTags,
        createdAt: tag.createdAt,
    })
}

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params

    const tag = await prisma.tag.findUnique({ where: { id } })
    if (!tag) return NextResponse.json({ error: 'Tag not found' }, { status: 404 })
    if (tag.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    await prisma.tag.delete({ where: { id } })

    return new NextResponse(null, { status: 204 })
}

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params

    const tag = await prisma.tag.findUnique({ where: { id } })
    if (!tag) return NextResponse.json({ error: 'Tag not found' }, { status: 404 })
    if (tag.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const body = await request.json().catch(() => ({}))
    const { name, color } = body

    if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
        return NextResponse.json({ error: 'Name must be a non-empty string' }, { status: 400 })
    }

    if (name && name.trim() !== tag.name) {
        const existingTag = await prisma.tag.findUnique({
            where: {
                userId_name: {
                    userId: user.id,
                    name: name.trim(),
                },
            },
        })
        if (existingTag) {
            return NextResponse.json({ error: 'Tag name already used' }, { status: 409 })
        }
    }

    const updatedTag = await prisma.tag.update({
        where: { id },
        data: {
            ...(name ? { name: name.trim() } : {}),
            ...(color ? { color } : {}),
        },
    })

    return NextResponse.json(updatedTag)
}
