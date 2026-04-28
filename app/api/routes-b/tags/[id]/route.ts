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

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
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

        const existingTag = await prisma.tag.findUnique({
            where: { id },
            include: { _count: { select: { invoiceTags: true } } },
        })
        if (!existingTag) {
            return NextResponse.json({ error: 'Tag not found' }, { status: 404 })
        }

        if (existingTag.userId !== user.id) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const body = await request.json()
        const updates: { name?: string; color?: string } = {}

        if (body.name !== undefined) {
            if (typeof body.name !== 'string' || body.name.trim().length === 0) {
                return NextResponse.json({ error: 'Tag name is required' }, { status: 400 })
            }
            if (body.name.length > 50) {
                return NextResponse.json({ error: 'Tag name must be at most 50 characters' }, { status: 400 })
            }
            updates.name = body.name
        }

        if (body.color !== undefined) {
            if (typeof body.color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(body.color)) {
                return NextResponse.json({ error: 'Invalid hex color format' }, { status: 400 })
            }
            updates.color = body.color
        }

        if (updates.name && updates.name !== existingTag.name) {
            const duplicateTag = await prisma.tag.findUnique({
                where: { userId_name: { userId: user.id, name: updates.name } },
            })
            if (duplicateTag) {
                return NextResponse.json({ error: 'Tag with this name already exists' }, { status: 409 })
            }
        }

        const hasNoChanges =
            (updates.name === undefined || updates.name === existingTag.name) &&
            (updates.color === undefined || updates.color === existingTag.color)

        if (hasNoChanges) {
            return NextResponse.json({
                id: existingTag.id,
                name: existingTag.name,
                color: existingTag.color,
                invoiceCount: existingTag._count.invoiceTags,
                createdAt: existingTag.createdAt,
            })
        }

        const updatedTag = await prisma.tag.update({
            where: { id },
            data: updates,
            include: { _count: { select: { invoiceTags: true } } },
        })

        return NextResponse.json({
            id: updatedTag.id,
            name: updatedTag.name,
            color: updatedTag.color,
            invoiceCount: updatedTag._count.invoiceTags,
            createdAt: updatedTag.createdAt,
        })
    } catch (error) {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

// DELETE /api/routes-b/tags/[id] - remove a tag and all its invoice associations
export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
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

        const tag = await prisma.tag.findUnique({ where: { id } })
        if (!tag) {
            return NextResponse.json({ error: 'Tag not found' }, { status: 404 })
        }

        if (tag.userId !== user.id) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        await prisma.invoiceTag.deleteMany({ where: { tagId: id } })
        await prisma.tag.delete({ where: { id } })

        return new NextResponse(null, { status: 204 })
    } catch (error) {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
